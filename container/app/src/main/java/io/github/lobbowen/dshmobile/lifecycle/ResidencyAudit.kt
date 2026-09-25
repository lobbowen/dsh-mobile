package io.github.lobbowen.dshmobile.lifecycle

import android.content.Context
import android.os.SystemClock
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs

/**
 * 常驻中断的**定罪边**。它取代的是「进程被杀后周期复活」那条路：复活只把壳点回来 ——
 * 内核重启时一律把 running/pending 判成 failed（`kernel/src/platform/tasks.js` 的 `_load`），
 * 而复活之后的通知又会写「运行时在线」，等于把打断伪装成没打断。本产品要的是**不被杀**
 * （单链路，类音乐播放器的系统服务），一旦被杀，唯一诚实的动作是把它显示出来，不是再拽一次。
 *
 * 判据：活着时每拍盖一个「我还在」的时间戳并写明未干净收尾；只有服务 `onDestroy` 才补 clean 戳。
 * 下一次进程一起来就翻旧账 —— 没有 clean 戳 = 上次不是正常退出（强杀/划掉/osense 都走不到 onDestroy）。
 * 文件里同时存开机基准（wall − elapsedRealtime）：本次算出的基准对不上，说明那条记录属于
 * 上一次开机，设备重启不该被定罪成「App 被杀」。
 */
object ResidencyAudit {

    private const val FILE = "residency.txt"
    private const val STATE_ALIVE = "alive"
    private const val STATE_CLEAN = "clean"
    /** 判定「换了一次开机」的基准容差：时钟同步本身的抖动留余量。 */
    private const val BOOT_BASIS_TOLERANCE_MS = 60_000L

    @Volatile
    private var interruptionLine: String? = null

    private val timeFmt = SimpleDateFormat("HH:mm:ss", Locale.US)

    private fun file(ctx: Context): File = File(ctx.filesDir, FILE)

    /** 同一世开机内恒定；跨开机必然不同，用它区分「设备重启」与「App 被回收」。 */
    private fun bootBasisMs(): Long = System.currentTimeMillis() - SystemClock.elapsedRealtime()

    /** 进程一起来就翻旧账（幂等：只有第一次读会留下结论）。没有旧账 = 首次安装，无罪可定。 */
    @Synchronized
    fun auditPreviousExit(ctx: Context) {
        if (interruptionLine != null) return
        val lines = try {
            file(ctx).readText().trim().split("\n")
        } catch (_: Throwable) {
            return
        }
        if (lines.size < 3) return
        val lastAliveMs = lines[0].toLongOrNull() ?: return
        val priorBasisMs = lines[1].toLongOrNull() ?: return
        if (lines[2] == STATE_CLEAN) return
        interruptionLine = if (abs(priorBasisMs - bootBasisMs()) > BOOT_BASIS_TOLERANCE_MS) {
            "上次常驻结束于设备重启（${timeFmt.format(Date(lastAliveMs))}），不是 App 被回收"
        } else {
            val gapMs = System.currentTimeMillis() - lastAliveMs
            "常驻被打断：上次存活到 ${timeFmt.format(Date(lastAliveMs))}，中断 ${humanGap(gapMs)}"
        }
    }

    /** 活着时每拍盖戳（与状态通知同频，见 ContainerSupervisor.refreshStatusNotice）。 */
    @Synchronized
    fun heartbeat(ctx: Context) = write(ctx, STATE_ALIVE)

    /** 正常收尾才留这个戳。系统强杀走不到这里，于是下次启动必然定罪 —— 这正是本边的用途。 */
    @Synchronized
    fun markCleanStop(ctx: Context) = write(ctx, STATE_CLEAN)

    /** 结论的唯一文案源：常驻通知首行与首页「最近动作」都读它，不许两处各说各话。 */
    fun interruption(): String? = interruptionLine

    private fun write(ctx: Context, state: String) {
        val text = "${System.currentTimeMillis()}\n${bootBasisMs()}\n$state"
        runCatching { file(ctx).writeText(text) }
    }

    private fun humanGap(gapMs: Long): String = when {
        gapMs < 0 -> "时长不明（期间改过系统时间）"
        gapMs < 60_000L -> "${gapMs / 1000} 秒"
        else -> "${gapMs / 60_000L} 分 ${(gapMs % 60_000L) / 1000} 秒"
    }
}
