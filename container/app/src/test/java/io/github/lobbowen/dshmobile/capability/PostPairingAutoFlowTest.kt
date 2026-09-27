package io.github.lobbowen.dshmobile.capability

import io.github.lobbowen.dshmobile.permissions.PermissionCatalog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 配对后自动适配流 golden。
 *
 * 这层是「静默即唯一入口」的执行计划：开屏不再问什么、欠账由谁办，全由这里钉死。
 * 三条不许回退的纪律（见 [PostPairingAutoFlow] 的注释）：
 * 1. [PostPairingAutoFlow.plan] 的判据 = 非 optional 且未 GRANTED 且取法链首项是 SILENT_*；
 * 2. [CapabilityCatalog.DEVICE_OWNER] **始终在队列里** —— 它是 AppOps 档唯一的静默前提，
 *    即使判据会落 UNREACHABLE，也必须由本流试过一次，而不是从计划里消失；
 * 3. [PostPairingAutoFlow.ready] 在「凭据在册」或「通道在线」任一成立时为 true ——
 *    配对刚成功那一帧凭据已在册而探针还没 LIVE，只等通道会把自动流推迟到下一世。
 */
class PostPairingAutoFlowTest {

    private val NOW = 1_000_000L
    private val LIVE = ChannelProbe(ProbeOutcome.LIVE, NOW, "shell 在线")

    private fun ev(
        creds: CredentialsState = CredentialsState.NO_KEY,
        channel: ChannelProbe = ChannelProbe(ProbeOutcome.NEVER_RUN),
        deviceOwner: Boolean = false,
        grants: Set<String> = emptySet(),
    ) = Evidence(
        nowMs = NOW,
        credentials = creds,
        channel = channel,
        deviceOwner = deviceOwner,
        grants = grants,
    )

    @Test fun 计划按登记表声明序排列_且通道与DO齐备时覆盖全部静默项() {
        val e = ev(creds = CredentialsState.PAIRED, channel = LIVE, deviceOwner = true)
        assertEquals(
            listOf(
                CapabilityCatalog.DEVICE_OWNER,
                PermissionCatalog.MANAGE_EXTERNAL_STORAGE,
                PermissionCatalog.REQUEST_INSTALL_PACKAGES,
                PermissionCatalog.SYSTEM_ALERT_WINDOW,
                PermissionCatalog.BATTERY_OPTIMIZATION,
                PermissionCatalog.NOTIFICATION_ACCESS,
                PermissionCatalog.ACCESSIBILITY,
            ),
            PostPairingAutoFlow.plan(e),
        )
        // 声明序 = 执行序：runAutoFlow 串行下发，多条 settings put 并发会互相覆盖服务名单。
        assertEquals(
            "plan 必须跟随 ALL 的声明序",
            CapabilityCatalog.ALL.map { it.id }.filter { it in PostPairingAutoFlow.plan(e) },
            PostPairingAutoFlow.plan(e),
        )
    }

    @Test fun DeviceOwner无条件在队列里_即使不可达也不许从计划里消失() {
        // 什么都没有（无凭据、无通道、DO 不在位）：队列里仍要有 device-owner。
        // 它由执行器读判据决定成败；平台拒绝落 UNREACHABLE 后不重试、不阻塞后续。
        assertEquals(listOf(CapabilityCatalog.DEVICE_OWNER), PostPairingAutoFlow.plan(ev()))
        // 已经是 DO 也照样在列：本流是「试一次」的入口，跳过与否由执行器读判据决定。
        assertTrue(
            PostPairingAutoFlow.plan(ev(deviceOwner = true)).contains(CapabilityCatalog.DEVICE_OWNER)
        )
    }

    @Test fun 只有通道在线时_AppOps三项不进计划_ADB档静默项照常进() {
        // DO 不在位：AppOps 三项（全部文件 / 安装未知应用 / 悬浮窗）没有静默路径 → 不进计划。
        val e = ev(channel = LIVE)
        assertEquals(
            listOf(
                CapabilityCatalog.DEVICE_OWNER,
                PermissionCatalog.BATTERY_OPTIMIZATION,
                PermissionCatalog.NOTIFICATION_ACCESS,
                PermissionCatalog.ACCESSIBILITY,
            ),
            PostPairingAutoFlow.plan(e),
        )
        assertFalse(PermissionCatalog.MANAGE_EXTERNAL_STORAGE in PostPairingAutoFlow.plan(e))
    }

    @Test fun 已GRANTED的项被跳过() {
        val e = ev(
            creds = CredentialsState.PAIRED, channel = LIVE, deviceOwner = true,
            grants = setOf(
                PermissionCatalog.ACCESSIBILITY,
                PermissionCatalog.NOTIFICATION_ACCESS,
                PermissionCatalog.BATTERY_OPTIMIZATION,
            ),
        )
        val plan = PostPairingAutoFlow.plan(e)
        assertFalse(PermissionCatalog.ACCESSIBILITY in plan)
        assertFalse(PermissionCatalog.NOTIFICATION_ACCESS in plan)
        assertFalse(PermissionCatalog.BATTERY_OPTIMIZATION in plan)
        // 未授予的 AppOps 项照旧在列（DO 在位 → SILENT_VIA_DO）。
        assertTrue(PermissionCatalog.MANAGE_EXTERNAL_STORAGE in plan)
    }

    @Test fun 没有静默路径的项不进计划_通知发送与屏幕捕获不归本流() {
        val e = ev(creds = CredentialsState.PAIRED, channel = LIVE, deviceOwner = true)
        // 通知发送是 RUNTIME 档 → 弹窗，不是静默；它属于开屏 REQUIRED，不属于配对后自动流。
        assertFalse(PermissionCatalog.POST_NOTIFICATIONS in PostPairingAutoFlow.plan(e))
        // mediaprojection 每次会话授权，物理不可预置。
        assertFalse(PermissionCatalog.MEDIAPROJECTION in PostPairingAutoFlow.plan(e))
    }

    @Test fun 计划与就绪判定幂等_只读快照不写状态() {
        val e = ev(creds = CredentialsState.PAIRED, channel = LIVE, deviceOwner = true)
        val first = PostPairingAutoFlow.plan(e)
        assertEquals(first, PostPairingAutoFlow.plan(e))
        assertEquals(first, PostPairingAutoFlow.plan(e))
        // ready 同样只读：反复问不会改变结论（UI 每轮采集都会问它）。
        assertTrue(PostPairingAutoFlow.ready(e))
        assertTrue(PostPairingAutoFlow.ready(e))
    }

    @Test fun ready门槛_凭据在册或通道在线任一成立() {
        // 都没有：不跑（不能拿「什么都没配好」去下发静默命令）。
        assertFalse(PostPairingAutoFlow.ready(ev()))
        // 刚配好、探针还没跑 —— 凭据在册就够（否则自动流会被推迟到下一世）。
        assertTrue(
            PostPairingAutoFlow.ready(
                ev(creds = CredentialsState.PAIRED, channel = ChannelProbe(ProbeOutcome.NEVER_RUN))
            )
        )
        // 老设备：凭据在册但通道死着，仍然进（自动流自己会判每项可达性）。
        assertTrue(
            PostPairingAutoFlow.ready(
                ev(creds = CredentialsState.PAIRED, channel = ChannelProbe(ProbeOutcome.DEAD, NOW, "ECONNREFUSED"))
            )
        )
        // 只有通道在线：也进（凭据可能刚被回收）。
        assertTrue(PostPairingAutoFlow.ready(ev(channel = LIVE)))
        // 通道读数过期不算「在线」——与 Evidence.channelLive 同一把尺子。
        assertFalse(
            PostPairingAutoFlow.ready(
                ev(channel = ChannelProbe(ProbeOutcome.LIVE, NOW - Evidence.CHANNEL_TTL_MS - 1, "旧读数"))
            )
        )
    }
}
