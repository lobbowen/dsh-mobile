package io.github.lobbowen.dshmobile.ui

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * G1-1 探针日志：真机定罪四项（spec §7）的**唯一证据载体**。
 *
 * 为什么单独成文件而不是进 RuntimeDiagnostics：诊断页是给人读的流水，探针日志是
 * 要**复制导出回来做定罪结论**的结构化证据（设备 adb 关闭，剪贴板是唯一出口）。
 * 每行带毫秒时间戳 —— ④（mDNS 发布时序）的判据就是这里的时间差。
 */
object ProbeJournal {

    private const val FILE = "probe-journal.txt"
    private val tsFmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    // 定罪槽位（跨事件关联后才拼得出结论；@Volatile 因写入方分布在主线程与 NSD/工作线程）。
    @Volatile var browsePairingStartedAt: Long = 0L
    @Volatile var pairingRecordFirstSeenAt: Long = 0L
    @Volatile var browseConnectStartedAt: Long = 0L
    @Volatile var connectRecordFirstSeenAt: Long = 0L
    @Volatile var codeReceivedAt: Long = 0L
    @Volatile var deepLinkEmittedAt: Long = 0L

    fun file(ctx: Context): File = File(ctx.filesDir, FILE)

    @Synchronized
    fun append(ctx: Context, tag: String, message: String) {
        val line = "${tsFmt.format(Date())} [$tag] $message\n"
        runCatching { file(ctx).appendText(line) }
    }

    @Synchronized
    fun clear(ctx: Context) {
        runCatching { file(ctx).writeText("") }
        browsePairingStartedAt = 0L; pairingRecordFirstSeenAt = 0L
        browseConnectStartedAt = 0L; connectRecordFirstSeenAt = 0L
        codeReceivedAt = 0L; deepLinkEmittedAt = 0L
    }

    /** 四项定罪进度摘要（拼在报告头部；「未定罪」的槽位保留提示作用）。 */
    fun verdicts(): String {
        fun ms(x: Long) = if (x > 0) x.toString() else "—"
        val v1 = "① 下拉通知栏时配对对话框存活 —— 需人工对照：输码时刻 ${ms(codeReceivedAt)} 前后对话框是否仍在"
        val v2 = "② mDNS 可见性：pairing 记录=${if (pairingRecordFirstSeenAt > 0) "见过" else "未见过"}; connect 记录=${if (connectRecordFirstSeenAt > 0) "见过" else "未见过"}"
        val v3 = "③ 无线调试深链：intent 已发于 ${ms(deepLinkEmittedAt)} —— 需人工确认落在哪一页"
        val v4 = if (browsePairingStartedAt in 1L until pairingRecordFirstSeenAt)
            "④ browse→首记录延迟 = ${pairingRecordFirstSeenAt - browsePairingStartedAt} ms"
        else "④ browse→首记录延迟 —— 未采到（先开 browse 再开对话框）"
        return "$v1\n$v2\n$v3\n$v4"
    }

    fun readAll(ctx: Context): String = runCatching { file(ctx).readText() }.getOrDefault("")
}
