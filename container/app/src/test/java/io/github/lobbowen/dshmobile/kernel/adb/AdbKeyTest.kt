package io.github.lobbowen.dshmobile.kernel.adb

import java.math.BigInteger
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * ADB 密钥对象（阶段 1c）。
 *
 * 这里做**真实**的 RSA 生成/签名/验证 —— `java.security` / `javax.crypto` 在 JVM 与
 * Android 上都是同一套 API，所以单测覆盖的路径就是真机上跑的路径。
 *
 * 关键点：ADB 的 token 签名不是 `SHA1withRSA`，而是把 token **当作 SHA-1 摘要**
 * 直接包进 DigestInfo 的原始 PKCS#1 签名（见 [AdbKey] 类注释）。下面的用例把
 * 还原出的编码块逐段钉死，正是为了拦住这个坑。
 */
class AdbKeyTest {

    // 生成一次、全类共用：RSA-2048 生成较慢，不必每个用例各来一次。
    private val key = SHARED_KEY

    private companion object {
        val SHARED_KEY: AdbKey by lazy { AdbKey.generate() }

        /** SHA-1 的 DigestInfo 前缀，独立于实现写成字面量以形成交叉校验。 */
        val SHA1_DIGEST_INFO = byteArrayOf(
            0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e,
            0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14,
        )
    }

    /** 用公钥做原始 RSA 运算还原 EM（= BoringSSL `RSA_verify_raw` 会检查的那串字节）。 */
    private fun recoverEncodedMessage(modulus: BigInteger, exponent: BigInteger, signature: ByteArray): ByteArray {
        val value = BigInteger(1, signature).modPow(exponent, modulus)
        var raw = value.toByteArray()
        if (raw.size > 256) raw = raw.copyOfRange(raw.size - 256, raw.size)
        val out = ByteArray(256)
        System.arraycopy(raw, 0, out, 256 - raw.size, raw.size)
        return out
    }

    @Test fun 生成2048位密钥_公钥blob恰好524字节() {
        assertEquals(2048, key.publicKey.modulus.bitLength())
        assertEquals(AdbPublicKey.ENCODED_SIZE, key.publicKeyBlob.size)
        // blob 能被解回同一把公钥
        assertEquals(key.publicKey.modulus, AdbPublicKey.decode(key.publicKeyBlob).modulus)
    }

    @Test fun 公钥串是base64加名字_且能解回blob() {
        val s = key.publicKeyString("dsh@device")
        val parts = s.split(" ")
        assertEquals("必须是 base64 + 单个空格 + 名字", 2, parts.size)
        assertEquals("dsh@device", parts[1])
        assertArrayEquals(key.publicKeyBlob, java.util.Base64.getDecoder().decode(parts[0]))
    }

    @Test fun 公钥串base64长度与padding正确() {
        // 524 % 3 == 2 ⇒ 700 个字符、1 个 '='；写错 padding 会让 adbd 解出 523/525 字节。
        val b64 = key.publicKeyString("x").split(" ")[0]
        assertEquals(700, b64.length)
        assertTrue("末尾应有 padding", b64.endsWith("="))
        assertFalse("524 字节只应有 1 个 padding 字符", b64.endsWith("=="))
    }

    @Test fun AUTH公钥payload以NUL结尾() {
        val name = "dsh@device"
        val text = key.publicKeyString(name)
        val payload = key.authPublicKeyPayload(name)
        assertEquals(text.length + 1, payload.size)
        assertEquals("末字节必须是 NUL", 0, payload[payload.size - 1].toInt())
        assertEquals(text, String(payload.copyOf(payload.size - 1), Charsets.UTF_8))
    }

    @Test fun 签名块是DigestInfo加token_而非再哈希一次() {
        val token = ByteArray(AdbKey.TOKEN_SIZE) { (it * 7 + 1).toByte() }
        val signature = key.signToken(token)
        assertEquals(AdbKey.SIGNATURE_BYTES, signature.size)

        val em = recoverEncodedMessage(key.publicKey.modulus, key.publicKey.publicExponent, signature)
        val separator = 256 - token.size - SHA1_DIGEST_INFO.size - 1
        assertEquals(0, em[0].toInt())
        assertEquals(1, em[1].toInt())
        for (i in 2 until separator) {
            assertEquals("填充必须是 0xFF", 0xFF, em[i].toInt() and 0xFF)
        }
        assertEquals(0, em[separator].toInt())
        assertArrayEquals(
            SHA1_DIGEST_INFO,
            em.copyOfRange(separator + 1, separator + 1 + SHA1_DIGEST_INFO.size)
        )
        // 末尾必须是 token 原文。若误用了 SHA1withRSA，这里会变成 SHA1(token) 而失败。
        assertArrayEquals(
            "token 必须原样出现在末尾",
            token,
            em.copyOfRange(256 - token.size, 256)
        )
    }

    @Test fun 签名可被从blob还原的公钥还原() {
        // 把"编码 → 传输 → 解码 → 验证"整条链钉死。
        val token = ByteArray(AdbKey.TOKEN_SIZE) { (it * 3 + 5).toByte() }
        val signature = key.signToken(token)
        val decoded = AdbPublicKey.decode(key.publicKeyBlob)
        val em = recoverEncodedMessage(
            decoded.modulus,
            BigInteger.valueOf(decoded.exponent.toLong()),
            signature
        )
        assertArrayEquals(token, em.copyOfRange(256 - token.size, 256))
    }

    @Test fun token长度不是20必须拒绝() {
        for (size in intArrayOf(0, 19, 21, 32)) {
            try {
                key.signToken(ByteArray(size))
                fail("应拒绝 " + size + " 字节 token")
            } catch (e: IllegalArgumentException) {
                assertTrue(e.message!!.contains("20"))
            }
        }
    }

    @Test fun 只有公钥时不能签名() {
        val publicOnly = AdbKey.fromPublicKey(key.publicKey)
        try {
            publicOnly.signToken(ByteArray(AdbKey.TOKEN_SIZE))
            fail("没有私钥不应能签名")
        } catch (e: IllegalStateException) {
            assertTrue(e.message!!.contains("私钥"))
        }
    }

    @Test fun 自定义base64编码与JDK逐字节一致() {
        // padding 的三个分支都要走到（余 1 / 余 2 / 余 0）。
        val vectors = mapOf(
            "" to "",
            "f" to "Zg==",
            "fo" to "Zm8=",
            "foo" to "Zm9v",
            "foob" to "Zm9vYg==",
            "fooba" to "Zm9vYmE=",
            "foobar" to "Zm9vYmFy"
        )
        for ((input, expected) in vectors) {
            assertEquals(expected, AdbBase64.encode(input.toByteArray(Charsets.UTF_8)))
        }
        // 真实 blob（524 字节，余 2）也必须与 JDK 一致
        val blob = key.publicKeyBlob
        assertEquals(java.util.Base64.getEncoder().encodeToString(blob), AdbBase64.encode(blob))
        assertArrayEquals(blob, java.util.Base64.getDecoder().decode(AdbBase64.encode(blob)))
    }

    @Test fun 生成密钥的n0inv与rr自洽() {
        val n = key.publicKey.modulus
        val twoPow32 = BigInteger.ONE.shiftLeft(32)
        val n0 = n.mod(twoPow32)
        val n0inv = AdbPublicKey.n0inv(n)
        assertEquals(
            "n0 * n0inv 必须 ≡ -1 (mod 2^32)",
            twoPow32.subtract(BigInteger.ONE),
            n0.multiply(BigInteger.valueOf(n0inv)).mod(twoPow32)
        )
        val rr = AdbPublicKey.rr(n)
        assertTrue("rr 必须小于 n", rr < n)
        assertTrue("rr 必须非负", rr.signum() >= 0)
    }
}
