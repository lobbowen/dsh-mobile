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
// 下载专用：单次 read 上限（不是总时长；总时长由启动预算在循环里管）、重试次数、连接超时。
// 连接超时比 manifest 的 5s 宽：弱网下 TLS+握手经常超过 5s，过紧会把它误判成失败。
private const val DOWNLOAD_READ_TIMEOUT_MS = 30_000
private const val DOWNLOAD_CONNECT_TIMEOUT_MS = 15_000
private const val DOWNLOAD_ATTEMPTS = 3

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

        // ── C3 新鲜度一：过期即拒（防"永久冻结在旧版本"）──
        val expMs = manifest.optLong("expiresEpochMs", 0L)
        if (expMs > 0L && System.currentTimeMillis() > expMs) {
            return Outcome(true, false, false, current, remote,
                "manifest 已过期（expiresEpochMs=" + expMs + "）—— 拒绝使用；检查发布流水线是否仍在签发")
        }
        // ── C3 新鲜度二：sequence 不得低于本通道已见最大值（防重放旧 manifest）──
        val seq = manifest.optLong("sequence", 0L)
        val st = loadState(context)
        val lastSeq = st.optLong("lastSequence", 0L)
        if (seq in 1..lastSeq) {
            return Outcome(true, false, false, current, remote,
                "manifest sequence=" + seq + " 不高于已见 " + lastSeq + " —— 疑似重放，拒绝")
        }

        if (current != null && km.compareKernelVersions(remote, current) <= 0) {
            return Outcome(true, false, false, current, remote, "已是最新（本地 $current，远端 $remote）")
        }
        if (checkOnly) {
            return Outcome(true, true, false, current, remote, "发现新版本 $remote（checkOnly：未安装）")
        }

        // ── C4 灰度放量：安装 ID + 版本 → 确定性分桶 ──
        // 无需后端即可灰度：同一台设备对同一版本永远落在同一个桶里（不是随机），
        // rolloutPercent=0 即"停发"。100 表示全量。
        val rollout = manifest.optInt("rolloutPercent", 100).coerceIn(0, 100)
        if (rollout < 100) {
            val bucket = Math.abs((installId(context) + ":" + remote).hashCode()) % 100
            if (bucket >= rollout) {
                return Outcome(true, true, false, current, remote,
                    "灰度未命中（bucket=" + bucket + " >= rolloutPercent=" + rollout + "）—— 本次不安装，下次启动再试")
            }
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
        val dlErr = downloadResumable(url, tmp, part, manifest.optString("sha256", "").ifBlank { null }, deadline)
        if (dlErr != null) {
            // ⚠ **绝不删 part**：已下的字节留给下次启动续传。
            // 这正是"弱网也能装上"的关键 —— 把一次大失败拆成若干次小成功。
            return Outcome(true, true, false, current, remote, "下载未完成（$url）：$dlErr")
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

    // =========================================================================
    // 下载：**断点续传 + 重试 + 完整性校验**
    // =========================================================================
    // 为什么必须做扎实：内核包 ~1.2MB。弱网下单次 GET 经常中途断，而原实现失败即删临时文件，
    // 于是**每次开机都从 0 开始** —— 网络永远「差一点点」，内核永远装不上，签名 / 版本下限 /
    // 灰度这一整套机制全都发挥不了作用。
    //
    // 四条设计决定：
    //   ① **不删半包**：下到 <name>.part；失败或预算耗尽都保留，下次用 Range 接着下。
    //   ② **预算到点就停、进度留下**：单次开机最多花 budget，进度跨启动累积。
    //   ③ **重试 + 指数退避**：瞬时抖动（连接重置 / 5xx / 提前 EOF）自动重来。
    //   ④ **收齐后校验 sha256**：不一致立即丢弃重来，绝不把「拼出来的包」交给安装器。
    //      （信任根仍是包内 ed25519 签名；sha256 防的是传输损坏与拼接错误。）
    //
    // 返回 null = 成功；非 null = 失败原因（**半包已保留**）

    private enum class Transfer { DONE, PARTIAL, FAILED }

    private fun downloadResumable(
        url: String,
        dest: File,
        part: File,
        expectedSha256: String?,
        deadline: Long,
    ): String? {
        var lastErr: String? = null
        for (attempt in 1..DOWNLOAD_ATTEMPTS) {
            if (expired(deadline)) return "启动预算耗尽；已下 " + part.length() + " 字节已保留，下次启动继续"
            val r = try {
                transferOnce(url, part, expectedSha256, deadline)
            } catch (e: Throwable) {
                lastErr = e::class.java.simpleName + ": " + (e.message ?: "")
                Transfer.FAILED
            }
            when (r) {
                Transfer.DONE -> {
                    dest.delete()
                    // 原子就位：rename 优先，跨设备才退化拷贝。
                    if (!part.renameTo(dest)) {
                        part.copyTo(dest, overwrite = true)
                        part.delete()
                    }
                    return null
                }
                Transfer.PARTIAL -> return "启动预算耗尽；已下 " + part.length() + " 字节已保留，下次启动继续"
                Transfer.FAILED -> {
                    if (attempt < DOWNLOAD_ATTEMPTS) {
                        try { Thread.sleep(minOf(500L shl (attempt - 1), 4_000L)) } catch (_: InterruptedException) { }
                    }
                }
            }
        }
        return lastErr ?: ("重试 " + DOWNLOAD_ATTEMPTS + " 次仍未完成")
    }

    private fun transferOnce(url: String, part: File, expectedSha256: String?, deadline: Long): Transfer {
        val have = if (part.isFile) part.length() else 0L
        val conn = openDownload(url)
        if (have > 0L) conn.setRequestProperty("Range", "bytes=" + have + "-")
        return try {
            when (val code = conn.responseCode) {
                // 半包 >= 服务端长度时，越界 Range 会得到 416 —— 视为「已收齐」，交给 sha256 判定。
                416 -> if (sha256Ok(part, expectedSha256)) Transfer.DONE
                       else { part.delete(); throw IllegalStateException("416 且 sha256 不符，已丢弃") }
                206 -> appendTo(conn, part, expectedSha256, deadline)   // 支持续传 → 追加
                in 200..299 -> {                                        // 不支持 Range（或首次）→ 从头写
                    part.delete()
                    appendTo(conn, part, expectedSha256, deadline)
                }
                else -> throw IllegalStateException("HTTP " + code)
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun appendTo(conn: HttpURLConnection, part: File, expectedSha256: String?, deadline: Long): Transfer {
        val total = totalBytes(conn)
        conn.inputStream.use { ins ->
            part.parentFile?.mkdirs()
            java.io.FileOutputStream(part, true).use { out ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    // 预算检查放在循环内：到点立刻停，**已写部分保留**（这就是跨启动续传）。
                    if (expired(deadline)) return Transfer.PARTIAL
                    val n = ins.read(buf)
                    if (n <= 0) break
                    out.write(buf, 0, n)
                    if (part.length() > MAX_ZIP_BYTES) throw IllegalStateException("包超过上限 ${MAX_ZIP_BYTES} 字节")
                }
                out.flush()
                try { out.fd.sync() } catch (_: Throwable) { }   // 落盘后再信 length
            }
        }
        if (part.length() <= 0L) throw IllegalStateException("下载到 0 字节")
        // 有总长信息就能判断是否提前断：提前断 → 抛错走重试（而不是把半包当完整包）。
        if (total > 0L && part.length() < total) {
            throw java.io.EOFException("提前结束 " + part.length() + "/" + total)
        }
        if (!sha256Ok(part, expectedSha256)) {
            // 最常见原因：服务端忽略了 Range 却仍回 206（或中间缓存层改写了内容）。
            // 丢弃重来 —— 绝不把可疑字节交给安装器。
            part.delete()
            throw IllegalStateException("sha256 校验未通过，已丢弃半包重下")
        }
        return Transfer.DONE
    }

    private fun sha256Ok(file: File, expected: String?): Boolean {
        val e = expected?.trim()?.lowercase().orEmpty()
        if (e.isBlank()) return true          // 无锚点时交给包内签名把关（manifest 正常都带 sha256）
        return try {
            KernelInstaller.sha256(file).equals(e, ignoreCase = true)
        } catch (_: Throwable) { false }
    }

    private fun totalBytes(conn: HttpURLConnection): Long {
        conn.getHeaderField("Content-Range")?.substringAfterLast("/")?.trim()?.toLongOrNull()?.let { if (it > 0) return it }
        return conn.getHeaderField("Content-Length")?.trim()?.toLongOrNull() ?: -1L
    }

    private fun expired(deadline: Long): Boolean = deadline > 0L && System.currentTimeMillis() > deadline

    /**
     * 下载专用连接。
     *
     * 与 [open] 的区别：超时**不再按启动预算夹逼**。预算是「总时长」约束（由 [expired] 在循环里管），
     * 而 read timeout 是「单次阻塞」约束 —— 拿 12s 的预算去夹逼它，会把「慢但在稳定传输」的连接误杀，
     * 恰好破坏续传要解决的问题。
     *
     * 另外显式声明 Accept-Encoding: identity：若中间层做了压缩，Range 偏移会指向压缩流的位置，
     * 续传拼出来的包必然损坏。
     */
    private fun openDownload(url: String): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = DOWNLOAD_CONNECT_TIMEOUT_MS
            readTimeout = DOWNLOAD_READ_TIMEOUT_MS
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "dsh-kernel-ota")
            setRequestProperty("Accept-Encoding", "identity")
        }
}
