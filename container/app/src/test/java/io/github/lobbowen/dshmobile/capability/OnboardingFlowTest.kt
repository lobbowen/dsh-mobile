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
 * 钉的是**顺序与出口**：哪一步是当前步、它给哪个动作、后面的行闭不闭嘴，以及
 * 「用户点了却什么也不会发生」的死路不许出现。判据本身由 [CapabilityDegradationTest] 钉。
 *
 * 两条不可回退的流程事实（真机定罪的直接后果）：
 * 1. **授权冲刺不上屏**（P0 静默完成）：阶段卡里不许出现「先给我授权」这种行，
 *    用户第一眼的动作就是 F1「开始配对」；
 * 2. **F1 永远是活的**：哪怕还差开发者选项/通知，它的动作也必须存在 —— 那一下会
 *    起探针并把用户送到能修前置的页面（[PairingGate]）。收掉这个按钮 = 回到 v1 的死锁。
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

    /** 唯一**可动作**行：首页的主按钮就来自这一条，所以它比状态更适合当断言对象。 */
    private fun actionable(e: Evidence) = OnboardingFlow.stages(e, CapabilityCatalog.evaluate(e))
        .filter { it.action != null }

    @Test fun 骨架只有四行_授权冲刺不上屏() {
        // P0 是静默行为（flow-spec §2.1）。这里钉的是「别再把要权限做成一行卡」：
        // 曾经 F1 = 授权卡，用户开屏看到的是一排请求，而不是配对入口。
        assertEquals(
            listOf("F1 无线配对（一次 6 位码）", "F2 校验 ADB 通道（现问端点）", "F3 进入工作台",
                "F4 补齐剩余授权（不挡入口）"),
            OnboardingFlow.SKELETON.map { "${it.id} ${it.title}" },
        )
        // 全新安装（什么都缺）也不许有行拿 RUNTIME_DIALOG 当主行动 —— 弹窗归 P0。
        val fresh = OnboardingFlow.stages(ev(), CapabilityCatalog.evaluate(ev()))
        assertTrue(
            "开屏不许把授权请求摆成卡片动作：" + fresh.map { it.action?.kind },
            fresh.none { it.action?.kind == AcquireKind.RUNTIME_DIALOG },
        )
    }

    @Test fun 全新安装_配对是第一个动作_且绝不许多出第二个按钮() {
        val e = ev()
        val f1 = rows(e).getValue(OnboardingFlow.F1)
        // 读数诚实地说「还差开发者选项」，但动作必须在：点它 = 起探针 + 跳去能拨开关的页
        assertEquals(StageStatus.BLOCKED, f1.status)
        assertTrue(f1.detail.contains(CapabilityCatalog.titleOf(CapabilityCatalog.DEV_OPTIONS)))
        assertEquals(AcquireKind.USER_CODE, f1.action?.kind)
        assertEquals(1, actionable(e).size)
    }

    @Test fun 两个开关都开_当前步是配对_动作是输码() {
        val e = ev(dev = true, wireless = true, grants = NOTIF)
        val f1 = rows(e).getValue(OnboardingFlow.F1)
        assertEquals(StageStatus.CURRENT, f1.status)
        assertEquals(AcquireKind.USER_CODE, f1.action?.kind)
    }

    @Test fun 配对失败_当前步仍是配对并给出重试() {
        val e = ev(
            dev = true, wireless = true, grants = NOTIF,
            pair = PairAttempt(NOW, false, "spake2 校验失败"),
        )
        val f1 = rows(e).getValue(OnboardingFlow.F1)
        assertEquals(StageStatus.FAILED, f1.status)
        assertEquals(AcquireKind.USER_CODE, f1.action?.kind)
        assertTrue(f1.detail.contains("spake2"))
        assertEquals(OnboardingFlow.F1, actionable(e).single().id)
    }

    @Test fun 凭据在册但通道没起来_当前步是通道校验() {
        val e = ev(
            dev = true, wireless = true, grants = NOTIF, creds = CredentialsState.PAIRED,
            channel = ChannelProbe(ProbeOutcome.DEAD, NOW, "ECONNREFUSED"),
        )
        assertEquals(StageStatus.DONE, rows(e).getValue(OnboardingFlow.F1).status)
        assertEquals(StageStatus.FAILED, rows(e).getValue(OnboardingFlow.F2).status)
        assertEquals(AcquireKind.AUTO, rows(e).getValue(OnboardingFlow.F2).action?.kind)
        assertEquals(OnboardingFlow.F2, actionable(e).single().id)
    }

    @Test fun 通道读数过期_入口不许续绿() {
        val stale = ev(
            dev = true, wireless = true, grants = ENTRY_GRANTS, creds = CredentialsState.PAIRED,
            channel = ChannelProbe(ProbeOutcome.LIVE, NOW - Evidence.CHANNEL_TTL_MS - 1, "旧读数"),
            controlPlane = true, checks = listOf(CheckItem("bundle", true)),
        )
        assertFalse(OnboardingFlow.readyToEnter(CapabilityCatalog.evaluate(stale)))
        assertEquals(OnboardingFlow.F2, actionable(stale).single().id)
    }

    @Test fun 全绿读数_没有任何主行动_补齐行也说全部就位() {
        val e = ev(
            dev = true, wireless = true, grants = ENTRY_GRANTS, creds = CredentialsState.PAIRED,
            channel = LIVE, controlPlane = true, checks = listOf(CheckItem("bundle", true)),
        )
        assertTrue(actionable(e).isEmpty())
        assertEquals(StageStatus.DONE, rows(e).getValue(OnboardingFlow.F4).status)
        assertEquals("全部就位", rows(e).getValue(OnboardingFlow.F4).detail)
    }

    @Test fun 已配对后通知被回收_欠账落到补齐行而不是消失() {
        // 实测优先：通道在线 + 凭据在册 = F1/F2 都绿，ROM 回收掉的授权不许把主链判红；
        // 但它必须有人催 —— F1 已成立，所以它的认领集失效，通知发送回到 F4 清单。
        val e = ev(
            dev = true, wireless = true, creds = CredentialsState.PAIRED, channel = LIVE,
            grants = emptySet(), controlPlane = true, checks = listOf(CheckItem("bundle", true)),
        )
        val rows = rows(e)
        assertEquals(StageStatus.DONE, rows.getValue(OnboardingFlow.F1).status)
        assertTrue(
            "回收掉的授权不许无处可催",
            rows.getValue(OnboardingFlow.F4).detail
                .contains(CapabilityCatalog.titleOf(PermissionCatalog.POST_NOTIFICATIONS)),
        )
        assertEquals(OnboardingFlow.F4, actionable(e).single().id)
    }

    @Test fun 入口三要素绿但悬浮窗缺_不挡门由补齐行接手() {
        val noOverlay = ENTRY_GRANTS - PermissionCatalog.SYSTEM_ALERT_WINDOW
        val e = ev(
            dev = true, wireless = true, grants = noOverlay, creds = CredentialsState.PAIRED,
            channel = LIVE, controlPlane = true, checks = listOf(CheckItem("bundle", true)),
        )
        assertTrue("悬浮窗未授予也必须能进面板", OnboardingFlow.readyToEnter(CapabilityCatalog.evaluate(e)))
        val f4 = rows(e).getValue(OnboardingFlow.F4)
        assertEquals(StageStatus.CURRENT, f4.status)
        assertEquals(PermissionCatalog.SYSTEM_ALERT_WINDOW, f4.actionCapId)
        assertEquals(AcquireKind.USER_TAP, f4.action?.kind)
    }

    @Test fun 通道就绪时补齐优先走静默取法() {
        val noA11y = ENTRY_GRANTS - PermissionCatalog.ACCESSIBILITY
        val e = ev(
            dev = true, wireless = true, grants = noA11y, creds = CredentialsState.PAIRED,
            channel = LIVE, controlPlane = true, checks = listOf(CheckItem("bundle", true)),
        )
        val f4 = rows(e).getValue(OnboardingFlow.F4)
        assertEquals(PermissionCatalog.ACCESSIBILITY, f4.actionCapId)
        assertEquals(AcquireKind.SILENT_VIA_ADB, f4.action?.kind)
    }

    @Test fun 配对前置不重复催_未成立的F1认领它们() {
        // 同一项在两处催 = 两张清单。F1 还开着时，它的前置（含通知）不进 F4 的补齐文案。
        val e = ev(dev = true, wireless = true)
        val f4 = rows(e).getValue(OnboardingFlow.F4)
        assertFalse(
            "通知发送该由 P0 与 F1 认领，不许出现在补齐清单里",
            f4.detail.contains(CapabilityCatalog.titleOf(PermissionCatalog.POST_NOTIFICATIONS)),
        )
    }

    @Test fun 任意读数下主行动唯一_次要只许出现在F4() {
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
            assertTrue("第 $i 条读数长出 ${stages.count { it.action != null }} 个主按钮",
                stages.count { it.action != null } <= 1)
            assertTrue("第 $i 条读数的 CURRENT 不唯一",
                stages.count { it.status == StageStatus.CURRENT } <= 1)
            assertTrue("第 $i 条读数的次要按钮越界：" + stages.filter { it.extra != null }.map { it.id },
                stages.filter { it.extra != null }.all {
                    it.id == OnboardingFlow.F4 && it.status != StageStatus.DONE
                })
            assertNull("第 $i 条读数的 F1 动作必须是输码入口",
                stages.first { it.id == OnboardingFlow.F1 }
                    .action?.takeIf { it.kind != AcquireKind.USER_CODE })
        }
    }
}
