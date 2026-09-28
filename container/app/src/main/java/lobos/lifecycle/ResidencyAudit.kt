package lobos.lifecycle

import android.content.Context
import lobos.os.KillAudit
import android.os.SystemClock
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs

/**
 * 常驻中断的**判决降级告警边**。锚掉 = ColorOS 判决掉出 importance=accessibility = 即将被杀
 * （真机 2026-09-27 实证）；一旦被杀，唯一诚实的动作是把它显示出来。
 *
 * 本设计**不提供死后恢复**：复活只把壳点回来 —— 内核重启时一律把 running/pending 判成 failed
 * （console 的 `tasks.js` `_load`），agent 的工作在进程死的那一刻就断了，
 * 而复活之后的通知还会写「运行时在线」，等于把打断伪装成没打断。唯一路径是**不被杀**
 * （单链路，类音乐播放器的系统服务）：让锚一直在位，判决就一直停在 accessibility。
 *
 * 判据：活着时每拍盖一个「我还在」的时间戳并写明未干净收尾；只有服务 `onDestroy` 才补 clean 戳。
 * 下一次进程一起来就翻旧账 —— 没有 clean 戳 = 上次不是正常退出（强杀/划掉/osense 都走不到 onDestroy）。
 * 文件里同时存开机基准（wall − elapsedRealtime）：本次算出的基准对不上，说明那条记录属于
 * 上一次开机，设备重启不该被定罪成「App 被杀」。
 *
 * 「是谁杀的、被杀过几次」不由本对象猜：系统退出史（[KillAudit] 度量）给出事实，本对象只负责把
 * 它接进告警文案 —— 常驻通知首行与诊断页因此都能看到 o-kill，而不是笼统的「被打断」。
 */
object ResidencyAudit {

    private const val FILE = "residency.txt"
    private const val STATE_ALIVE = "alive"
    private const val STATE_CLEAN = "clean"
    /** 判定「换了一次开机」的基准容差：时钟同步本身的抖动留余量。 */
    private const val BOOT_BASIS_TOLERANCE_MS = 60_000L
    /** 「被打断」告警的固定前缀：interruption() 靠它判断该不该补机制与度量。 */
    private const val INTERRUPTION_PREFIX = "常驻被打断"
    /** 这次中断的机制：锚掉 = 判决掉出 accessibility = 即将被杀。 */
    private const val VERDICT_DEGRADED_NOTE = "锚掉=判决降级=即将被杀"

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
            "$INTERRUPTION_PREFIX：上次存活到 ${timeFmt.format(Date(lastAliveMs))}，中断 ${humanGap(gapMs)}"
        }
    }

    /** 活着时每拍盖戳（与状态通知同频，见 OsHostService.refreshStatusNotice）。 */
    @Synchronized
    fun heartbeat(ctx: Context) = write(ctx, STATE_ALIVE)

    /** 正常收尾才留这个戳。系统强杀走不到这里，于是下次启动必然定罪 —— 这正是本边的用途。 */
    @Synchronized
    fun markCleanStop(ctx: Context) = write(ctx, STATE_CLEAN)

    /**
     * 结论的唯一文案源：常驻通知首行与首页「最近动作」都读它，不许两处各说各话。
     *
     * 文案必须同时说清三件事：机制（锚掉=判决降级=即将被杀）、被杀度量（[KillAudit] 的
     * o-kill 次数与真凶）、以及本设计不提供死后恢复。度量是后台一次性采的，可能比本对象的
     * 定罪晚一拍就绪，所以这里**每次读都现取**，而不是在 auditPreviousExit 时固化成终稿 ——
     * 那份固化正是「通知第一行永远只有『被打断』、用户看不到根因」的来源。
     * 设备重启那一支不补机制与度量：重启时的退出记录不代表 App 被杀。
     */
    fun interruption(): String? {
        val base = interruptionLine ?: return null
        if (!base.startsWith(INTERRUPTION_PREFIX)) return base
        val measured = KillAudit.killMeasurement()
        val tail = if (measured == null) VERDICT_DEGRADED_NOTE else "$VERDICT_DEGRADED_NOTE；$measured"
        return "$base（$tail；本设计不提供死后恢复）"
    }

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
