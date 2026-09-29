package lobos.lifecycle

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import lobos.OsApplication
import lobos.R
import lobos.RuntimeDiagnostics
import lobos.bridge.CapabilityBroker
import lobos.bridge.ScreenCaptureController
import lobos.capability.AdbChannelProbe
import lobos.capability.CapabilityEvidenceCollector
import lobos.os.AppRegistry
import lobos.os.OsFacts
import lobos.os.OsInit
import lobos.os.OsPhase
import lobos.ota.ProgramManager
import lobos.runtime.InstanceHost
import lobos.ui.setup.SetupActivity

/**
 * Lob OS 宿主 —— **单一生命周期**的唯一承载点：唯一前台服务 + 唯一常驻通知。
 *
 * 设计前提（v4 §2.3 五层保活组合）：
 *  - Android 只看得到一个进程（:main）、一个前台服务（本服务）、一条通知；
 *  - 运行时实例（InstanceHost）、能力桥（CapabilityBroker）、截屏（ScreenCaptureController）
 *    都是**本进程内的组件**，不再各自成为 Android 进程或前台服务；
 *  - 因此没有跨进程监督链：没有 bindService/rebind，也没有跨进程存活/出生标记判据。
 *    实例自身的启动失败退避留在 InstanceHost 内部（父看子，同进程）。
 *
 * 不提供死后恢复（用户拍板 + ADR-0006）：进程真被 ROM 清掉时，唯一动作是让打断可见
 * （ResidencyAudit/Journal），不做 checkpoint/replay，也不假装"运行时还在线"。
 *
 * 通知 = 状态出口：用户不打开界面也能看到运行时/通道/锚的当前状态。
 */
class OsHostService : Service() {

    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var lastNotifyMs = 0L

    private var instance: InstanceHost? = null
    private var broker: CapabilityBroker? = null
    private var capture: ScreenCaptureController? = null

    // ---- 锚层：只观测状态翻转（复用本服务 tick，不新起闹钟/心跳，也不在这里自愈） ----
    private var anchorBoundLastTick: Boolean? = null

    /** 本服务不对外提供调用面（同进程组件直连），仅维持自身生命周期。 */
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 先翻旧账再转前台：定罪结论必须在第一条状态出来之前就位（幂等，只有首次读盘）。
        ResidencyAudit.auditPreviousExit(this)
        // 每次投递都重新自转前台：普通 startService 路径没有 FGS 特权，被拒时吞。
        promoteToForeground()
        ensureComponents(intent)
        if (thread == null) {
            thread = HandlerThread("lobos-host").apply { start() }
            handler = Handler(thread!!.looper)
            handler?.postDelayed(tick, TICK_MS)
            // 状态机唯一迁移入口：state.json = 通知 = 控制台（C1 三处同源）。
            OsInit.transition(this, OsPhase.RUNNING, "宿主组件就绪")
            // 程序登记（AUD-G37）：把 OS 实际在管的 console Program 写进 files/os/programs.json，
            // 否则 os.programs.*/os.instances.* 永远是空账。装没装由 CURRENT 指针如实决定。
            runCatching {
                val ver = ProgramManager(this).currentVersion()
                AppRegistry.upsert(
                    this,
                    AppRegistry.Entry(
                        id = AppRegistry.consoleId(),
                        version = ver,
                        role = "system",
                        desired = if (ver.isNullOrBlank()) AppRegistry.Desired.STOPPED else AppRegistry.Desired.RUNNING,
                        port = null,
                    ),
                )
            }
            // Doze 兜底（AUD-G22）：每次宿主就位都重排一次（幂等，同 PendingIntent 覆盖）。
            lobos.os.DozeBackstop.schedule(this)
            RuntimeDiagnostics.append(
                this, "host", true, "Lob OS 宿主就位（单进程 / 单前台服务）",
                "组件：InstanceHost + CapabilityBroker + ScreenCaptureController；节拍 " + TICK_MS + "ms",
            )
            // 运行环境挂在「宿主就位」这条边上装配（债表 ENV-1）：$PREFIX 真名、随包 npm、
            // 信任根重播与 C 层供给都不该等某颗 Program 被启动才发生。
            // 必须投递到 lobos-host 线程：provision 是实打实的复制（bash/rg/libc++），
            // 在 onStartCommand 的主线程上做就是 ANR 风险。
            handler?.post {
                try {
                    lobos.os.RuntimeEnvironment.ensure(this)
                } catch (e: Throwable) {
                    RuntimeDiagnostics.append(
                        this, "prefix", false, "运行环境装配异常（\$PREFIX 内状态未知）",
                        "${e::class.java.simpleName}: ${e.message}"
                    )
                }
            }
        }
        return START_STICKY
    }

    private fun promoteToForeground() {
        try {
            startForeground(NOTIF_ID, buildNotification(OsInit.statusLine(this)))
        } catch (t: Throwable) {
            RuntimeDiagnostics.append(
                this, "host", false, "转前台失败",
                t::class.java.simpleName + ": " + t.message,
            )
        }
    }

    /** 组件都在本进程内：构造一次、幂等 start，之后只转发宿主 intent。 */
    private fun ensureComponents(intent: Intent?) {
        try {
            val i = instance ?: InstanceHost(this).also { instance = it; it.start() }
            i.onHostStart(intent)
        } catch (t: Throwable) {
            RuntimeDiagnostics.append(this, "runtime", false, "运行时实例组件异常", t::class.java.simpleName + ": " + t.message)
        }
        try {
            val b = broker ?: CapabilityBroker(this).also { broker = it; it.start() }
            b.onHostStart(intent)
        } catch (t: Throwable) {
            RuntimeDiagnostics.append(this, "bridge", false, "能力桥组件异常", t::class.java.simpleName + ": " + t.message)
        }
        try {
            val c = capture ?: ScreenCaptureController(this).also { capture = it; it.start() }
            c.onHostStart(intent)
        } catch (t: Throwable) {
            RuntimeDiagnostics.append(this, "capture", false, "截屏组件异常", t::class.java.simpleName + ": " + t.message)
        }
    }

    private val tick: Runnable = Runnable {
        try {
            val now = SystemClock.elapsedRealtime()
            // 一拍只读一次锚：观测边与状态行必须拿同一份读数，读两次就可能各说各话
            // （相邻两拍之间系统真的会重绑，那时「告警说在位、正文说掉线」又是一处同源破口）。
            val anchor = AccessibilityAnchor.state(this)
            observeAnchorTransition(anchor)
            refreshStatusNotice(now, anchor)
        } catch (e: Throwable) {
            Log.e(TAG, "宿主节拍异常（不致命，下一拍继续）", e)
        } finally {
            handler?.postDelayed(tick, TICK_MS)
        }
    }

    /** 常驻通知 = 状态出口；心跳与状态同拍（这一拍落盘 = 这一刻进程还活着）。 */
    private fun refreshStatusNotice(now: Long, anchor: AnchorState) {
        if (now - lastNotifyMs < NOTIFY_MS) return
        lastNotifyMs = now
        ResidencyAudit.heartbeat(this)
        val facts = OsFacts(
            readingsCollected = true,
            controlPlaneUp = runCatching { CapabilityEvidenceCollector.controlPlaneUp() }.getOrDefault(false),
            channel = AdbChannelProbe.cached().outcome,
            anchor = anchor,
        )
        // 先落盘再上屏：通知渲染的是 state.json 那一份，不是另一把现场拼出来的尺子。
        OsInit.refresh(this, facts, ResidencyAudit.interruption())
        runCatching {
            (getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager)
                .notify(NOTIF_ID, buildNotification(OsInit.statusLine(this)))
        }
    }

    /**
     * 锚层监护：**只观测，不复活**。
     *
     * 为什么删掉自愈重试环（2026-09-28 拍板）：锚掉线意味着 ColorOS 的判决已经降到
     * importance=traffic（AnchorPolicy 头注的真机实证），此时反复 `settings put` 是把「已经输掉
     * 的判决」用重试伪装成正常 —— 那是兜底，不是判据。恢复窗口在**进程出生的第一毫秒**
     * （OsApplication / BootReceiver 各戳一次，硬上界见 [AnchorPolicy.ACTIVATION_BUDGET_MS]），
     * 不在这里。本方法唯一的职责是让状态翻转**可见**：掉线那一刻上屏一条判决降级告警，
     * 系统重绑成功上屏一条恢复，其余节拍保持安静（重复告警不是可见性，是噪音）。
     */
    private fun observeAnchorTransition(st: AnchorState) {
        if (st == AnchorState.UNKNOWN) return      // 读不到是采集失败，不是锚的状态
        val bound = st == AnchorState.BOUND
        val prev = anchorBoundLastTick
        anchorBoundLastTick = bound
        if (prev == null || prev == bound) return
        if (bound) {
            RuntimeDiagnostics.append(
                this, "accessibility", true, "锚已回到位（闸门重开）",
                "系统完成重绑，判决回到 importance=accessibility",
            )
        } else {
            RuntimeDiagnostics.append(
                this, "accessibility", false, "判决降级告警：锚掉线",
                "锚不在位 = 判决停在 importance=traffic，随时被 o-kill；" +
                    "本设计不做复活，下一次挂锚的时机是进程重生（见 AnchorPolicy）",
            )
        }
    }

    override fun onDestroy() {
        runCatching { OsInit.transition(this, OsPhase.STOPPING, "宿主被销毁") }
        ResidencyAudit.markCleanStop(this)
        handler?.removeCallbacksAndMessages(null)
        thread?.quitSafely()
        thread = null
        handler = null
        try { instance?.shutdown() } catch (_: Throwable) {}
        try { broker?.shutdown() } catch (_: Throwable) {}
        try { capture?.shutdown() } catch (_: Throwable) {}
        instance = null
        broker = null
        capture = null
        super.onDestroy()
    }

    private fun buildNotification(text: String): Notification {
        val pi = PendingIntent.getActivity(
            this, REQ_OPEN,
            Intent(this, SetupActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, OsApplication.SUPERVISOR_CHANNEL_ID)
            .setContentTitle("Lob OS 常驻")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSmallIcon(R.drawable.ic_lobos_logo)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()
    }

    companion object {
        const val TAG = "OsHostService"
        private const val NOTIF_ID = 1004
        private const val REQ_OPEN = 41
        /** 心跳/状态节拍：60s（计划要求「≥60s 低频」；状态不是死亡判据，变化时另有立即刷新）。 */
        private const val TICK_MS = 60_000L
        private const val NOTIFY_MS = 60_000L

        /** 拉起宿主（幂等，普通 startService；本服务自己在 onStartCommand 转前台）。 */
        fun ensureRunning(context: Context) {
            try {
                context.startService(Intent(context, OsHostService::class.java))
            } catch (e: Throwable) {
                Log.w(TAG, "拉起宿主失败（等互保闭环其它边重试）", e)
            }
        }
    }
}
