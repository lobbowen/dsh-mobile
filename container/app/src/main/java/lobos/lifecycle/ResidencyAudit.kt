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
 * 常驻中断的**取证与告警边**。一旦被杀，唯一诚实的动作是把它显示出来 —— 显示成**查到的事实**，
 * 不是显示成一句推测的机制（2026-09-30 定罪，债 E11：这里过去写死「锚掉=判决降级=即将被杀」，
 * 于是用户强停、覆盖安装、热档清理在通知里长得一模一样，而那三个东西的处置完全不同）。
 *
 * 本设计**不提供死后恢复**：复活只把壳点回来 —— 内核重启时一律把 running/pending 判成 failed
 * （console 的 `tasks.js` `_load`），agent 的工作在进程死的那一刻就断了，
 * 而复活之后的通知还会写「运行时在线」，等于把打断伪装成没打断。唯一路径是**不被杀**
 * （单链路，类音乐播放器的系统服务）：让锚一直在位，判决就一直停在 accessibility。
 *
 * 判据：活着时每拍盖一个「我还在」的时间戳。下一次进程一起来就翻旧账 —— 只要留下过记录，
 * 上一次就一定是被打断的（本仓没有任何一路能正常收尾宿主：`am stopservice` 在真机直接
 * `Error stopping service`，系统强杀/划掉/osense 更走不到 `onDestroy`）。
 * 文件里同时存开机基准（wall − elapsedRealtime）：本次算出的基准对不上，说明那条记录属于
 * 上一次开机，设备重启不该被定罪成「App 被杀」。
 *
 * 「是谁杀的」不由本对象判，也不由文案猜：[KillAudit] 从系统退出记录里取回那一次的读数，
 * 取不到就写「未取证」。判决（锚在位/掉线）另有观测边在告警（`OsHostService.observeAnchorTransition`
 * 与 `OsApplication.ensureProtectionActive`），那是**当场观测**，不需要也不许在这里事后归因。
 */
object ResidencyAudit {

    private const val FILE = "residency.txt"
    /** 判定「换了一次开机」的基准容差：时钟同步本身的抖动留余量。 */
    private const val BOOT_BASIS_TOLERANCE_MS = 60_000L
    /** 「被打断」告警的固定前缀：首行与诊断页都读它。 */
    private const val INTERRUPTION_PREFIX = "常驻被打断"

    /**
     * 翻出来的旧账。[lastAliveMs] 同时是归因的**时间下界**：早于它的退出记录属于上一次中断，
     * 拿它归因就是把旧账冒充这一次。
     */
    private data class Debt(val lastAliveMs: Long, val gapMs: Long, val deviceReboot: Boolean)

    @Volatile
    private var debt: Debt? = null

    private val timeFmt = SimpleDateFormat("HH:mm:ss", Locale.US)

    private fun file(ctx: Context): File = File(ctx.filesDir, FILE)

    /** 同一世开机内恒定；跨开机必然不同，用它区分「设备重启」与「App 被回收」。 */
    private fun bootBasisMs(): Long = System.currentTimeMillis() - SystemClock.elapsedRealtime()

    /** 进程一起来就翻旧账（幂等：只有第一次读会留下结论）。没有旧账 = 首次安装，无罪可定。 */
    @Synchronized
    fun auditPreviousExit(ctx: Context) {
        if (debt != null) return
        val lines = try {
            file(ctx).readText().trim().split("\n")
        } catch (_: Throwable) {
            return
        }
        if (lines.size < 2) return
        val lastAliveMs = lines[0].toLongOrNull() ?: return
        val priorBasisMs = lines[1].toLongOrNull() ?: return
        debt = Debt(
            lastAliveMs = lastAliveMs,
            gapMs = System.currentTimeMillis() - lastAliveMs,
            deviceReboot = abs(priorBasisMs - bootBasisMs()) > BOOT_BASIS_TOLERANCE_MS,
        )
    }

    /**
     * 活着时每拍盖戳（与状态通知同频，见 OsHostService.refreshStatusNotice）：
     * 落盘的就是「这一刻进程还活着 + 属于哪一次开机」。
     */
    @Synchronized
    fun heartbeat(ctx: Context) {
        val text = "${System.currentTimeMillis()}\n${bootBasisMs()}"
        runCatching { file(ctx).writeText(text) }
    }

    /**
     * 结论的唯一文案源：常驻通知首行与首页「最近动作」都读它，不许两处各说各话。
     *
     * 三件事缺一不可：中断了什么（存活到几点、断了多久）、**这一世查到的死因**、以及本设计不提供
     * 死后恢复。死因那句必须现取（[KillAudit.attribution]）而不是在翻旧账时固化成终稿 ——
     * 退出史是后台一次性读的，可能比本对象的定罪晚一拍就绪；那份固化正是「通知第一行永远只有
     * 『被打断』、用户看不到根因」的来源。取不到时它自己会说「未取证」，这里不替它编。
     * 设备重启那一支不归因：重启时的退出记录不代表 App 被杀。
     */
    @Synchronized
    fun interruption(): String? {
        val d = debt ?: return null
        return interruptionText(
            lastAliveAt = timeFmt.format(Date(d.lastAliveMs)),
            gapText = humanGap(d.gapMs),
            deviceReboot = d.deviceReboot,
            attribution = KillAudit.attribution(d.lastAliveMs),
        )
    }

    /**
     * 纯函数版文案判据（与 `KillAudit.attribute`、`OsPhaseRule` 同构的纪律：判据不许长在
     * Android 细节里，否则「这一支到底可不可达」只能靠真机撞）。
     * 拆出来的直接理由：债 E11 定罪的正是**这一句**里的归因段被写成常量。
     */
    fun interruptionText(lastAliveAt: String, gapText: String, deviceReboot: Boolean, attribution: String): String =
        if (deviceReboot) {
            "上次常驻结束于设备重启（$lastAliveAt），不是 App 被回收"
        } else {
            "$INTERRUPTION_PREFIX：上次存活到 $lastAliveAt，中断 $gapText；$attribution；本设计不提供死后恢复"
        }

    private fun humanGap(gapMs: Long): String = when {
        gapMs < 0 -> "时长不明（期间改过系统时间）"
        gapMs < 60_000L -> "${gapMs / 1000} 秒"
        else -> "${gapMs / 60_000L} 分 ${(gapMs % 60_000L) / 1000} 秒"
    }
}
