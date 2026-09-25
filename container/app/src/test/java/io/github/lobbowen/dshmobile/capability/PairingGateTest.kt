package io.github.lobbowen.dshmobile.capability

import io.github.lobbowen.dshmobile.permissions.PermissionCatalog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「点配对那一下」的现场引导 golden（flow-spec §2.1）。
 *
 * 三段式里这一层最容易被写歪：在 UI 里 `if (devOptionsOn)` 判一遍「还差什么」就是第二把
 * 尺子 —— 它与登记表不同源，登记表一改首页文案立刻说谎。这里钉的是缺口的**选取顺序**、
 * 每个缺口的**落点**、以及「前置全齐时也必须给得出跳页动作」。
 */
class PairingGateTest {

    private val NOW = 1_000_000L

    private fun ev(
        dev: Boolean = false,
        wireless: Boolean = false,
        grants: Set<String> = emptySet(),
    ) = Evidence(nowMs = NOW, devOptionsOn = dev, wirelessDebugOn = wireless, grants = grants)

    private fun decide(e: Evidence) = PairingGate.decide(e, CapabilityCatalog.evaluate(e))

    @Test fun 全缺时先引导环境开关_通知排在后面() {
        // GATE_ORDER 取登记表 requires 的声明序（dev-options → wireless-debug → 通知）。
        // 顺序不许反过来：开发者选项还没开时，弹通知授权页只是让人对着灰掉的开关发呆。
        val d = decide(ev())
        assertEquals(CapabilityCatalog.DEV_OPTIONS, d.gapCapId)
        assertFalse(d.ready)
        assertEquals(AcquireKind.USER_TAP, d.jump?.kind)
        assertEquals(CapabilityCatalog.NAV_DEV_OPTIONS, d.jump?.target)
    }

    @Test fun 缺口文案与判据同源_不许闸门自己编一句() {
        val e = ev()
        val detail = CapabilityCatalog.evaluate(e).getValue(CapabilityCatalog.DEV_OPTIONS).detail
        assertTrue("notice 必须引用判据 detail，否则两张表各说一套：" + decide(e).notice,
            decide(e).notice.contains(detail))
    }

    @Test fun 开发者选项已开_缺口前进到无线调试并落在无线调试页() {
        val d = decide(ev(dev = true))
        assertEquals(CapabilityCatalog.WIRELESS_DEBUG, d.gapCapId)
        assertEquals(AcquireKind.USER_TAP, d.jump?.kind)
        // ColorOS 的案底：落点声明成无线调试页，能不能直达由 CapabilityNavigation 现场问系统
        assertEquals(CapabilityCatalog.NAV_WIRELESS_DEBUG, d.jump?.target)
        assertTrue(d.notice.contains("无线调试"))
    }

    @Test fun 两个开关齐但通知没给_缺口是通知且用系统弹窗要() {
        val d = decide(ev(dev = true, wireless = true))
        assertEquals(PermissionCatalog.POST_NOTIFICATIONS, d.gapCapId)
        assertEquals(AcquireKind.RUNTIME_DIALOG, d.jump?.kind)
        assertEquals(PermissionCatalog.POST_NOTIFICATIONS, d.jump?.target)
    }

    @Test fun 前置全齐就跳无线调试页_ready不等于配对成功() {
        // 凭据、通道一律还没影 —— 闸门只管「现在能不能引导」，成败由判据层读数说话。
        val d = decide(ev(dev = true, wireless = true, grants = setOf(PermissionCatalog.POST_NOTIFICATIONS)))
        assertTrue(d.ready)
        assertNull(d.gapCapId)
        assertEquals(CapabilityCatalog.NAV_WIRELESS_DEBUG, d.jump?.target)
    }

    @Test fun 每个缺口都给得出动作_闸门不许产出一条死路() {
        // 反事实：S0 死锁的形态就是「按钮在、点了没地方去」。逐条读数都必须有 jump。
        val readings = listOf(
            ev(),
            ev(dev = true),
            ev(wireless = true),
            ev(dev = true, wireless = true),
            ev(grants = setOf(PermissionCatalog.POST_NOTIFICATIONS)),
            ev(dev = true, wireless = true, grants = setOf(PermissionCatalog.POST_NOTIFICATIONS)),
        )
        for ((i, e) in readings.withIndex()) {
            val d = decide(e)
            assertNotNull("第 $i 条读数点配对没有落点", d.jump)
            assertTrue("第 $i 条读数的 notice 为空", d.notice.isNotBlank())
        }
    }
}
