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
     * 待选项 = 现在拿最便宜、但**不挡配对**的授权：权限档、无前置、非可选加速器，
     * 且**没有静默通道**。最后那半条是刻意的 —— `settings put secure` 一档（通知读取、无障碍）
     * 在通道打通后由 F4 静默办（flow-spec §2.2「不进冲刺」），开屏把人一路送进系统的
     * 无障碍设置页，是「用户点两次、我们省零次」的负收益。
     * `mediaprojection` 因 optional 天然不在链上（每次会话授权，物理不可预置）；
     * `device-owner` 不是权限档、要通道才能拿，也不进冲刺。
     */
    val OPTIONAL: List<String> = CapabilityCatalog.ALL.filter {
        PermissionCatalog.byId(it.id) != null && it.id !in REQUIRED &&
            it.requires.isEmpty() && !it.optional && !silentLater(it)
    }.map { it.id }

    /**
     * 「通道在册的最优情况」下，这项的取法链里有没有静默通道。有的话开屏就不该问用户：
     * 判据问的是能力**能不能**静默拿到，所以喂一份最好的读数而不是当前读数 ——
     * 拿当前读数会把「现在还没有通道」当成结论，于是这些项永远留在冲刺里。
     */
    private fun silentLater(c: Capability): Boolean {
        val bestCase = Evidence(nowMs = 1L, channel = ChannelProbe(ProbeOutcome.LIVE, 1L))
        return c.acquirer(bestCase).any { it.kind == AcquireKind.SILENT_VIA_ADB }
    }

    /** 冲刺顺序：必要项在前（它挡配对的输码入口），其余按登记表声明序。 */
    val ORDER: List<String> = REQUIRED + OPTIONAL

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
