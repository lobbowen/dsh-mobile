package lobos.capability

/** 阶段卡状态。[CURRENT] 全列表**至多一个** —— 首页因此永远只有一个可点动作。 */
enum class StageStatus { DONE, CURRENT, NEXT, BLOCKED, FAILED }

/**
 * 一张阶段卡：标题 + 为什么排在这里（[why]）+ 当前读数 + 动作。
 * 动作取自能力登记表的取法链首项，本层不发明动作、不拼命令。
 *
 * [action] 全列表至多一个（主行动，决定流程往哪走）。[extra] 保留字段但本版不再填充：
 * 原 F4「补齐剩余授权」已折叠成一行欠账（见 [OnboardingFlow.debts]），不再占阶段行、
 * 也不再长出第二个按钮 —— 静默能办的在配对后由 [PostPairingAutoFlow] 办完。
 *
 * [FlowStage] 里没有「授权申请」这一行：开屏授权冲刺是 **P0**，静默完成，
 * 上屏的用户动作从 F1「配对」直接到 F3「进入工作台」。
 */
data class FlowStage(
    val id: String,
    val title: String,
    val why: String,
    val status: StageStatus,
    val detail: String = "",
    val action: Acquisition? = null,
    val actionCapId: String? = null,
    /** 保留位：本版不再产生次要动作（F4 欠账已折叠成文案）。 */
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
 * 2026-09-27 收敛为**两行**：F1「无线配对」→ F3「进入工作台」。
 *  - F2（通道校验）不再单独成行：它是入口三要素之一，折进 F3 的读数里；
 *  - F4（补齐授权）不再成行：折叠欠账由 [debts] 给文案，静默能办的由
 *    [PostPairingAutoFlow] 在配对后办完。
 *
 * 分层纪律同 [CapabilityCatalog]：不 import Android 类型，可由 JVM 单测钉死。
 */
object OnboardingFlow {

    const val F1 = "F1"
    const val F2 = "F2"
    const val F3 = "F3"
    const val F4 = "F4"

    private val RUNTIME_ENV = listOf(CapabilityCatalog.RUNTIME, CapabilityCatalog.PROGRAM_BUNDLE)

    /**
     * 配对这一步认领的读数 = 它自己的硬前置（顺序由登记表推导，见
     * [CapabilityCatalog.requiresInOrder]）加它本身。
     * 认领的意义是**不重复催**：这些项在 F1 未成立期间不进折叠欠账；一旦 F1 成立
     * （已配对），前置读数被 ROM 回收就又变成欠账 —— 不会出现「哪儿都不管」的幽灵红灯。
     */
    private val F1_OWNS =
        (CapabilityCatalog.requiresInOrder(CapabilityCatalog.ADB_CREDENTIALS) +
            CapabilityCatalog.ADB_CREDENTIALS).toSet()

    /** F3 认领的入口读数：通道 + 运行时 + 内核包（原 F2 的通道也在这里认领）。 */
    private val F3_OWNS = (listOf(CapabilityCatalog.ADB_CHANNEL) + RUNTIME_ENV).toSet()

    /**
     * 入口三要素的**展示顺序**：只决定「把哪一个缺项说成 F3 的当前步」。
     * 放行判定仍只走 [readyToEnter]（→ [PipelineProjection.workbenchReady]），
     * 本表不复制判据，只复制人话排序。
     */
    private val ENTRY_ORDER = listOf(CapabilityCatalog.ADB_CHANNEL) + RUNTIME_ENV

    fun readyToEnter(verdicts: Map<String, CapVerdict>): Boolean =
        PipelineProjection.workbenchReady(verdicts)

    /**
     * 首页布局用的骨架：阶段 id/标题/为什么排在这里的**唯一出处**。
     * [stages] 只在这份骨架上覆盖状态与读数，别处（含 GUI）不得再抄一份标题文案。
     */
    val SKELETON: List<FlowStage> = listOf(
        FlowStage(F1, "无线配对（一次 6 位码）", WHY_PAIR, StageStatus.NEXT),
        FlowStage(F3, "进入工作台", WHY_ENTER, StageStatus.NEXT),
    )

    fun stages(e: Evidence, v: Map<String, CapVerdict>): List<FlowStage> {
        val cred = v[CapabilityCatalog.ADB_CREDENTIALS]
        val ready = readyToEnter(v)
        // 通道/运行时/内核包三项里第一个未达成的：它决定 F3 的当前动作与读数。
        val entryGap = ENTRY_ORDER.firstOrNull { v[it]?.status != CapStatus.GRANTED }

        // (动作目标, 认领的能力, 是否已成立, 是否挡主链, 上屏读数, 透传的 verdict)
        val rows = listOf(
            Row(CapabilityCatalog.ADB_CREDENTIALS, F1_OWNS, cred?.status == CapStatus.GRANTED, true,
                cred?.detail ?: "", cred),
            Row(entryGap ?: CapabilityCatalog.RUNTIME, F3_OWNS, ready, true,
                if (ready) "通道与控制面就绪"
                else ENTRY_ORDER.filter { v[it]?.status != CapStatus.GRANTED }
                    .joinToString("；") { "${CapabilityCatalog.titleOf(it)}：${v[it]?.detail ?: ""}" },
                entryGap?.let { v[it] }),
        )

        // 主行动只有一个：第一个**挡路**且未成立的行；没有挡路的欠账时才轮到
        // 第一个未成立的行（本版两行都挡路，所以恒等于第一行未成立的）。
        val current = rows.indexOfFirst { !it.done && it.blocking }
            .let { if (it >= 0) it else rows.indexOfFirst { !it.done } }
        return SKELETON.mapIndexed { i, base ->
            val r = rows[i]
            val status = when {
                r.done -> StageStatus.DONE
                i == current -> when (r.verdict?.status) {
                    CapStatus.FAILED -> StageStatus.FAILED
                    CapStatus.BLOCKED -> StageStatus.BLOCKED
                    else -> StageStatus.CURRENT
                }
                r.verdict?.status == CapStatus.BLOCKED -> StageStatus.BLOCKED
                else -> StageStatus.NEXT
            }
            // 主按钮全列表至多一个。F1 即使读数是 BLOCKED（还差开关/通知）**照样给动作**：
            // 点它不是「假装前置齐了」，而是把用户送到能修前置的那一页 —— 见 [PairingGate]。
            base.copy(
                status = status,
                detail = r.detail,
                action = if (i == current) firstAction(r.capId, e) else null,
                actionCapId = if (i == current) r.capId else null,
            )
        }
    }

    /**
     * 折叠欠账（原 F4 的内容）：不挡入口、尚未达成、也不属于当前阶段行认领的能力。
     * 只作一行可展开文案，**不占阶段行、不给主按钮** —— 否则又回到「一排按钮」。
     * 静默能办的那些由 [PostPairingAutoFlow] 在配对后办掉，剩下的才是真欠账。
     */
    fun debts(v: Map<String, CapVerdict>): List<Capability> {
        val cred = v[CapabilityCatalog.ADB_CREDENTIALS]
        val claimed = mutableSetOf<String>()
        if (cred?.status != CapStatus.GRANTED) claimed += F1_OWNS
        if (!readyToEnter(v)) claimed += F3_OWNS
        return CapabilityCatalog.ALL.filter {
            !it.optional && it.id !in claimed && v[it.id]?.status != CapStatus.GRANTED
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
     * 取法链首项。传 [e] 而不是空快照：链里 SILENT_VIA_ADB 是否出现
     * 取决于通道与 DO 的实际读数，空快照会让欠账行永远只给出人点的那条。
     */
    private fun firstAction(capId: String?, e: Evidence): Acquisition? =
        capId?.let { CapabilityCatalog.byId(it) }?.acquirer?.invoke(e)?.firstOrNull()

    private const val WHY_PAIR = "点一下就现场核对开发者环境并跳到无线调试页；端口只在册时才算数"
    private const val WHY_ENTER = "通道+控制面+内核包就绪就进面板，其余权限不挡门；通道每次现问 mDNS"
}
