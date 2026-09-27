package io.github.lobbowen.dshmobile.capability

import io.github.lobbowen.dshmobile.permissions.PermissionCatalog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P0 首启授权冲刺 golden（flow-spec §2.2）。
 *
 * 2026-09-27 收敛：开屏只留 [PermissionSprint.REQUIRED]（通知发送一项）。
 * 凡取法链首项是 SILENT_* 的能力（无障碍 / 通知读取 / 电池白名单 / DO 派生的 AppOps）
 * 一律撤出开屏，改由 [PostPairingAutoFlow] 在配对成功的**同一前台会话内**静默办。
 *
 * 因此本测试钉的是新事实：ANCHORS/OPTIONAL 均为空、ORDER 只剩必要项，
 * 以及「能经 ADB 无感的三项不得出现在开屏链上」。顺序错了仍会直接改变用户体验
 * （通知排第一是硬事实：它挡配对的输码入口）。
 */
class PermissionSprintTest {

    private fun ev(grants: Set<String> = emptySet()) = Evidence(nowMs = 1_000_000L, grants = grants)

    /**
     * 理想证据：通道在线 + DO 在位，用于复算「这条能不能静默办」。
     * 与 [PermissionSprint] 内部的 SILENT_DEFERRABLE 推导同一姿势 —— 测试自己复算一遍，
     * 而不是去读私有字段，这样推导逻辑变了这里会红。
     */
    private fun ideal() = Evidence(
        nowMs = 0L,
        credentials = CredentialsState.PAIRED,
        channel = ChannelProbe(ProbeOutcome.LIVE, 0L, "推导用理想读数"),
        deviceOwner = true,
    )

    private fun firstKind(id: String, e: Evidence): AcquireKind? =
        CapabilityCatalog.byId(id)?.acquirer?.invoke(e)?.firstOrNull()?.kind

    @Test fun 必要项从登记表的配对前置推导_不是手写第二张清单() {
        assertEquals(
            CapabilityCatalog.requiresInOrder(CapabilityCatalog.ADB_CREDENTIALS)
                .filter { PermissionCatalog.byId(it) != null },
            PermissionSprint.REQUIRED,
        )
        // 反事实钉死：通知发送是配对的物理前置（无通知 = 无输码入口），必须留在必要项里。
        assertTrue(PermissionSprint.REQUIRED.contains(PermissionCatalog.POST_NOTIFICATIONS))
    }

    @Test fun 冲刺顺序只由三档拼成_本版锚与待选项均为空() {
        assertEquals(
            "顺序只能由 REQUIRED + ANCHORS + OPTIONAL 拼成，不许另插私货",
            PermissionSprint.REQUIRED + PermissionSprint.ANCHORS + PermissionSprint.OPTIONAL,
            PermissionSprint.ORDER,
        )
        // 收敛后的硬事实：开屏只问通知发送一项。
        assertEquals(listOf(PermissionCatalog.POST_NOTIFICATIONS), PermissionSprint.ORDER)
        assertTrue("本版锚全部有静默路径，不应再占开屏位", PermissionSprint.ANCHORS.isEmpty())
        assertTrue("本版待选项全部有静默路径，不应再占开屏位", PermissionSprint.OPTIONAL.isEmpty())
    }

    @Test fun 保活锚从登记表推导_本版全部由静默路径接管_不是被删掉() {
        // 反事实钉死（真机 2026-09-26「锁屏后 App 被清理」的病根是锚掉了）：
        // 锚没有被删，只是不再由开屏抢问 —— 它们都有 SILENT_* 的取法链首项，
        // 由配对后的 [PostPairingAutoFlow] + ContainerSupervisor 的低频监护无感自愈。
        val anchors = CapabilityCatalog.ALL.filter { it.keepAliveAnchor }.map { it.id }
        assertEquals(
            "锚仍由登记表的 keepAliveAnchor 位推导，数量与成员不许悄悄变",
            listOf(
                PermissionCatalog.ACCESSIBILITY,
                PermissionCatalog.BATTERY_OPTIMIZATION,
                PermissionCatalog.NOTIFICATION_ACCESS,
            ).sorted(),
            anchors.sorted(),
        )
        for (id in anchors) {
            val kind = firstKind(id, ideal())
            assertTrue(
                "$id 应有静默首项（否则不能从开屏撤下它）：$kind",
                kind == AcquireKind.SILENT_VIA_ADB || kind == AcquireKind.SILENT_VIA_DO,
            )
            assertFalse("$id 有静默路径，不该再进开屏 ANCHORS", PermissionSprint.ANCHORS.contains(id))
            assertFalse("$id 有静默路径，不该再进开屏 ORDER", PermissionSprint.ORDER.contains(id))
        }
        // 锚与待选项是互斥档位，不许重复出现（老不变式，继续钉）。
        assertTrue(PermissionSprint.ANCHORS.intersect(PermissionSprint.OPTIONAL.toSet()).isEmpty())
    }

    @Test fun 能经ADB无感的三项不得出现在开屏ORDER里() {
        // 收敛的**核心断言**：无障碍 / 通知读取 / 电池白名单都有 SILENT_VIA_ADB 首项，
        // 开屏再抢问一遍 = 让用户对着三个系统页点，正是本次要消灭的按钮墙。
        val three = listOf(
            PermissionCatalog.ACCESSIBILITY,
            PermissionCatalog.NOTIFICATION_ACCESS,
            PermissionCatalog.BATTERY_OPTIMIZATION,
        )
        for (id in three) {
            assertEquals("$id 的静默路径必须是取法链首项", AcquireKind.SILENT_VIA_ADB, firstKind(id, ideal()))
            assertFalse("$id 必须由配对后的自动流办，不许出现在开屏 ORDER", PermissionSprint.ORDER.contains(id))
            assertFalse("$id 不许出现在开屏 pending 里", PermissionSprint.pending(ev()).contains(id))
        }
    }

    @Test fun 需要通道或每次会话的能力不进冲刺() {
        // device-owner 要 ADB 通道；mediaprojection 每次会话授权 —— 两者都不能在开屏静默要。
        assertFalse(PermissionSprint.ORDER.contains(CapabilityCatalog.DEVICE_OWNER))
        assertFalse(PermissionSprint.ORDER.contains(PermissionCatalog.MEDIAPROJECTION))
        // 环境开关不是权限，也不该被当成「授权」去要
        assertFalse(PermissionSprint.ORDER.contains(CapabilityCatalog.DEV_OPTIONS))
        assertFalse(PermissionSprint.ORDER.contains(CapabilityCatalog.WIRELESS_DEBUG))
    }

    @Test fun AppOps档不再由开屏问_静默不可用时才回落人点() {
        // 反面已反转：旧版要求开屏把 MANAGE_EXTERNAL_STORAGE 抛给人点；
        // 新版 DO 在位时它是 SILENT_VIA_DO，DO 不可达时判 UNREACHABLE、不重试，
        // 不复用「去系统页点一下」的回落 —— 所以开屏链上必须没有它。
        assertFalse(PermissionSprint.ORDER.contains(PermissionCatalog.MANAGE_EXTERNAL_STORAGE))
        assertFalse(PermissionSprint.OPTIONAL.contains(PermissionCatalog.MANAGE_EXTERNAL_STORAGE))
        // 但取法链的降级项仍在：DO 不在位时人点仍是一条路（能力没被做成不可达）。
        assertEquals(AcquireKind.USER_TAP, firstKind(PermissionCatalog.MANAGE_EXTERNAL_STORAGE, ev()))
    }

    @Test fun 一次开屏只闹一回_问过的项不再重复抛给用户() {
        val e = ev()
        val first = PermissionSprint.next(e, emptySet())
        assertEquals(PermissionSprint.REQUIRED.first(), first?.first)
        // 本轮只有一项：问过即结束（欠账交给配对后的自动流 / 工作台，不靠开屏骚扰）。
        assertNull(PermissionSprint.next(e, PermissionSprint.ORDER.toSet()))
        assertTrue(PermissionSprint.pending(e, PermissionSprint.ORDER.toSet()).isEmpty())
    }

    @Test fun 下一项给的是它的取法链首项_手段由登记表决定() {
        val (id, acq) = PermissionSprint.next(ev(), emptySet())!!
        assertEquals(PermissionCatalog.POST_NOTIFICATIONS, id)
        // 通知是 RUNTIME 档 → 系统弹窗；这条如果被改成 USER_TAP，开屏就会多出一个授权按钮。
        assertEquals(AcquireKind.RUNTIME_DIALOG, acq.kind)
        assertEquals(id, acq.target)
        // 已授予的项不再出现在 pending 里
        assertTrue(PermissionSprint.pending(ev(setOf(PermissionCatalog.POST_NOTIFICATIONS)))
            .none { it == PermissionCatalog.POST_NOTIFICATIONS })
    }
}
