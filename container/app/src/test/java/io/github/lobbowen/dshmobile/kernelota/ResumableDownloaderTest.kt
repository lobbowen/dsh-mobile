package io.github.lobbowen.dshmobile.kernelota

import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * [ResumableDownloader] 的分支测试。
 *
 * 为什么自己写一个极小的 HTTP 服务（而不是 com.sun.net.httpserver / MockWebServer）：
 *   ① Android 单元测试的编译 classpath 里**没有** com.sun.net.httpserver（它是 JDK 的非默认
 *      模块 jdk.httpserver）—— 实测直接报 Unresolved reference com。
 *   ② 目标是真实地跑 HttpURLConnection 的 Range / 206 / 416 / 提前断语义。
 *      自己用 ServerSocket 写，能精确控制**状态码、Content-Range、以及"声明长度与实际写入
 *      字节数不一致"**这类真实网络里才会出现的异常，比现成的测试服务器控制力更强。
 *   ③ 只用 java.* （android.jar 必带），零额外依赖。
 */
class ResumableDownloaderTest {

    private lateinit var http: MiniHttp
    private lateinit var dir: File

    /** ~293KB 确定性内容：足够跨越多次 64KB read，便于触发预算/中断分支。 */
    private val body = ByteArray(300_000) { (it % 251).toByte() }
    private val bodySha: String get() = shaOf(body)

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("dsh-dl").toFile()
    }

    @After
    fun tearDown() {
        // 不是每个用例都需要 HTTP 服务（例如纯函数的退避序列用例），
        // 所以必须守卫，否则 lateinit 未初始化会在 tearDown 抛异常 ——
        // 表现为「测试失败」，但真正失败的其实是夹具自己（本轮实测踩过）。
        if (::http.isInitialized) http.stop()
        dir.deleteRecursively()
    }

    // ---------- 测试用的极小 HTTP 服务 ----------

    /**
     * 单次响应。
     * @param declaredLength 声明在 Content-Length 里的长度（默认=body.size）
     * @param writeBytes     实际写入的字节数（默认=body.size）。故意小于声明值即可模拟"提前断"。
     */
    private data class Resp(
        val code: Int,
        val body: ByteArray = ByteArray(0),
        val headers: Map<String, String> = emptyMap(),
        val declaredLength: Long = -1L,
        val writeBytes: Int = -1,
    )

    private class MiniHttp(private val handler: (Map<String, String>) -> Resp) {
        private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        val port: Int get() = server.localPort
        val seenRanges = java.util.Collections.synchronizedList(mutableListOf<String>())

        init {
            Thread {
                while (!server.isClosed) {
                    val sock = try { server.accept() } catch (_: Throwable) { break }
                    Thread { serve(sock) }.apply { isDaemon = true }.start()
                }
            }.apply { isDaemon = true }.start()
        }

        private fun serve(sock: java.net.Socket) {
            try {
                sock.use { s ->
                    val ins = s.getInputStream()
                    val out = s.getOutputStream()
                    val heads = mutableListOf<String>()
                    while (true) {
                        val line = readLine(ins) ?: break
                        if (line.isEmpty()) break
                        heads.add(line)
                    }
                    val hdrs = heads.drop(1).mapNotNull { l ->
                        val i = l.indexOf(':')
                        if (i > 0) l.substring(0, i).trim().lowercase() to l.substring(i + 1).trim() else null
                    }.toMap()
                    seenRanges.add(hdrs["range"] ?: "-")
                    val resp = handler(hdrs)
                    writeResponse(out, resp)
                }
            } catch (_: Throwable) { }
        }

        private fun writeResponse(out: OutputStream, r: Resp) {
            val reason = when (r.code) { 200 -> "OK"; 206 -> "Partial Content"; 416 -> "Range Not Satisfiable"; 500 -> "Internal Server Error"; else -> "Status" }
            val sb = StringBuilder()
            sb.append("HTTP/1.1 ").append(r.code).append(' ').append(reason).append("\r\n")
            r.headers.forEach { (k, v) -> sb.append(k).append(": ").append(v).append("\r\n") }
            val declared = if (r.declaredLength >= 0) r.declaredLength else r.body.size.toLong()
            sb.append("Content-Length: ").append(declared).append("\r\n")
            sb.append("Connection: close\r\n\r\n")
            out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
            val n = if (r.writeBytes >= 0) r.writeBytes else r.body.size
            if (n > 0) out.write(r.body, 0, n)
            out.flush()
        }

        private fun readLine(ins: InputStream): String? {
            val sb = StringBuilder()
            while (true) {
                val c = ins.read()
                if (c < 0) return if (sb.isEmpty()) null else sb.toString()
                if (c == '\n'.code) return sb.toString().removeSuffix("\r")
                sb.append(c.toChar())
            }
        }

        fun stop() { try { server.close() } catch (_: Throwable) { } }
    }

    private fun start(handler: (Map<String, String>) -> Resp) { http = MiniHttp(handler) }

    /** 正确实现 Range 的服务端。 */
    private fun startWithRangeSupport() = start { h ->
        val range = h["range"]
        val start = range?.removePrefix("bytes=")?.removeSuffix("-")?.toIntOrNull() ?: 0
        when {
            start <= 0 -> Resp(200, body)
            start >= body.size -> Resp(416)
            else -> Resp(
                206,
                body.copyOfRange(start, body.size),
                mapOf("Content-Range" to ("bytes " + start + "-" + (body.size - 1) + "/" + body.size)),
            )
        }
    }

    private fun url() = "http://127.0.0.1:" + http.port + "/k.zip"
    private fun dest() = File(dir, "k.zip")
    private fun part() = File(dir, "k.zip.part")

    private fun shaOf(b: ByteArray): String {
        val f = File(dir, "sha-tmp"); f.writeBytes(b)
        val s = ResumableDownloader.sha256(f); f.delete(); return s
    }

    private fun now0() = { 0L }

    // ---------- 用例 ----------

    @Test fun 完整下载_落盘且半包消失() {
        startWithRangeSupport()
        val r = ResumableDownloader.download(url(), dest(), part(), bodySha, 0L, now = now0())
        assertEquals(ResumableDownloader.Result.DONE, r.result)
        assertNull(r.detail)
        assertTrue(dest().isFile)
        assertEquals(bodySha, ResumableDownloader.sha256(dest()))
        assertFalse("半包应已被 rename 掉", part().exists())
    }

    @Test fun 断点续传_带Range且只取剩余部分() {
        startWithRangeSupport()
        val have = 100_000
        part().writeBytes(body.copyOfRange(0, have))       // 模拟上次下到一半
        val r = ResumableDownloader.download(url(), dest(), part(), bodySha, 0L, now = now0())
        assertEquals(ResumableDownloader.Result.DONE, r.result)
        assertEquals(bodySha, ResumableDownloader.sha256(dest()))
        assertEquals("应恰好请求剩余部分", "bytes=" + have + "-", http.seenRanges.first())
    }

    @Test fun 服务端忽略Range_安全从头写而不是拼重复() {
        start { Resp(200, body) }                          // 无视 Range，总是整包
        part().writeBytes(ByteArray(50_000) { 1 })          // 半包内容是垃圾
        val r = ResumableDownloader.download(url(), dest(), part(), bodySha, 0L, now = now0())
        assertEquals(ResumableDownloader.Result.DONE, r.result)
        assertEquals("长度必须等于整包（不能是 50k+300k）", body.size.toLong(), dest().length())
        assertEquals(bodySha, ResumableDownloader.sha256(dest()))
    }

    @Test fun 提前断_重试后成功() {
        var calls = 0
        start { _ ->
            calls++
            if (calls == 1) Resp(200, body, writeBytes = body.size / 2)   // 声明整包，只写一半
            else Resp(200, body)
        }
        val r = ResumableDownloader.download(url(), dest(), part(), bodySha, 0L, sleep = {}, now = now0())
        assertEquals(ResumableDownloader.Result.DONE, r.result)
        assertEquals(bodySha, ResumableDownloader.sha256(dest()))
        assertTrue("应至少重试过一次", calls >= 2)
    }

    @Test fun 重试耗尽_返回失败() {
        start { Resp(500, "boom".toByteArray()) }
        val r = ResumableDownloader.download(url(), dest(), part(), bodySha, 0L, attempts = 2, sleep = {}, now = now0())
        assertEquals(ResumableDownloader.Result.FAILED, r.result)
        assertNotNull(r.detail)
        assertFalse("失败不应产出 dest", dest().exists())
    }

    @Test fun sha不符_丢弃重下且不落盘() {
        startWithRangeSupport()
        val r = ResumableDownloader.download(url(), dest(), part(), "deadbeef".repeat(8), 0L, attempts = 2, sleep = {}, now = now0())
        assertEquals(ResumableDownloader.Result.FAILED, r.result)
        assertFalse("sha 不符绝不能落盘", dest().exists())
        assertFalse("半包也应被丢弃（内容可疑）", part().exists())
    }

    @Test fun 预算耗尽_返回PARTIAL且已下字节保留() {
        startWithRangeSupport()
        var n = 0
        val now = { if (n++ < 2) 0L else 99_999L }     // 第 2 次检查即过期
        val r = ResumableDownloader.download(url(), dest(), part(), bodySha, 1_000L, now = now)
        assertEquals(ResumableDownloader.Result.PARTIAL, r.result)
        assertTrue("必须保留已下部分（跨启动续传的基础）", part().length() > 0L)
        assertFalse("未收齐不应产出 dest", dest().exists())
    }

    @Test fun 半包已完整且服务端回416_视为完成() {
        start { Resp(416) }
        part().writeBytes(body)                        // 上次其实已下完，只是没来得及改名
        val r = ResumableDownloader.download(url(), dest(), part(), bodySha, 0L, now = now0())
        assertEquals(ResumableDownloader.Result.DONE, r.result)
        assertEquals(bodySha, ResumableDownloader.sha256(dest()))
    }

    @Test fun 请求显式声明identity编码() {
        var ae: String? = null
        start { h -> ae = h["accept-encoding"]; Resp(200, body) }
        ResumableDownloader.download(url(), dest(), part(), bodySha, 0L, now = now0())
        assertEquals("identity", ae)
    }

    @Test fun 退避序列递增且有上限() {
        assertEquals(500L, ResumableDownloader.delayFor(1))
        assertEquals(1_000L, ResumableDownloader.delayFor(2))
        assertEquals(2_000L, ResumableDownloader.delayFor(3))
        assertEquals(4_000L, ResumableDownloader.delayFor(9))
    }
}
