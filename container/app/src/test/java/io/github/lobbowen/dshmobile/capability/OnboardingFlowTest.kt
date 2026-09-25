package io.github.lobbowen.dshmobile.capability

import io.github.lobbowen.dshmobile.permissions.PermissionCatalog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 开场流程 golden（docs/contracts/onboarding-flow-spec.md §2、§6）。
 *
 * 钉的是**顺序**：哪一步是 CURRENT、它给哪个动作、后面的行必须闭嘴。判据本身
 * 由 [CapabilityDegradationTest] 钉，两份加起来才等于「从 S0 走得下去」——
 * v1/v2 的真机事故都不是判据错，而是**没有流程**：每段随机挑一个待办上屏，
 * 于是全新安装永远停在「点开始配对 → 通知栏什么都没有」。
 */
class OnboardingFlowTest {

    private val NOW = 1_000_000L
    private val NOTIF = setOf(PermissionCatalog.POST_NOTIFICATIONS)
    private val ENTRY_GRANTS = NOTIF + setOf(
        PermissionCatalog.BATTERY_OPTIMIZATION,
        PermissionCatalog.SYSTEM_ALERT_WINDOW,
        PermissionCatalog.MANAGE_EXTERNAL_STORAGE,
        PermissionCatalog.REQUEST_INSTALL_PACKAGES,
        PermissionCatalog.NOTIFICATION_ACCESS,
        PermissionCatalog.ACCESSIBILITY,
        PermissionCatalog.MEDIAPROJECTION,
    )
    private val LIVE = ChannelProbe(ProbeOutcome.LIVE, NOW, "shell 在线")

    private fun ev(
        dev: Boolean = false,
        wireless: Boolean = false,
        creds: CredentialsState = CredentialsState.NO_KEY,
        channel: ChannelProbe = ChannelProbe(ProbeOutcome.NEVER_RUN),
        grants: Set<String> = emptySet(),
        controlPlane: Boolean = false,
        checks: List<CheckItem> = emptyList(),
        pair: PairAttempt? = null,
    ) = Evidence(
        nowMs = NOW,
        devOptionsOn = dev,
        wirelessDebugOn = wireless,
        credentials = creds,
        channel = channel,
        grants = grants,
        controlPlaneUp = controlPlane,
        kernelChecks = checks,
        pairAttempt = pair,
    )

    private fun rows(e: Evidence) =
        OnboardingFlow.stages(e, CapabilityCatalog.evaluate(e)).associateBy { it.id }

    /** 唯一 CURRENT（本步只是「还没做」）。 */
    private fun current(e: Evidence) = OnboardingFlow.stages(e, CapabilityCatalog.evaluate(e))
        .filter { it.status == StageStatus.CURRENT }

    /**
     * 唯一**可动作**行：阶段机只给第一个未成立的行发动作，无论它是「待办」还是「试过失败」。
     * 首页的可点按钮就来自这一条，所以它比状态更适合当「现在该干什么」的断言对象。
     */
    private fun actionable(e: Evidence) = OnboardingFlow.stages(e, CapabilityCatalog.evaluate(e))
        .filter { it.action != null }

    @Test fun 全新安装_当前步是授权冲刺_且配对行不许给动作() {
        val e = ev()
        val cur = current(e)
        assertEquals("首页必须只有一个可点动作", 1, cur.size)
        assertEquals(OnboardingFlow.F1, cur.first().id)
        assertEquals(AcquireKind.RUNTIME_DIALOG, cur.first().action?.kind)
        // 这条就是 S0 死锁的反事实：通知未授予时配对那一步只能是「等待」，不能给一个发不出通知的按钮
        assertEquals(StageStatus.BLOCKED, rows(e).getValue(OnboardingFlow.F3).status)
        assertNull(rows(e).getValue(OnboardingFlow.F3).action)
    }

    @Test fun 冲刺之后才是开发者环境_顺序不许倒挂() {
        val onlyNotif = ev(grants = NOTIF)
        assertEquals(OnboardingFlow.F2, current(onlyNotif).single().id)
        val devOn = ev(dev = true, grants = NOTIF)
        val cur = current(devOn).single()
        assertEquals(OnboardingFlow.F2, cur.id)
        assertEquals(AcquireKind.USER_TAP, cur.action?.kind)
        // 无线调试是第二个开关：F2 未成立时不许跳到 F3
        assertEquals(StageStatus.BLOCKED, rows(devOn).getValue(OnboardingFlow.F3).status)
    }

    @Test fun 两个开关都开_当前步是配对_动作是输码() {
        val e = ev(dev = true, wireless = true, grants = NOTIF)
        val cur = current(e).single()
        assertEquals(OnboardingFlow.F3, cur.id)
        assertEquals(AcquireKind.USER_CODE, cur.action?.kind)
    }

    @Test fun 配对失败_当前步仍是配对并给出重试() {
        val e = ev(
            dev = true, wireless = true, grants = NOTIF,
            pair = PairAttempt(NOW, false, "spake2 校验失败"),
        )
        val f3 = rows(e).getValue(OnboardingFlow.F3)
        assertEquals(StageStatus.FAILED, f3.status)
        assertEquals(AcquireKind.USER_CODE, f3.action?.kind)
        assertTrue(f3.detail.contains("spake2"))
        assertEquals(OnboardingFlow.F3, actionable(e).single().id)
    }

    @Test fun 凭据在册但通道没起来_当前步是通道校验() {
        val e = ev(
            dev = true, wireless = true, grants = NOTIF, creds = CredentialsState.PAIRED,
            channel = ChannelProbe(ProbeOutcome.DEAD, NOW, "ECONNREFUSED"),
        )
        assertEquals(StageStatus.FAILED, rows(e).getValue(OnboardingFlow.F4).status)
        assertEquals(AcquireKind.AUTO, rows(e).getValue(OnboardingFlow.F4).action?.kind)
        assertEquals(OnboardingFlow.F4, actionable(e).single().id)
    }

    @Test fun 通道读数过期_入口不许续绿() {
        val stale = ev(
            dev = true, wireless = true, grants = ENTRY_GRANTS, creds = CredentialsState.PAIRED,
            channel = ChannelProbe(ProbeOutcome.LIVE, NOW - Evidence.CHANNEL_TTL_MS - 1, "旧读数"),
            controlPlane = true, checks = listOf(CheckItem("bundle", true)),
        )
        assertFalse(OnboardingFlow.readyToEnter(CapabilityCatalog.evaluate(stale)))
        assertEquals(OnboardingFlow.F4, actionable(stale).single().id)
    }

    @Test fun 老设备打开就走短路_缺的授权落到补齐清单() {
        // 通道 LIVE + 凭据在册，但通知权限被 ROM 回收：不再重走 F1–F3，改由 F6 提示
        val e = ev(
            dev = true, wireless = true, creds = CredentialsState.PAIRED, channel = LIVE,
            grants = emptySet(), controlPlane = true, checks = listOf(CheckItem("bundle", true)),
        )
        assertEquals(StageStatus.DONE, rows(e).getValue(OnboardingFlow.F1).status)
        assertEquals(StageStatus.DONE, rows(e).getValue(OnboardingFlow.F3).status)
        assertTrue(rows(e).getValue(OnboardingFlow.F6).detail
            .contains(CapabilityCatalog.titleOf(PermissionCatalog.POST_NOTIFICATIONS)))
        assertEquals(OnboardingFlow.F6, actionable(e).single().id)
    }

    @Test fun 冲刺欠账不挡主链_只给次要按钮() {
        // 通知已给、其余冲刺项没给：主行动必须往下走（F2 引导开发者环境），
        // 欠的授权留在 F1 的次要动作上 —— 既满足「开屏先拿最大」，也不把链钉死在 F1。
        val e = ev(grants = NOTIF)
        val rows = rows(e)
        assertEquals(StageStatus.NEXT, rows.getValue(OnboardingFlow.F1).status)
        assertEquals(PermissionCatalog.BATTERY_OPTIMIZATION, rows.getValue(OnboardingFlow.F1).extraCapId)
        assertNull(rows.getValue(OnboardingFlow.F1).action)
        assertEquals(OnboardingFlow.F2, current(e).single().id)
        assertEquals("整页只许一个主行动", 1, actionable(e).size)
    }

    @Test fun 入口三要素绿但悬浮窗缺_不挡门由F6接手() {
        // 入口 ≠ 全绿（§1 总则 6）。这项读数走的是 F0→F5 短路（通道 LIVE + 凭据在册），
        // 所以 F1 不再认领被 ROM 回收掉的悬浮窗 —— 它必须出现在 F6 的补齐清单上并给出动作，
        // 而不是既不进 F1（已短路）也不进 F6（被认领）地凭空消失。
        val noOverlay = ENTRY_GRANTS - PermissionCatalog.SYSTEM_ALERT_WINDOW
        val e = ev(
            dev = true, wireless = true, grants = noOverlay, creds = CredentialsState.PAIRED,
            channel = LIVE, controlPlane = true, checks = listOf(CheckItem("bundle", true)),
        )
        assertTrue("悬浮窗未授予也必须能进面板", OnboardingFlow.readyToEnter(CapabilityCatalog.evaluate(e)))
        val rows = rows(e)
        assertEquals(StageStatus.DONE, rows.getValue(OnboardingFlow.F5).status)
        assertEquals("回收掉的授权不许无处可催", StageStatus.CURRENT, rows.getValue(OnboardingFlow.F6).status)
        assertEquals(PermissionCatalog.SYSTEM_ALERT_WINDOW, rows.getValue(OnboardingFlow.F6).actionCapId)
        assertEquals(AcquireKind.USER_TAP, rows.getValue(OnboardingFlow.F6).action?.kind)
    }

    @Test fun 通道就绪时补齐优先走静默取法() {
        // 无障碍在未授权但通道 LIVE 时，主路径必须是 SILENT_VIA_ADB（用户不必点设置页）
        val noA11y = ENTRY_GRANTS - PermissionCatalog.ACCESSIBILITY
        val e = ev(
            dev = true, wireless = true, grants = noA11y, creds = CredentialsState.PAIRED,
            channel = LIVE, controlPlane = true, checks = listOf(CheckItem("bundle", true)),
        )
        val f6 = rows(e).getValue(OnboardingFlow.F6)
        assertEquals(PermissionCatalog.ACCESSIBILITY, f6.actionCapId)
        assertEquals(AcquireKind.SILENT_VIA_ADB, f6.action?.kind)
    }

    @Test fun 任意读数下主行动唯一_次要只许出现在F1与F6() {
        // flow-spec §6-6。钉的是「按钮墙」复发的免疫：只要某行读数让首页长出两个主按钮，
        // 或者次要按钮挂到了挡路的行上，这里就红。全绿的读数是 0 个主按钮，因此判「至多一个」。
        val readings = listOf(
            ev(),
            ev(grants = NOTIF),
            ev(dev = true, grants = NOTIF),
            ev(dev = true, wireless = true, grants = NOTIF),
            ev(dev = true, wireless = true, grants = NOTIF, pair = PairAttempt(NOW, false, "码过期")),
            ev(dev = true, wireless = true, grants = NOTIF, creds = CredentialsState.PAIRED,
                channel = ChannelProbe(ProbeOutcome.DEAD, NOW, "ECONNREFUSED")),
            ev(dev = true, wireless = true, grants = ENTRY_GRANTS, creds = CredentialsState.PAIRED,
                channel = LIVE, controlPlane = true, checks = listOf(CheckItem("bundle", true))),
            ev(dev = true, wireless = true, creds = CredentialsState.PAIRED, channel = LIVE,
                controlPlane = true, checks = listOf(CheckItem("bundle", true))),
        )
        for ((i, e) in readings.withIndex()) {
            val stages = OnboardingFlow.stages(e, CapabilityCatalog.evaluate(e))
            val primary = stages.filter { it.action != null }
            assertTrue("第 $i 条读数长出 $primary 个主按钮", primary.size <= 1)
            assertTrue("第 $i 条读数的 CURRENT 不唯一", stages.count { it.status == StageStatus.CURRENT } <= 1)
            assertTrue("第 $i 条读数的次要按钮越界：" +
                stages.filter { it.extra != null }.map { it.id },
            stages.filter { it.extra != null }.all {
                (it.id == OnboardingFlow.F1 || it.id == OnboardingFlow.F6) && it.status != StageStatus.DONE
            })
        }
    }
}
