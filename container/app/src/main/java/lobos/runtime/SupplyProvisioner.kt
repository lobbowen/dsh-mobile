package lobos.runtime

import android.content.Context
import lobos.RuntimeDiagnostics
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
    // 仅供**设备侧落盘副本**命名；远端对象键一律由通道锚声明，这里不留默认值（见 anchorName）。
    private const val MANIFEST_NAME = "userland-manifest.json"
    private const val FETCH_TIMEOUT_MS = 30000

    fun toolchainDir(ctx: Context): File = File(PrefixProvisioner.libDir(ctx), "toolchain")
    fun entryLink(ctx: Context, name: String): File = File(PrefixProvisioner.binDir(ctx), name)

    // 清单所在**目录**：通道锚里的 baseUrl 是主机（hubcdn.zll.ink），真正的路径还要带通道子目录
    //   userland-<channel>。漏了这一段就是 404 —— 2026-09-29 自审时发现。
    private fun manifestDir(ctx: Context): String? {
        return try {
            val t = ctx.assets.open(CHANNEL_ASSET).use { it.readBytes().toString(Charsets.UTF_8) }
            val o = JSONObject(t)
            val base = o.optString("baseUrl", "").trimEnd('/')
            if (base.isEmpty()) null
            else base + "/userland-" + o.optString("channel", "canary")
        } catch (e: Throwable) { null }
    }

    // 清单与签名的 URL 必须**每次回源**：CDN 边缘会缓存同名对象，而「发了但设备读不到新版」的代价
    //   是整条供给静默滞后（2026-09-24 Program 面为此踩过一次并写进 ProgramOtaUpdater；
    //   2026-09-29 真机现读 C 层仍在吃旧清单：同一对象键，工作侧带 cache-buster 读到
    //   2026.09.29.142，设备 17 分钟前落盘的副本却是 2026.09.29.141、git 的 sha 也随之不同）。
    // 件 zip 相反 —— 文件名里带内容哈希，可长缓存；给它加 bust 等于每次开机重拖 24MB。
    private fun uncached(url: String): String =
        url + (if (url.indexOf('?') >= 0) "&" else "?") + "t=" + System.currentTimeMillis()

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

    // 清单名/签名名**由通道锚驱动**：换对象键是避开「旧键被长 TTL 缓存钉死」的正规手段
    //   （2026-09-29 实证：清单本身已正确发布 tools=5，但旧键被一年缓存挡住，新上传不作废旧条目）。
    // 所以这里**不给默认键名**：锚读不到就返回 null 交调用方判红。留一个旧键名当默认，等于
    //   允许「仓内声明已改名 + 线上仍是废止身份」同时成立而不报错 —— 2026-09-29 线上正是这个形态
    //   （声明键 404、旧键 200 且内容是 2026.09.27 的陈表），照默认值走的品牌会安静装上陈件。
    private fun anchorName(ctx: Context, field: String): String? {
        return try {
            val t = ctx.assets.open(CHANNEL_ASSET).use { it.readBytes().toString(Charsets.UTF_8) }
            JSONObject(t).optString(field, "").ifBlank { null }
        } catch (e: Throwable) { null }
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
        val inside = root.canonicalPath + File.separator
        var applied = 0
        for (line in farm.readLines()) {
            if (line.isEmpty() || line.startsWith("#")) continue
            val parts = line.split("\t")
            if (parts.size != 2) continue
            val rel = parts[0].trim()
            val target = parts[1].trim()
            if (rel.isEmpty() || target.isEmpty()) continue
            try {
                val dst = File(root, rel)
                // 防穿越的口径是**落点**，不是字面：`..` 在相对目标里是合法写法（真机 2026-09-29：
                //   git 件第一行就是 `libexec/git-core/git → ../../bin/git`，一律禁 `..` 会让这个锚点
                //   永不建立，而它下面 148 条 `git-* -> git` 全部悬空 —— 件照样就位，只是子命令全废）。
                val resolved = File(dst.parentFile, target).canonicalPath
                if (!resolved.startsWith(inside) || resolved == root.canonicalPath) continue
                dst.parentFile?.mkdirs()
                dst.delete()
                Os.symlink(target, dst.absolutePath)
                applied++
            } catch (e: Throwable) { }
        }
        return applied
    }

    /** 农场建成核验：清单里每一条都必须是**真的、可解析的**符号链接（包内存的是链接目标文本，不是链接本身）。 */
    private fun farmBroken(root: File): Int {
        val farm = File(root, "link-farm.txt")
        if (!farm.isFile) return 0
        var broken = 0
        for (line in farm.readLines()) {
            if (line.isEmpty() || line.startsWith("#")) continue
            val rel = line.split("\t")[0].trim()
            if (rel.isEmpty()) continue
            val f = File(root, rel)
            // 只判「是不是链」会放过悬空链：锚点缺失时 148 条子命令链仍是链，却指向不存在的路径。
            try { if (!java.nio.file.Files.isSymbolicLink(f.toPath()) || !f.exists()) broken++ } catch (e: Throwable) { broken++ }
        }
        return broken
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
            val manName = anchorName(ctx, "manifestName")
            if (manName == null) {
                RuntimeDiagnostics.append(
                    ctx, "supply", false, "C 层供给未启动",
                    "assets/" + CHANNEL_ASSET + " 没有 manifestName：远端对象键只由通道锚声明，不回落旧键"
                )
                return 0
            }
            val sigName = anchorName(ctx, "sigName") ?: (manName + ".sig")
            val manifestBytes = httpGet(uncached(base + "/" + manName))
            val sigBytes = httpGet(uncached(base + "/" + sigName)).toString(Charsets.UTF_8).trim().let {
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
                if (marker.isFile && marker.readText().trim() == want && File(root, entryRel).isFile) {
                    // marker 命中**不等于件还能用**：农场完好性必须在这里复验一次。
                    //   件按 sha256 内容寻址，同一个 sha 只会落位一次 —— 不在这里读，
                    //   那么「后来修好了建链代码」对已就位件永远不会起效，设备上只剩一堆悬空链
                    //   而供给一路记 OK（2026-09-29 真机定罪 DS-7）。只记账不自动重下：
                    //   重建要靠删 `.<name>.ok`，免得农场天生建不成时每次开机都拖 24MB。
                    val brokenLinks = farmBroken(root)
                    if (brokenLinks > 0) {
                        RuntimeDiagnostics.append(ctx, "supply", false, "C 层已就位件的链接农场有 " + brokenLinks + " 条不可解析", name)
                    }
                    okCount++
                    continue
                }
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
                // 包内存的是链接**目标文本**（打包用 zip -y 不跟随），所以这里核验链接真的建成了 ——
                //   没建成即记账，不静默（否则设备上会得到一堆装着路径文本的小文件，表现为「git 装上了但子命令全废」）。
                val brokenLinks = farmBroken(staging)
                if (brokenLinks > 0) {
                    RuntimeDiagnostics.append(ctx, "supply", false, "C 层件链接农场有 " + brokenLinks + " 条没建成", name)
                }
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
