package io.github.lobbowen.dshmobile.capability

import io.github.lobbowen.dshmobile.permissions.PermissionCatalog

/**
 * 首启授权冲刺（flow-spec §2 的 **P0**，界面上**不出现**）：App 一打开就把「这轮非问人不可、
 * 且不需要 ADB 就能拿」的授权按顺序一次要完。用户面对的是系统弹窗与系统授权页，不是按钮墙。
 *
 * 这一层只有计划（纯函数，可 JVM 单测钉死），发起动作住 ui 层：
 * 「问什么、按什么顺序问」是判据事实，「怎么把问题抛给系统」才是 Android 细节。
 *
 * 2026-09-27 收敛：开屏只留 [REQUIRED]。凡取法链首项是 SILENT_* 的能力（无障碍 / 通知读取 /
 * 电池白名单 / DO 派生的 AppOps）一律撤出开屏，改由 [PostPairingAutoFlow] 在配对成功的
 * **同一前台会话内**静默办 —— 用户开屏只看到「开始配对」。
 */
object PermissionSprint {

    /**
     * 必要项 = 配对能力在**权限档**上的硬前置，从登记表推导而不是手写第二张清单：
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
     * 理想证据：只用于 [SILENT_DEFERRABLE] 的静态推导。nowMs 与 atMs 同值使
     * [Evidence.channelLive] 成立（age=0 < TTL），deviceOwner=true 让 DO 静默路径显形。
     * **必须声明在使用它的 [SILENT_DEFERRABLE] 之前** —— object 属性按声明顺序初始化，
     * 放到后面会让推导读到未初始化的字段（NPE 在类初始化期就炸）。
     */
    private val IDEAL_EVIDENCE = Evidence(
        nowMs = 0L,
        credentials = CredentialsState.PAIRED,
        channel = ChannelProbe(ProbeOutcome.LIVE, 0L, "取法链推导用理想读数"),
        deviceOwner = true,
    )

    /**
     * 「静默可办」集合：在**理想证据**（通道在线 + DO 在位）下取法链首项是 SILENT_* 的能力。
     *
     * 为什么用理想证据推导而不是手写一张清单：手写清单会跟登记表的取法链漂移，而
     * 「这条能不能静默办」本来就定义在 [CapabilityCatalog.permAcquirers] 里。理想证据只
     * 用于回答「是否存在静默路径」，**不代表任何真实设备状态**，也不产生上屏读数。
     */
    private val SILENT_DEFERRABLE: List<String> = CapabilityCatalog.ALL
        .filter { c ->
            val kind = c.acquirer(IDEAL_EVIDENCE).firstOrNull()?.kind
            kind == AcquireKind.SILENT_VIA_ADB || kind == AcquireKind.SILENT_VIA_DO
        }
        .map { it.id }

    /**
     * 保活锚（[Capability.keepAliveAnchor]）：电池豁免 / 无障碍 / 通知读取。
     *
     * **本版从开屏撤下**（2026-09-27 真机实证）：这三项在通道在线时都属于
     * [SILENT_DEFERRABLE]，静默路径就是取法链首项，开屏再抢问一遍等于让用户点三个系统页。
     *
     * 旧注释里的「循环依赖」（没有锚 → :main 被 HANS 冻/杀 → 那条静默通道永远等不到）现在
     * 用两条边规避，而不是靠开屏抢问：
     *  ① 配对成功的**同一前台会话内**立刻跑 [PostPairingAutoFlow]（配对期间
     *     [io.github.lobbowen.dshmobile.ui.PairingProbeService] 的前台服务还活着，进程不
     *     可能已经被冻）；
     *  ② 锚掉线由 [io.github.lobbowen.dshmobile.lifecycle.ContainerSupervisor] 的低频监护
     *     经 [io.github.lobbowen.dshmobile.lifecycle.AccessibilityAnchor] 无感自愈
     *     （先摘后写逼 AMS 重绑 + 总开关置 1）。
     * 这是**预防**不是死后自愈：真机 2026-09-27 07:08 实测锚在位 = importance=accessibility
     * （HANS 拒绝转出 Running），不在位 = importance=traffic（随时被 o-kill）。
     */
    val ANCHORS: List<String> = CapabilityCatalog.ALL
        .filter { it.keepAliveAnchor && it.id !in REQUIRED && it.id !in SILENT_DEFERRABLE }
        .map { it.id }

    /**
     * 其余待选项：权限档、无前置、非可选加速器，且不属于上面两档、也没有静默路径。
     *
     * 有静默路径的一律排除（否则它们会从 [ANCHORS] 掉进这里，又被开屏问一遍 —— 那正是
     * 本次收敛要消灭的按钮墙）。本机 AppOps 档的静默前提是 Device Owner，由自动流去试；
     * 试不成落 UNREACHABLE/欠账，不回落到「去 3 个系统页点一下」。
     */
    val OPTIONAL: List<String> = CapabilityCatalog.ALL.filter {
        PermissionCatalog.byId(it.id) != null && it.id !in REQUIRED && it.id !in ANCHORS &&
            it.id !in SILENT_DEFERRABLE && it.requires.isEmpty() && !it.optional
    }.map { it.id }

    /**
     * 冲刺顺序：配对前置 → 保活锚 → 其余（挡路的先要，同一件事只做一次）。
     * 本版 ANCHORS / OPTIONAL 均为空（全部由静默路径接管），实际开屏只问 [REQUIRED]。
     */
    val ORDER: List<String> = REQUIRED + ANCHORS + OPTIONAL

    /**
     * 本轮还该要哪些。[asked] = 本次开屏已经抛过问题的项：**一次开屏只闹一回**，
     * 用户拒了之后不许把他往同一个系统页里反复推 —— 那些欠账由配对后的自动流或
     * 工作台里的能力面板接手，不由开屏骚扰。
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
