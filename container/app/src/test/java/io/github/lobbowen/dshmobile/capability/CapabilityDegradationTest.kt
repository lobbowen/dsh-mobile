package io.github.lobbowen.dshmobile.capability

import io.github.lobbowen.dshmobile.permissions.PermissionCatalog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 能力模型 v2 的退化路径 golden（spec §8-2「假绿免疫」、§2.1 规则 2/3，R6）。
 *
 * 钉的是判据而不是文案：事故全部发生在「拿不到某项事实时怎么渲染」这一支上 ——
 * 首次安装被当成待办、DO 不可得被当成门槛、通道过期读数被当成可用、通知权限放错段。
 * 前四条都在真机咬过。顺序层面的免疫见 [OnboardingFlowTest]。
 */
class CapabilityDegradationTest {

    /** 全部权限档位的 id —— 表里加一档而这里没列，最后一条测试会红。 */
    private val ALL_GRANTS = setOf(
        PermissionCatalog.MANAGE_EXTERNAL_STORAGE,
        PermissionCatalog.REQUEST_INSTALL_PACKAGES,
        PermissionCatalog.SYSTEM_ALERT_WINDOW,
        PermissionCatalog.POST_NOTIFICATIONS,
        PermissionCatalog.BATTERY_OPTIMIZATION,
        PermissionCatalog.NOTIFICATION_ACCESS,
        PermissionCatalog.ACCESSIBILITY,
        PermissionCatalog.MEDIAPROJECTION,
    )

    private fun fresh(
        nowMs: Long = 1_000_000L,
        grants: Set<String> = ALL_GRANTS,
        deviceOwner: Boolean = false,
        ownerAttempt: OwnerAttempt? = null,
        channel: ChannelProbe = ChannelProbe(ProbeOutcome.LIVE, 1_000_000L, "uid=2000"),
        kernelChecks: List<CheckItem> = listOf(CheckItem("bundle", true)),
    ): Evidence = Evidence(
        nowMs = nowMs,
        devOptionsOn = true,
        wirelessDebugOn = true,
        credentials = CredentialsState.PAIRED,
        channel = channel,
        deviceOwner = deviceOwner,
        ownerAttempt = ownerAttempt,
        grants = grants,
        controlPlaneUp = true,
        kernelChecks = kernelChecks,
        channelTtlMs = Evidence.CHANNEL_TTL_MS,
    )

    private fun steps(e: Evidence) =
        PipelineProjection.project(e, CapabilityCatalog.evaluate(e)).associateBy { it.id }

    @Test fun 全新安装_没有任何一段被误判为已完成() {
        val rows = steps(Evidence(nowMs = 1_000_000L))
        assertFalse("全新设备不该有 DONE 段", rows.values.any { it.status == StepStatus.DONE })
        // 段行取「最可推进」的那一项：S0 亮 ACTION（差人点开关），S1 加速器则如实 BLOCKED 在通道后。
        assertEquals(StepStatus.ACTION, rows.getValue("S0").status)
        assertEquals(StepStatus.BLOCKED, rows.getValue("S1").status)
        assertEquals(StepStatus.ACTION, rows.getValue("S3").status)
        // S4 有待办且其中有可推进项（非全 BLOCKED）→ ACTION，不是死锁
        assertEquals(StepStatus.ACTION, rows.getValue("S4").status)
        assertEquals(CapabilityCatalog.DEV_OPTIONS, rows.getValue("S0").pendingCapId)
        // v1 的错法（凭据在册即绿）在此处必须拿不到 GRANTED
        assertEquals(CapStatus.ACTION, CapabilityCatalog.rawJudge(CapabilityCatalog.ADB_CHANNEL, Evidence())?.status)
    }

    @Test fun DeviceOwner不可得_仍可走完全管线到工作台() {
        val e = fresh(ownerAttempt = OwnerAttempt(1L, OwnerAttemptOutcome.REJECTED, "several users"))
        val rows = steps(e)
        assertEquals(StepStatus.DONE, rows.getValue("S0").status)
        assertEquals(StepStatus.DONE, rows.getValue("S2").status)
        assertEquals(StepStatus.DONE, rows.getValue("S3").status)
        assertEquals(StepStatus.DONE, rows.getValue("S4").status)
        // 加速器被平台拒绝只影响 S1 自己（灰显），不许外溢成门槛
        assertEquals(StepStatus.UNREACHABLE, rows.getValue("S1").status)
        assertEquals(CapStatus.UNREACHABLE, CapabilityCatalog.evaluate(e).getValue(CapabilityCatalog.DEVICE_OWNER).status)
        // 桥令牌不因 DO 缺席而少发一项 S2/S3 所需能力
        assertTrue(BridgeTokens.from(e).contains(PermissionCatalog.ACCESSIBILITY))
    }

    @Test fun 通道读数过期_立即不再算绿() {
        val live = fresh(channel = ChannelProbe(ProbeOutcome.LIVE, 1_000_000L, "uid=2000"))
        assertEquals(StepStatus.DONE, steps(live).getValue("S0").status)
        val stale = fresh(
            channel = ChannelProbe(ProbeOutcome.LIVE, 1_000_000L - Evidence.CHANNEL_TTL_MS - 1, "uid=2000")
        )
        assertFalse("过期读数续绿 = v1 假绿事故复现", steps(stale).values.any { it.id == "S4" && it.status == StepStatus.DONE })
        assertEquals(StepStatus.FAILED, steps(stale).getValue("S0").status)
        assertTrue(steps(stale).getValue("S0").detail.contains("已过期"))
    }

    @Test fun 通道明确不通_S0归因到探针而不是一片BLOCKED() {
        val e = fresh(channel = ChannelProbe(ProbeOutcome.DEAD, 999_000L, "ECONNREFUSED 127.0.0.1:37021"))
        val rows = steps(e)
        assertEquals(StepStatus.FAILED, rows.getValue("S0").status)
        assertEquals(CapabilityCatalog.ADB_CHANNEL, rows.getValue("S0").pendingCapId)
        assertTrue(rows.getValue("S0").detail.contains("ECONNREFUSED"))
    }

    @Test fun 登记表每一段都有能力_新增档位漏登记会在这里变红() {
        val segs = CapabilityCatalog.ALL.map { it.segment }.toSet()
        assertEquals(setOf("S0", "S1", "S2", "S3"), segs)
        // 通知权限登记在 S0（它是配对的物理前置），其余权限档仍在 S2
        val s0 = CapabilityCatalog.ALL.filter { it.segment == CapabilityCatalog.S0 }.map { it.id }.toSet()
        assertTrue("通知发送必须登记在 S0：S0 输码靠通知栏", s0.contains(PermissionCatalog.POST_NOTIFICATIONS))
        val s2 = CapabilityCatalog.ALL.filter { it.segment == CapabilityCatalog.S2 }.map { it.id }.toSet()
        assertEquals(
            "S2 权限能力须与 PermissionCatalog 的权限档一一对应",
            ALL_GRANTS - PermissionCatalog.POST_NOTIFICATIONS, s2,
        )
    }

    @Test fun 没有通知权限时配对是等待_不能是让人点的待办() {
        // 真机定罪的反事实：全新安装时「开始配对」把通知栏当唯一输码入口，而通知权限
        // 当年登记在 S2 —— 于是 S0 永远走不下去（onboarding-flow-spec §0 表第 3 行）。
        val e = Evidence(
            nowMs = 1_000_000L,
            devOptionsOn = true,
            wirelessDebugOn = true,
            grants = ALL_GRANTS - PermissionCatalog.POST_NOTIFICATIONS,
        )
        val v = CapabilityCatalog.evaluate(e)
        assertEquals(CapStatus.BLOCKED, v.getValue(CapabilityCatalog.ADB_CREDENTIALS).status)
        assertEquals(
            "等待 " + CapabilityCatalog.titleOf(PermissionCatalog.POST_NOTIFICATIONS),
            v.getValue(CapabilityCatalog.ADB_CREDENTIALS).detail,
        )
    }

    @Test fun 老设备通道在线但通知被回收_实测优先不许降级成等待() {
        // ROM 回收 post_notifications 是真机会发生的事（HANS/osense 案底）。此时凭据仍在册、探针仍 LIVE：
        // 若 DAG 推断能推翻实测，S0/S3/S4 会整片变成「等待 通知发送」，面板再也进不去 —— 而正确的表现是
        // 通道照旧绿、缺的那项授权出现在 F6 补齐清单（onboarding-flow-spec §2.2 认领规则）。
        val e = fresh(grants = ALL_GRANTS - PermissionCatalog.POST_NOTIFICATIONS)
        val v = CapabilityCatalog.evaluate(e)
        assertEquals(CapStatus.GRANTED, v.getValue(CapabilityCatalog.ADB_CREDENTIALS).status)
        assertEquals(CapStatus.GRANTED, v.getValue(CapabilityCatalog.ADB_CHANNEL).status)
        assertEquals(StepStatus.DONE, steps(e).getValue("S4").status)
        // 缺的那项也不许凭空消失：它自己的判据仍是 ACTION，等 F6 认领。
        assertEquals(CapStatus.ACTION, v.getValue(PermissionCatalog.POST_NOTIFICATIONS).status)
    }

    @Test fun 入口只看三要素_权限缺失不挡门() {
        val noOverlay = ALL_GRANTS - PermissionCatalog.SYSTEM_ALERT_WINDOW
        val rows = steps(fresh(grants = noOverlay))
        assertEquals(StepStatus.DONE, rows.getValue("S4").status)
        assertEquals(StepStatus.ACTION, rows.getValue("S2").status)
    }
}
