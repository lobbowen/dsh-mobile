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
 * 五段不再是模型：S4 甚至不对应任何能力，它 = 「所有非 optional 能力都绿或都不可得」的
 * 派生结论。段内取 worst 的优先级写死在这里，便于单测钉死。
 */
object PipelineProjection {

    const val S4 = "S4"

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

    /** S4 = 放行判定：非 optional 能力全部 GRANTED（UNREACHABLE 的加速器/旁路不计）。 */
    private fun workbenchRow(e: Evidence, verdicts: Map<String, CapVerdict>): PipelineStep {
        // 通道与权限之外，S0 的绿只看 adb-channel（凭据在册不等于可用，spec §2.2 注 1）。
        val gaps = CapabilityCatalog.blockingGaps(verdicts)
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
            pending = CapabilityCatalog.byId(worst.first.id)?.acquirer?.invoke(e)?.firstOrNull(),
            pendingCapId = worst.first.id,
        )
    }

    /** 首页是否放行 S4 入口。 */
    fun workbenchOpen(steps: List<PipelineStep>): Boolean =
        steps.lastOrNull()?.status == StepStatus.DONE
}
