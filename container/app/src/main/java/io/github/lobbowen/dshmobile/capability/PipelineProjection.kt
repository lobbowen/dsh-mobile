package io.github.lobbowen.dshmobile.capability

import io.github.lobbowen.dshmobile.capability.CapabilityCatalog.S0
import io.github.lobbowen.dshmobile.capability.CapabilityCatalog.S1
import io.github.lobbowen.dshmobile.capability.CapabilityCatalog.S2
import io.github.lobbowen.dshmobile.capability.CapabilityCatalog.S3

/** 段行的渲染状态（[CapStatus] 的段级聚合结果，spec §2.3）。 */
enum class StepStatus { DONE, ACTION, BLOCKED, FAILED, UNREACHABLE }

/**
 * 一行段：状态 + 人话 + **该点的那个按钮**（[pending] 来自能力登记表的取法链首项）。
 * GUI 拿到什么就渲染什么、点就发什么 —— 不再自己按 stepId 硬编码按钮。
 */
data class PipelineStep(
    val id: String,
    val title: String,
    val status: StepStatus,
    val detail: String,
    val pending: Acquisition? = null,
    val pendingCapId: String? = null,
)

/**
 * 段投影（spec §2.3）：能力登记表按 `requires` 拓扑排序后的**呈现视图**。
 *
 * 五段不再是模型：S4 甚至不对应任何能力，它是 [GATING] 三要素的派生结论（入口 ≠ 全绿）。
 * 段内取 worst 的优先级写死在这里，便于单测钉死。首页驱动器是 `OnboardingFlow`，
 * 这张表退为判据核对视图与探针报告的证据出口。
 */
object PipelineProjection {

    const val S4 = "S4"

    /**
     * 放行三要素（onboarding-flow-spec §1 总则 6：入口 ≠ 全绿）。
     * 这三项之外绿不绿都不挡门 —— 改动这张表等于改产品入口判据，必须同时改规范。
     */
    private val GATING = listOf(
        CapabilityCatalog.ADB_CHANNEL,
        CapabilityCatalog.RUNTIME,
        CapabilityCatalog.KERNEL_BUNDLE,
    )

    /** 入口是否可进（[OnboardingFlow] 与首页自动跳转共用这一把尺子，UI 不得自己算）。 */
    fun workbenchReady(verdicts: Map<String, CapVerdict>): Boolean =
        GATING.all { verdicts[it]?.status == CapStatus.GRANTED }

    private val TITLES = mapOf(
        S0 to "ADB 通道",
        S1 to "Device Owner（可选）",
        S2 to "能力与权限集",
        S3 to "运行时+内核",
    )

    /** 数字越小越「差」；聚合时取段内最小。顺序即 spec §2.3 的判定顺序。 */
    private fun rank(s: CapStatus): Int = when (s) {
        CapStatus.FAILED -> 0
        CapStatus.ACTION -> 1
        CapStatus.BLOCKED -> 2
        CapStatus.UNREACHABLE -> 3
        CapStatus.GRANTED -> 4
    }

    private fun toStep(s: CapStatus): StepStatus = when (s) {
        CapStatus.GRANTED -> StepStatus.DONE
        CapStatus.ACTION -> StepStatus.ACTION
        CapStatus.BLOCKED -> StepStatus.BLOCKED
        CapStatus.FAILED -> StepStatus.FAILED
        CapStatus.UNREACHABLE -> StepStatus.UNREACHABLE
    }

    fun project(e: Evidence, verdicts: Map<String, CapVerdict>): List<PipelineStep> {
        val rows = listOf(S0, S1, S2, S3).map { seg ->
            val caps = CapabilityCatalog.ALL.filter { it.segment == seg }
            // S1 只有可选加速器：它自己就是整行，不参与「非 optional 全绿」口径。
            val scoped = if (seg == S1) caps else caps.filter { !it.optional }
            val ranked = scoped.map { it to verdicts[it.id] }
                .filter { it.second != null }
                .map { it.first to it.second!! }
            if (ranked.isEmpty()) PipelineStep(seg, TITLES.getValue(seg), StepStatus.DONE, "本段无待办")
            else worstOf(seg, TITLES.getValue(seg), ranked, e)
        }
        return rows + workbenchRow(e, verdicts)
    }

    private fun worstOf(
        seg: String,
        title: String,
        ranked: List<Pair<Capability, CapVerdict>>,
        e: Evidence,
    ): PipelineStep {
        val best = ranked.minByOrNull { rank(it.second.status) }!!
        val pendingCount = ranked.count { it.second.status != CapStatus.GRANTED }
        val detail = if (seg == S2 && pendingCount > 1) {
            "${best.first.title}：${best.second.detail}（另有 ${pendingCount - 1} 项待办）"
        } else {
            best.second.detail.ifBlank { best.first.title }
        }
        return PipelineStep(
            id = seg,
            title = title,
            status = toStep(best.second.status),
            detail = detail,
            pending = CapabilityCatalog.byId(best.first.id)?.acquirer?.invoke(e)?.firstOrNull(),
            pendingCapId = best.first.id,
        )
    }

    /**
     * S4 = 放行判定。口径（onboarding-flow-spec §1 总则 6）：**入口 ≠ 能力全绿**。
     *
     * 只要求「通道 + 控制面 + 内核包」三项 —— 这三项绿了面板就能干活。
     * 其余权限是面板内各功能的**能力位**：缺了就在面板里降级并提示（F6 补齐），
     * 不挡入口。旧口径「所有非 optional 能力 GRANTED 才放行」把 5 个授权页排在
     * 用户能看到任何东西之前，是「配对之后跳不进去」的直接原因。
     */
    private fun workbenchRow(e: Evidence, verdicts: Map<String, CapVerdict>): PipelineStep {
        val gating = GATING.mapNotNull { id ->
            val c = CapabilityCatalog.byId(id) ?: return@mapNotNull null
            val v = verdicts[id] ?: return@mapNotNull null
            c to v
        }
        val gaps = gating.filter { it.second.status != CapStatus.GRANTED }
        if (gaps.isEmpty()) {
            return PipelineStep(S4, "工作台", StepStatus.DONE, "可进入控制面板")
        }
        val worst = gaps.minByOrNull { rank(it.second.status) }!!
        val blockedOnly = gaps.all { it.second.status == CapStatus.BLOCKED }
        return PipelineStep(
            id = S4,
            title = "工作台",
            status = if (blockedOnly) StepStatus.BLOCKED else StepStatus.ACTION,
            detail = "缺 " + gaps.joinToString("、") { it.first.title } +
                "（共 " + gaps.size + " 项）",
            pending = worst.first.acquirer.invoke(e).firstOrNull(),
            pendingCapId = worst.first.id,
        )
    }
}
