package lobos.os

import android.content.Context

/**
 * KillAudit：把系统退出史的原文压成统一口径（债 E1/C6）。
 *
 * 过去只认 o-kill，漏掉 bgLimit_level_thermal_*（subreason 1030）与 o-kill(6008 = lowmem)，
 * 于是判定的口径永远对不上 dumpsys 原文。现在所有解释都经 Journal.Reason 词表，
 * 词表只有一份（C6）。
 *
 * 采集面：dumpsys activity exit-info <pkg>；无权限/无输出时如实返回，绝不编造。
 */
object KillAudit {

    private const val CMD = "dumpsys activity exit-info"

    @Volatile
    private var lastMeasurement: String? = null

    /** 读一次退出史并落 Journal（本身可重复调用）。 */
    fun auditOnce(ctx: Context) {
        val pkg = ctx.packageName
        val raw = runCatching {
            // 豁免（§5 I2 的另一半）：exec 的是**系统件** `sh`+`dumpsys`，不经环境、不跑载荷，
            // 取共享树根只会让每分钟巡检 tick 反复触发装配上屏。豁免以断言表达：
            // boot-env-contract 判 5 断言本文件不自己拼环境、也不取共享树根。
            val p = ProcessBuilder("sh", "-c", CMD + " " + pkg)
                .redirectErrorStream(true)
                .start()
            val text = p.inputStream.bufferedReader().readText()
            p.waitFor()
            text
        }.getOrNull() ?: return

        if (!raw.contains(pkg)) return
        val counts = mutableMapOf<Journal.Reason, Int>()
        raw.lineSequence()
            .filter { it.contains(pkg) || it.contains("reason", ignoreCase = true) }
            .forEach { line ->
                val r = Journal.Reason.parse(line)
                if (r != Journal.Reason.UNKNOWN && r != Journal.Reason.DEVICE_REBOOT) {
                    counts[r] = (counts[r] ?: 0) + 1
                    Journal.append(ctx, "kill-audit", r, line.trim().take(200))
                }
            }
        if (counts.isEmpty()) return
        val summary = counts.entries
            .sortedByDescending { it.value }
            .joinToString("; ") { it.key.code + " x" + it.value }
        lastMeasurement = summary
        Journal.append(ctx, "kill-audit", null, "退出史口径 " + summary)
    }

    /** 供通知首行/诊断页读取的口径；从未采集过返回 null（不伪造）。 */
    fun measurement(): String? = lastMeasurement

    /** 兼容旧调用名。 */
    fun killMeasurement(): String? = measurement()
}
