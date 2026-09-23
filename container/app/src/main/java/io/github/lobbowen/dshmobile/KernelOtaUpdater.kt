package io.github.lobbowen.dshmobile

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 远端内核 OTA 的**能力本体**：查 feed → 比较版本 → （可选）下载 → 校验 → 安装。
 *
 * 触发方式（刻意如此）：
 *   · **默认手动** —— 由内核/面板经桥方法 `build.kernelUpdate` 触发（内核侧本就有版本检测）。
 *     `kernel-feed.json` 的 `autoCheck=false` 时启动链**不**主动检查 —— 稳定态就该没有意外动作。
 *   · 需要"启动即自动升级"时把 `autoCheck` 置 `true`。
 *
 * 三条硬约束（都是"别把开机/调用搞死"）：
 *   1. 全程超时（连接 5s / 读 20s）、失败只返回 Outcome、**永不抛异常**；
 *   2. **只升不降**（复用 KernelManager 的版本比较，与本地 feed 同一语义）；
 *   3. 下载物与本地 feed 走**同一条校验链**（KernelInstaller：验签 + sha256 + 协议兼容）——
 *      远端拿到的包不比本地文件更可信。
 */
object KernelOtaUpdater {

    private const val TAG = "KernelOtaUpdater"
    private const val CONFIG_ASSET = "kernel-feed.json"
    private const val CONNECT_TIMEOUT_MS = 5_000
    private const val READ_TIMEOUT_MS = 20_000
    private const val MAX_MANIFEST_BYTES = 64 * 1024
    private const val MAX_ZIP_BYTES = 32L * 1024 * 1024

    data class Config(
        val baseUrl: String,
        val releaseTag: String,
        val manifestName: String,
        val autoCheck: Boolean,
    ) {
        val manifestUrl: String get() = "$baseUrl/$releaseTag/$manifestName"
        fun zipUrl(version: String) = "$baseUrl/$releaseTag/kernel-$version.zip"
    }

    /**
     * 一次检查/升级的结果。
     * [available] 与 [updated] 必须分开："有新版本但没装"（checkOnly）与"装了"是两件事。
     */
    data class Outcome(
        val checked: Boolean,
        val available: Boolean,
        val updated: Boolean,
        val current: String?,
        val remote: String?,
        val detail: String,
    )

    /** 读 assets/kernel-feed.json；缺失/非法/baseUrl 非 https → null（= 远端 OTA 关闭）。 */
    fun loadConfig(context: Context): Config? = try {
        val text = context.assets.open(CONFIG_ASSET).bufferedReader().use { it.readText() }
        val o = JSONObject(text)
        val base = o.optString("baseUrl", "").trim().trimEnd('/')
        val tag = o.optString("releaseTag", "kernel-latest").trim().ifBlank { "kernel-latest" }
        val name = o.optString("manifestName", "kernel-manifest.json").trim().ifBlank { "kernel-manifest.json" }
        val auto = o.optBoolean("autoCheck", false)
        if (!base.startsWith("https://")) null else Config(base, tag, name, auto)
    } catch (e: Throwable) {
        Log.w(TAG, "kernel-feed.json 不可用: ${e.message}")
        null
    }

    /**
     * 查一次；[checkOnly] 为 true 时**只报告不安装**。
     * **永不抛异常** —— 调用方可能是启动链或桥方法，必须总能拿到结果。
     */
    fun checkAndUpdate(context: Context, km: KernelManager, checkOnly: Boolean = false): Outcome {
        val cfg = loadConfig(context)
            ?: return Outcome(false, false, false, km.currentVersion(), null, "未配置 kernel-feed.json（远端 OTA 关闭）")

        val current = km.currentVersion()
        val manifestText = try {
            httpGetText(cfg.manifestUrl, MAX_MANIFEST_BYTES)
        } catch (e: Throwable) {
            return Outcome(true, false, false, current, null, "取 manifest 失败（离线或不可达）：${e::class.java.simpleName}: ${e.message}")
        }

        val manifest = try {
            JSONObject(manifestText)
        } catch (e: Throwable) {
            return Outcome(true, false, false, current, null, "manifest 不是合法 JSON：${e.message}")
        }

        val remote = manifest.optString("version", "").trim().ifBlank { null }
            ?: return Outcome(true, false, false, current, null, "manifest 缺 version 字段")

        if (current != null && km.compareKernelVersions(remote, current) <= 0) {
            return Outcome(true, false, false, current, remote, "已是最新（本地 $current，远端 $remote）")
        }
        if (checkOnly) {
            return Outcome(true, true, false, current, remote, "发现新版本 $remote（checkOnly：未安装）")
        }

        val url = manifest.optString("url", "").trim().ifBlank { cfg.zipUrl(remote) }
        val tmp = File(context.cacheDir, "kernel-ota-$remote.zip")
        try {
            download(url, tmp)
        } catch (e: Throwable) {
            tmp.delete()
            return Outcome(true, true, false, current, remote, "下载失败（$url）：${e::class.java.simpleName}: ${e.message}")
        }

        val result = try {
            KernelInstaller.install(context, tmp, manifest, KernelInstaller.Source.OTA)
        } finally {
            tmp.delete()
        }
        return Outcome(
            checked = true,
            available = true,
            updated = result.ok,
            current = current,
            remote = result.version ?: remote,
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
