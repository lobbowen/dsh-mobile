package io.github.lobbowen.dshmobile.kernelota

import java.io.EOFException
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * 断点续传下载器 —— **纯 JVM，不依赖任何 Android API**。
 *
 * 为什么单独成类（而不是留在 KernelOtaUpdater 里）：
 *   下载是内核 OTA 里**最容易失败**的一环（弱网），也是最值得逐分支验证的逻辑。
 *   做成纯 JVM 后可以用 JUnit 直接测：配合 JDK 自带的 com.sun.net.httpserver.HttpServer
 *   起本地服务，就能真实覆盖 Range 续传 / 416 / 提前断 / sha256 不符 等分支，
 *   不需要 MockWebServer 之类的额外依赖。
 *
 * 四条设计决定：
 *   ① **绝不删半包**：下到 part；失败或预算耗尽都保留，下次用 Range 接着下。
 *      （旧实现失败即删，导致每次开机都从 0 开始 —— 弱网下内核永远装不上。）
 *   ② **预算到点就停、进度留下**：单次调用最多花 deadline，进度跨调用累积。
 *   ③ **重试 + 指数退避**：瞬时抖动（连接重置 / 5xx / 提前 EOF）自动重来。
 *   ④ **收齐后校验 sha256**：不一致立即丢弃重来，绝不把可疑字节交给安装器。
 *      （信任根仍是包内 ed25519 签名；sha256 防的是传输损坏与拼接错误。）
 */
object ResumableDownloader {

    /** 单次阻塞的上限。注意：约束的是「单次 read」，**不是总时长**（总时长由 deadline 管）。 */
    const val CONNECT_TIMEOUT_MS = 15_000
    const val READ_TIMEOUT_MS = 30_000
    const val MAX_BYTES = 32L * 1024 * 1024
    const val DEFAULT_ATTEMPTS = 3

    enum class Result { DONE, PARTIAL, FAILED }

    /** 半包后缀：命名规则的唯一出处。调用方一律 `dest.name + PART_SUFFIX`，
     *  自检/清扫一律问 [isPartialFile] —— 别处再手写一次 `.part` 就是第二把尺子，
     *  改一次名就有一个判据静默失配（真机案底：`$PREFIX` 的字面量漂移）。 */
    const val PART_SUFFIX = ".part"

    /** 这个名字是不是半包。只看文件名、不碰磁盘，所以自检采事实时不必再拼一次后缀。 */
    fun isPartialFile(name: String): Boolean = name.endsWith(PART_SUFFIX)

    data class Outcome(val result: Result, val detail: String?, val partBytes: Long)

    fun download(
        url: String,
        dest: File,
        part: File,
        expectedSha256: String?,
        deadline: Long,
        attempts: Int = DEFAULT_ATTEMPTS,
        maxBytes: Long = MAX_BYTES,
        connectTimeoutMs: Int = CONNECT_TIMEOUT_MS,
        readTimeoutMs: Int = READ_TIMEOUT_MS,
        sleep: (Long) -> Unit = { Thread.sleep(it) },
        now: () -> Long = { System.currentTimeMillis() },
    ): Outcome {
        var lastErr: String? = null
        for (attempt in 1..attempts) {
            if (expired(deadline, now)) return partial(part, budgetDetail(part))
            val r = try {
                transferOnce(url, part, expectedSha256, deadline, maxBytes, connectTimeoutMs, readTimeoutMs, now)
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
                    return Outcome(Result.DONE, null, dest.length())
                }
                Transfer.PARTIAL -> return partial(part, budgetDetail(part))
                Transfer.FAILED -> if (attempt < attempts) {
                    try { sleep(delayFor(attempt)) } catch (_: InterruptedException) { }
                }
            }
        }
        return Outcome(Result.FAILED, lastErr ?: ("重试 " + attempts + " 次仍未完成，半包已保留"), part.length())
    }

    /** 退避：0.5s → 1s → 2s，上限 4s。抽成函数是为了让测试不必真的等待。 */
    fun delayFor(attempt: Int): Long = minOf(500L shl (attempt - 1), 4_000L)

    private enum class Transfer { DONE, PARTIAL, FAILED }

    private fun partial(part: File, detail: String) = Outcome(Result.PARTIAL, detail, part.length())

    private fun budgetDetail(part: File) = "启动预算耗尽；已下 " + part.length() + " 字节已保留，下次启动继续"

    private fun expired(deadline: Long, now: () -> Long): Boolean = deadline > 0L && now() > deadline

    private fun transferOnce(
        url: String, part: File, expectedSha256: String?, deadline: Long,
        maxBytes: Long, connectTimeoutMs: Int, readTimeoutMs: Int, now: () -> Long,
    ): Transfer {
        val have = if (part.isFile) part.length() else 0L
        val conn = open(url, connectTimeoutMs, readTimeoutMs)
        if (have > 0L) conn.setRequestProperty("Range", "bytes=" + have + "-")
        return try {
            when (val code = conn.responseCode) {
                // 半包 >= 服务端长度时越界 Range 会得到 416 —— 视为「已收齐」，交给 sha256 判定。
                416 -> if (sha256Ok(part, expectedSha256)) Transfer.DONE
                       else { part.delete(); throw IllegalStateException("416 且 sha256 不符，已丢弃") }
                206 -> appendTo(conn, part, expectedSha256, deadline, maxBytes, now)
                in 200..299 -> {
                    // 服务端不支持/忽略了 Range：安全回退，从头写（丢弃半包，避免拼接重复）。
                    part.delete()
                    appendTo(conn, part, expectedSha256, deadline, maxBytes, now)
                }
                else -> throw IllegalStateException("HTTP " + code)
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun appendTo(
        conn: HttpURLConnection, part: File, expectedSha256: String?,
        deadline: Long, maxBytes: Long, now: () -> Long,
    ): Transfer {
        val total = totalBytes(conn)
        conn.inputStream.use { ins ->
            part.parentFile?.mkdirs()
            FileOutputStream(part, true).use { out ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    // 预算检查放在循环内：到点立刻停，**已写部分保留** —— 这就是跨启动续传。
                    if (expired(deadline, now)) return Transfer.PARTIAL
                    val n = ins.read(buf)
                    if (n <= 0) break
                    out.write(buf, 0, n)
                    if (part.length() > maxBytes) throw IllegalStateException("包超过上限 " + maxBytes + " 字节")
                }
                out.flush()
                try { out.fd.sync() } catch (_: Throwable) { }   // 落盘后再信 length
            }
        }
        if (part.length() <= 0L) throw IllegalStateException("下载到 0 字节")
        // 有总长就能判断「是否提前断」：提前断 → 抛错走重试（而不是把半包当完整包）。
        if (total > 0L && part.length() < total) throw EOFException("提前结束 " + part.length() + "/" + total)
        if (!sha256Ok(part, expectedSha256)) {
            // 最常见原因：服务端忽略了 Range 却仍回 206（或中间缓存层改写了内容）。
            // 丢弃重来 —— 绝不把可疑字节交给安装器。
            part.delete()
            throw IllegalStateException("sha256 校验未通过，已丢弃半包重下")
        }
        return Transfer.DONE
    }

    fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { ins ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = ins.read(buf)
                if (n <= 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    private fun sha256Ok(file: File, expected: String?): Boolean {
        val e = expected?.trim()?.lowercase().orEmpty()
        if (e.isBlank()) return true          // 无锚点时交给包内签名把关（manifest 正常都带 sha256）
        return try { sha256(file).equals(e, ignoreCase = true) } catch (_: Throwable) { false }
    }

    private fun totalBytes(conn: HttpURLConnection): Long {
        conn.getHeaderField("Content-Range")?.substringAfterLast("/")?.trim()?.toLongOrNull()?.let { if (it > 0) return it }
        return conn.getHeaderField("Content-Length")?.trim()?.toLongOrNull() ?: -1L
    }

    /**
     * 连接。显式声明 Accept-Encoding: identity：
     * 若中间层做了压缩，Range 偏移会指向**压缩流**的位置，续传拼出来的包必然损坏。
     */
    private fun open(url: String, connectTimeoutMs: Int, readTimeoutMs: Int): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "dsh-kernel-ota")
            setRequestProperty("Accept-Encoding", "identity")
        }
}
