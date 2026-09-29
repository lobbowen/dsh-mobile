package lobos.os

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * KillAudit：读**本包**的系统退出记录，落成 [Journal] 的统一口径（债 E11/C6/E1）。
 *
 * 为什么换数据源（2026-09-30 定罪）：旧写法 exec `dumpsys activity exit-info <pkg>`，而 dumpsys
 * 要 android.permission.DUMP —— app uid 下它稳定回 `Permission Denial`，于是这条采集在生产域
 * **从来没有返回过一个字节**（设备 journal 251 行里 kill-audit 0 条）。一扇永远推不开的门长得
 * 跟没有门一样：读数为空，而通知却照样说得出一句「死因」。
 * 现在走 `ActivityManager.getHistoricalProcessExitReasons`：AOSP 源码写明查**自己 UID 的包**
 * 不需要任何权限（查别人才要 DUMP），拿到的是同一批 ApplicationExitInfo 记录。
 *
 * 「被杀过几次」不在这里攒内存计数：每条记录按 [Journal] 落盘，要统计走 os.journal.metrics
 * （单一出口，见 Journal 头注的纪律）。本对象只留两件事 —— 台账（落盘）与归因（这次中断的死因）。
 */
object KillAudit {

    private const val CURSOR_FILE = "kill-audit-cursor.txt"

    /**
     * 单次取回的上界：退出史按包留得很长，全量落盘会挤掉 journal 里别的事件。
     * 系统返回的是「新→旧」（AOSP `ActivityManager.java:4453-4454`），所以这颗上界截掉的是**老记录**，
     * 而游标只在「本次比上次新」时前进 —— 两者合起来决定：一次成组清理攒出几十条时，落盘的是最近那批。
     */
    private const val MAX_RECORDS = 32

    /**
     * 一条退出记录里用得上的字段。数值码原样留着，词表不认时它就是补词表的证据。
     *
     * 字段表停在公开 API 的边界上，不是漏采：`ApplicationExitInfo.getSubReason()` 在 AOSP 源码里
     * 标着 `@hide`（android15-release `:881-883`），app uid 拿不到那颗号，而按号猜口径就是伪造事实。
     * 系统认识的 subreason 会由 `getDescription()` 以 `[NAME]` 前缀落进描述文本，判据按词接得住
     * （见 [Journal.Reason.fromExitInfo]）；抄串过的旧说法与完整推导记在债表 E11。
     */
    data class ExitRecord(
        val atMs: Long,
        val pid: Int,
        val process: String,
        val reason: Int,
        val importance: Int,
        val description: String?,
    ) {
        val verdict: Journal.Reason get() = Journal.Reason.fromExitInfo(reason, description)

        fun detail(): String = "reason=" + reason + " importance=" + importance +
            " process=" + process + " desc=" + (description?.take(160) ?: "null")
    }

    /**
     * 一次取数的完整快照：读数 + 这批读数属于哪个进程 + 取不到时为什么。
     * 三者同生共死，免得出现「有读数却没有主体进程」这种自相矛盾的中间态。
     */
    private data class Reading(
        val exits: List<ExitRecord>,
        val ownProcess: String,
        val unreadable: String?,
    )

    /** null = 这次进程出生还没读过退出史（采集在后台线程，可能晚于第一次读文案）。 */
    @Volatile
    private var reading: Reading? = null

    /** 读一次退出史并落 Journal（进程出生时戳一次，见 OsApplication / BootReceiver）。 */
    fun auditOnce(ctx: Context) {
        val pkg = ctx.packageName
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            reportUnreadable(ctx, pkg, "本机系统（API ${Build.VERSION.SDK_INT}）不提供退出史")
            return
        }
        val raw = runCatching {
            (ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager)
                .getHistoricalProcessExitReasons(pkg, 0, MAX_RECORDS)
        }.getOrNull()
        if (raw == null) {
            reportUnreadable(ctx, pkg, "读系统退出史失败（binder 调用没答上来）")
            return
        }
        val records = raw.map {
            ExitRecord(
                atMs = it.timestamp,
                pid = it.pid,
                process = it.processName,
                reason = it.reason,
                importance = it.importance,
                description = it.description,
            )
        }
        reading = Reading(records, pkg, null)
        val cursor = readCursor(ctx)
        // 落盘按旧 -> 新，账本才读得通。
        records.asReversed().filter { isNewerThanCursor(it, cursor) }.forEach {
            Journal.append(ctx, "kill-audit", it.verdict, it.detail())
        }
        // 只前进不后退：系统留存的退出史会轮换，某次取到的「最新一条」可能比游标还旧，
        // 直接覆写会把游标倒回去，下一次启动就把同批记录再落一遍盘（台账变成噪音）。
        records.filter { isNewerThanCursor(it, cursor) }.maxByOrNull { it.atMs }
            ?.let { writeCursor(ctx, it) }
    }

    /**
     * 中断文案里的归因段：**只能**由取证结果生成（债 E11 定罪的就是它此前是一句常量）。
     * 常驻就是主进程，所以主体进程取本包包名。
     */
    fun attribution(sinceMs: Long): String {
        val r = reading ?: return "死因未取证（还没读系统退出史）"
        return attribute(r.exits, r.unreadable, sinceMs, r.ownProcess)
    }

    /**
     * 纯函数版判据，单列出来是为了能在 JVM 单测里钉死它（与 `OsPhaseRule` 同构的纪律：
     * 判据不许长在 Android 细节里，否则「这条归因可不可达」只能靠真机撞）。
     *
     * 三条各对应 2026-09-30 定罪里的一处冒充，缺一条就会重新写成常量：
     *  · 只认 [mainProcess] 的退出记录 —— 同包里渲染/沙箱进程死了不等于常驻断了；
     *  · 只认发生在 [sinceMs] **之后**的那条 —— 早于它的记录属于上一次中断，拿它归因是翻旧账；
     *  · 两条都不满足就说「未取证」并说清为什么，绝不退成「没被杀」。
     */
    fun attribute(
        exits: List<ExitRecord>,
        unreadable: String?,
        sinceMs: Long,
        mainProcess: String,
    ): String {
        val r = exits.firstOrNull { it.process == mainProcess && it.atMs >= sinceMs }
        if (r == null) {
            return if (unreadable == null) {
                "死因未取证（退出史里没有这次中断对应的记录）"
            } else {
                "死因未取证（$unreadable）"
            }
        }
        val at = SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(Date(r.atMs))
        return "死因=" + r.verdict.code + "（系统退出记录 " + at + " " + r.detail() + "）"
    }

    private fun reportUnreadable(ctx: Context, pkg: String, why: String) {
        reading = Reading(emptyList(), pkg, why)
        Journal.append(ctx, "kill-audit", Journal.Reason.UNREADABLE, why)
    }

    /**
     * 台账去重。判据是 (时间戳, pid) 而不是只看时间戳：OEM 成组清理会在同一毫秒留下多条记录，
     * 只比时间戳会把同一毫秒的兄弟进程**静默丢掉** —— 那正是本对象存在的理由要防的事。
     */
    private fun isNewerThanCursor(r: ExitRecord, cursor: Pair<Long, Int>): Boolean =
        r.atMs > cursor.first || (r.atMs == cursor.first && r.pid > cursor.second)

    private fun readCursor(ctx: Context): Pair<Long, Int> = runCatching {
        val parts = File(ctx.filesDir, CURSOR_FILE).readText().trim().split(" ")
        (parts.getOrNull(0)?.toLongOrNull() ?: 0L) to (parts.getOrNull(1)?.toIntOrNull() ?: 0)
    }.getOrDefault(0L to 0)

    private fun writeCursor(ctx: Context, newest: ExitRecord) {
        runCatching { File(ctx.filesDir, CURSOR_FILE).writeText("${newest.atMs} ${newest.pid}") }
    }
}
