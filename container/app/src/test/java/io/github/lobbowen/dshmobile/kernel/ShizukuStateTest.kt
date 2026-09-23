package io.github.lobbowen.dshmobile.kernel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Shizuku 四态分类（ADR-0003 的必备能力）。
 *
 * 最要紧的一条：**只有 binder 而没有授权时必须判为不可用**。
 * 少判任一条都会让 `shell.exec` 静默地误报可用/不可用 —— 而这正是"能力矩阵"里
 * 最不该出错的地方。
 */
class ShizukuStateTest {

    @Test fun 就绪_必须同时满足守护进程在跑与已授权() {
        val c = ShizukuState.classify("13.1.5", binderAlive = true, granted = true)
        assertEquals(ShizukuState.State.READY, c.state)
        assertTrue(c.ok)
        assertTrue(c.hint.contains("uid(2000)"))
    }

    @Test fun 守护进程在跑但未授权_不可用() {
        val c = ShizukuState.classify("13.1.5", binderAlive = true, granted = false)
        assertEquals(ShizukuState.State.NO_PERMISSION, c.state)
        assertFalse("只有 binder 不能算可用", c.ok)
        assertTrue("应告诉用户去哪里授权", c.hint.contains("已授权应用"))
    }

    @Test fun 已安装但未启动_不可用且与未安装区分() {
        val c = ShizukuState.classify("13.1.5", binderAlive = false, granted = false)
        assertEquals(ShizukuState.State.NOT_RUNNING, c.state)
        assertFalse(c.ok)
        assertTrue("状态里应带版本号", c.status.contains("13.1.5"))
        assertTrue("应给出正确的处置：点一次「启动」", c.hint.contains("启动"))
        assertFalse("绝不能与「未安装」混为一谈", c.state == ShizukuState.State.NOT_INSTALLED)
    }

    @Test fun 未安装_不可用且说明它是必备能力() {
        val c = ShizukuState.classify(null, binderAlive = false, granted = false)
        assertEquals(ShizukuState.State.NOT_INSTALLED, c.state)
        assertFalse(c.ok)
        assertTrue("应给出包名，否则用户不知道装什么", c.hint.contains(ShizukuState.PACKAGE))
        assertTrue("应说明默认降级行为（-32001）", c.hint.contains("-32001"))
    }

    @Test fun 未安装但已授权_仍判为未安装_而不是可用() {
        // 退化输入：不能因为 granted=true 就放行（授权可能是残留状态）。
        val c = ShizukuState.classify(null, binderAlive = false, granted = true)
        assertEquals(ShizukuState.State.NOT_INSTALLED, c.state)
        assertFalse(c.ok)
    }

    @Test fun 只有就绪态为ok() {
        val all = listOf(
            ShizukuState.classify("v", true, true),
            ShizukuState.classify("v", true, false),
            ShizukuState.classify("v", false, false),
            ShizukuState.classify(null, false, false),
        )
        assertEquals("恰好一种状态可用", 1, all.count { it.ok })
        assertTrue(all.first().ok)
    }
}
