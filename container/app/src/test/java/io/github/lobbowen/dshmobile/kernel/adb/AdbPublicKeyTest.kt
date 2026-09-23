package io.github.lobbowen.dshmobile.kernel.adb

import java.math.BigInteger
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

// ═══════════════════════════════════════════════════════════════════════════
// AOSP 官方测试向量，逐字节照抄自：
//   system/core/libcrypto_utils/tests/android_pubkey_test.cpp
//   （Apache-2.0）
//
// 直接钉住原始字节，是本层最重要的防线：RSAPublicKey 的**小端布局**、
// n0inv / rr 两个 Montgomery 预计算值、以及 524 字节的边界，任何一处写错
// 都会在这里立刻暴露 —— 而不是等到真机上"授权了也连不上"。
// ═══════════════════════════════════════════════════════════════════════════
private const val KEY_2048_HEX =
    "40000000057561d133f02d1245fbae0702154f3a2ba3bc49bd1407a0c09f0c5260779fa231d0a7fb7edefbc905c097f77499e6d108a6c2595ad8371de0485e6344048b0520f6256738b2b6f9beb61d7f1b718aebb7f801c15ef7fe4808270f272a641a438dcf5a335c18c5f4e7feeed31262ad61789a03b0afab915746bf18c6bc0c6b55cddac4cc98469199bca3ca6c86a61c8fcaf8f68a008e05d71343e2f21a13f35013a4f24e41b13678554c5e27c5c04bd893aa7ef090081026726db921ae4d014b551de71e5e316e62d13326cbdbfe7298c8061c12dffc74e57a6ff5a36308e302684d7c7005ec957e24a4bc4ccd3914b52a8fc1e34efaf870508fd58ec7b532894dbb6ac1c1a2425757bd2adca6fdc886446a035d4d28e1deb4a9a503617a5fb109172b9ca25428ad34c95f6c9fb8d2a978a7aab3112f659b4e670ccc2036bf262b4ec0d4bd2264c41c5669db5f89e175688d0eab1c101ac0125d6fbd09bb47cbe734ef56abeac3e97f9a3de92d146125375c3b4baf5a4bc8991a328f5407d3578a3d2af79e7e922a50e9d8dbd603d38e5432ce879392e775e16b781a85c246a131bbc7b91dd171e0e29b9c0da3cf934d877b65d9da4cd96aa636c2c7e333e2c383d1725430815e342c61eef44897b6aa476a0509d84d90afa84e82e48eb5e2658667e95b4b9a680830f6258b20da266fbd0da5d86a7b012fab7bb5fe62372d94432f4d1601000100"

private const val DIGEST_HEX =
    "315f5bdb76d078c43b8ac0064e4a0164612b1fce77c869345bfc94c75894edd3"

private const val SIGNATURE_HEX =
    "3a118440c12f138cdeb0c3898a63b2509358c00cb708e76c52874e7889a39a47eb1157bcb397f834f1f7bf3afa1c6bdcd102de9a0d72e719638146681e6364c659e77c39ed32d2d1d51f139b52df34a3c0c49a639b9cbe22c8d8142f4c7836db164167c1218a73b2e5b0d380917abff9594a4d784544a1528629484df05df255a7cdc52b7be0b1f62ad561ba1e1e3af055bc8c4441fcb88c76bf805882354b0cfdefd570d164cb465837bca97dd470acceecca48cb0a40770459ca9c7d1a0bf0b5ddde7118b8ef902a09423974ff45a139175089a65fbc9c0c9b4725793ee3aaafbe736bcbe735c12709cdebd7cf6383648c451c1d58ccd2f82b4c4e14892d70"

/** SHA-256 的 DigestInfo 前缀（SEQUENCE{ AlgorithmIdentifier(sha256), OCTET STRING(32) }）。 */
private const val SHA256_DIGEST_INFO_HEX = "3031300d060960864801650304020105000420"

private val TWO_POW_32: BigInteger = BigInteger.ONE.shiftLeft(32)

private fun hex(s: String): ByteArray {
    require(s.length % 2 == 0) { "hex 串长度必须为偶数" }
    val out = ByteArray(s.length / 2)
    for (i in out.indices) {
        out[i] = ((Character.digit(s[i * 2], 16) shl 4) or Character.digit(s[i * 2 + 1], 16)).toByte()
    }
    return out
}

/** 读小端 u32（返回无符号值，用 Long 承载）。 */
private fun leInt(b: ByteArray, offset: Int): Long {
    var v = 0L
    for (i in 0 until 4) v = v or ((b[offset + i].toLong() and 0xFF) shl (8 * i))
    return v
}

/** 读小端 BigInteger。 */
private fun readLe(b: ByteArray, offset: Int, length: Int): BigInteger {
    val be = ByteArray(length)
    for (i in 0 until length) be[length - 1 - i] = b[offset + i]
    return BigInteger(1, be)
}

/**
 * Android RSA 公钥格式（ADB 阶段 1c）。
 *
 * 本文件用 AOSP 官方向量把三件事钉死：
 *   ① 524 字节的定长小端布局；
 *   ② n0inv = -1/n[0] mod 2^32 与 rr = 2^4096 mod n；
 *   ③ 解码出的模数/指数确实是那把能验签的真钥匙，且签名语义与 AOSP 一致。
 */
class AdbPublicKeyTest {

    private val key2048 = hex(KEY_2048_HEX)
    private val digest = hex(DIGEST_HEX)
    private val signature = hex(SIGNATURE_HEX)

    /**
     * 用公钥做原始 RSA 运算，还原编码块 EM。
     * 这正是 BoringSSL `RSA_verify_raw(..., RSA_PKCS1_PADDING)` 会检查的那串字节；
     * 不依赖任何 provider 的 `Signature` 语义，纯粹是数学。
     */
    private fun recoverEncodedMessage(modulus: BigInteger, exponent: BigInteger, signature: ByteArray): ByteArray {
        val value = BigInteger(1, signature).modPow(exponent, modulus)
        var raw = value.toByteArray()
        if (raw.size > 256) raw = raw.copyOfRange(raw.size - 256, raw.size)
        val out = ByteArray(256)
        System.arraycopy(raw, 0, out, 256 - raw.size, raw.size)
        return out
    }

    @Test fun 长度常量与AOSP一致() {
        assertEquals(256, AdbPublicKey.MODULUS_BYTES)
        assertEquals(64, AdbPublicKey.MODULUS_WORDS)
        assertEquals(4, AdbPublicKey.WORD_BYTES)
        // 3 个 u32 + 2 段 256 字节 = 524
        assertEquals(524, AdbPublicKey.ENCODED_SIZE)
        assertEquals(AdbPublicKey.ENCODED_SIZE, key2048.size)
    }

    @Test fun 官方向量的小端头部与尾部字节正确() {
        // modulus_size_words = 64 → 小端 40 00 00 00
        assertArrayEquals(byteArrayOf(0x40, 0, 0, 0), key2048.copyOfRange(0, 4))
        // exponent = 65537 → 小端 01 00 01 00
        assertArrayEquals(
            byteArrayOf(0x01, 0x00, 0x01, 0x00),
            key2048.copyOfRange(524 - 4, 524)
        )
        assertEquals(64L, leInt(key2048, 0))
        assertEquals(65537L, leInt(key2048, 520))
    }

    @Test fun 解码官方向量得到2048位模数与65537指数() {
        val key = AdbPublicKey.decode(key2048)
        assertEquals(65537, key.exponent)
        assertEquals(2048, key.modulus.bitLength())
        // 模数字段就是小端存储；独立按小端读回必须一致
        assertEquals(readLe(key2048, 8, 256), key.modulus)
    }

    @Test fun 重编码官方向量必须逐字节一致() {
        val key = AdbPublicKey.decode(key2048)
        assertArrayEquals("解码后再编码必须是恒等变换", key2048, key.encode())
        assertArrayEquals(key2048, AdbPublicKey.encode(key.modulus, key.exponent))
    }

    @Test fun n0inv满足Montgomery定义() {
        val n = AdbPublicKey.decode(key2048).modulus
        val n0 = n.mod(TWO_POW_32)
        val n0inv = AdbPublicKey.n0inv(n)
        // 定义式：n0 * n0inv ≡ -1 (mod 2^32)
        assertEquals(
            TWO_POW_32.subtract(BigInteger.ONE),
            n0.multiply(BigInteger.valueOf(n0inv)).mod(TWO_POW_32)
        )
        // 必须落在无符号 32 位范围内
        assertTrue("n0inv 必须 >= 0", n0inv >= 0L)
        assertTrue("n0inv 必须 < 2^32", n0inv < TWO_POW_32.toLong())
        // 且必须与 AOSP 向量里预计算的字段完全一致
        assertEquals(0xd1617505L, leInt(key2048, 4))
        assertEquals(leInt(key2048, 4), n0inv)
    }

    @Test fun rr等于2的4096次方模n() {
        val n = AdbPublicKey.decode(key2048).modulus
        val expected = BigInteger.ONE.shiftLeft(4096).mod(n)
        assertEquals(expected, AdbPublicKey.rr(n))
        // 字段位置 [264, 520) 也必须是这个值（小端）
        assertEquals(expected, readLe(key2048, 264, 256))
    }

    @Test fun 官方向量签名块是DigestInfo加Digest的PKCS1填充() {
        // adbd 验签走 BoringSSL 的 RSA_verify(NID_sha256, digest, ...)：digest 本身
        // 就是摘要，被直接包进 DigestInfo，**不再哈希一次**。用 sig^e mod n 还原 EM 对照。
        val key = AdbPublicKey.decode(key2048)
        val em = recoverEncodedMessage(
            key.modulus,
            BigInteger.valueOf(key.exponent.toLong()),
            signature
        )
        val prefix = hex(SHA256_DIGEST_INFO_HEX)
        val separator = 256 - digest.size - prefix.size - 1
        assertEquals(0, em[0].toInt())
        assertEquals(1, em[1].toInt())
        for (i in 2 until separator) {
            assertEquals("填充必须是 0xFF", 0xFF, em[i].toInt() and 0xFF)
        }
        assertEquals(0, em[separator].toInt())
        assertArrayEquals(prefix, em.copyOfRange(separator + 1, separator + 1 + prefix.size))
        assertArrayEquals(digest, em.copyOfRange(256 - digest.size, 256))
    }

    @Test fun 长度不足524必须拒绝() {
        try {
            AdbPublicKey.decode(ByteArray(523))
            fail("应拒绝短 blob")
        } catch (e: AdbPublicKey.MalformedKeyException) {
            assertTrue(e.message!!.contains("524"))
        }
    }

    @Test fun 长度超过524必须拒绝() {
        try {
            AdbPublicKey.decode(ByteArray(525))
            fail("应拒绝长 blob")
        } catch (e: AdbPublicKey.MalformedKeyException) {
            assertTrue(e.message!!.contains("524"))
        }
    }

    @Test fun 空输入必须拒绝() {
        try {
            AdbPublicKey.decode(ByteArray(0))
            fail("应拒绝空 blob")
        } catch (e: AdbPublicKey.MalformedKeyException) {
            assertTrue(e.message!!.contains("524"))
        }
    }

    @Test fun modulus_size_words错误必须拒绝() {
        val bad = key2048.copyOf()
        bad[0] = 63 // 写成 63 词就代表 2016 位，必须拒绝而不是照单全收
        try {
            AdbPublicKey.decode(bad)
            fail("应拒绝错误词数")
        } catch (e: AdbPublicKey.MalformedKeyException) {
            assertTrue(e.message!!.contains("modulus_size_words"))
        }
    }

    @Test fun 指数非法必须拒绝() {
        val bad = key2048.copyOf()
        bad[520] = 17 // 小端写入 17
        bad[521] = 0
        bad[522] = 0
        bad[523] = 0
        try {
            AdbPublicKey.decode(bad)
            fail("应拒绝非法指数")
        } catch (e: AdbPublicKey.MalformedKeyException) {
            assertTrue(e.message!!.contains("指数"))
        }
    }

    @Test fun 编码拒绝非2048位模数() {
        // 1024 位（短）与 2049 位（长）都必须拒绝：格式是定长的。
        for (bits in intArrayOf(1024, 2049)) {
            val modulus = BigInteger.ONE.shiftLeft(bits - 1)
            try {
                AdbPublicKey.encode(modulus, AdbPublicKey.EXPONENT_F4)
                fail("应拒绝 " + bits + " 位模数")
            } catch (e: IllegalArgumentException) {
                assertTrue(e.message!!.contains("2048"))
            }
        }
    }

    @Test fun 编码拒绝非法指数() {
        val modulus = AdbPublicKey.decode(key2048).modulus
        try {
            AdbPublicKey.encode(modulus, 17)
            fail("应拒绝指数 17")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("65537"))
        }
    }

    @Test fun 编码接受指数3() {
        val modulus = AdbPublicKey.decode(key2048).modulus
        val blob = AdbPublicKey.encode(modulus, AdbPublicKey.EXPONENT_3)
        assertEquals(AdbPublicKey.ENCODED_SIZE, blob.size)
        assertEquals(3, AdbPublicKey.decode(blob).exponent)
    }
}
