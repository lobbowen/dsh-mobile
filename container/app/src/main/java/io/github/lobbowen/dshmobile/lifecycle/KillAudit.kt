package io.github.lobbowen.dshmobile.lifecycle

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import io.github.lobbowen.dshmobile.RuntimeDiagnostics
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 加固效果度量：加固到底有没有把 ColorOS 的判决捂住。
 *
 * 定位（2026-09-27 用户拍板）：本设计**不提供死后恢复，唯一路径是不被杀**。锚在位 = 判决停在
 * importance=accessibility；锚掉 = importance=traffic = 即将被 o-kill。本对象不是恢复动作，
 * 也不触发任何恢复，它只回答一个可度量的问题：**被谁杀过、杀过几次、每次的 description/
 * reason/importance 是什么** —— 用来验证「确保锚在位」这个预防手段是否真的有效。
 *
 * 判决链（真机 2026-09-27 07:08 实证）：
 *   锚在位 ⟺ OplusHansManager 打 "cannot transition from R to M, importance=accessibility"；
 *   锚不在位 → importance=traffic → 随后 o-kill（dumpsys activity exit-info: reason=13
 *   OTHER KILLS BY SYSTEM, description=o-kill(4008)，主进程 importance=125 前台服务级照杀）。
 *
 * 取证手段：ActivityManager.getHistoricalProcessExitReasons()（API 30+）。App 可以读**自己**
 * 的退出史，不需要 ADB，也不需要 root。三条铁律：
 *  · **API 守卫**：minSdk 24，API<30 直接返回「不可用」，绝不因缺 ApplicationExitInfo 而崩；
 *  · **一次性 + 缓存**：系统对退出史查询有限流，本对象整个进程只查一次，成败都缓存；
 *    绝不轮询、绝不在主线程重复触发；
 *  · **只认正主进程**：:node 有自己的退出史，两个进程写同一份 JSON 会互相顶掉，
 *    所以只有进程名 == 包名的 :main 才落盘（低版本经 /proc/self/cmdline 判定）。
 *
 * 它**不是**能力判据：这里只描述「发生过什么」。设备能力是否达标仍只由
 * CapabilityCatalog / CapabilityCriteria / PermissionCatalog 裁定，别处不许再判一遍。
 */
object KillAudit {

    /** 退出史落盘文件名（files 下的小 JSON，度量与诊断用）。 */
    private const val FILE = "kill-audit.json"

    /**
     * 只往回看最近几条。度量只看最近一次死亡；历史只为交叉印证 ——
     * 多采既无增益，又会先把系统侧的限流额度耗掉。
     */
    private const val MAX_RECORDS = 8

    /** ApplicationExitInfo.REASON_OTHER 的数值（API 30 常量）；写死字面量以免低版本解析新类。 */
    private const val REASON_OTHER = 13

    private const val NOTE_NOT_MAIN = "非正主进程（:node 有自己的退出史，落盘会与 :main 互相顶掉）"
    private const val NOTE_LOW_API = "Android < 11（API 30）没有退出史接口，只能按存活戳告警"

    @Volatile
    private var cached: Verdict? = null

    /** 单条退出记录：只保留本对象自己的类型，不含任何 API 30 类型，低版本也能安全持有与序列化。 */
    data class ExitRecord(
        val reason: Int,
        val reasonLabel: String,
        val description: String,
        val timestampMs: Long,
        val importance: Int,
        val pid: Int,
        val processName: String,
        val status: Int,
        /** 是否命中 o-kill 特征（判定口径见 isOkill）。 */
        val isOkill: Boolean,
    )

    /** 一次取证的全部结论。 */
    data class Verdict(
        val available: Boolean,
        val records: List<ExitRecord>,
        val okillCount: Int,
        val note: String,
    ) {
        /** 退出史按时间从新到旧返回，首条即最近一次死亡。 */
        val latest: ExitRecord? get() = records.firstOrNull()
        /** 最近一次死亡是否就是 o-kill。 */
        val latestIsOkill: Boolean get() = latest?.isOkill == true
    }

    /**
     * 一次性采集并缓存。**只许在后台线程调用** —— 内部是对 system_server 的 binder 查询。
     * 成败都缓存：一次失败就反复重试只会撞系统限流，反而把唯一一条取证通道弄哑。
     *
     * @return 永远非空；API<30、非正主进程或查询被拒时 available=false，note 说明原因。
     */
    @Synchronized
    fun auditOnce(ctx: Context): Verdict {
        cached?.let { return it }
        val app = ctx.applicationContext ?: ctx
        val verdict = if (isMainProcess(app)) collect(app) else skip(NOTE_NOT_MAIN)
        cached = verdict
        return verdict
    }

    /**
     * 加固效果度量的一行摘要：系统退出史里被 o-kill 过几次、最近一次的 description/reason/importance。
     * 只有**最近一次**退出确实命中 o-kill 才返回；历史里的旧 o-kill 不给本次中断背锅。
     * 尚未就绪时返回 null —— 告警文案先只有机制半句，等度量采完，通知与诊断页下一次刷新自然补上。
     */
    fun killMeasurement(): String? {
        val verdict = cached ?: return null
        val latest = verdict.latest ?: return null
        if (!latest.isOkill) return null
        val who = latest.description.ifBlank { latest.reasonLabel }
        return "系统退出史里 o-kill ${verdict.okillCount} 次，最近一次：$who，" +
            "reason=${latest.reason}(${latest.reasonLabel})，importance=${latest.importance}"
    }

    // ---- 内部实现 ----

    private fun skip(note: String) = Verdict(false, emptyList(), 0, note)

    /**
     * 真读系统。API 30 以下直接降级 —— 这是 minSdk 24 的硬守卫：
     * 低版本连类都不解析，不可能因为缺 ApplicationExitInfo 而崩。
     */
    private fun collect(ctx: Context): Verdict {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return skip(NOTE_LOW_API)
        return try {
            val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
                ?: return skip("拿不到 ActivityManager")
            // 读**自己**的退出史：App 自查不需要 ADB/root；pid=0 覆盖本包所有进程。
            val raw = am.getHistoricalProcessExitReasons(ctx.packageName, 0, MAX_RECORDS) ?: emptyList()
            val records = raw.map { r ->
                val desc = r.description ?: ""
                ExitRecord(
                    reason = r.reason,
                    reasonLabel = reasonLabel(r.reason),
                    description = desc,
                    timestampMs = r.timestamp,
                    importance = r.importance,
                    pid = r.pid,
                    processName = r.processName ?: "",
                    status = r.status,
                    isOkill = isOkill(r.reason, desc),
                )
            }
            val verdict = Verdict(true, records, records.count { it.isOkill }, "共 ${records.size} 条退出记录")
            persist(ctx, verdict)
            noteOnce(ctx, verdict)
            verdict
        } catch (t: Throwable) {
            // SecurityException / 被 ROM 关掉 / 其它异常一律降级为「不可用」，并缓存这次失败。
            skip("${t::class.java.simpleName}: ${t.message}")
        }
    }

    /**
     * o-kill 判定：ColorOS 的 description 形如 "o-kill(4008)"（2026-09-27 真机
     * dumpsys activity exit-info 实证）。同时接受不带连字符的拼法，以及
     * 「reason=13(OTHER KILLS BY SYSTEM) 且 description 含 kill」的系统级杀法 ——
     * 有的 ROM 会把 o-kill 折叠成更笼统的 OTHER KILLS。
     */
    private fun isOkill(reason: Int, description: String): Boolean {
        val d = description.lowercase()
        return d.contains("o-kill") || d.contains("okill") ||
            (reason == REASON_OTHER && d.contains("kill"))
    }

    /**
     * reason 数值 → 可读标签。数值口径照抄 ApplicationExitInfo.REASON_*（API 30）。
     * 刻意用整数字面量而不是引用那些常量：引用会把新类拖进本方法的常量池，
     * 而本对象在 minSdk 24 上也要能被加载。
     */
    private fun reasonLabel(reason: Int): String = when (reason) {
        1 -> "EXIT_SELF"
        2 -> "SIGNALED"
        3 -> "LOW_MEMORY"
        4 -> "CRASH"
        5 -> "CRASH_NATIVE"
        6 -> "ANR"
        7 -> "INITIALIZATION_FAILURE"
        8 -> "PERMISSION_CHANGE"
        9 -> "EXCESSIVE_RESOURCE_USAGE"
        10 -> "USER_REQUESTED"
        11 -> "USER_STOPPED"
        12 -> "DEPENDENCY_DIED"
        13 -> "OTHER KILLS BY SYSTEM"
        14 -> "FREEZER"
        15 -> "PACKAGE_STATE_CHANGE"
        16 -> "PACKAGE_UPDATED"
        else -> "UNKNOWN($reason)"
    }

    /** 结构化落盘：诊断页/常驻通知之外，还需要一份机器可读的原始证据。 */
    private fun persist(ctx: Context, verdict: Verdict) {
        runCatching {
            val root = JSONObject()
                .put("collectedAtMs", System.currentTimeMillis())
                .put("available", verdict.available)
                .put("note", verdict.note)
                .put("okillCount", verdict.okillCount)
            val arr = JSONArray()
            verdict.records.forEach { r ->
                arr.put(
                    JSONObject()
                        .put("reason", r.reason)
                        .put("reasonLabel", r.reasonLabel)
                        .put("description", r.description)
                        .put("timestampMs", r.timestampMs)
                        .put("importance", r.importance)
                        .put("pid", r.pid)
                        .put("processName", r.processName)
                        .put("status", r.status)
                        .put("okill", r.isOkill)
                )
            }
            root.put("records", arr)
            File(ctx.filesDir, FILE).writeText(root.toString())
        }
    }

    /** 把 o-kill 这个结论也写进诊断流水：诊断页按文本读，结构化 JSON 另存。 */
    private fun noteOnce(ctx: Context, verdict: Verdict) {
        val latest = verdict.latest ?: return
        if (!latest.isOkill) return
        runCatching {
            RuntimeDiagnostics.append(
                ctx, "kill-audit", false,
                "上次退出被系统 o-kill 干掉",
                "${latest.description} · reason=${latest.reason}(${latest.reasonLabel}) · " +
                    "importance=${latest.importance} · pid=${latest.pid} · ${latest.processName}"
            )
        }
    }

    /**
     * 进程名判定：/proc/self/cmdline 在 Android 上就是进程名（与 ContainerSupervisor.selfCmdline 同口径）。
     * 不用 API 28 的 Application.getProcessName()，维持 minSdk 24 下无守卫可用。
     */
    private fun isMainProcess(ctx: Context): Boolean {
        val proc = try {
            File("/proc/self/cmdline").readBytes().toString(Charsets.UTF_8).trimEnd('\u0000')
        } catch (_: Throwable) {
            return true // 读不到不阻断取证：宁可多采一次，也不许零采集
        }
        return proc.isEmpty() || proc == ctx.packageName
    }
}
