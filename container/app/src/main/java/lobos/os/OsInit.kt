package lobos.os

import android.content.Context
import java.io.File
import lobos.capability.ProbeOutcome
import lobos.lifecycle.AnchorState
import org.json.JSONObject

/**
 * OsInit：进程/端口/存储/日志的唯一权威 + 状态机（架构 v4 §10，债 A12）。
 *
 * 对外唯一状态落在 files/os/state.json：那里存的是**本世的完整对外状态**（相位 + 三份实测读数 +
 * 待认的中断定罪），通知、控制台首行、快捷磁贴都渲染这一份，不各自取数再拼一句话
 * （三处同源，C1）。**没有 replay 恢复**：重启只把上次中断如实写进 Journal，然后继续 BOOTING → RUNNING。
 * 「不继承上一世」在这里是结构性的：[beginLife] 在本世第一条通知之前把这份状态归零，
 * 而中断判决根本不走文件回读（见 [interruptedThisLife]）。
 */
object OsInit {

    private const val DIR = "os"
    private const val FILE = "state.json"

    /**
     * 本世的中断判决。**唯一来源是显式入参**（[beginLife] / [transition] / [refresh]，
     * 源头只有 [lobos.lifecycle.ResidencyAudit.interruption] 一处），绝不从 state.json 回读：
     * 文件里那一格是上一世写下的存档，回读它就是把「上一世对它自己的上一世说的话」
     * 当成这一世的读数渲染出去（真机 2026-09-30 实测到的 60s 窗口，债 E12）。
     */
    @Volatile
    private var interruptedThisLife: String? = null

    private fun file(ctx: Context): File {
        val d = File(ctx.filesDir, DIR)
        d.mkdirs()
        return File(d, FILE)
    }

    @Synchronized
    fun current(ctx: Context): OsPhase = snapshot(ctx).phase

    /** 读整份对外状态。没有 state.json 或读坏了 = BOOTING 初值，不拿猜测填结论。 */
    @Synchronized
    fun snapshot(ctx: Context): OsSnapshot {
        val obj = runCatching { JSONObject(file(ctx).readText()) }.getOrNull()
            ?: return OsSnapshot(OsPhase.BOOTING, OsFacts(), interruptedThisLife, 0L)
        val phase = OsPhase.values().firstOrNull { it.name == obj.optString("phase") } ?: OsPhase.BOOTING
        val f = obj.optJSONObject("facts")
        val facts = if (f == null) OsFacts() else OsFacts(
            readingsCollected = f.optBoolean("readingsCollected"),
            controlPlaneUp = f.optBoolean("controlPlaneUp"),
            channel = ProbeOutcome.values().firstOrNull { it.name == f.optString("channel") }
                ?: ProbeOutcome.NEVER_RUN,
            anchor = AnchorState.values().firstOrNull { it.name == f.optString("anchor") }
                ?: AnchorState.UNKNOWN,
        )
        return OsSnapshot(
            phase = phase,
            facts = facts,
            interrupted = interruptedThisLife,
            atMs = obj.optLong("at", 0L),
        )
    }

    private fun write(ctx: Context, snap: OsSnapshot, previous: OsPhase, note: String?) {
        val obj = JSONObject().apply {
            put("phase", snap.phase.name)
            put("label", snap.phase.label)
            put("previous", previous.name)
            put("at", snap.atMs)
            if (!note.isNullOrBlank()) put("note", note)
            put("facts", JSONObject().apply {
                put("readingsCollected", snap.facts.readingsCollected)
                put("controlPlaneUp", snap.facts.controlPlaneUp)
                put("channel", snap.facts.channel.name)
                put("anchor", snap.facts.anchor.name)
            })
            // 只作本世渲染过的存档：[snapshot] 不读这一格（读了就是把上一世的判决当这一世的现状）。
            snap.interrupted?.let { put("interrupted", it) }
        }
        runCatching { file(ctx).writeText(obj.toString(2)) }
    }

    /**
     * 本世的第一次写：对外状态从「什么都没量」起算，文件里上一世那份相位与读数一份都不继承。
     *
     * 必须排在第一条通知之前。跨世残留的形状不止 `interrupted` 那一格：出生后若还读回上一世的
     * `readingsCollected=true / 锚在位`，第一句状态行就把本世没量过的事说成量过了（债 E12 同族）。
     * 上世停在哪个相位只进 Journal 当归档文案，不进对外状态。
     */
    @Synchronized
    fun beginLife(ctx: Context, interrupted: String?): OsSnapshot {
        val stalled = snapshot(ctx).phase
        interruptedThisLife = interrupted
        val snap = OsSnapshot(OsPhase.BOOTING, OsFacts(), interrupted, System.currentTimeMillis())
        write(ctx, snap, OsPhase.BOOTING, null)
        Journal.append(
            ctx, "os-phase", null,
            "宿主出生：本世从 BOOTING 起算（上世停在 " + stalled.name + "，那份读数不继承）",
        )
        return snap
    }

    /**
     * 唯一状态迁移入口（生命周期边）：写盘 + 落 Journal（同一次调用，不允许只做一半）。
     *
     * `note` 与 `interrupted` 都没有默认值：每一次写状态都必须自带判决来源，
     * 少写一个参数就编译不过 —— 「靠 prev.copy 把上一份判决顺带写下去」正是债 E12 的通路。
     */
    @Synchronized
    fun transition(ctx: Context, phase: OsPhase, note: String?, interrupted: String?): OsPhase {
        val prev = snapshot(ctx)
        val now = System.currentTimeMillis()
        interruptedThisLife = interrupted
        write(ctx, prev.copy(phase = phase, atMs = now, interrupted = interrupted), prev.phase, note)
        Journal.append(ctx, "os-phase", null, prev.phase.name + " -> " + phase.name + (note?.let { "（" + it + "）" } ?: ""))
        return phase
    }

    /**
     * 一拍实测：读数落进唯一状态，相位由 [OsPhaseRule.next] 决定 —— DEGRADED 的唯一生产者就是这里，
     * 而「凭什么降级」这条判据不在本对象里（它住 [OsPhaseRule]，这样纯函数可被 JVM 单测钉死，
     * 落盘与 Journal 这些 Android 侧的事不参与判据）。
     *
     * Journal 只在相位**真的翻转**时落一条：每拍都写会把旧设计里「低频监护重复告警」的噪音
     * 换成另一种噪音，而可度量要求的是翻转点。
     */
    @Synchronized
    fun refresh(ctx: Context, facts: OsFacts, interrupted: String?): OsSnapshot {
        val prev = snapshot(ctx)
        val next = OsPhaseRule.next(prev.phase, facts)
        val now = System.currentTimeMillis()
        interruptedThisLife = interrupted
        val snap = prev.copy(
            phase = next ?: prev.phase,
            facts = facts,
            interrupted = interrupted,
            atMs = if (next != null) now else prev.atMs,
        )
        write(ctx, snap, prev.phase, next?.let { OsPhaseRule.reason(it, facts) })
        if (next != null) {
            Journal.append(
                ctx, "os-phase", null,
                prev.phase.name + " -> " + next.name + "（" + OsPhaseRule.reason(next, facts) + "）",
            )
        }
        return snap
    }

    /** 当前相位的起始时刻（state.json 的 at；缺失返回 0）。 */
    @Synchronized
    fun since(ctx: Context): Long = snapshot(ctx).atMs

    /**
     * 通知 / 控制台 / 快捷磁贴共用的状态行：**每个字段都取自 state.json**（[snapshot]）。
     *
     * 定罪结论排最前：它是"这条常驻断过"的唯一可见出口。「锚未知」单列一词而不并入
     * 「锚在位」或「锚掉线」：取不到读数既不是保护生效也不是保护失效，把它塞进任何一边都是假话。
     */
    fun statusLine(ctx: Context): String {
        val s = snapshot(ctx)
        val runtime = when {
            !s.facts.readingsCollected -> "状态采集中…"
            s.facts.controlPlaneUp -> "运行时在线"
            else -> "运行时未响应"
        }
        val channel = when (s.facts.channel) {
            ProbeOutcome.LIVE -> "通道通"
            ProbeOutcome.DEAD -> "通道不通"
            ProbeOutcome.NEVER_RUN -> "通道未验"
        }
        val anchor = when (s.facts.anchor) {
            AnchorState.BOUND -> "锚在位"
            AnchorState.UNBOUND -> "锚掉线"
            AnchorState.UNKNOWN -> "锚未知"
        }
        val prefix = s.interrupted?.let { it + " · " } ?: ""
        return prefix + "Lob OS · " + s.phase.label + " · " + runtime + " · " + channel + " · " + anchor
    }
}
