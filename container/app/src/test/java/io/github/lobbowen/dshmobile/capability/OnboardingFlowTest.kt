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
 * 2026-09-27 收敛为**两行**：F1「无线配对」→ F3「进入工作台」。
 *  - F2（通道校验）不再单独成行：通道不绿时它作为 F3 的当前读数/动作出现，顶部另有状态条；
 *  - F4（补齐授权）不再单独成行：欠账走 [OnboardingFlow.debts]，一行文案、不给按钮。
 *
 * 本测试钉的是**顺序与出口**：哪一步是当前步、它给哪个动作、后面的行闭不闭嘴，以及
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

    /** 原 F4 的职责，现在是折叠欠账 [OnboardingFlow.debts]。 */
    private fun debts(e: Evidence) = OnboardingFlow.debts(CapabilityCatalog.evaluate(e))

    @Test fun 骨架只有两行_通道与欠账降级为状态条与折叠文案() {
        // P0 是静默行为（flow-spec §2.1）。这里钉的是「别再把要权限做成一行卡」：
        // 曾经 F1 = 授权卡，用户开屏看到的是一排请求，而不是配对入口。
        assertEquals(
            listOf("F1 无线配对（一次 6 位码）", "F3 进入工作台"),
            OnboardingFlow.SKELETON.map { "${it.id} ${it.title}" },
        )
        // F2/F4 不再是阶段行：行 id 里不许再出现它们（通道读数归 F3，欠账归 debts()）。
        assertEquals(
            listOf(OnboardingFlow.F1, OnboardingFlow.F3),
            OnboardingFlow.SKELETON.map { it.id },
        )
        val fresh = OnboardingFlow.stages(ev(), CapabilityCatalog.evaluate(ev()))
        assertTrue(
            "阶段行里不许再有 F2/F4：" + fresh.map { it.id },
            fresh.none { it.id == OnboardingFlow.F2 || it.id == OnboardingFlow.F4 },
        )
        // 全新安装（什么都缺）也不许有行拿 RUNTIME_DIALOG 当主行动 —— 弹窗归 P0。
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

    @Test fun 凭据在册但通道没起来_当前步落在F3的通道读数上() {
        // F2 不再是阶段行：通道不绿时，它作为 F3 的当前读数与动作出现（顶部状态条同源）。
        val e = ev(
            dev = true, wireless = true, grants = NOTIF, creds = CredentialsState.PAIRED,
            channel = ChannelProbe(ProbeOutcome.DEAD, NOW, "ECONNREFUSED"),
        )
        assertEquals(StageStatus.DONE, rows(e).getValue(OnboardingFlow.F1).status)
        val f3 = rows(e).getValue(OnboardingFlow.F3)
        assertEquals(StageStatus.FAILED, f3.status)
        assertEquals(AcquireKind.AUTO, f3.action?.kind)
        assertEquals(CapabilityCatalog.ADB_CHANNEL, f3.actionCapId)
        assertEquals(OnboardingFlow.F3, actionable(e).single().id)
    }

    @Test fun 通道读数过期_入口不许续绿() {
        val stale = ev(
            dev = true, wireless = true, grants = ENTRY_GRANTS, creds = CredentialsState.PAIRED,
            channel = ChannelProbe(ProbeOutcome.LIVE, NOW - Evidence.CHANNEL_TTL_MS - 1, "旧读数"),
            controlPlane = true, checks = listOf(CheckItem("bundle", true)),
        )
        assertFalse(OnboardingFlow.readyToEnter(CapabilityCatalog.evaluate(stale)))
        assertEquals(OnboardingFlow.F3, actionable(stale).single().id)
    }

    @Test fun 全绿读数_没有主行动也不留欠账() {
        val e = ev(
            dev = true, wireless = true, grants = ENTRY_GRANTS, creds = CredentialsState.PAIRED,
            channel = LIVE, controlPlane = true, checks = listOf(CheckItem("bundle", true)),
        )
        assertTrue(actionable(e).isEmpty())
        assertEquals(StageStatus.DONE, rows(e).getValue(OnboardingFlow.F1).status)
        assertEquals(StageStatus.DONE, rows(e).getValue(OnboardingFlow.F3).status)
        // 原 F4「全部就位」的语义搬家：没有主行动 = 也没有欠账。
        assertTrue("全绿时欠账清单必须为空：" + debts(e).map { it.id }, debts(e).isEmpty())
    }

    @Test fun 已配对后通知被回收_欠账落到折叠清单而不是消失() {
        // 实测优先：通道在线 + 凭据在册 = F1/F3 都绿，ROM 回收掉的授权不许把主链判红；
        // 但它必须有人催 —— F1 已成立，所以它的认领集失效，通知发送回到欠账清单。
        val e = ev(
            dev = true, wireless = true, creds = CredentialsState.PAIRED, channel = LIVE,
            grants = emptySet(), controlPlane = true, checks = listOf(CheckItem("bundle", true)),
        )
        val rows = rows(e)
        assertEquals(StageStatus.DONE, rows.getValue(OnboardingFlow.F1).status)
        assertEquals(StageStatus.DONE, rows.getValue(OnboardingFlow.F3).status)
        assertTrue(
            "回收掉的授权不许无处可催（原 F4 的职责，现归 debts()）",
            debts(e).any { it.id == PermissionCatalog.POST_NOTIFICATIONS },
        )
        // 主链照绿、不因回收的授权长按钮：欠账不挡入口。
        assertTrue(actionable(e).isEmpty())
    }

    @Test fun 入口三要素绿但悬浮窗缺_不挡门且进欠账清单() {
        val noOverlay = ENTRY_GRANTS - PermissionCatalog.SYSTEM_ALERT_WINDOW
        val e = ev(
            dev = true, wireless = true, grants = noOverlay, creds = CredentialsState.PAIRED,
            channel = LIVE, controlPlane = true, checks = listOf(CheckItem("bundle", true)),
        )
        assertTrue("悬浮窗未授予也必须能进面板", OnboardingFlow.readyToEnter(CapabilityCatalog.evaluate(e)))
        assertTrue(
            "缺的授权必须进折叠欠账（不许凭空消失）",
            debts(e).any { it.id == PermissionCatalog.SYSTEM_ALERT_WINDOW },
        )
        assertTrue("欠账不占主链：没有当前步要用户点", actionable(e).isEmpty())
    }

    @Test fun 通道就绪时无障碍欠账归静默自动流() {
        // 原 F4「优先走静默取法」的语义：静默能办的不再排成阶段行动作，
        // 而是由配对后的 [PostPairingAutoFlow] 静默办 —— 本处只钉「它仍被记着」。
        val noA11y = ENTRY_GRANTS - PermissionCatalog.ACCESSIBILITY
        val e = ev(
            dev = true, wireless = true, grants = noA11y, creds = CredentialsState.PAIRED,
            channel = LIVE, controlPlane = true, checks = listOf(CheckItem("bundle", true)),
        )
        assertTrue(debts(e).any { it.id == PermissionCatalog.ACCESSIBILITY })
        // 通道在线时它的取法链首项就是静默下发（自动流的执行前提）。
        assertEquals(
            AcquireKind.SILENT_VIA_ADB,
            CapabilityCatalog.byId(PermissionCatalog.ACCESSIBILITY)?.acquirer?.invoke(e)?.firstOrNull()?.kind,
        )
    }

    @Test fun 配对前置不重复催_未成立的F1认领它们() {
        // 同一项在两处催 = 两张清单。F1 还开着时，它的前置（含通知）不进 debts()。
        val e = ev(dev = true, wireless = true)
        assertFalse(
            "通知发送该由 P0 与 F1 认领，不许出现在欠账清单里",
            debts(e).any { it.id == PermissionCatalog.POST_NOTIFICATIONS },
        )
    }

    @Test fun 任意读数下主行动唯一_且本版没有次要按钮() {
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
            // 原 F4 的次要动作已折叠：本版任何行都不许长第二个按钮。
            assertTrue("第 $i 条读数出现次要动作：" + stages.filter { it.extra != null }.map { it.id },
                stages.none { it.extra != null || it.extraCapId != null })
            assertNull("第 $i 条读数的 F1 动作必须是输码入口",
                stages.first { it.id == OnboardingFlow.F1 }
                    .action?.takeIf { it.kind != AcquireKind.USER_CODE })
        }
    }
}
