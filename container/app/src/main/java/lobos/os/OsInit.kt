package lobos.os

import android.content.Context
import java.io.File
import org.json.JSONObject

/**
 * OsInit：进程/端口/存储/日志的唯一权威 + 状态机（架构 v4 §10，债 A12）。
 *
 * 对外唯一状态落在 files/os/state.json；通知与控制台都从这里读（三处同源，C1）。
 * **没有 replay 恢复**：重启只把上次中断如实写进 Journal，然后继续 BOOTING -> RUNNING。
 */
object OsInit {

    private const val DIR = "os"
    private const val FILE = "state.json"

    private fun file(ctx: Context): File {
        val d = File(ctx.filesDir, DIR)
        d.mkdirs()
        return File(d, FILE)
    }

    @Synchronized
    fun current(ctx: Context): OsPhase {
        val raw = runCatching { JSONObject(file(ctx).readText()).optString("phase") }.getOrNull()
        return OsPhase.values().firstOrNull { it.name == raw } ?: OsPhase.BOOTING
    }

    /** 唯一状态迁移入口：写盘 + 落 Journal（同一次调用，不允许只做一半）。 */
    @Synchronized
    fun transition(ctx: Context, phase: OsPhase, note: String? = null): OsPhase {
        val prev = current(ctx)
        val obj = JSONObject().apply {
            put("phase", phase.name)
            put("label", phase.label)
            put("previous", prev.name)
            put("at", System.currentTimeMillis())
            if (!note.isNullOrBlank()) put("note", note)
        }
        runCatching { file(ctx).writeText(obj.toString(2)) }
        Journal.append(ctx, "os-phase", null, prev.name + " -> " + phase.name + (note?.let { "（" + it + "）" } ?: ""))
        return phase
    }

    /** 当前相位的起始时刻（state.json 的 at；缺失返回 0）。 */
    @Synchronized
    fun since(ctx: Context): Long =
        runCatching { JSONObject(file(ctx).readText()).optLong("at", 0L) }.getOrDefault(0L)

    /** 通知/控制台共用的首行文案（与 state.json 同源）。 */
    fun stateLine(ctx: Context): String = "Lob OS · " + current(ctx).label
}
