package io.github.lobbowen.dshmobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 管线状态机的钉子（spec §2）：**串行门**是唯一必须永远为真的性质 ——
 * 「后面某项其实早就绪」不能让它在前面变绿前提前跳 DONE，否则首页会把用户
 * 引向一条点了必然失败的路径（DO 未激活时权限页全是手动逐项点，正是我们要消掉的体验）。
 */
class PipelineStateTest {

    private fun allGreen() = PipelineReadings(
        adbPaired = true,
        deviceOwner = true,
        missingPermissions = emptyList(),
        runtimeUp = true,
    )

    private fun List<PipelineStep>.statusOf(id: String) =
        first { it.id == id }.status

    @Test fun 全绿时五段全DONE且工作台放行() {
        val steps = PipelineState.evaluate(allGreen())
        assertEquals(5, steps.size)
        assertTrue(steps.all { it.status == StepStatus.DONE })
        assertTrue(PipelineState.workbenchOpen(steps))
    }

    @Test fun S0未配对时后四段一律BLOCKED() {
        val steps = PipelineState.evaluate(allGreen().copy(adbPaired = false))
        assertEquals(StepStatus.ACTION, steps.statusOf(PipelineState.S0))
        for (id in listOf(PipelineState.S1, PipelineState.S2, PipelineState.S3, PipelineState.S4)) {
            assertEquals("$id 必须被串行门挡住", StepStatus.BLOCKED, steps.statusOf(id))
        }
        assertFalse(PipelineState.workbenchOpen(steps))
    }

    @Test fun 降级恢复只重开断点段而非全链() {
        // 设备重启后 adb 端口变了：只有 S0 回到 ACTION，其余段读数还在 → 立即回 DONE。
        // 这是 spec §2.1「降级=该行直连该 Step」的机器保证，不依赖用户重跑开场。
        val steps = PipelineState.evaluate(allGreen().copy(adbPaired = false))
        assertEquals(StepStatus.ACTION, steps.statusOf(PipelineState.S0))
        assertEquals(StepStatus.BLOCKED, steps.statusOf(PipelineState.S1))
        val fixed = PipelineState.evaluate(allGreen())
        assertTrue(fixed.all { it.status == StepStatus.DONE })
    }

    @Test fun 配对失败优先于待办呈现且带原因() {
        val steps = PipelineState.evaluate(allGreen().copy(adbPaired = false, lastPairError = "spake2 校验失败"))
        val s0 = steps.first { it.id == PipelineState.S0 }
        assertEquals(StepStatus.FAILED, s0.status)
        assertTrue(s0.detail.contains("spake2"))
    }

    @Test fun 缺权限列表要原样进S2详情() {
        val steps = PipelineState.evaluate(
            allGreen().copy(missingPermissions = listOf("notification-access", "battery-optimization"))
        )
        val s2 = steps.first { it.id == PipelineState.S2 }
        assertEquals(StepStatus.ACTION, s2.status)
        assertTrue(s2.detail.contains("notification-access"))
        assertTrue(s2.detail.contains("battery-optimization"))
    }

    @Test fun S3掉线时S4不放行() {
        val steps = PipelineState.evaluate(allGreen().copy(runtimeUp = false))
        assertEquals(StepStatus.ACTION, steps.statusOf(PipelineState.S3))
        assertEquals(StepStatus.BLOCKED, steps.statusOf(PipelineState.S4))
        assertFalse(PipelineState.workbenchOpen(steps))
    }
}
