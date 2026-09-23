package io.github.lobbowen.dshmobile.kernel.adb

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ADB 握手迁移。重点钉住两条最容易写错、且现场最难定位的规则：
 *   ① 第二次 AUTH(token) 必须回**公钥**，而不是再签一次；
 *   ② 公钥被拒后必须**失败**，不能无限重试。
 */
class AdbHandshakeTest {

    private val token = byteArrayOf(1, 2, 3, 4)

    private fun step(phase: AdbHandshake.Phase, cmd: AdbProtocol.Command, arg0: Int = 0, payload: ByteArray = ByteArray(0)) =
        AdbHandshake.onMessage(phase, cmd, arg0, payload)

    @Test fun 首次收到token_应回签名() {
        val s = step(AdbHandshake.Phase.START, AdbProtocol.Command.AUTH, AdbProtocol.AUTH_TOKEN, token)
        assertEquals(AdbHandshake.Phase.SIGNATURE_SENT, s.phase)
        assertTrue(s.action is AdbHandshake.Action.SendSignature)
        assertArrayEquals(token, (s.action as AdbHandshake.Action.SendSignature).token)
    }

    @Test fun 第二次token_应回公钥而不是再签一次() {
        val s = step(AdbHandshake.Phase.SIGNATURE_SENT, AdbProtocol.Command.AUTH, AdbProtocol.AUTH_TOKEN, token)
        assertEquals(AdbHandshake.Phase.PUBKEY_SENT, s.phase)
        assertTrue("必须是公钥", s.action is AdbHandshake.Action.SendPublicKey)
    }

    @Test fun 公钥也被拒_必须失败而不是重试() {
        val s = step(AdbHandshake.Phase.PUBKEY_SENT, AdbProtocol.Command.AUTH, AdbProtocol.AUTH_TOKEN, token)
        assertEquals(AdbHandshake.Phase.FAILED, s.phase)
        assertTrue(s.action is AdbHandshake.Action.Fail)
    }

    @Test fun 收到CNXN即就绪() {
        val s = step(AdbHandshake.Phase.START, AdbProtocol.Command.CNXN)
        assertEquals(AdbHandshake.Phase.READY, s.phase)
        assertEquals(AdbHandshake.Action.Ready, s.action)
    }

    @Test fun 就绪后多余消息必须失败_不能继续处理() {
        val s = step(AdbHandshake.Phase.READY, AdbProtocol.Command.WRTE)
        assertEquals(AdbHandshake.Phase.READY, s.phase)
        assertTrue(s.action is AdbHandshake.Action.Fail)
    }

    @Test fun 失败后不再处理任何消息() {
        val s = step(AdbHandshake.Phase.FAILED, AdbProtocol.Command.CNXN)
        assertEquals(AdbHandshake.Phase.FAILED, s.phase)
        assertTrue(s.action is AdbHandshake.Action.Fail)
    }

    @Test fun 握手期收到非AUTH非CNXN_必须失败() {
        val s = step(AdbHandshake.Phase.START, AdbProtocol.Command.OPEN)
        assertEquals(AdbHandshake.Phase.FAILED, s.phase)
    }

    @Test fun 收到非token子类型的AUTH_必须失败() {
        val s = step(AdbHandshake.Phase.START, AdbProtocol.Command.AUTH, AdbProtocol.AUTH_SIGNATURE, token)
        assertEquals(AdbHandshake.Phase.FAILED, s.phase)
        assertTrue((s.action as AdbHandshake.Action.Fail).reason.contains("非 token"))
    }
}
