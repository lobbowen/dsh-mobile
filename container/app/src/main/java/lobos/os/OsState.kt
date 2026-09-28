package lobos.os

import lobos.capability.ProbeOutcome
import lobos.lifecycle.AnchorState

/**
 * Lob OS 的唯一对外状态（架构 v4 §10）。
 *
 * 三处同源：os/state.json = 常驻通知 = 控制台首行。任何一处都不许自己编状态 ——
 * 「编」的具体形状就是拿外部读数现场拼一句话：那样 state.json 与通知各说各话，
 * 而两边看起来都「有依据」（真机 2026-09-28 定罪的三处同源破口）。
 * 迁移语义：BOOTING → RUNNING ⇄ DEGRADED → STOPPING。
 * Program 的状态只是子状态，对外只汇总成这一个。
 */
enum class OsPhase {
    /** 进程刚出生、宿主组件还在装配（含没有 state.json 的全新设备）。 */
    BOOTING,

    /** 一拍实测：读数没有构成降级（控制面在线，锚在位或读不到）。锚读不到时状态行单列「锚未知」。 */
    RUNNING,

    /**
     * 实测到的降级：控制面不在线 **或** 锚不在位。
     *
     * 这一档以前**永远不可达** —— 全仓只有 RUNNING / STOPPING 两个迁移点，而通知正文
     * 现场拼装「锚掉线·运行时未响应」，于是相位串同源、结论不同源。判据见 [OsPhaseRule]，
     * 生产者只有宿主节拍一处（[OsInit.refresh]）。
     */
    DEGRADED,

    /** 宿主被销毁（正常停止；不是崩溃 —— 崩溃由 ResidencyAudit 在下次启动翻旧账）。 */
    STOPPING;

    val label: String
        get() = when (this) {
            BOOTING -> "启动中"
            RUNNING -> "运行中"
            DEGRADED -> "降级"
            STOPPING -> "停止中"
        }
}

/**
 * 宿主在一拍里实测到的对外事实。字段全是**读数**，不是结论：
 * 结论（相位、上屏那句状态行）由 [OsPhaseRule] 和 [OsInit.statusLine] 从这份读数推导。
 *
 * 三个读数各自的**唯一取数口**：控制面 = `CapabilityEvidenceCollector.controlPlaneUp()`，
 * 通道 = `AdbChannelProbe.cached()`，锚 = `AccessibilityAnchor.state()`。本类型不采集，只承接。
 */
data class OsFacts(
    /** 是否至少采过一次。默认值不许当结论播出去：没采过时相位判据保持沉默。 */
    val readingsCollected: Boolean = false,
    val controlPlaneUp: Boolean = false,
    val channel: ProbeOutcome = ProbeOutcome.NEVER_RUN,
    val anchor: AnchorState = AnchorState.UNKNOWN,
)

/** state.json 的完整形状 = 对外唯一状态（相位 + 读数 + 待认的中断定罪）。 */
data class OsSnapshot(
    val phase: OsPhase,
    val facts: OsFacts,
    /** [lobos.lifecycle.ResidencyAudit.interruption] 的当前文案；null = 没有待认的中断。 */
    val interrupted: String? = null,
    /** 当前相位的起始时刻（毫秒）。翻转才更新 —— 每拍重写会让 uptime 永远归零。 */
    val atMs: Long = 0L,
)

/**
 * 「读数 → 相位」的判据，仓内唯一住址。
 *
 * 降级只认两个方向：**控制面不在线**（运行时未响应，面板干活没着落）与**锚不在位**
 * （ColorOS 判决降到 importance=traffic，随时被 o-kill —— [lobos.lifecycle.AnchorPolicy] 的真机实证）。
 *
 * 两档刻意**不**算降级：
 *  - 通道不通（[ProbeOutcome.DEAD]）：那是配对手没了，属于「能不能静默下发」的事，
 *    入口判据另有其表（`PipelineProjection.GATING`），不是常驻相位；
 *  - 锚 [AnchorState.UNKNOWN]：读数取不到是**采集失败**，不是锚掉了。把它判成降级会伪造
 *    一次并不存在的判决掉线，判成在位则是在谎报保护 —— 所以相位维持不动，
 *    而状态行必须显式写「锚未知」，让这件事可见（见 [OsInit.statusLine]）。
 */
object OsPhaseRule {

    /** 这一拍的读数是否构成降级（[OsPhaseRule] 上方的两条判据）。 */
    fun degraded(facts: OsFacts): Boolean =
        !facts.controlPlaneUp || facts.anchor == AnchorState.UNBOUND

    /**
     * 这一拍该不该改相位、改成什么。**返回 null = 不改**，三种不改各有原因：
     *  - 一次读数都没采到：初值不是结论，拿它判降级就是凭空造一次事故；
     *  - 相位还在 BOOTING / STOPPING：装配中与已销毁都没有「一拍」可判，而把销毁后的文件
     *    写成降级等于谎报一次判决掉线（那两个边由 [OsInit.transition] 走）；
     *  - 读数与相位本来就一致：不写翻转，Journal 才只记翻转点。
     */
    fun next(prev: OsPhase, facts: OsFacts): OsPhase? = when {
        !facts.readingsCollected -> null
        prev == OsPhase.BOOTING || prev == OsPhase.STOPPING -> null
        degraded(facts) && prev != OsPhase.DEGRADED -> OsPhase.DEGRADED
        !degraded(facts) && prev == OsPhase.DEGRADED -> OsPhase.RUNNING
        else -> null
    }

    /** 翻转归因：只说读数里有的事，不猜。 */
    fun reason(next: OsPhase, facts: OsFacts): String = when {
        next == OsPhase.DEGRADED && !facts.controlPlaneUp -> "控制面不在线"
        next == OsPhase.DEGRADED -> "锚不在位"
        else -> "读数恢复"
    }
}
