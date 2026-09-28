package lobos.os

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import org.json.JSONObject

/**
 * OS Journal：**追加落盘的结构化事件**（架构 v4 §10/§11，债 C1/C6/E1）。
 *
 * 纪律（硬）：
 *  · 只做「打断可见」——**没有 checkpoint、没有 replay、不承担续跑**（A16/E6）。
 *  · 被杀原因的**词表唯一**：bgLimit_level_thermal_*（subreason 1030）与 o-kill(4008/6008)
 *    在这一处统一解释；ResidencyAudit / 通知 / 诊断页都应读它，不许各自再判一遍（E1/C6）。
 */
object Journal {

    private const val DIR = "os/journal"
    private const val FILE = "events.jsonl"
    private const val MAX_BYTES = 512 * 1024L

    /** 退出/中断原因词表（系统退出史原文 -> 统一口径）。 */
    enum class Reason(val code: String) {
        BG_LIMIT_THERMAL("bgLimit_level_thermal"),
        O_KILL_LOWMEM("o-kill(6008)"),
        O_KILL("o-kill"),
        USER_FORCE_STOP("user"),
        DEVICE_REBOOT("reboot"),
        UNKNOWN("unknown");

        companion object {
            /** 把系统退出史的原文压回词表；找不到就是 UNKNOWN（不猜）。 */
            fun parse(raw: String): Reason {
                val s = raw.lowercase(Locale.US)
                return when {
                    s.contains("bglimit") -> BG_LIMIT_THERMAL
                    s.contains("6008") || s.contains("lowmem") -> O_KILL_LOWMEM
                    s.contains("o-kill") || s.contains("okill") -> O_KILL
                    s.contains("force-stop") || s.contains("user") -> USER_FORCE_STOP
                    s.contains("reboot") -> DEVICE_REBOOT
                    else -> UNKNOWN
                }
            }
        }
    }

    data class Event(
        val seq: Long,
        val atMs: Long,
        val category: String,
        val reason: Reason?,
        val detail: String,
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("seq", seq)
            put("at", atMs)
            put("category", category)
            if (reason != null) put("reason", reason.code)
            put("detail", detail)
        }
    }

    private val fmt = SimpleDateFormat("MM-dd HH:mm:ss", Locale.US)
    @Volatile private var seq = 0L

    private fun file(ctx: Context): File {
        val d = File(ctx.filesDir, DIR)
        d.mkdirs()
        return File(d, FILE)
    }

    /** 进程冷启动时从落盘末条恢复 seq（契约：gseq 跨 OS 重启连续）。 */
    private fun lastSeq(ctx: Context): Long = runCatching {
        val f = file(ctx)
        if (!f.exists()) 0L else (f.readLines().lastOrNull { it.isNotBlank() }
            ?.let { JSONObject(it).optLong("seq", 0L) } ?: 0L)
    }.getOrDefault(0L)

    @Synchronized
    fun append(ctx: Context, category: String, reason: Reason?, detail: String): Event {
        if (seq == 0L) seq = lastSeq(ctx)
        val ev = Event(++seq, System.currentTimeMillis(), category, reason, detail)
        runCatching {
            val f = file(ctx)
            if (f.length() > MAX_BYTES) f.writeText("")
            f.appendText(ev.toJson().toString() + "\n")
        }
        return ev
    }

    /** 结构化事件读取（最新在最后）。损坏行跳过：一条坏记录不该毁掉整本账。 */
    @Synchronized
    fun events(ctx: Context, limit: Int = 50): List<Event> {
        val out = mutableListOf<Event>()
        runCatching {
            val f = file(ctx)
            if (!f.exists()) return emptyList()
            f.readLines().forEach { line ->
                if (line.isBlank()) return@forEach
                val o = runCatching { JSONObject(line) }.getOrNull() ?: return@forEach
                val rawReason = o.optString("reason")
                out.add(
                    Event(
                        seq = o.optLong("seq"),
                        atMs = o.optLong("at"),
                        category = o.optString("category"),
                        reason = Reason.values().firstOrNull { it.code == rawReason },
                        detail = o.optString("detail"),
                    )
                )
            }
        }
        return out.takeLast(limit)
    }

    /** 当前最大 gseq（跨重启连续；无事件返回 0）。 */
    @Synchronized
    fun latestSeq(ctx: Context): Long = runCatching {
        val f = file(ctx)
        if (!f.exists()) 0L else (f.readLines().lastOrNull { it.isNotBlank() }
            ?.let { JSONObject(it).optLong("seq", 0L) } ?: 0L)
    }.getOrDefault(0L)

    fun tail(ctx: Context, limit: Int = 8): String = events(ctx, limit)
        .joinToString("\n") { fmt.format(Date(it.atMs)) + " [" + it.category + "] " + it.detail }
}
