package lobos.capability

import lobos.permissions.PermissionCatalog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P0 首启授权冲刺 golden（flow-spec §2.2；次序是 2026-09-28 拍板的事实）：
 *
 *   ① 配对/adb 是第一步且跳不过 → 配对前只问「没有它就够不到配对」的那几项（[PermissionSprint.REQUIRED]）；
 *   ② 连上之后每一项都先经 adb **实试** → 没有实测账时，有静默路的项其取法链首项必须是 SILENT_*；
 *   ③ 实测没开掉的才回落人点 → 只有账上是 [AttemptOutcome.NEEDS_TAP] / [AttemptOutcome.UNSUPPORTED]
 *      的项才进弹人清单（[PermissionSprint.residue]），锚在前。
 *
 * 本版为什么**反着钉**：旧版在这里钉的是「AppOps 三项只能人点」，而那三项从没被 adb 下发过
 * —— 那就是被真机定罪的「未试先判」。所以「有静默路就先试」与「试完才弹人」两条都必须
 * 由实测账说话，谁再把档位当判据预先判死，这里就红。
 */
class PermissionSprintTest {

    /** 通道从没探过 = 全新设备还没配对。此时 adb 一条命令都下不去。 */
    private fun ev(attempts: Map<String, SilentAttempt> = emptyMap(), grants: Set<String> = emptySet()) =
        Evidence(nowMs = 1_000_000L, grants = grants, permissionAttempts = attempts)

    /** adb 真的能下发（凭据在册 + 通道 LIVE 且未过期）。 */
    private fun adbReady(
        attempts: Map<String, SilentAttempt> = emptyMap(),
        grants: Set<String> = emptySet(),
    ) = Evidence(
        nowMs = 1_000_000L,
        credentials = CredentialsState.PAIRED,
        channel = ChannelProbe(ProbeOutcome.LIVE, 1_000_000L, "uid=2000 shell"),
        grants = grants,
        permissionAttempts = attempts,
    )

    private fun firstKind(id: String, e: Evidence): AcquireKind? =
        CapabilityCatalog.byId(id)?.acquirer?.invoke(e)?.firstOrNull()?.kind

    private fun booked(id: String, outcome: AttemptOutcome) =
        id to SilentAttempt(outcome, 999_000L, "单测造的读数")

    /** 有 adb 静默路的权限项（通道在位、无实测账时的链首 = SILENT_*），由登记表推导。 */
    private fun silentlyAcquirable(): List<String> = CapabilityCatalog.ALL
        .filter { PermissionCatalog.byId(it.id) != null }
        .map { it.id }
        .filter { firstKind(it, adbReady()) == AcquireKind.SILENT_VIA_ADB }

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
        // 次序是拍板的事实，所以这条定罪用例换了内容但没换判据：**实测办不成的差集**
        // 也不许挤到未满足的配对前置项前面（旧版钉的是「锚与 AppOps 待选项排在必要项之前」）。
        val e = adbReady(
            attempts = mapOf(
                booked(PermissionCatalog.ACCESSIBILITY, AttemptOutcome.NEEDS_TAP),
                booked(PermissionCatalog.BATTERY_OPTIMIZATION, AttemptOutcome.UNSUPPORTED),
            )
        )
        assertTrue("前提：差集里确实有东西，否则这条排序断言是空的", PermissionSprint.residue(e).isNotEmpty())
        assertEquals(PermissionSprint.REQUIRED.first(), PermissionSprint.pending(e).first())
        assertEquals(
            "顺序只能由 REQUIRED + 实测差集拼成，不许另插私货",
            PermissionSprint.REQUIRED + PermissionSprint.residue(e),
            PermissionSprint.pending(e),
        )
    }

    @Test fun 保活锚从登记表推导_不是手写第二张清单() {
        // 锚这一族没有因为「先配对后实试」被删掉：成员与数量仍由登记表的 anchor 位推导，
        // 病根（真机 2026-09-26「锁屏后 App 被清理」）就在锚上，所以谁动锚都要在这里红。
        val anchors = CapabilityCatalog.ALL.filter { it.keepAliveAnchor }.map { it.id }
        assertEquals(
            "锚仍由 keepAliveAnchor 推导，数量与成员不许悄悄变",
            listOf(
                PermissionCatalog.ACCESSIBILITY,
                PermissionCatalog.BATTERY_OPTIMIZATION,
                PermissionCatalog.NOTIFICATION_ACCESS,
            ).sorted(),
            anchors.sorted(),
        )
        // 本版修正的是**推导方向**：锚有 adb 静默路，所以通道在位时链首必须是静默项，
        // 而不是像旧版那样按档位先钉成「只能人点」（= 未试先判，债表 SP-1）。
        val ready = adbReady()
        for (id in anchors) {
            assertEquals("$id 在 adb 在手时必须先试静默路", AcquireKind.SILENT_VIA_ADB, firstKind(id, ready))
        }
        // 弹人差集里锚在前 —— 这是排序判据，取的是同一个 keepAliveAnchor 位，不是第二张手写清单。
        val both = adbReady(
            attempts = mapOf(
                booked(PermissionCatalog.NOTIFICATION_ACCESS, AttemptOutcome.NEEDS_TAP),
                booked(PermissionCatalog.MANAGE_EXTERNAL_STORAGE, AttemptOutcome.NEEDS_TAP),
            )
        )
        assertEquals(
            listOf(PermissionCatalog.NOTIFICATION_ACCESS, PermissionCatalog.MANAGE_EXTERNAL_STORAGE),
            PermissionSprint.residue(both),
        )
    }

    @Test fun 配对之前只问必要项_其余一律不弹人() {
        // 全新设备（adb 还没连）：弹人清单必须恰好等于配对前置项。
        // 旧版在这里排着一串「只能人点」的推断项 —— 用户第一眼就被推去三个系统页，
        // 而那些页在 adb 在手之后根本不需要人点。
        assertEquals(PermissionSprint.REQUIRED, PermissionSprint.pending(ev()))
        assertTrue("通道没起来时 adb 还没试过，一条都不许算「办不成」", PermissionSprint.residue(ev()).isEmpty())
        // 已授予的项不再要：清单必须跟着系统侧回读走。
        assertTrue(
            PermissionSprint.pending(ev(grants = setOf(PermissionCatalog.POST_NOTIFICATIONS)))
                .none { it == PermissionCatalog.POST_NOTIFICATIONS },
        )
    }

    @Test fun 有静默路的项_没有实测账就先试_不许未试先判() {
        val ready = adbReady()
        assertEquals(
            "adb 在位时，静默路覆盖这几项（AppOps 三项与运行时权限都在内：它们从没被试过就先被钉成人点项）",
            setOf(
                PermissionCatalog.POST_NOTIFICATIONS,
                PermissionCatalog.MANAGE_EXTERNAL_STORAGE,
                PermissionCatalog.REQUEST_INSTALL_PACKAGES,
                PermissionCatalog.SYSTEM_ALERT_WINDOW,
                PermissionCatalog.BATTERY_OPTIMIZATION,
                PermissionCatalog.NOTIFICATION_ACCESS,
                PermissionCatalog.ACCESSIBILITY,
            ),
            silentlyAcquirable().toSet(),
        )
        for (id in silentlyAcquirable()) {
            assertEquals("$id 的链首必须是静默下发", AcquireKind.SILENT_VIA_ADB, firstKind(id, ready))
            assertFalse("$id 还没实测过，不许进弹人清单", PermissionSprint.residue(ready).contains(id))
        }
        // 只有「每次会话」那一档真的没有静默路：adb 替不了用户那一下「立即开始」。
        assertEquals(AcquireKind.USER_TAP, firstKind(PermissionCatalog.MEDIAPROJECTION, ready))
        // 双向对照：运行时权限在**通道还没起来**时仍由系统弹窗承担 —— 配对之前就得先拿到它，
        // 静默路是配对之后的事。把这条改成静默优先，S0 就会被自己的前置锁死。
        assertEquals(AcquireKind.RUNTIME_DIALOG, firstKind(PermissionCatalog.POST_NOTIFICATIONS, ev()))
    }

    @Test fun adb试完没开掉的才弹人_锚排在最前() {
        val e = adbReady(
            attempts = mapOf(
                booked(PermissionCatalog.MANAGE_EXTERNAL_STORAGE, AttemptOutcome.NEEDS_TAP),
                booked(PermissionCatalog.ACCESSIBILITY, AttemptOutcome.UNSUPPORTED),
                booked(PermissionCatalog.BATTERY_OPTIMIZATION, AttemptOutcome.NEEDS_TAP),
            )
        )
        // 锚（无障碍 / 电池豁免）在前：锚掉了整条常驻会被 ROM 清掉，其余只是功能降级。
        // 同为锚取登记表声明序（电池豁免声明在无障碍之前）。
        assertEquals(
            listOf(
                PermissionCatalog.BATTERY_OPTIMIZATION,
                PermissionCatalog.ACCESSIBILITY,
                PermissionCatalog.MANAGE_EXTERNAL_STORAGE,
            ),
            PermissionSprint.residue(e),
        )
        // 账上记着「adb 在这台机办不成」，链首就不再排静默项（同一命令不每开一次屏重放一遍）。
        for (id in PermissionSprint.residue(e)) {
            assertEquals("$id 应回落人点", AcquireKind.USER_TAP, firstKind(id, e))
        }
    }

    @Test fun 需要人点的待选项仍然要问() {
        // 「谁需要人点」不再按档位推断，但**要人点的一定要被问**这一条没变，而且它现在更难违反：
        // 账上记着办不成的非可选权限项，一项都不许被静默吞掉。旧版的罪是「开屏不问 +
        // 自动流办不到」= 双无状态（债表 SP-1）。
        val gated = CapabilityCatalog.ALL
            .filter {
                PermissionCatalog.byId(it.id) != null && !it.optional &&
                    !PermissionSprint.REQUIRED.contains(it.id)
            }
            .map { it.id }
        val tried = adbReady(attempts = gated.associate { booked(it, AttemptOutcome.NEEDS_TAP) })
        assertEquals(
            "试完办不成的每一项都必须进弹人差集",
            gated.sorted(), PermissionSprint.residue(tried).sorted(),
        )
        // 双向对照：同一批项在**没有实测账**时一条都不进差集 —— 那时它们该被 adb 试，不该被人点。
        assertTrue(PermissionSprint.residue(adbReady()).isEmpty())
        // 「既没人点也没人试」在本设计里只允许一种合法成因：每次会话那一档（屏幕捕获），
        // 它在登记表上就标着 optional。任何新增的非可选权限项若既没有 adb 静默路、又不被
        // 配对前置认领，就会在这里红 —— 那正是必须回去补静默路（或明确它是配对前置）的信号。
        val stranded = CapabilityCatalog.ALL
            .filter {
                PermissionCatalog.byId(it.id) != null && !it.optional &&
                    !PermissionSprint.REQUIRED.contains(it.id) &&
                    firstKind(it.id, adbReady()) != AcquireKind.SILENT_VIA_ADB
            }
            .map { it.id }
        assertEquals("非可选权限项必须有 adb 静默路，否则就是双无状态", emptyList<String>(), stranded)
    }

    @Test fun 账上是SILENT_OK而判据未绿_先无声要回来不弹人() {
        // ROM 回收掉已授予的静默项是真机会发生的事（HANS/osense 案底）。
        // 正确处理是再无声要一次（自动流），而不是把用户推去系统页。
        val e = adbReady(attempts = mapOf(booked(PermissionCatalog.ACCESSIBILITY, AttemptOutcome.SILENT_OK)))
        assertEquals(AcquireKind.SILENT_VIA_ADB, firstKind(PermissionCatalog.ACCESSIBILITY, e))
        assertFalse(PermissionSprint.residue(e).contains(PermissionCatalog.ACCESSIBILITY))
        assertTrue(
            "回收项必须由配对后的自动流认领（否则它会既不进冲刺也不进自动流 = 静默吞掉）",
            PostPairingAutoFlow.plan(e).contains(PermissionCatalog.ACCESSIBILITY),
        )
    }

    @Test fun 通道掉线时静默项回落人点_但不进弹人清单() {
        // adb 半路死了（端口轮换 / 配对被系统清掉）：此刻只有人能开，链首回落 USER_TAP；
        // 而「弹人清单」仍以实测账为据 —— 没试过的项不许因为掉线就被记成办不成。
        val e = ev(attempts = mapOf(booked(PermissionCatalog.ACCESSIBILITY, AttemptOutcome.SILENT_OK)))
        assertEquals(AcquireKind.USER_TAP, firstKind(PermissionCatalog.ACCESSIBILITY, e))
        assertTrue(PermissionSprint.residue(e).isEmpty())
    }

    @Test fun 需要通道或每次会话的能力不进冲刺() {
        val tried = adbReady(
            attempts = CapabilityCatalog.ALL
                .filter { PermissionCatalog.byId(it.id) != null }
                .associate { booked(it.id, AttemptOutcome.NEEDS_TAP) }
        )
        assertFalse("屏幕捕获每次会话授权，冲刺里要了也白要",
            PermissionSprint.residue(tried).contains(PermissionCatalog.MEDIAPROJECTION))
        for (env in listOf(CapabilityCatalog.DEV_OPTIONS, CapabilityCatalog.WIRELESS_DEBUG)) {
            assertFalse("$env 是环境开关不是权限，不许被当成授权去要",
                PermissionSprint.residue(tried).contains(env) || PermissionSprint.REQUIRED.contains(env))
        }
    }

    @Test fun 一次开屏只闹一回_问过的项不再重复抛给用户() {
        val e = ev()
        assertEquals(PermissionSprint.REQUIRED.first(), PermissionSprint.next(e, emptySet())?.first)
        assertNull("本轮问完就结束：欠账由折叠清单继续可见，不靠开屏骚扰",
            PermissionSprint.next(e, PermissionSprint.REQUIRED.toSet()))
        assertTrue(PermissionSprint.pending(e, PermissionSprint.REQUIRED.toSet()).isEmpty())
    }

    @Test fun 下一项给的是它的取法链首项_手段由登记表决定() {
        val (id, acq) = PermissionSprint.next(ev(), emptySet())!!
        assertEquals(PermissionCatalog.POST_NOTIFICATIONS, id)
        // 通知是 RUNTIME 档 → 系统弹窗；这条如果被改成 USER_TAP，开屏就会多出一个授权按钮。
        assertEquals(AcquireKind.RUNTIME_DIALOG, acq.kind)
        assertEquals(id, acq.target)
    }
}
