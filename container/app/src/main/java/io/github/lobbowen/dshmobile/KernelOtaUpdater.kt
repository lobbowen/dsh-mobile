package io.github.lobbowen.dshmobile

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 远端内核 OTA：启动时查一次 feed；有更新就 **下载 → 校验 → 安装**。
 *
 * 为什么放在启动链、且在 spawn 之前：
 *   内核进程在后面的步骤才 spawn，此时 CURRENT 指针已确定。在这一步之前完成升级，
 *   本次启动就直接跑新内核 —— **不需要额外重启**。
 *
 * 三条硬约束（每一条都是"别把开机搞死"）：
 *   1. 只查一次、全程超时、失败只落诊断 —— 离线或服务端故障必须仍能开机；
 *   2. **只升不降**（用 KernelManager 的版本比较，与本地 feed 同一套语义）；
 *   3. 下载物与本地 feed 走**同一条校验链**（KernelInstaller：验签 + sha256 + 协议兼容），
 *      远端拿到的包不比本地文件更可信。
 */
object KernelOtaUpdater {

    private const val TAG = "KernelOtaUpdater"
    private const val CONFIG_ASSET = "kernel-feed.json"
    private const val CONNECT_TIMEOUT_MS = 5_000
    private const val READ_TIMEOUT_MS = 20_000
    private const val MAX_MANIFEST_BYTES = 64 * 1024
    private const val MAX_ZIP_BYTES = 32L * 1024 * 1024

    data class Config(val baseUrl: String, val releaseTag: String, val manifestName: String) {
        val manifestUrl: String get() = "$baseUrl/$releaseTag/$manifestName"
        fun zipUrl(version: String) = "$baseUrl/$releaseTag/kernel-$version.zip"
    }

    data class Outcome(
        val checked: Boolean,
        val updated: Boolean,
        val version: String?,
        val detail: String,
    )

    /** 读 assets/kernel-feed.json；缺失/非法/baseUrl 非 https → null（= 远端 OTA 关闭）。 */
    fun loadConfig(context: Context): Config? = try {
        val text = context.assets.open(CONFIG_ASSET).bufferedReader().use { it.readText() }
        val o = JSONObject(text)
        val base = o.optString("baseUrl", "").trim().trimEnd('/')
        val tag = o.optString("releaseTag", "kernel-latest").trim().ifBlank { "kernel-latest" }
        val name = o.optString("manifestName", "kernel-manifest.json").trim().ifBlank { "kernel-manifest.json" }
        if (!base.startsWith("https://")) null else Config(base, tag, name)
    } catch (e: Throwable) {
        Log.w(TAG, "kernel-feed.json 不可用: ${e.message}")
        null
    }

    /**
     * 查一次并（必要时）安装。**永不抛异常** —— 调用方是启动链，必须总能继续。
     */
    fun checkAndUpdate(context: Context, km: KernelManager): Outcome {
        val cfg = loadConfig(context)
            ?: return Outcome(false, false, null, "未配置 kernel-feed.json（远端 OTA 关闭）")

        val current = km.currentVersion()
        val manifestText = try {
            httpGetText(cfg.manifestUrl, MAX_MANIFEST_BYTES)
        } catch (e: Throwable) {
            return Outcome(true, false, null, "取 manifest 失败（离线或不可达）：${e::class.java.simpleName}: ${e.message}")
        }

        val manifest = try {
            JSONObject(manifestText)
        } catch (e: Throwable) {
            return Outcome(true, false, null, "manifest 不是合法 JSON：${e.message}")
        }

        val remote = manifest.optString("version", "").trim().ifBlank { null }
            ?: return Outcome(true, false, null, "manifest 缺 version 字段")

        if (current != null && km.compareKernelVersions(remote, current) <= 0) {
            return Outcome(true, false, current, "已是最新（本地 $current，远端 $remote）")
        }

        val url = manifest.optString("url", "").trim().ifBlank { cfg.zipUrl(remote) }
        val tmp = File(context.cacheDir, "kernel-ota-$remote.zip")
        try {
            download(url, tmp)
        } catch (e: Throwable) {
            tmp.delete()
            return Outcome(true, false, null, "下载失败（$url）：${e::class.java.simpleName}: ${e.message}")
        }

        val result = try {
            KernelInstaller.install(context, tmp, manifest, KernelInstaller.Source.OTA)
        } finally {
            tmp.delete()
        }
        return Outcome(
            checked = true,
            updated = result.ok,
            version = result.version ?: remote,
            detail = result.toDiagnosticLine(),
        )
    }

    private fun open(url: String): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "dsh-kernel-ota")
        }

    private fun httpGetText(url: String, maxBytes: Int): String {
        val conn = open(url)
        val code = conn.responseCode
        if (code !in 200..299) throw IllegalStateException("HTTP $code")
        return conn.inputStream.use { ins ->
            val buf = ByteArray(maxBytes)
            var total = 0
            while (total < maxBytes) {
                val n = ins.read(buf, total, maxBytes - total)
                if (n <= 0) break
                total += n
            }
            String(buf, 0, total, Charsets.UTF_8)
        }
    }

    private fun download(url: String, dest: File) {
        val conn = open(url)
        val code = conn.responseCode
        if (code !in 200..299) throw IllegalStateException("HTTP $code")
        conn.inputStream.use { ins ->
            dest.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    val n = ins.read(buf)
                    if (n <= 0) break
                    total += n
                    if (total > MAX_ZIP_BYTES) throw IllegalStateException("包超过上限 ${MAX_ZIP_BYTES} 字节")
                    out.write(buf, 0, n)
                }
            }
        }
        if (dest.length() <= 0L) throw IllegalStateException("下载到 0 字节")
    }
}
