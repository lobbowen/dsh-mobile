package io.github.lobbowen.dshmobile.kernel.adb

/**
 * ADB 线协议的**纯字节层** —— 不碰 socket，因此完全可单测。
 *
 * 为什么单独成层且必须单测：
 *   我们决定**自带 ADB 客户端**作为唯一的特权 shell 通道（不再依赖 Shizuku）。
 *   而 ADB 报文解析属于**不可信输入解析** —— 畸形长度、错误 magic、越界 payload
 *   都必须被拒绝，否则一个坏包就能让 shell 通道崩溃。这一层不依赖真机，等价纯函数，
 *   正好能在 CI 里逐分支钉住。
 *
 * 线格式（每条消息 = 24 字节头 + payload）：
 *   command(4 ASCII) | arg0(LE u32) | arg1(LE u32) | dataLength(LE u32)
 *   | dataChecksum(LE u32) | magic(LE u32 = command xor 0xFFFFFFFF)
 *
 * 参考 ADB 协议文档（Apache-2.0）。这里是**独立实现**，未复制任何代码。
 */
object AdbProtocol {

    const val HEADER_SIZE = 24
    const val MAX_PAYLOAD = 256 * 1024
    const val VERSION = 0x01000000

    const val AUTH_TOKEN = 1
    const val AUTH_SIGNATURE = 2
    const val AUTH_RSAPUBLICKEY = 3

    enum class Command(val wire: String) {
        CNXN("CNXN"), AUTH("AUTH"), OPEN("OPEN"), OKAY("OKAY"), CLSE("CLSE"), WRTE("WRTE");

        companion object {
            /** 未知命令返回 null —— 调用方必须显式处理，不能默认当成某个已知命令。 */
            fun fromWire(s: String): Command? = values().firstOrNull { it.wire == s }
        }
    }

    data class Header(
        val command: Command,
        val arg0: Int,
        val arg1: Int,
        val dataLength: Int,
        val dataChecksum: Int,
    )

    class MalformedException(message: String) : Exception(message)

    private fun wireToInt(s: String): Int {
        require(s.length == 4) { "命令必须恰好 4 字节" }
        return (s[0].code and 0xFF) or ((s[1].code and 0xFF) shl 8) or
            ((s[2].code and 0xFF) shl 16) or ((s[3].code and 0xFF) shl 24)
    }

    private fun Int.toLe(): ByteArray = byteArrayOf(
        (this and 0xFF).toByte(),
        ((this ushr 8) and 0xFF).toByte(),
        ((this ushr 16) and 0xFF).toByte(),
        ((this ushr 24) and 0xFF).toByte(),
    )

    private fun readLe(b: ByteArray, off: Int): Int =
        (b[off].toInt() and 0xFF) or ((b[off + 1].toInt() and 0xFF) shl 8) or
            ((b[off + 2].toInt() and 0xFF) shl 16) or ((b[off + 3].toInt() and 0xFF) shl 24)

    /** ADB 校验和：payload 各字节按无符号相加（32 位回绕）。 */
    fun checksum(payload: ByteArray, length: Int = payload.size): Int {
        var sum = 0
        for (i in 0 until length) sum += (payload[i].toInt() and 0xFF)
        return sum
    }

    /** 解析 24 字节头；任何不自洽之处都抛 [MalformedException]。 */
    fun decodeHeader(bytes: ByteArray, offset: Int = 0): Header {
        if (bytes.size - offset < HEADER_SIZE) {
            throw MalformedException("头部不足 " + HEADER_SIZE + " 字节（实际 " + (bytes.size - offset) + "）")
        }
        val wire = String(bytes, offset, 4, Charsets.US_ASCII)
        val command = Command.fromWire(wire) ?: throw MalformedException("未知命令: " + wire)
        val dataLength = readLe(bytes, offset + 12)
        val magic = readLe(bytes, offset + 20)
        // 长度必须夹在 [0, MAX_PAYLOAD]：负数（符号位被置）同样要拒绝。
        if (dataLength < 0 || dataLength > MAX_PAYLOAD) {
            throw MalformedException("payload 长度越界: " + dataLength)
        }
        if (magic != (wireToInt(command.wire) xor -0x1)) {
            throw MalformedException("magic 不符（命令 " + command.wire + "）")
        }
        return Header(command, readLe(bytes, offset + 4), readLe(bytes, offset + 8), dataLength, readLe(bytes, offset + 16))
    }

    /** 组装完整消息（头 + payload）。 */
    fun encode(command: Command, arg0: Int, arg1: Int, payload: ByteArray): ByteArray {
        if (payload.size > MAX_PAYLOAD) throw IllegalArgumentException("payload 超上限: " + payload.size)
        val out = ByteArray(HEADER_SIZE + payload.size)
        System.arraycopy(command.wire.toByteArray(Charsets.US_ASCII), 0, out, 0, 4)
        System.arraycopy(arg0.toLe(), 0, out, 4, 4)
        System.arraycopy(arg1.toLe(), 0, out, 8, 4)
        System.arraycopy(payload.size.toLe(), 0, out, 12, 4)
        System.arraycopy(checksum(payload).toLe(), 0, out, 16, 4)
        System.arraycopy((wireToInt(command.wire) xor -0x1).toLe(), 0, out, 20, 4)
        System.arraycopy(payload, 0, out, HEADER_SIZE, payload.size)
        return out
    }

    fun connect(maxPayload: Int = MAX_PAYLOAD, banner: String = "host::features=shell_v2"): ByteArray =
        encode(Command.CNXN, VERSION, maxPayload, (banner + "\u0000").toByteArray(Charsets.UTF_8))

    fun auth(subType: Int, body: ByteArray): ByteArray = encode(Command.AUTH, subType, 0, body)

    /**
     * OPEN 一个 shell 服务。
     * 服务名**必须以 NUL 结尾**；缺了它服务端会当成未知服务而回 CLSE。
     */
    fun openShell(localId: Int, command: String): ByteArray =
        encode(Command.OPEN, localId, 0, ("shell:" + command + "\u0000").toByteArray(Charsets.UTF_8))

    fun simple(command: Command, localId: Int, remoteId: Int): ByteArray =
        encode(command, localId, remoteId, ByteArray(0))

    /** 从 shell 请求里取回命令原文（自测与日志用）。 */
    fun shellCommandOf(payload: ByteArray): String? {
        val s = String(payload, Charsets.UTF_8).trimEnd('\u0000')
        return if (s.startsWith("shell:")) s.removePrefix("shell:") else null
    }
}
