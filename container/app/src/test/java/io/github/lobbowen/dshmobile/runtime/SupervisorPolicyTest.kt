package io.github.lobbowen.dshmobile.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 监督循环的退避/重启策略。
 *
 * 每条规则都对应一次真机事故，因此逐条钉住：
 *   · 退避必须**增长且有上限**（否则紧循环风暴把设备拖死）
 *   · 退避清零只看**存活时长**，不看"健康探测回 200"（残留守卫会造成假成功）
 */
class SupervisorPolicyTest {

    @Test fun 退避序列_指数增长并在第五次后封顶() {
        assertEquals(1_000L, SupervisorPolicy.backoffMs(0))
        assertEquals(2_000L, SupervisorPolicy.backoffMs(1))
        assertEquals(4_000L, SupervisorPolicy.backoffMs(2))
        assertEquals(8_000L, SupervisorPolicy.backoffMs(3))
        assertEquals(16_000L, SupervisorPolicy.backoffMs(4))
        assertEquals(30_000L, SupervisorPolicy.backoffMs(5))
        assertEquals(30_000L, SupervisorPolicy.backoffMs(6))
        assertEquals(30_000L, SupervisorPolicy.backoffMs(100))
    }

    @Test fun 退避单调不减且永不超上限() {
        var prev = 0L
        for (n in 0..40) {
            val b = SupervisorPolicy.backoffMs(n)
            assertTrue("退避必须单调不减（n=$n）", b >= prev)
            assertTrue("退避不得超上限（n=$n, b=$b）", b <= SupervisorPolicy.BACKOFF_MAX_MS)
            assertTrue("退避必须为正（n=$n）", b > 0L)
            prev = b
        }
    }

    @Test fun 负重启计数也被夹住而不是变成意外值() {
        // Kotlin 的 shl 对负数移位按 31 取模，会得到难以预料的结果；这里不依赖"调用方不会传负数"。
        assertEquals(1_000L, SupervisorPolicy.backoffMs(-1))
        assertEquals(1_000L, SupervisorPolicy.backoffMs(Int.MIN_VALUE))
        assertTrue(SupervisorPolicy.backoffMs(Int.MIN_VALUE) > 0L)
    }

    @Test fun 存活够久才清零退避() {
        assertEquals("稳定存活 → 清零", 0, SupervisorPolicy.nextRestartCount(7, true, SupervisorPolicy.STABLE_MS))
        assertEquals("超过阈值 → 清零", 0, SupervisorPolicy.nextRestartCount(7, true, SupervisorPolicy.STABLE_MS + 1))
        assertEquals("差一点 → 继续增长", 8, SupervisorPolicy.nextRestartCount(7, true, SupervisorPolicy.STABLE_MS - 1))
    }

    @Test fun 拉不起来时计数单调增长() {
        var c = 0
        for (i in 1..6) {
            c = SupervisorPolicy.nextRestartCount(c, false, 0L)
            assertEquals("第 $i 次失败后计数应为 $i", i, c)
        }
    }

    @Test fun 起来但秒死时计数同样增长() {
        // 这正是"残留守卫占端口 → 新进程秒死但探测秒回 200"的场景：
        // 启动成功（bootOk=true）但存活极短 → 绝不能清零，否则退避永远停在 1s。
        assertEquals(1, SupervisorPolicy.nextRestartCount(0, true, 0L))
        assertEquals(5, SupervisorPolicy.nextRestartCount(4, true, 100L))
    }

    @Test fun 退出归因区分曾就绪与从未拉起() {
        assertTrue("曾就绪必须给出排查方向", SupervisorPolicy.exitNote(true).contains("曾就绪"))
        assertEquals("从未就绪时不追加噪音", "", SupervisorPolicy.exitNote(false))
    }
}
