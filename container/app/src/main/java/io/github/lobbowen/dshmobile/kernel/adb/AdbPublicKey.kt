package io.github.lobbowen.dshmobile.kernel.adb

import java.math.BigInteger

/**
 * Android 的 RSA 公钥二进制格式 —— 纯数学，不依赖 Android，因此完全可单测。
 *
 * 为什么必须自己实现：
 *   我们自带的 ADB 客户端要在 `AUTH(RSAPUBLICKEY)` 里把公钥交给 adbd，而 adbd 只认
 *   Android 自己的紧凑格式（**不是** DER/PEM）。格式写错的后果不是"报错"，而是服务端
 *   **静默无法识别密钥**：表现为每次都弹授权、授权了也没用，现场极难定位。
 *
 * 格式（`system/core/libcrypto_utils/android_pubkey.cpp`，Apache-2.0；此处独立实现）：
 *
 *   struct RSAPublicKey {
 *     uint32_t modulus_size_words;   // 词数：2048 位 = 64
 *     uint32_t n0inv;                // -1 / n[0] mod 2^32（Montgomery 预计算）
 *     uint8_t  modulus[256];         // 模数，**小端**
 *     uint8_t  rr[256];              // R^2 mod n，R = 2^2048，**小端**
 *     uint32_t exponent;             // 3 或 65537
 *   };   // 3*4 + 2*256 = 524 字节
 *
 * 两处最容易写错、也最难现场定位的地方：
 *   ① 所有多字节字段都是**小端**（Android 只支持小端处理器，直接按内存布局发）；
 *   ② n0inv / rr 是预计算的 Montgomery 参数，字段本身必须填对。
 *      adbd 的 decode 当前会忽略这两个字段、让 BoringSSL 重算，但把它当"可以乱填"是错的：
 *      格式必须完整且自洽（例如设备若把公钥写进系统 `adb_keys`、或经过其它校验路径）。
 *
 * 校验基准是 AOSP 官方测试向量（`libcrypto_utils/tests/android_pubkey_test.cpp`），
 * 见 [AdbPublicKeyTest]：解码 → 重编码必须逐字节一致，且能验签。
 */
object AdbPublicKey {

    /** 模数字节数：RSA-2048。 */
    const val MODULUS_BYTES = 2048 / 8

    /** 模数的 32 位词数（格式头里存的就是它）。 */
    const val MODULUS_WORDS = MODULUS_BYTES / 4

    /** 32 位词的字面字节数。 */
    const val WORD_BYTES = 4

    /** 编码后的固定长度：3 个 u32 头尾 + 2 段 256 字节。 */
    const val ENCODED_SIZE = 3 * WORD_BYTES + 2 * MODULUS_BYTES

    const val EXPONENT_3 = 3
    const val EXPONENT_F4 = 65537

    private val TWO_POW_32 = BigInteger.ONE.shiftLeft(32)

    /** R = 2^(8 * 模数字节数)，Montgomery 参数 rr 的基数。 */
    private val R = BigInteger.ONE.shiftLeft(MODULUS_BYTES * 8)

    /** 公钥 blob 不自洽（长度 / 头部 / 指数非法）时抛出。 */
    class MalformedKeyException(message: String) : Exception(message)

    /** 解码结果：只剩 ADB 真正需要的两个数学量。 */
    data class Key(val modulus: BigInteger, val exponent: Int) {
        /** 重新编码；与原始 blob 逐字节一致（解码-编码是恒等变换）。 */
        fun encode(): ByteArray = AdbPublicKey.encode(modulus, exponent)
    }

    /**
     * n0inv = -1 / n[0] mod 2^32，其中 n[0] 是模数的最低 32 位。
     *
     * 返回值是**无符号 32 位**，用 Long 承载（范围 [0, 2^32)），调用方按小端写回即可。
     * 模数是奇数 ⇒ n[0] 与 2^32 互素 ⇒ 逆元一定存在。
     */
    fun n0inv(modulus: BigInteger): Long {
        val n0 = modulus.mod(TWO_POW_32)
        val inverse = n0.modInverse(TWO_POW_32)
        // AOSP 先取逆、再用 2^32 相减（等价于取负），而不是直接 modInverse(-n0)。
        return TWO_POW_32.subtract(inverse).toLong()
    }

    /** rr = (2^2048)^2 mod n = 2^4096 mod n。 */
    fun rr(modulus: BigInteger): BigInteger = R.multiply(R).mod(modulus)

    /**
     * 把 RSA 参数编码成 524 字节的 Android 公钥 blob。
     *
     * 模数**必须恰好 2048 位**：格式是定长的，短了/长了都不接受 —— 宁可在这里失败，
     * 也不要产出一个 adbd 认不出来、却看起来"成功"的密钥。
     */
    fun encode(modulus: BigInteger, exponent: Int): ByteArray {
        require(modulus.signum() > 0) { "RSA 模数必须为正" }
        require(modulus.bitLength() == MODULUS_BYTES * 8) {
            "RSA 模数必须是 " + (MODULUS_BYTES * 8) + " 位（实际 " + modulus.bitLength() + " 位）"
        }
        require(exponent == EXPONENT_3 || exponent == EXPONENT_F4) {
            "RSA 指数只支持 3 或 65537（实际 " + exponent + "）"
        }

        val out = ByteArray(ENCODED_SIZE)
        writeLeInt(out, 0, MODULUS_WORDS.toLong())
        writeLeInt(out, WORD_BYTES, n0inv(modulus))
        writeLePadded(out, 2 * WORD_BYTES, modulus)
        writeLePadded(out, 2 * WORD_BYTES + MODULUS_BYTES, rr(modulus))
        writeLeInt(out, 2 * WORD_BYTES + 2 * MODULUS_BYTES, exponent.toLong())
        return out
    }

    /**
     * 解析 524 字节公钥 blob。任何不自洽之处都抛 [MalformedKeyException]，
     * 绝不"尽力而为"地猜。
     */
    fun decode(blob: ByteArray): Key {
        if (blob.size != ENCODED_SIZE) {
            throw MalformedKeyException("公钥长度必须为 " + ENCODED_SIZE + " 字节（实际 " + blob.size + "）")
        }
        val words = readLeInt(blob, 0)
        if (words != MODULUS_WORDS) {
            throw MalformedKeyException("modulus_size_words 必须是 " + MODULUS_WORDS + "（实际 " + words + "）")
        }
        val exponent = readLeInt(blob, 2 * WORD_BYTES + 2 * MODULUS_BYTES)
        if (exponent != EXPONENT_3 && exponent != EXPONENT_F4) {
            throw MalformedKeyException("RSA 指数非法: " + exponent)
        }
        return Key(readLeBigInteger(blob, 2 * WORD_BYTES, MODULUS_BYTES), exponent)
    }

    private fun writeLeInt(out: ByteArray, offset: Int, value: Long) {
        for (i in 0 until WORD_BYTES) {
            out[offset + i] = ((value ushr (8 * i)) and 0xFF).toByte()
        }
    }

    private fun readLeInt(bytes: ByteArray, offset: Int): Int {
        var value = 0
        for (i in 0 until WORD_BYTES) {
            value = value or ((bytes[offset + i].toInt() and 0xFF) shl (8 * i))
        }
        return value
    }

    /**
     * 定长小端写入（低字节在前），不足补 0；超长直接拒绝，绝不静默截断。
     *
     * 之所以自己处理而不是用 BigInteger 的字节：`toByteArray()` 是大端，且正数最高位为 1
     * 时会多出一个 0x00 符号字节 —— 两个坑叠加正好会把小端布局写错。
     */
    private fun writeLePadded(out: ByteArray, offset: Int, value: BigInteger) {
        val bigEndian = value.toByteArray()
        val start = if (bigEndian.size > 1 && bigEndian[0] == 0.toByte()) 1 else 0
        val length = bigEndian.size - start
        require(length <= MODULUS_BYTES) { "数值超出 " + MODULUS_BYTES + " 字节: " + length }
        for (i in 0 until length) {
            out[offset + i] = bigEndian[start + length - 1 - i]
        }
    }

    private fun readLeBigInteger(bytes: ByteArray, offset: Int, length: Int): BigInteger {
        val bigEndian = ByteArray(length)
        for (i in 0 until length) {
            bigEndian[length - 1 - i] = bytes[offset + i]
        }
        return BigInteger(1, bigEndian)
    }
}
