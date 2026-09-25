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

    @Test fun 冲刺首项必须是必要项_其余待选项不得挡在前面() {
        assertEquals(PermissionSprint.REQUIRED.first(), PermissionSprint.ORDER.first())
        assertEquals(
            "待选项不许挤掉必要项的位置",
            PermissionSprint.REQUIRED + PermissionSprint.OPTIONAL,
            PermissionSprint.ORDER,
        )
        // 待选项一律「无前置、非加速器」：冲刺不能被自己的前置锁死（门禁规则 4 的镜像）
        for (id in PermissionSprint.OPTIONAL) {
            val c = CapabilityCatalog.byId(id)!!
            assertTrue("$id 有前置，不该进静默冲刺", c.requires.isEmpty())
            assertFalse("$id 是加速器/每次会话项，物理不可预置", c.optional)
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

    @Test fun 通道一通就能静默办的项不进冲刺() {
        // SECURE_SETTINGS 档（通知读取、无障碍）在 F4 由 `settings put secure` 静默开。
        // 开屏把人送进系统无障碍页 = 用户多点一次、我们一点没省（flow-spec §2.2「不进冲刺」）。
        assertFalse(PermissionSprint.ORDER.contains(PermissionCatalog.NOTIFICATION_ACCESS))
        assertFalse(PermissionSprint.ORDER.contains(PermissionCatalog.ACCESSIBILITY))
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
