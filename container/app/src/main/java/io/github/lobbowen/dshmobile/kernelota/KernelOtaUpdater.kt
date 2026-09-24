package io.github.lobbowen.dshmobile.kernelota

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/**
 * 远端内核 OTA 的**能力本体**：查 feed → 比较版本 → （可选）下载 → 校验 → 安装。
 *
 * 触发方式：
 *   · **默认自动** —— `kernel-feed.json` 的 `autoCheck` 缺省即 true，启动链主动检测并升级；
 *     置 false 后启动链不检查，稳定态无意外动作，手动入口仍在
 *     （面板按钮 dsh:kernel-update-request / 桥方法 build.kernelInstall）。
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
        /** 解析后的滚动 tag：`kernel-<channel>`，或被 kernel-feed.json 的 releaseTag 显式覆盖（调试用）。 */
        val releaseTag: String,
        val channel: String,
        val manifestName: String,
        val autoCheck: Boolean,
        /** 启动链的**总预算**：超时就放弃本次升级（下次启动/手动再试），绝不拖住开机。0=不限。 */
        val startupBudgetMs: Long,
    ) {
        /**
     * manifest 的 URL。**刻意带 cache-buster**。
     *
     * 实测教训（2026-09-24）：CDN 会把 manifest 缓存在**边缘**。一次探针上传（未带 Cache-Control）
     * 之后，即使源站已换成真实 manifest，读到的仍是旧的 —— 表现为「发了但设备没更新」。
     * manifest 只有 ~1KB，每次回源代价可忽略；而"读到陈旧 manifest"的代价是整条更新链静默失效。
     * 内核包则相反：文件名带版本号、内容不可变，可长缓存、可断点续传。
     */
    val manifestUrl: String get() = "$baseUrl/$releaseTag/$manifestName?t=${System.currentTimeMillis()}"
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
        val channel = o.optString("channel", "stable").trim().ifBlank { "stable" }
        // releaseTag 显式覆盖优先（调试用）；否则由通道推导 —— 通道是投递语义，版本号不是。
        val override = o.optString("releaseTag", "").trim()
        val tag = if (override.isNotBlank()) override else "kernel-" + channel
        val name = o.optString("manifestName", "kernel-manifest.json").trim().ifBlank { "kernel-manifest.json" }
        val auto = o.optBoolean("autoCheck", true)
        val budget = o.optLong("startupBudgetMs", 12000L)
        if (!base.startsWith("https://")) null else Config(base, tag, channel, name, auto, budget)
    } catch (e: Throwable) {
        Log.w(TAG, "kernel-feed.json 不可用: ${e.message}")
        null
    }

    /**
     * 查一次；[checkOnly] 为 true 时**只报告不安装**。
     * **永不抛异常** —— 调用方可能是启动链或桥方法，必须总能拿到结果。
     */
    fun checkAndUpdate(
        context: Context,
        km: KernelManager,
        checkOnly: Boolean = false,
        budgetMs: Long = 0L,
    ): Outcome {
        val deadline = if (budgetMs > 0L) System.currentTimeMillis() + budgetMs else 0L
        fun left(): Long = if (deadline == 0L) Long.MAX_VALUE else deadline - System.currentTimeMillis()
        val cfg = loadConfig(context)
            ?: return Outcome(false, false, false, km.currentVersion(), null, "未配置 kernel-feed.json（远端 OTA 关闭）")

        val current = km.currentVersion()
        val manifestText = try {
            httpGetText(cfg.manifestUrl, MAX_MANIFEST_BYTES, left())
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

        // ── 准入判定：**纯逻辑**，见 kernel/OtaPolicy（五条规则各有单测）──
        // 顺序即语义：过期 → 重放 → 是否更新 → 只检查 → 版本下限 → 灰度。
        val seq = manifest.optLong("sequence", 0L)
        val st = loadState(context)
        val verdict = OtaPolicy.evaluate(
            OtaPolicy.Input(
                remoteVersion = remote,
                currentVersion = current,
                floorVersion = km.floorVersion(),
                expiresEpochMs = manifest.optLong("expiresEpochMs", 0L),
                sequence = seq,
                lastSequence = st.optLong("lastSequence", 0L),
                rolloutPercent = manifest.optInt("rolloutPercent", 100),
                installId = installId(context),
                nowMs = System.currentTimeMillis(),
            ),
            checkOnly = checkOnly,
        )
        when (verdict) {
            is OtaPolicy.Verdict.Reject -> return Outcome(true, false, false, current, remote, verdict.message)
            is OtaPolicy.Verdict.UpToDate -> return Outcome(true, false, false, current, remote, verdict.message)
            is OtaPolicy.Verdict.Available -> return Outcome(true, true, false, current, remote, verdict.message)
            is OtaPolicy.Verdict.Holdback -> return Outcome(true, true, false, current, remote, verdict.message)
            OtaPolicy.Verdict.Install -> Unit
        }

        // 启动预算用完就**不下载**：宁可下次启动再升，也不把开机拖住。
        if (left() <= 0L) {
            return Outcome(true, true, false, current, remote, "启动预算已耗尽（${budgetMs}ms）：本次不下载，下次启动或手动触发重试")
        }
        val url = manifest.optString("url", "").trim().ifBlank { cfg.zipUrl(remote) }
        val tmp = File(context.cacheDir, "kernel-ota-$remote.zip")
        // 半包用**独立文件名**并跨启动保留：下次从 Range 断点接着下（见 downloadResumable）。
        val part = File(context.cacheDir, "kernel-ota-$remote.zip.part")
        // 把 manifest **原样**落盘：签名是对原始字节的规范化 JSON 做的，
        // 只有原始内容才能通过验签（重新序列化会改变 key 顺序 —— canonical 会排序，
        // 所以严格说也行，但"原样"能顺带发现传输/解析层的意外改动）。
        val manifestFile = File(context.cacheDir, "kernel-manifest-ota.json")
        try { manifestFile.writeText(manifestText) } catch (_: Throwable) { }
        val dl = ResumableDownloader.download(
            url = url,
            dest = tmp,
            part = part,
            expectedSha256 = manifest.optString("sha256", "").ifBlank { null },
            deadline = deadline,
            // 显式传上限：sha256 已能挡内容造假，但大小上限防的是「恶意/异常大响应
            // 灌满缓存区」—— 上限的归属应是调用方策略，而非下载器的默认值巧合。
            maxBytes = MAX_ZIP_BYTES,
        )
        if (dl.result != ResumableDownloader.Result.DONE) {
            // ⚠ **绝不删 part**：已下的字节留给下次启动续传。
            // 这正是"弱网也能装上"的关键 —— 把一次大失败拆成若干次小成功。
            return Outcome(true, true, false, current, remote, "下载未完成（$url）：${dl.detail ?: dl.result}")
        }

        val result = try {
            KernelInstaller.install(
                context, tmp, manifest, KernelInstaller.Source.OTA, manifestFile = manifestFile,
            )
        } finally {
            tmp.delete()
            manifestFile.delete()
        }
        // 安装成功才推进 sequence 水位：失败不推进，下次仍可重试同一个 sequence。
        if (result.ok && seq > 0L) {
            st.put("lastSequence", seq)
            saveState(context, st)
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

    // ---- 通道状态（sequence 水位 + 安装 ID）----
    // 为什么必须落盘：sequence 水位要**跨启动**记住，否则重放旧 manifest 每次都能通过；
    // 安装 ID 要稳定，否则灰度分桶每次重启都换桶 —— "灰度"就退化成随机。

    private fun stateFile(context: Context) = File(context.filesDir, "kernel-feed-state.json")

    private fun loadState(context: Context): JSONObject =
        try { JSONObject(stateFile(context).readText()) } catch (_: Throwable) { JSONObject() }

    private fun saveState(context: Context, o: JSONObject) {
        try { stateFile(context).writeText(o.toString()) } catch (_: Throwable) { }
    }

    private fun installId(context: Context): String {
        val st = loadState(context)
        val id = st.optString("installId", "")
        if (id.isNotBlank()) return id
        val gen = java.util.UUID.randomUUID().toString()
        st.put("installId", gen)
        saveState(context, st)
        return gen
    }

    /** [budgetMs] <= 0 用默认超时；否则夹逼到 [1s, 默认] —— 预算就是硬上限。 */
    private fun open(url: String, budgetMs: Long): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            val cap = if (budgetMs <= 0L) Long.MAX_VALUE else budgetMs.coerceAtLeast(1_000L)
            connectTimeout = minOf(CONNECT_TIMEOUT_MS.toLong(), cap).toInt()
            readTimeout = minOf(READ_TIMEOUT_MS.toLong(), cap).toInt()
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "dsh-kernel-ota")
        }

    private fun httpGetText(url: String, maxBytes: Int, budgetMs: Long): String {
        val conn = open(url, budgetMs)
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

}
