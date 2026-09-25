package io.github.lobbowen.dshmobile.capability

import io.github.lobbowen.dshmobile.permissions.PermissionCatalog

/**
 * 首启授权冲刺（flow-spec §2 的 **P0**，界面上**不出现**）：App 一打开就把「不需要 ADB
 * 就能拿」的授权按顺序一次要完。用户面对的是系统弹窗与系统授权页，不是我们的一排按钮。
 *
 * 这一层只有计划（纯函数，可 JVM 单测钉死），发起动作住 ui 层：
 * 「问什么、按什么顺序问」是判据事实，「怎么把问题抛给系统」才是 Android 细节。
 */
object PermissionSprint {

    /**
     * 必要项 = 配对能力在**权限档**上的硬前置，从登记表推导而不是手写第二张清单：
     * 谁改 [CapabilityCatalog.ADB_CREDENTIALS] 的 requires，冲刺项跟着变。
     * 顺序取登记表声明序 —— `requires` 是 Set，迭代序不确定不许流到用户动作序列上。
     */
    val REQUIRED: List<String> = CapabilityCatalog
        .requiresInOrder(CapabilityCatalog.ADB_CREDENTIALS)
        .filter { PermissionCatalog.byId(it) != null }

    /**
     * 保活锚（[Capability.keepAliveAnchor]）：电池豁免 / 无障碍 / 通知读取。
     *
     * 它们**必须**在开屏就问，不许推给「等通道通了静默办」—— 那是循环依赖：
     * 无障碍绑定是 :main 不被 ColorOS HANS 冻结的唯一实证锚（ContainerSupervisor 顶部），
     * 没有锚 → 锁屏清掉 :main → 通道与运行时一起死 → 那条「静默办」的通道永远等不到。
     * 真机 2026-09-26 定罪：上一版按「能静默办就先不打扰用户」把它们排除出冲刺，
     * 用户看到的现象就是「锁屏之后 App 被清理掉」。
     * 静默通道（SILENT_VIA_ADB）依然留在取法链里，但只是**降级位**：通道先通就少闹一次，
     * 不通就由 P0 现场要。
     */
    val ANCHORS: List<String> = CapabilityCatalog.ALL
        .filter { it.keepAliveAnchor && it.id !in REQUIRED }.map { it.id }

    /** 其余待选项：权限档、无前置、非可选加速器，且不属于上面两档。 */
    val OPTIONAL: List<String> = CapabilityCatalog.ALL.filter {
        PermissionCatalog.byId(it.id) != null && it.id !in REQUIRED && it.id !in ANCHORS &&
            it.requires.isEmpty() && !it.optional
    }.map { it.id }

    /** 冲刺顺序：配对前置 → 保活锚 → 其余（挡路的先要，同一件事只做一次）。 */
    val ORDER: List<String> = REQUIRED + ANCHORS + OPTIONAL

    /**
     * 本轮还该要哪些。[asked] = 本次开屏已经抛过问题的项：**一次开屏只闹一回**，
     * 用户拒了之后不许把他往同一个系统页里反复推 —— 那些欠账归 F4 补齐清单，由用户主动催。
     */
    fun pending(e: Evidence, asked: Set<String> = emptySet()): List<String> =
        ORDER.filter { !e.granted(it) && it !in asked }

    /**
     * 下一项与它的**取法链首项**（弹窗 / 系统页 / DO 静默 —— 由登记表决定，本层不挑手段）。
     * 返回 null = 这一轮该问的问完了。UI 只做「把这条 Acquisition 交出去」，
     * 于是冲刺与阶段卡共用同一条动作通道，不会长出第二套授权按钮逻辑。
     */
    fun next(e: Evidence, asked: Set<String>): Pair<String, Acquisition>? {
        val id = pending(e, asked).firstOrNull() ?: return null
        val acq = CapabilityCatalog.byId(id)?.acquirer?.invoke(e)?.firstOrNull() ?: return null
        return id to acq
    }
}
