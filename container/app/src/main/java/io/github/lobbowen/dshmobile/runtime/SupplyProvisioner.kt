package io.github.lobbowen.dshmobile.runtime

import android.content.Context
import io.github.lobbowen.dshmobile.RuntimeDiagnostics
import android.system.Os
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.zip.ZipInputStream

// C 层共享供给的容器侧执行者（**Android 原生**：不依赖 node / 任何运行时）。
//
// 为什么原生（用户 2026-09-29 复核）：「不应该用 node，而是用安卓原生的逻辑……它不应该再触及 node 或运行时环境，
//   它触及的是安卓原生怎么把这些能力向下，因为它是配套给下面的东西的。」C 是服务所有产品的共享层，
//   职责就是向下供给；再借 node 等于又欠一层依赖。
//
// 路径：读 assets/supply 的通道锚与信任根（只放数据，不放 JS）→ 取 manifest 与 .sig → Ed25519 验签
//   → 逐件 sha256 校验 → ZipInputStream 解包到暂存 → 原子落位 $PREFIX/lib/toolchain/<件名>/
//   → Os.symlink 建 $PREFIX/bin 入口与件内链接农场（link-farm.txt）。
//
// 诚实降级：Ed25519 需要 API >= 33；拿不到就不装任何件（拒装优于放过未验签的件）。
object SupplyProvisioner {

    private const val CHANNEL_ASSET = "supply/channel.json"
    private const val PUBKEY_ASSET = "supply/userland-public.pem"
    private const val MANIFEST_NAME = "userland-manifest.json"
    private const val FETCH_TIMEOUT_MS = 30000

    fun toolchainDir(ctx: Context): File = File(PrefixProvisioner.libDir(ctx), "toolchain")
    fun entryLink(ctx: Context, name: String): File = File(PrefixProvisioner.binDir(ctx), name)

    // 清单所在**目录**：通道锚里的 baseUrl 是主机（hubcdn.zll.ink），真正的路径带通道子目录
    //   userland-<channel>（线上实证：https://hubcdn.zll.ink/userland-canary/userland-manifest.json）。
    //   漏了这一段就是 404 —— 2026-09-29 自审时发现。
    private fun manifestDir(ctx: Context): String? {
        return try {
            val t = ctx.assets.open(CHANNEL_ASSET).use { it.readBytes().toString(Charsets.UTF_8) }
            val o = JSONObject(t)
            val base = o.optString("baseUrl", "").trimEnd('/')
            if (base.isEmpty()) null
            else base + "/userland-" + o.optString("channel", "canary")
        } catch (e: Throwable) { null }
    }

    private fun httpGet(url: String): ByteArray {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = FETCH_TIMEOUT_MS
        conn.readTimeout = FETCH_TIMEOUT_MS
        conn.instanceFollowRedirects = true
        try {
            if (conn.responseCode != 200) throw IllegalStateException("HTTP " + conn.responseCode + " " + url)
            return conn.inputStream.use { it.readBytes() }
        } finally {
            conn.disconnect()
        }
    }

    private fun pemToDer(pem: String): ByteArray {
        val body = pem.replace("-----BEGIN PUBLIC KEY-----", "")
            .replace("-----END PUBLIC KEY-----", "")
            .replace("\r", "").replace("\n", "").trim()
        return android.util.Base64.decode(body, android.util.Base64.DEFAULT)
    }

    // Ed25519 验签：对 manifest 的**原始字节**验（与发布侧对文件字节签名一致）。
    private fun verifyEd25519(pubPem: String, data: ByteArray, sig: ByteArray): Boolean {
        return try {
            val key = KeyFactory.getInstance("Ed25519").generatePublic(X509EncodedKeySpec(pemToDer(pubPem)))
            val v = Signature.getInstance("Ed25519")
            v.initVerify(key)
            v.update(data)
            v.verify(sig)
        } catch (e: Throwable) { false }
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val d = MessageDigest.getInstance("SHA-256").digest(bytes)
        val sb = StringBuilder()
        for (b in d) {
            val v = b.toInt() and 0xff
            if (v < 16) sb.append('0')
            sb.append(Integer.toHexString(v))
        }
        return sb.toString()
    }

    private fun sha256File(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(65536)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                md.update(buf, 0, n)
            }
        }
        val sb = StringBuilder()
        for (b in md.digest()) {
            val v = b.toInt() and 0xff
            if (v < 16) sb.append('0')
            sb.append(Integer.toHexString(v))
        }
        return sb.toString()
    }

    private fun unzipInto(zipBytes: ByteArray, dest: File) {
        dest.mkdirs()
        ZipInputStream(ByteArrayInputStream(zipBytes)).use { zin ->
            var e = zin.nextEntry
            while (e != null) {
                val name = e.name
                if (name.contains("..")) { zin.closeEntry(); e = zin.nextEntry; continue }
                val out = File(dest, name)
                if (e.isDirectory) {
                    out.mkdirs()
                } else {
                    out.parentFile?.mkdirs()
                    out.outputStream().use { zin.copyTo(it) }
                    if (name.startsWith("bin/")) out.setExecutable(true, false)
                }
                zin.closeEntry()
                e = zin.nextEntry
            }
        }
    }

    // 件内链接农场（git 的 libexec/git-core 那类）：每行「相对路径 <TAB> 目标」，原生建链。
    private fun applyLinkFarm(root: File): Int {
        val farm = File(root, "link-farm.txt")
        if (!farm.isFile) return 0
        var applied = 0
        for (line in farm.readLines()) {
            if (line.isEmpty() || line.startsWith("#")) continue
            val parts = line.split("\t")
            if (parts.size != 2) continue
            val rel = parts[0].trim()
            val target = parts[1].trim()
            if (rel.isEmpty() || target.isEmpty() || rel.contains("..") || target.contains("..")) continue
            try {
                val dst = File(root, rel)
                dst.parentFile?.mkdirs()
                dst.delete()
                Os.symlink(target, dst.absolutePath)
                applied++
            } catch (e: Throwable) { }
        }
        return applied
    }

    private fun linkEntry(ctx: Context, name: String, entry: File, aliases: List<String>): Boolean {
        return try {
            val link = entryLink(ctx, name)
            link.delete()
            Os.symlink(entry.absolutePath, link.absolutePath)
            for (a in aliases) {
                if (a.isEmpty() || a == name) continue
                val la = entryLink(ctx, a)
                la.delete()
                Os.symlink(entry.absolutePath, la.absolutePath)
            }
            true
        } catch (e: Throwable) { false }
    }

    // 跑一轮供给：返回成功就位的件数；任何异常都只记账不抛出（不阻塞启动）。
    fun ensure(ctx: Context): Int {
        val base = manifestDir(ctx) ?: run {
            RuntimeDiagnostics.append(ctx, "supply", false, "C 层供给未启动", "assets/" + CHANNEL_ASSET + " 读不到通道锚")
            return 0
        }
        val pubPem = try {
            ctx.assets.open(PUBKEY_ASSET).use { it.readBytes().toString(Charsets.UTF_8) }
        } catch (e: Throwable) {
            RuntimeDiagnostics.append(ctx, "supply", false, "C 层供给未启动", "assets/" + PUBKEY_ASSET + " 读不到信任根")
            return 0
        }
        val tc = toolchainDir(ctx)
        tc.mkdirs()
        try {
            val manifestBytes = httpGet(base + "/" + MANIFEST_NAME)
            val sigBytes = httpGet(base + "/" + MANIFEST_NAME + ".sig").toString(Charsets.UTF_8).trim().let {
                android.util.Base64.decode(it, android.util.Base64.DEFAULT)
            }
            if (!verifyEd25519(pubPem, manifestBytes, sigBytes)) {
                RuntimeDiagnostics.append(ctx, "supply", false, "C 层清单验签不通过", "拒装任何件")
                return 0
            }
            File(tc, MANIFEST_NAME).writeBytes(manifestBytes)
            val manifest = JSONObject(manifestBytes.toString(Charsets.UTF_8))
            val tools = manifest.optJSONArray("tools") ?: return 0
            var okCount = 0
            var i = 0
            while (i < tools.length()) {
                val t = tools.getJSONObject(i)
                i++
                val name = t.optString("name", "")
                val url = t.optString("url", "")
                val want = t.optString("sha256", "")
                val entryRel = t.optString("entry", "bin/" + name)
                if (name.isEmpty() || url.isEmpty() || want.isEmpty()) continue
                val marker = File(tc, "." + name + ".ok")
                val root = File(tc, name)
                if (marker.isFile && marker.readText().trim() == want && File(root, entryRel).isFile) { okCount++; continue }
                val bytes = httpGet(url)
                val got = sha256Hex(bytes)
                if (got != want) {
                    RuntimeDiagnostics.append(ctx, "supply", false, "C 层件 sha256 不符（已丢弃，不落位）", name + " " + got.take(12) + " != " + want.take(12))
                    continue
                }
                val staging = File(tc, "." + name + ".staging")
                staging.deleteRecursively()
                unzipInto(bytes, staging)
                val stagedEntry = File(staging, entryRel)
                if (!stagedEntry.isFile) {
                    RuntimeDiagnostics.append(ctx, "supply", false, "C 层件缺入口（已丢弃）", name + " " + entryRel)
                    staging.deleteRecursively()
                    continue
                }
                applyLinkFarm(staging)
                root.deleteRecursively()
                if (!staging.renameTo(root)) {
                    RuntimeDiagnostics.append(ctx, "supply", false, "C 层件落位失败", name)
                    staging.deleteRecursively()
                    continue
                }
                val aliases = mutableListOf<String>()
                val ja = t.optJSONArray("aliases")
                if (ja != null) { var k = 0; while (k < ja.length()) { aliases.add(ja.getString(k)); k++ } }
                linkEntry(ctx, name, File(root, entryRel), aliases)
                marker.writeText(want)
                okCount++
            }
            RuntimeDiagnostics.append(ctx, "supply", true, "C 层供给完成：就位 " + okCount + " 件", base)
            return okCount
        } catch (e: Throwable) {
            RuntimeDiagnostics.append(ctx, "supply", false, "C 层供给异常", e.message ?: e.javaClass.simpleName)
            return 0
        }
    }
}
