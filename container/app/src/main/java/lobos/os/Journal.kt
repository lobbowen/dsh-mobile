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
 *  · 被杀原因的**词表唯一**：数值退出码与 OEM 写在描述文本里的口径（`o-kill(N)`、
 *    `bgLimit_level_thermal_N`）在 [Reason.fromExitInfo] 这一处统一解释；ResidencyAudit /
 *    通知 / 诊断页 / 面板都应读它，不许各自再判一遍（E1/C6）。
 */
object Journal {

    private const val DIR = "os/journal"
    private const val FILE = "events.jsonl"
    private const val MAX_BYTES = 512 * 1024L

    /** 退出/中断原因词表（系统退出记录 -> 统一口径）。 */
    enum class Reason(val code: String) {
        OEM_BG_LIMIT("bgLimit"),
        OEM_KILL("o-kill"),
        LOW_MEMORY("lowMemory"),
        USER_STOPPED("userStopped"),
        CRASH("crash"),
        ANR("anr"),
        SIGNALED("signaled"),
        SELF_EXIT("exitSelf"),
        DEPENDENCY_DIED("dependencyDied"),
        PACKAGE_CHANGED("packageChanged"),
        PERMISSION_CHANGED("permissionChanged"),
        /** App Freezer 杀的口径：本产品的模型里「被冻」是事故不是噪音，不许落进 UNKNOWN。 */
        FREEZER("freezer"),
        UNKNOWN("unknown"),
        /** 取数本身失败 / 本机系统不提供退出史。它**不等于**「没被杀」，也不许退成 UNKNOWN。 */
        UNREADABLE("unreadable");

        companion object {
            /**
             * 把一条系统退出记录压回词表；不认的一律 UNKNOWN（不猜）。
             *
             * 描述文本优先于数值码，是这台机器的实证而不是偏好：ColorOS 的真凶口径
             * （`o-kill(4008)`、`bgLimit_level_thermal_10`、`Cached(lowmem)[…]`）只出现在描述里，
             * 而它的数值 reason 一律停在 13（AOSP `REASON_OTHER`）—— 只按数值码判，本机每一次
             * OEM 杀都会归成「不明」。代价是 AOSP 明说这串文本「不保证跨设备/跨版本稳定」，
             * 所以认不出的一律带**原始数值**落盘（见 [UNKNOWN] 的用法），让人能补词表。
             *
             * 数值码表以 AOSP android15-release 的公开 `REASON_*` 常量为准（`:65-183`，表止于 16）；
             * 更高版本会加码，else 里的数字就是**如实未归因**，不是读不到。
             *
             * 判据里没有 subreason 这一维，是因为 app 侧拿不到它：`getSubReason()` 是 `@hide`
             * （`:881-883`）。系统认识的那些 subreason 由 `getDescription()` 以 `[NAME]` 前缀落进
             * 描述文本（拼法 `:785-802`，名表 `subreasonToString` `:1351-1412`，表外的 OEM 号退
             * "UNKNOWN"）—— 所以下面这半边按词判，词表因此同时接管 OEM 的口径和 AOSP 自己的
             * `FREEZER BINDER TRANSACTION` / `FORCE STOP` / `REMOVE TASK`。抄串过的旧说法见债表 E11。
             */
            fun fromExitInfo(reason: Int, description: String?): Reason {
                val d = description?.lowercase(Locale.US) ?: ""
                return when {
                    d.contains("bglimit") -> OEM_BG_LIMIT
                    d.contains("o-kill") || d.contains("okill") -> OEM_KILL
                    d.contains("freezer") -> FREEZER
                    d.contains("lowmem") || d.contains("low memory") -> LOW_MEMORY
                    // 这里不出现裸 `contains("user")`：退出记录原文带 `user=0` 这样的字段，
                    // 旧的「user 子串」判法会把每一次退出都归成用户强杀（债 E11）。
                    d.contains("force stop") || d.contains("force-stop") ||
                        d.contains("user requested") || d.contains("user stopped") ||
                        d.contains("remove task") -> USER_STOPPED
                    d.contains("crash") -> CRASH
                    d.contains("anr") -> ANR
                    else -> when (reason) {
                        1 -> SELF_EXIT
                        2 -> SIGNALED
                        3 -> LOW_MEMORY
                        4, 5 -> CRASH
                        6 -> ANR
                        8 -> PERMISSION_CHANGED
                        10, 11 -> USER_STOPPED
                        12 -> DEPENDENCY_DIED
                        14 -> FREEZER
                        15, 16 -> PACKAGE_CHANGED
                        else -> UNKNOWN
                    }
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
