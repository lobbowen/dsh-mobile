package io.github.lobbowen.dshmobile.capability

/** 阶段卡状态。[CURRENT] 全列表**至多一个** —— 首页因此永远只有一个可点动作。 */
enum class StageStatus { DONE, CURRENT, NEXT, BLOCKED, FAILED, UNREACHABLE }

/**
 * 一张阶段卡：标题 + 为什么排在这里（[why]）+ 当前读数 + 动作。
 * 动作取自能力登记表的取法链首项，本层不发明动作、不拼命令。
 *
 * 两个动作位是刻意的：**[action] 全列表至多一个**（主行动，决定流程往哪走），
 * [extra] 只挂在「欠账但不挡路」的行上（F4 的补齐清单），让用户在推进主链的同时
 * 把能拿的授权一次拿完 —— 两者都不会造出按钮墙。
 *
 * [FlowStage] 里没有「授权申请」这一行：开屏授权冲刺是 **P0**，静默完成，
 * 上屏的用户动作从 F1「配对」开始（见 docs/contracts/onboarding-flow-spec.md §2）。
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

    private val RUNTIME_ENV = listOf(CapabilityCatalog.RUNTIME, CapabilityCatalog.KERNEL_BUNDLE)

    /**
     * 配对这一步认领的读数 = 它自己的硬前置（顺序由登记表推导，见
     * [CapabilityCatalog.requiresInOrder]）加它本身。
     * 认领的意义是**不重复催**：这些项在 F1 未成立期间不进 F4 的补齐清单；一旦 F1 成立
     * （已配对），前置读数被 ROM 回收就又变成 F4 的欠账 —— 不会出现「哪儿都不管」的幽灵红灯。
     */
    private val F1_OWNS =
        (CapabilityCatalog.requiresInOrder(CapabilityCatalog.ADB_CREDENTIALS) +
            CapabilityCatalog.ADB_CREDENTIALS).toSet()
    private val F2_OWNS = setOf(CapabilityCatalog.ADB_CHANNEL)
    private val F3_OWNS = RUNTIME_ENV.toSet()

    fun readyToEnter(verdicts: Map<String, CapVerdict>): Boolean =
        PipelineProjection.workbenchReady(verdicts)

    /**
     * 首页布局用的骨架：阶段 id/标题/为什么排在这里的**唯一出处**。
     * [stages] 只在这份骨架上覆盖状态与读数，别处（含 GUI）不得再抄一份标题文案。
     */
    val SKELETON: List<FlowStage> = listOf(
        FlowStage(F1, "无线配对（一次 6 位码）", WHY_PAIR, StageStatus.NEXT),
        FlowStage(F2, "校验 ADB 通道（现问端点）", WHY_CHANNEL, StageStatus.NEXT),
        FlowStage(F3, "进入工作台", WHY_ENTER, StageStatus.NEXT),
        FlowStage(F4, "补齐剩余授权（不挡入口）", WHY_GAPS, StageStatus.NEXT),
    )

    fun stages(e: Evidence, v: Map<String, CapVerdict>): List<FlowStage> {
        val cred = v[CapabilityCatalog.ADB_CREDENTIALS]
        val chan = v[CapabilityCatalog.ADB_CHANNEL]
        val ready = readyToEnter(v)
        val runtimeGap = RUNTIME_ENV.firstOrNull { v[it]?.status != CapStatus.GRANTED }

        // (动作目标, 认领的能力, 是否已成立, 是否挡主链, 上屏读数, 透传的 verdict)
        val head = listOf(
            Row(CapabilityCatalog.ADB_CREDENTIALS, F1_OWNS, cred?.status == CapStatus.GRANTED, true,
                cred?.detail ?: "", cred),
            Row(CapabilityCatalog.ADB_CHANNEL, F2_OWNS, chan?.status == CapStatus.GRANTED, true,
                chan?.detail ?: "", chan),
            Row(runtimeGap ?: CapabilityCatalog.RUNTIME, F3_OWNS, ready, true,
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
        // 第一个未成立的行（F4 补齐就是这种「不挡门但该拿」的）。
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
            // F1 即使读数是 BLOCKED（还差开关/通知）**照样给动作**：点它不是「假装前置齐了」，
            // 而是把用户送到能修前置的那一页 —— 见 [PairingGate]。收掉这个按钮才是死路。
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
     * 取决于通道与 DO 的实际读数，空快照会让 F4 永远只给出人点的那条。
     */
    private fun firstAction(capId: String?, e: Evidence): Acquisition? =
        capId?.let { CapabilityCatalog.byId(it) }?.acquirer?.invoke(e)?.firstOrNull()

    private const val WHY_PAIR = "点一下就现场核对开发者环境并跳到无线调试页；端口只在册时才算数"
    private const val WHY_CHANNEL = "凭据在册只说明「以前配过」，端点每次现问 mDNS"
    private const val WHY_ENTER = "通道+控制面+内核包就绪就进面板，其余权限不挡门"
    private const val WHY_GAPS = "有通道后这些可静默开启；缺了只是面板里个别功能降级"
}
