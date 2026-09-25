package io.github.lobbowen.dshmobile.capability

import io.github.lobbowen.dshmobile.permissions.PermissionCatalog

/** 阶段卡状态。[CURRENT] 全列表**至多一个** —— 首页因此永远只有一个可点动作。 */
enum class StageStatus { DONE, CURRENT, NEXT, BLOCKED, FAILED, UNREACHABLE }

/**
 * 一张阶段卡：标题 + 为什么排在这里（[why]）+ 当前读数 + 动作。
 * 动作取自能力登记表的取法链首项，本层不发明动作、不拼命令。
 *
 * 两个动作位是刻意的：**[action] 全列表至多一个**（主行动，决定流程往哪走），
 * [extra] 只挂在「欠账但不挡路」的行上（F1 的剩余授权、F6 的补齐清单），
 * 让用户能在推进主链的同时把能拿的权限一次拿完 —— 两者都不会造出按钮墙。
 */
data class FlowStage(
    val id: String,
    val title: String,
    val why: String,
    val status: StageStatus,
    val detail: String = "",
    val action: Acquisition? = null,
    val actionCapId: String? = null,
    val extra: Acquisition? = null,
    val extraCapId: String? = null,
)

/**
 * 开场流程（docs/contracts/onboarding-flow-spec.md §2）：**[Evidence] 的纯函数**。
 *
 * 不存进度、没有转移表 —— 「现在该干什么」每次从读数推导，做完一步下一步自动成为
 * CURRENT，也就不会出现「状态已变而界面还在问上一步」。段投影（S0–S4）继续作为
 * 判据核对视图与报告来源，但首页驱动器换成这个函数。
 *
 * 分层纪律同 [CapabilityCatalog]：不 import Android 类型，可由 JVM 单测钉死。
 */
object OnboardingFlow {

    const val F1 = "F1"
    const val F2 = "F2"
    const val F3 = "F3"
    const val F4 = "F4"
    const val F5 = "F5"
    const val F6 = "F6"

    /**
     * 首启授权冲刺（flow-spec §2.2）：**不需要 ADB 就能拿到**的授权，按固定顺序一次要完。
     * 顺序不是偏好：第 1 项是 F3 输码的物理前置（登记表 `adb_credentials.requires` 同源），
     * 其余四项只是「现在拿最便宜」（ROM 冻结/浮层/落盘/装机各挡一处功能），
     * 所以它们排在冲刺里却**不挡主链** —— 只有第 1 项未授予时流程才停在 F1。
     */
    private val SPRINT = listOf(
        PermissionCatalog.POST_NOTIFICATIONS,
        PermissionCatalog.BATTERY_OPTIMIZATION,
        PermissionCatalog.SYSTEM_ALERT_WINDOW,
        PermissionCatalog.MANAGE_EXTERNAL_STORAGE,
        PermissionCatalog.REQUEST_INSTALL_PACKAGES,
    )

    private val DEV_ENV = listOf(CapabilityCatalog.DEV_OPTIONS, CapabilityCatalog.WIRELESS_DEBUG)
    private val RUNTIME_ENV = listOf(CapabilityCatalog.RUNTIME, CapabilityCatalog.KERNEL_BUNDLE)

    /** 每一行认领的能力：F6 的补齐清单只收「没有开放行认领」的项，同一项不得两处催。 */
    private val F1_OWNS = SPRINT.toSet()
    private val F2_OWNS = DEV_ENV.toSet()
    private val F3_OWNS = setOf(CapabilityCatalog.ADB_CREDENTIALS)
    private val F4_OWNS = setOf(CapabilityCatalog.ADB_CHANNEL)
    private val F5_OWNS = RUNTIME_ENV.toSet()

    fun readyToEnter(verdicts: Map<String, CapVerdict>): Boolean =
        PipelineProjection.workbenchReady(verdicts)

    /**
     * 首页布局用的骨架：阶段 id/标题/为什么排在这里的**唯一出处**。
     * [stages] 只在这份骨架上覆盖状态与读数，别处（含 GUI）不得再抄一份标题文案。
     */
    val SKELETON: List<FlowStage> = listOf(
        FlowStage(F1, "先拿到能拿的授权", WHY_SPRINT, StageStatus.NEXT),
        FlowStage(F2, "打开开发者环境与无线调试", WHY_DEVENV, StageStatus.NEXT),
        FlowStage(F3, "无线配对（一次 6 位码）", WHY_PAIR, StageStatus.NEXT),
        FlowStage(F4, "校验 ADB 通道（现问端点）", WHY_CHANNEL, StageStatus.NEXT),
        FlowStage(F5, "进入工作台", WHY_ENTER, StageStatus.NEXT),
        FlowStage(F6, "补齐剩余能力（不挡入口）", WHY_GAPS, StageStatus.NEXT),
    )

    fun stages(e: Evidence, v: Map<String, CapVerdict>): List<FlowStage> {
        val sprintHead = SPRINT.firstOrNull { !e.granted(it) }
        // 冲刺五项里只有通知是 F3 的**物理**前置（与登记表 adb_credentials.requires 同源）。
        // 其余四项是「现在拿最便宜」：欠着它们只该在卡片上留一条次要动作，
        // 不许把主链钉在 F1 —— 那正是用户「走不到面板」的那一半原因。
        val sprintBlocks = !e.granted(PermissionCatalog.POST_NOTIFICATIONS)
        val sprintDebt = SPRINT.filter { !e.granted(it) }
        val devGap = DEV_ENV.firstOrNull { v[it]?.status != CapStatus.GRANTED }
        val cred = v[CapabilityCatalog.ADB_CREDENTIALS]
        val chan = v[CapabilityCatalog.ADB_CHANNEL]
        val runtimeGap = RUNTIME_ENV.firstOrNull { v[it]?.status != CapStatus.GRANTED }
        // 通道已 LIVE 的老设备不必重走冲刺/引导/配对（flow-spec §2.1 的 F0→F5 短路）；
        // 此时短路的这几行认领的能力会重新落到 F6 的补齐清单里。
        val bypass = e.channelLive() && e.credentials == CredentialsState.PAIRED
        val ready = readyToEnter(v)

        // (动作目标, 认领的能力, 是否已成立, 是否挡主链, 上屏读数, 透传的 verdict)
        val head = listOf(
            Row(openAction(sprintHead, bypass), F1_OWNS, bypass || sprintHead == null, sprintBlocks,
                when {
                    bypass -> "通道已就绪，冲刺跳过"
                    sprintHead == null -> "首启授权 ${SPRINT.size} 项全在"
                    sprintBlocks -> "缺 ${CapabilityCatalog.titleOf(sprintHead!!)}：配对要在通知栏输码，没有它走不到下一步"
                    else -> "可以配对；仍建议现在拿：${sprintDebt.joinToString("、") { CapabilityCatalog.titleOf(it) }}"
                },
                null),
            Row(devGap, F2_OWNS, bypass || devGap == null, true,
                devGap?.let { "${CapabilityCatalog.titleOf(it)}：${v[it]?.detail ?: ""}" }
                    ?: "两个开关都已开启",
                devGap?.let { v[it] }),
            Row(openAction(CapabilityCatalog.ADB_CREDENTIALS, bypass), F3_OWNS,
                cred?.status == CapStatus.GRANTED || bypass, true, cred?.detail ?: "", cred),
            Row(CapabilityCatalog.ADB_CHANNEL, F4_OWNS, chan?.status == CapStatus.GRANTED, true,
                chan?.detail ?: "", chan),
            Row(runtimeGap ?: CapabilityCatalog.RUNTIME, F5_OWNS, ready, true,
                if (ready) "通道与控制面就绪"
                else RUNTIME_ENV.filter { v[it]?.status != CapStatus.GRANTED }
                    .joinToString("、") { "${CapabilityCatalog.titleOf(it)}：${v[it]?.detail ?: ""}" },
                runtimeGap?.let { v[it] }),
        )
        val claimed = head.filter { !it.done }.flatMap { it.owns }.toSet()
        val gaps = CapabilityCatalog.ALL.filter {
            !it.optional && it.id !in claimed &&
                v[it.id]?.status != CapStatus.GRANTED && v[it.id]?.status != CapStatus.UNREACHABLE
        }
        val rows = head + Row(gaps.firstOrNull()?.id, emptySet(), gaps.isEmpty(), false,
            if (gaps.isEmpty()) "全部就位"
            else "待补 ${gaps.size} 项：${gaps.joinToString("、") { it.title }}",
            null,
        )

        // 主行动只有一个：第一个**挡路**且未成立的行；没有挡路的欠账时才轮到
        // 第一个未成立的行（F1 剩余冲刺与 F6 补齐都是这种「不挡门但该拿」的）。
        val current = rows.indexOfFirst { !it.done && it.blocking }
            .let { if (it >= 0) it else rows.indexOfFirst { !it.done } }
        return SKELETON.mapIndexed { i, base ->
            val r = rows[i]
            val status = when {
                r.done -> StageStatus.DONE
                i == current -> when (r.verdict?.status) {
                    CapStatus.FAILED -> StageStatus.FAILED
                    CapStatus.BLOCKED -> StageStatus.BLOCKED
                    CapStatus.UNREACHABLE -> StageStatus.UNREACHABLE
                    else -> StageStatus.CURRENT
                }
                r.verdict?.status == CapStatus.BLOCKED -> StageStatus.BLOCKED
                else -> StageStatus.NEXT
            }
            // 主按钮全列表至多一个；次要按钮只挂在「不挡主链的开放行」上。
            // 若失败/等待的行也拿到主按钮，首页就又变回一排不知道先点哪个的按钮墙。
            val secondary = !r.done && !r.blocking && i != current
            base.copy(
                status = status,
                detail = r.detail,
                action = if (i == current) firstAction(r.capId, e) else null,
                actionCapId = if (i == current) r.capId else null,
                extra = if (secondary) firstAction(r.capId, e) else null,
                extraCapId = if (secondary) r.capId else null,
            )
        }
    }

    /** 短路（老设备通道已 LIVE）时 F1/F3 不再给动作：欠的授权改由 F6 认领。 */
    private fun openAction(id: String?, bypass: Boolean): String? = id?.takeIf { !bypass }

    /** 一行的运行时读数：动作目标、认领的能力、是否成立、是否挡路、上屏文案、透传的 verdict。 */
    private data class Row(
        val capId: String?,
        val owns: Set<String>,
        val done: Boolean,
        val blocking: Boolean,
        val detail: String,
        val verdict: CapVerdict?,
    )

    /**
     * 取法链首项。传 [e] 而不是空快照：链里 SILENT_VIA_ADB/SILENT_VIA_DO 是否出现
     * 取决于通道与 DO 的实际读数，空快照会让 F6 永远只给出人点的那条。
     */
    private fun firstAction(capId: String?, e: Evidence): Acquisition? =
        capId?.let { CapabilityCatalog.byId(it) }?.acquirer?.invoke(e)?.firstOrNull()

    private const val WHY_SPRINT = "打开 App 第一步：把不需要 ADB 就能拿的授权先拿掉"
    private const val WHY_DEVENV = "配对的前提是系统侧两个开关；已开则整步跳过"
    private const val WHY_PAIR = "两个开关就绪后自动挂出输码通知，用户只输一个 6 位码"
    private const val WHY_CHANNEL = "凭据在册只说明「以前配过」，端点每次现问 mDNS"
    private const val WHY_ENTER = "通道+控制面+内核包就绪就进面板，其余权限不挡门"
    private const val WHY_GAPS = "有通道后这些可静默开启；缺了只是面板里个别功能降级"
}
