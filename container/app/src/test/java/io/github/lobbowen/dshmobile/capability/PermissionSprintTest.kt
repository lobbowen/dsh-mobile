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
 * 冲刺是**静默**行为：开屏一瞬间把不需要 ADB 就能拿的授权依次抛给系统，界面上不出卡。
 * 这里钉的是计划本身 —— 顺序、必要项的来源、以及「不该出现在链上的东西」。
 * 顺序错了会直接改变用户体验（通知排第一是硬事实：它挡配对的输码入口）。
 */
class PermissionSprintTest {

    private fun ev(grants: Set<String> = emptySet()) = Evidence(nowMs = 1_000_000L, grants = grants)

    @Test fun 必要项从登记表的配对前置推导_不是手写第二张清单() {
        assertEquals(
            CapabilityCatalog.requiresInOrder(CapabilityCatalog.ADB_CREDENTIALS)
                .filter { PermissionCatalog.byId(it) != null },
            PermissionSprint.REQUIRED,
        )
        // 反事实钉死：通知发送是配对的物理前置（无通知 = 无输码入口），必须留在必要项里。
        assertTrue(PermissionSprint.REQUIRED.contains(PermissionCatalog.POST_NOTIFICATIONS))
    }

    @Test fun 冲刺首项必须是必要项_其余不得挡在前面() {
        assertEquals(PermissionSprint.REQUIRED.first(), PermissionSprint.ORDER.first())
        assertEquals(
            "锚与待选项不许挤掉必要项的位置",
            PermissionSprint.REQUIRED + PermissionSprint.ANCHORS + PermissionSprint.OPTIONAL,
            PermissionSprint.ORDER,
        )
        // 待选项一律「无前置、非加速器」：冲刺不能被自己的前置锁死（门禁规则 4 的镜像）
        for (id in PermissionSprint.OPTIONAL) {
            val c = CapabilityCatalog.byId(id)!!
            assertTrue("$id 有前置，不该进静默冲刺", c.requires.isEmpty())
            assertFalse("$id 是加速器/每次会话项，物理不可预置", c.optional)
        }
    }

    @Test fun 保活锚从登记表推导_不是手写第二张清单() {
        assertEquals(
            CapabilityCatalog.ALL
                .filter { it.keepAliveAnchor && it.id !in PermissionSprint.REQUIRED }.map { it.id },
            PermissionSprint.ANCHORS,
        )
        // 反事实钉死（真机 2026-09-26「锁屏后 App 被清理」的直接病根）：无障碍与通知读取
        // 是 :main 不被冻结的实证锚，必须在开屏就要，不许推给「等通道通了再静默办」。
        assertTrue(PermissionSprint.ANCHORS.contains(PermissionCatalog.ACCESSIBILITY))
        assertTrue(PermissionSprint.ANCHORS.contains(PermissionCatalog.NOTIFICATION_ACCESS))
        assertTrue(PermissionSprint.ANCHORS.contains(PermissionCatalog.BATTERY_OPTIMIZATION))
        // 锚住在 ANCHORS 档，不重复出现在 OPTIONAL 里
        assertTrue(PermissionSprint.ANCHORS.intersect(PermissionSprint.OPTIONAL.toSet()).isEmpty())
    }

    @Test fun 需要通道或每次会话的能力不进冲刺() {
        // device-owner 要 ADB 通道；mediaprojection 每次会话授权 —— 两者都不能在开屏静默要。
        assertFalse(PermissionSprint.ORDER.contains(CapabilityCatalog.DEVICE_OWNER))
        assertFalse(PermissionSprint.ORDER.contains(PermissionCatalog.MEDIAPROJECTION))
        // 环境开关不是权限，也不该被当成「授权」去要
        assertFalse(PermissionSprint.ORDER.contains(CapabilityCatalog.DEV_OPTIONS))
        assertFalse(PermissionSprint.ORDER.contains(CapabilityCatalog.WIRELESS_DEBUG))
    }

    @Test fun 需要人点的待选项仍然要问() {
        // 反面对照：AppOps 档没有 shell 通道（Android 17 已无 MANAGE_APP_OPS_MODES），只能人点 → 该要
        assertTrue(PermissionSprint.OPTIONAL.contains(PermissionCatalog.MANAGE_EXTERNAL_STORAGE))
    }

    @Test fun 一次开屏只闹一回_问过的项不再重复抛给用户() {
        val e = ev()
        val first = PermissionSprint.next(e, emptySet())
        assertEquals(PermissionSprint.REQUIRED.first(), first?.first)
        // 同一项已经问过 → 不再问；链继续往后走
        val asked = setOf(PermissionSprint.ORDER.first())
        assertEquals(PermissionSprint.ORDER[1], PermissionSprint.next(e, asked)?.first)
        // 全问过 = 链结束（欠账交给 F4 补齐行催，不靠开屏骚扰）
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
