package io.github.lobbowen.dshmobile.kernel.adb

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * ADB 线协议纯字节层。
 *
 * 这是**不可信输入解析**：畸形长度、错误 magic、未知命令、越界 payload 都必须被拒绝。
 * 一个坏包不该让 shell 通道崩溃，更不该被当成合法消息继续往下走。
 */
class AdbProtocolTest {

    private fun le(v: Int): ByteArray = byteArrayOf(
        (v and 0xFF).toByte(), ((v ushr 8) and 0xFF).toByte(),
        ((v ushr 16) and 0xFF).toByte(), ((v ushr 24) and 0xFF).toByte(),
    )

    @Test fun 编码后解码_头部字段一致() {
        val payload = "hello".toByteArray()
        val msg = AdbProtocol.encode(AdbProtocol.Command.WRTE, 7, 9, payload)
        val h = AdbProtocol.decodeHeader(msg)
        assertEquals(AdbProtocol.Command.WRTE, h.command)
        assertEquals(7, h.arg0)
        assertEquals(9, h.arg1)
        assertEquals(5, h.dataLength)
        assertEquals(AdbProtocol.checksum(payload), h.dataChecksum)
        assertEquals(msg.size, AdbProtocol.HEADER_SIZE + 5)
    }

    @Test fun payload完整随消息携带() {
        val payload = "shell:ls\u0000".toByteArray()
        val msg = AdbProtocol.encode(AdbProtocol.Command.OPEN, 1, 0, payload)
        val tail = msg.copyOfRange(AdbProtocol.HEADER_SIZE, msg.size)
        assertArrayEquals(payload, tail)
    }

    @Test fun magic被篡改必须拒绝() {
        val msg = AdbProtocol.connect()
        msg[20] = (msg[20] + 1).toByte()
        try { AdbProtocol.decodeHeader(msg); fail("应拒绝错误 magic") }
        catch (e: AdbProtocol.MalformedException) { assertTrue(e.message!!.contains("magic")) }
    }

    @Test fun 未知命令必须拒绝() {
        val msg = AdbProtocol.encode(AdbProtocol.Command.CNXN, 0, 0, ByteArray(0))
        // 把命令改成 "XXXX"（magic 也就不再匹配，但首错应是未知命令）
        System.arraycopy("XXXX".toByteArray(), 0, msg, 0, 4)
        try { AdbProtocol.decodeHeader(msg); fail("应拒绝未知命令") }
        catch (e: AdbProtocol.MalformedException) { assertTrue(e.message!!.contains("未知命令")) }
    }

    @Test fun 头部不足必须拒绝() {
        try { AdbProtocol.decodeHeader(ByteArray(10)); fail("应拒绝短头") }
        catch (e: AdbProtocol.MalformedException) { assertTrue(e.message!!.contains("头部不足")) }
    }

    @Test fun 长度超过上限必须拒绝() {
        val msg = AdbProtocol.connect()
        System.arraycopy(le(AdbProtocol.MAX_PAYLOAD + 1), 0, msg, 12, 4)
        try { AdbProtocol.decodeHeader(msg); fail("应拒绝超长 payload") }
        catch (e: AdbProtocol.MalformedException) { assertTrue(e.message!!.contains("越界")) }
    }

    @Test fun 长度为负_必须拒绝而不是当成超大正数() {
        val msg = AdbProtocol.connect()
        System.arraycopy(le(Int.MIN_VALUE), 0, msg, 12, 4)
        try { AdbProtocol.decodeHeader(msg); fail("应拒绝负数长度") }
        catch (e: AdbProtocol.MalformedException) { assertTrue(e.message!!.contains("越界")) }
    }

    @Test fun 编码时payload超上限抛异常() {
        try {
            AdbProtocol.encode(AdbProtocol.Command.WRTE, 0, 0, ByteArray(AdbProtocol.MAX_PAYLOAD + 1))
            fail("应在编码阶段就拒绝")
        } catch (e: IllegalArgumentException) { assertTrue(e.message!!.contains("超上限")) }
    }

    @Test fun checksum是各字节无符号和() {
        // 0xFF 必须算 255 而不是 -1；否则校验和会在高位字节上出错。
        assertEquals(255, AdbProtocol.checksum(byteArrayOf(0xFF.toByte())))
        assertEquals(1 + 255 + 0, AdbProtocol.checksum(byteArrayOf(1, 0xFF.toByte(), 0)))
        assertEquals(0, AdbProtocol.checksum(ByteArray(0)))
    }

    @Test fun shell命令必须以NUL结尾() {
        // 注意：不能硬编码切片长度 —— "shell:" + "id" + NUL 是 9 字节；
        // 我第一版写成 8，恰好把要断言的 NUL 截掉了（CI 实测抓出）。
        // 改为按头部声明的 dataLength 切，并显式断言末字节为 0。
        val msg = AdbProtocol.openShell(1, "id")
        val n = AdbProtocol.decodeHeader(msg).dataLength
        val payload = msg.copyOfRange(AdbProtocol.HEADER_SIZE, AdbProtocol.HEADER_SIZE + n)
        assertEquals(9, n)
        assertEquals("shell:id\u0000", String(payload, Charsets.UTF_8))
        assertEquals("末字节必须是 NUL", 0, payload[n - 1].toInt())
    }

    @Test fun shellCommandOf往返() {
        val payload = "shell:pm list packages\u0000".toByteArray()
        assertEquals("pm list packages", AdbProtocol.shellCommandOf(payload))
        assertNull("非 shell 服务应返回 null", AdbProtocol.shellCommandOf("tcp:1234\u0000".toByteArray()))
    }

    @Test fun connect声明的版本与最大负载正确() {
        val h = AdbProtocol.decodeHeader(AdbProtocol.connect())
        assertEquals(AdbProtocol.Command.CNXN, h.command)
        assertEquals(AdbProtocol.VERSION, h.arg0)
        assertEquals(AdbProtocol.MAX_PAYLOAD, h.arg1)
    }
}
