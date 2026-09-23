package io.github.lobbowen.dshmobile.kernel.adb

import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import javax.crypto.Cipher

/**
 * 一对 ADB 密钥，以及 ADB 认证所需的三种派生表示。
 *
 * ⚠️ 签名有一个**极易踩、且只有真机才暴露**的坑，值得单独说明：
 *
 *   BoringSSL 的 `RSA_sign(hash_nid, digest, digest_len, ...)` 里，`digest` 是
 *   **已经算好的摘要**，函数只负责把它包进 `DigestInfo` 再做 PKCS#1 v1.5 填充。
 *   AOSP 的 `adb_auth_sign` 传进去的是原始 20 字节 token，于是 adbd 用
 *   `RSA_verify(NID_sha1, token, 20, ...)` 验证 —— **token 本身被当作 SHA-1 摘要**。
 *
 *   所以**不能**用 JVM 的 `Signature("SHA1withRSA")`：那会去签 `SHA1(token)`，
 *   adbd 一定验不过，表现为"密钥发出去了但永远授权不通过"。
 *   正确做法与 AdbLib(dadb) 一致：自己拼出编码块
 *     EM = 00 || 01 || FF…FF || 00 || SHA1-DigestInfo || token
 *   再用 `Cipher("RSA/ECB/NoPadding")` 对私钥做原始运算。
 *   该结论由 AOSP 官方测试向量反推确认（见 [AdbPublicKeyTest]）。
 *
 * 依赖边界：只用 `java.security` / `javax.crypto`（Android 与 JVM 都自带），不碰 Android API，
 * 因此可以在普通 JVM 单测里真实生成密钥、真实签名、再按 adbd 的方式还原验证。
 */
class AdbKey private constructor(
    private val privateKey: RSAPrivateKey?,
    val publicKey: RSAPublicKey,
) {

    /** 524 字节的 Android 公钥 blob（`AUTH(RSAPUBLICKEY)` 的二进制本体）。 */
    val publicKeyBlob: ByteArray
        get() = AdbPublicKey.encode(publicKey.modulus, publicKey.publicExponent.toInt())

    /** adb 公钥文件里的文本形式：`<base64 blob> <name>`。 */
    fun publicKeyString(name: String): String = AdbBase64.encode(publicKeyBlob) + " " + name

    /**
     * `AUTH(RSAPUBLICKEY)` 的完整 payload：文本 + 结尾 NUL。
     *
     * AOSP 的 `send_auth_publickey` 显式 `+ 1` 带上结尾 NUL（"adbd expects a
     * null-terminated string"）。少这一个字节，adbd 会把密钥当成被截断的字符串。
     */
    fun authPublicKeyPayload(name: String): ByteArray =
        publicKeyString(name).toByteArray(Charsets.UTF_8) + byteArrayOf(0)

    /**
     * 对服务端发来的 20 字节 token 签名。产物与 adbd 的
     * `RSA_verify(NID_sha1, token, 20, ...)` 一一对应（见类注释：token 即 SHA-1 摘要）。
     */
    fun signToken(token: ByteArray): ByteArray {
        require(token.size == TOKEN_SIZE) {
            "ADB token 必须是 " + TOKEN_SIZE + " 字节（实际 " + token.size + "）"
        }
        val private = privateKey ?: throw IllegalStateException("这是公钥，没有私钥可签名")
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, private)
        return cipher.doFinal(signatureBlock(token))
    }

    /** 拼出待做原始 RSA 私钥运算的编码块 EM（也就是 adbd 验证时会还原出的字节）。 */
    private fun signatureBlock(token: ByteArray): ByteArray {
        val size = AdbPublicKey.MODULUS_BYTES
        val block = ByteArray(size)
        block[0] = 0x00
        block[1] = 0x01
        // 0x00 分隔符之后紧跟 DigestInfo，再之后是 token 原文。
        val separator = size - token.size - SHA1_DIGEST_INFO.size - 1
        for (i in 2 until separator) {
            block[i] = 0xFF.toByte()
        }
        block[separator] = 0x00
        System.arraycopy(SHA1_DIGEST_INFO, 0, block, separator + 1, SHA1_DIGEST_INFO.size)
        System.arraycopy(token, 0, block, size - token.size, token.size)
        return block
    }

    companion object {
        /** AOSP `adb.h` 里的 `TOKEN_SIZE`：SHA-1 摘要长度。 */
        const val TOKEN_SIZE = 20

        /** RSA-2048 签名固定 256 字节。 */
        const val SIGNATURE_BYTES = 256

        private const val TRANSFORMATION = "RSA/ECB/NoPadding"

        /**
         * SHA-1 的 `DigestInfo` 前缀：
         *   SEQUENCE { SEQUENCE { OID(sha1) NULL }, OCTET STRING SIZE(20) }。
         * 与 AdbLib / dadb 的 `SIGNATURE_PADDING` 尾部逐字节一致。
         */
        private val SHA1_DIGEST_INFO = byteArrayOf(
            0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e,
            0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14,
        )

        fun of(pair: KeyPair): AdbKey =
            AdbKey(pair.private as RSAPrivateKey, pair.public as RSAPublicKey)

        /** 只有公钥，可用于编码与验证，但 [signToken] 会失败。 */
        fun fromPublicKey(publicKey: RSAPublicKey): AdbKey = AdbKey(null, publicKey)

        /** 生成一对新的 RSA-2048 密钥（指数 65537）。 */
        fun generate(): AdbKey {
            val generator = KeyPairGenerator.getInstance("RSA")
            generator.initialize(AdbPublicKey.MODULUS_BYTES * 8)
            return of(generator.generateKeyPair())
        }
    }
}
