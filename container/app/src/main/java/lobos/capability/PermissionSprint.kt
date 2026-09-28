package lobos.capability

import lobos.permissions.PermissionCatalog

/**
 * 授权冲刺 —— 「什么时候问人」的唯一判据（flow-spec §2.2）。
 *
 * 次序是拍过板的事实：**先配对连 adb → 连上后把每一项都经 adb 实测试开 → 实测没开掉的才弹人**。
 * 于是本层只有两档：
 *  - [REQUIRED]：配对**之前**该要的，只有「没有它就够不到配对」的那些（现在 = 通知发送：
 *    输码入口是通知栏 RemoteInput，通知不可见时入口根本不存在）；
 *  - [residue]：adb **实测过一次**且没开掉的差集 —— 这是「弹人」这一档的唯一来源。
 *
 * 两档之间没有「按档位推断这人一定得点」那一支：那种推断就是被真机定罪的「未试先判」
 * （AppOps 三项从没被 adb 试过就先钉成人点项），判据住在 [PermissionLedger] 与
 * [CapabilityCatalog.permAcquirers]，本层只读它的结论。
 *
 * 这一层只有计划（纯函数，可 JVM 单测钉死），发起动作住 ui 层：
 * 「问什么、按什么顺序问」是判据事实，「怎么把问题抛给系统」才是 Android 细节。
 */
object PermissionSprint {

    /**
     * 配对前的必要项 = 配对能力在**权限档**上的硬前置，从登记表推导而不是手写第二张清单：
     * 谁改 [CapabilityCatalog.ADB_CREDENTIALS] 的 requires，冲刺项跟着变。
     * 顺序取登记表声明序 —— `requires` 是 Set，迭代序不确定不许流到用户动作序列上。
     *
     * 注意：开发者选项 / 无线调试不是权限（不在 PermissionCatalog 里），它们由 [PairingGate]
     * 在用户点「开始配对」那一下现场引导，不占本冲刺的位。
     */
    val REQUIRED: List<String> = CapabilityCatalog
        .requiresInOrder(CapabilityCatalog.ADB_CREDENTIALS)
        .filter { PermissionCatalog.byId(it) != null }

    /**
     * adb 实测办不成、现在该弹给人的差集。三个条件缺一个都不许弹：
     *  - 静默通道真的在位（[PostPairingAutoFlow.ready]）：通道没起来时「没开掉」只是还没轮到，
     *    弹人等于把用户推去一个 adb 还没试过的授权页；
     *  - 该项**有实测账**且结局是 [AttemptOutcome.NEEDS_TAP] / [AttemptOutcome.UNSUPPORTED]；
     *  - 系统侧回读仍未授权（由 [pending] 收口）。
     *
     * 排序：保活锚（[Capability.keepAliveAnchor]）在前 —— 锚掉了整个常驻会被 ROM 清掉，
     * 其余项只是功能降级；同为锚/同为非锚时取登记表声明序。
     */
    fun residue(e: Evidence): List<String> {
        if (!PostPairingAutoFlow.ready(e)) return emptyList()
        val anchors = CapabilityCatalog.ALL.filter { it.keepAliveAnchor }.map { it.id }.toSet()
        val candidates = CapabilityCatalog.ALL.filter {
            PermissionCatalog.byId(it.id) != null && !it.optional && it.id !in REQUIRED &&
                e.attemptOutcome(it.id) in setOf(AttemptOutcome.NEEDS_TAP, AttemptOutcome.UNSUPPORTED)
        }.map { it.id }
        return candidates.filter { anchors.contains(it) } + candidates.filter { !anchors.contains(it) }
    }

    /**
     * 本轮还该要哪些：配对前的必要项 + adb 实测办不成的差集，都要**尚未授权**且本轮没问过。
     * [asked] = 本次开屏已经抛过问题的项：**一次开屏只闹一回**，用户拒了之后不许把他往同一个
     * 系统页里反复推 —— 欠账由折叠清单（[OnboardingFlow.debts]）继续可见。
     */
    fun pending(e: Evidence, asked: Set<String> = emptySet()): List<String> =
        (REQUIRED + residue(e)).distinct().filter { !e.granted(it) && it !in asked }

    /**
     * 下一项与它的**取法链首项**（弹窗 / 系统页 —— 由登记表按实测账决定，本层不挑手段）。
     * 返回 null = 这一轮该问的问完了。UI 只做「把这条 Acquisition 交出去」，
     * 于是冲刺与阶段卡共用同一条动作通道，不会长出第二套授权按钮逻辑。
     */
    fun next(e: Evidence, asked: Set<String>): Pair<String, Acquisition>? {
        val id = pending(e, asked).firstOrNull() ?: return null
        val acq = CapabilityCatalog.byId(id)?.acquirer?.invoke(e)?.firstOrNull() ?: return null
        return id to acq
    }
}
