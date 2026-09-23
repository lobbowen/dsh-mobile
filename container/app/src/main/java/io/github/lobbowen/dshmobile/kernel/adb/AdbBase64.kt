package io.github.lobbowen.dshmobile.kernel.adb

/**
 * 标准 Base64（带 padding）编码。
 *
 * 为什么不用现成的：
 *   · `java.util.Base64` 需要 API 26，而本 APK 的 minSdk 是 24 —— 直接用它会在
 *     Android 7.0/7.1 上抛 NoClassDefFoundError，属于潜伏缺陷；
 *   · `android.util.Base64` 只能在真机跑，进不了 JVM 单测。
 * 自己实现后，编解码是纯函数，可以在 CI 里逐边界钉死。
 *
 * ADB 公钥串用的就是标准字母表（BoringSSL `EVP_EncodeBlock` 的输出），无换行。
 */
internal object AdbBase64 {

    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

    fun encode(bytes: ByteArray): String {
        val out = StringBuilder((bytes.size + 2) / 3 * 4)
        var i = 0
        // 完整的三字节组：每 3 字节 → 4 个字符。
        while (i + 3 <= bytes.size) {
            val n = ((bytes[i].toInt() and 0xFF) shl 16) or
                ((bytes[i + 1].toInt() and 0xFF) shl 8) or
                (bytes[i + 2].toInt() and 0xFF)
            out.append(ALPHABET[(n ushr 18) and 0x3F])
            out.append(ALPHABET[(n ushr 12) and 0x3F])
            out.append(ALPHABET[(n ushr 6) and 0x3F])
            out.append(ALPHABET[n and 0x3F])
            i += 3
        }
        // 尾巴：补 0 凑满 24 位，缺的字符用 '=' 占位。524 字节会落到 r=2 这一支。
        when (bytes.size - i) {
            1 -> {
                val n = (bytes[i].toInt() and 0xFF) shl 16
                out.append(ALPHABET[(n ushr 18) and 0x3F])
                out.append(ALPHABET[(n ushr 12) and 0x3F])
                out.append("==")
            }
            2 -> {
                val n = ((bytes[i].toInt() and 0xFF) shl 16) or ((bytes[i + 1].toInt() and 0xFF) shl 8)
                out.append(ALPHABET[(n ushr 18) and 0x3F])
                out.append(ALPHABET[(n ushr 12) and 0x3F])
                out.append(ALPHABET[(n ushr 6) and 0x3F])
                out.append('=')
            }
        }
        return out.toString()
    }
}
