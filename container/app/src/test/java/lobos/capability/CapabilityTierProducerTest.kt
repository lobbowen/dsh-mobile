package lobos.capability

import lobos.permissions.PermissionCatalog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 结论档位的**生产者** golden（债表 D10 定罪的形状：有消费点、零生产者的档位）。
 *
 * 为什么单独立一条门：D10 那条 `CapStatus.UNREACHABLE` 有四个消费点、零个生产者 ——
 * 读代码的人会以为「设备上有这项就是永久不可得」，而仓里没有任何一处实测能产出它。
 * 「预先判死」正是从这里进的门（SP-1 定罪的第一现场）。所以判据层每一档都必须回答
 * 「哪次实测会产出它」，答不出就删档，而不是留一档让散文去猜。
 *
 * 这一条只管**结论档位**（设备能是什么）。渲染档位（[StageStatus].NEXT、[StepStatus].BLOCKED
 * 这类「这行怎么画」）不在本条范围：它们可达与否随流程形状变，由 OnboardingFlowTest /
 * CapabilityDegradationTest 逐行钉。把它们混进来判会逼代码为了过门伪造读数。
 */
class CapabilityTierProducerTest {

    private val allGrants = setOf(
        PermissionCatalog.MANAGE_EXTERNAL_STORAGE,
        PermissionCatalog.REQUEST_INSTALL_PACKAGES,
        PermissionCatalog.SYSTEM_ALERT_WINDOW,
        PermissionCatalog.POST_NOTIFICATIONS,
        PermissionCatalog.BATTERY_OPTIMIZATION,
        PermissionCatalog.NOTIFICATION_ACCESS,
        PermissionCatalog.ACCESSIBILITY,
        PermissionCatalog.MEDIAPROJECTION,
    )

    private val allOem = setOf(
        OemGuards.STARTUP_MANAGER, OemGuards.CARD_LOCK, OemGuards.FULL_BACKGROUND, OemGuards.FREEZE_WHITELIST,
    )

    /** 全绿设备：每一项都有实测读数支持，这一份负责证明 GRANTED 不是默认值而是结论。 */
    private fun green() = Evidence(
        nowMs = 1_000_000L, devOptionsOn = true, wirelessDebugOn = true,
        credentials = CredentialsState.PAIRED,
        channel = ChannelProbe(ProbeOutcome.LIVE, 1_000_000L, "uid=2000 shell"),
        grants = allGrants, controlPlaneUp = true,
        programChecks = listOf(CheckItem("bundle", true)), oemGuards = allOem,
    )

    /** 一次配对尝试真失败（类型化读数，不是猜文本）。 */
    private fun pairFailed() = Evidence(
        nowMs = 1_000_000L, devOptionsOn = true, wirelessDebugOn = true, grants = allGrants,
        pairAttempt = PairAttempt(900_000L, false, "配对码校验失败"),
    )

    /** 凭据在册但通道明确不通。 */
    private fun channelDead() = Evidence(
        nowMs = 1_000_000L, devOptionsOn = true, wirelessDebugOn = true,
        credentials = CredentialsState.PAIRED,
        channel = ChannelProbe(ProbeOutcome.DEAD, 1_000_000L, "connection refused"),
        grants = allGrants,
    )

    /** 全新设备：什么都没开、什么都没试。 */
    private fun blank() = Evidence(nowMs = 1_000_000L)

    @Test fun CapStatus每一档都有实测生产者() {
        val minted = listOf(green(), pairFailed(), channelDead(), blank())
            .flatMap { CapabilityCatalog.evaluate(it).values }
            .map { it.status }
            .toSet()
        assertEquals(
            "有档位没人能实测出来 = 又一处零生产者判据（债表 D10），删档或给它一个真读数",
            CapStatus.values().toSet(), minted,
        )
        assertEquals(4, CapStatus.values().size)
    }

    @Test fun BLOCKED只由硬前置产生_实测失败不会伪装成等待() {
        // 这一条把 CapStatus.BLOCKED 的 KDoc（「只允许由 Capability.requires 产生」）变成可执行的：
        // 配对真失败给 FAILED，不给 BLOCKED；前置没齐才给 BLOCKED。两者混用就是界面把「办砸了」
        // 画成「还轮不到你」，用户按错按钮。
        assertEquals(CapStatus.FAILED, CapabilityCatalog.evaluate(pairFailed()).getValue(CapabilityCatalog.ADB_CREDENTIALS).status)
        assertEquals(CapStatus.BLOCKED, CapabilityCatalog.evaluate(blank()).getValue(CapabilityCatalog.WIRELESS_DEBUG).status)
        assertEquals(CapStatus.GRANTED, CapabilityCatalog.evaluate(green()).getValue(CapabilityCatalog.DEV_OPTIONS).status)
        assertEquals(CapStatus.ACTION, CapabilityCatalog.evaluate(green().copy(controlPlaneUp = false)).getValue(CapabilityCatalog.RUNTIME).status)
    }

    @Test fun 实测账分类只由下发与回读决定_没下发过绝不记账() {
        // AttemptOutcomeRule 是「这项归 adb 还是归人」的唯一分类口（账本词汇的出生地）。
        // 三档都必须有输入能打出来，而「命令没跑到 shell」永远不记账 —— 通道半路死是设备状态，
        // 不是这条路的事实，记成 UNSUPPORTED 就是把下一次该试的事预先判死。
        assertEquals(AttemptOutcome.SILENT_OK, AttemptOutcomeRule.of(true, true, ""))
        assertEquals(AttemptOutcome.NEEDS_TAP, AttemptOutcomeRule.of(true, false, "no error but not applied"))
        assertEquals(AttemptOutcome.UNSUPPORTED, AttemptOutcomeRule.of(true, false, "SecurityException: uid 2000"))
        assertEquals(AttemptOutcome.UNSUPPORTED, AttemptOutcomeRule.of(true, false, "Unknown operation xyz"))
        assertNull(AttemptOutcomeRule.of(false, false, "inconsistent state of transport"))
        // 三档全可达 + 没有第四档：加一档就必须在这里给它一个真输入。
        assertEquals(3, AttemptOutcome.values().size)
        assertEquals(
            AttemptOutcome.values().toSet(),
            setOf(
                AttemptOutcomeRule.of(true, true, ""),
                AttemptOutcomeRule.of(true, false, "plain failure"),
                AttemptOutcomeRule.of(true, false, "Permission Denial"),
            ),
        )
    }

    @Test fun 探针结果的三档各有唯一来路_没测过与测出不通不是一回事() {
        // ProbeOutcome 是 OsFacts 里的通道读数：NEVER_RUN（没测）与 DEAD（测出不通）并进任何一边
        // 都会造出假话（v1 把两者都画成黄灯待办，真机 2026-09-25 端口轮换后一路绿到 S3）。
        assertEquals(3, ProbeOutcome.values().size)
        val neverRun = Evidence(nowMs = 1_000_000L, credentials = CredentialsState.PAIRED)
        val dead = channelDead()
        assertEquals(CapStatus.ACTION, CapabilityCatalog.evaluate(neverRun).getValue(CapabilityCatalog.ADB_CHANNEL).status)
        assertEquals(CapStatus.FAILED, CapabilityCatalog.evaluate(dead).getValue(CapabilityCatalog.ADB_CHANNEL).status)
        assertEquals(CapStatus.GRANTED, CapabilityCatalog.evaluate(green()).getValue(CapabilityCatalog.ADB_CHANNEL).status)
    }
}
