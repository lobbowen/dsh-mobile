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
import lobos.capability.ProbeOutcome
import lobos.os.AppRegistry
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

    /** 控制面在线读数：与首页同源（CapabilityEvidenceCollector.controlPlaneUp）。 */
    @Volatile private var controlPlaneUp = false
    /** 是否至少采过一次读数：默认值不许当结论播出去。 */
    @Volatile private var readingsCollected = false

    private var instance: InstanceHost? = null
    private var broker: CapabilityBroker? = null
    private var capture: ScreenCaptureController? = null

    // ---- 锚层：低频监护（复用本服务 tick，不新起闹钟/心跳） ----
    private var a11yTicks = 0L
    private var a11yAttempts = 0
    private var a11yBackoffMs = A11Y_BACKOFF_BASE_MS
    private var a11yNextAttemptMs = 0L
    private var a11yGaveUp = false

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
        }
        return START_STICKY
    }

    private fun promoteToForeground() {
        try {
            startForeground(NOTIF_ID, buildNotification(statusLine()))
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
            monitorAccessibilityAnchor(now)
            refreshStatusNotice(now)
        } catch (e: Throwable) {
            Log.e(TAG, "宿主节拍异常（不致命，下一拍继续）", e)
        } finally {
            handler?.postDelayed(tick, TICK_MS)
        }
    }

    /** 常驻通知 = 状态出口；心跳与状态同拍（这一拍落盘 = 这一刻进程还活着）。 */
    private fun refreshStatusNotice(now: Long) {
        if (now - lastNotifyMs < NOTIFY_MS) return
        lastNotifyMs = now
        ResidencyAudit.heartbeat(this)
        controlPlaneUp = try {
            CapabilityEvidenceCollector.controlPlaneUp()
        } catch (_: Throwable) {
            false
        }
        readingsCollected = true
        try {
            (getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager)
                .notify(NOTIF_ID, buildNotification(statusLine()))
        } catch (_: Throwable) {
        }
    }

    /**
     * 锚层监护（预防，不是死后自愈）：低频、只读缓存通道、失败退避有上限。
     * 锚掉 = 判决降级 = 即将被 o-kill；恢复窗口在**被杀之前**。
     */
    private fun monitorAccessibilityAnchor(now: Long) {
        a11yTicks++
        if (a11yTicks % A11Y_MONITOR_TICKS != 0L) return
        if (AccessibilityAnchor.isBound(this)) {
            if (a11yAttempts > 0 || a11yGaveUp) {
                RuntimeDiagnostics.append(this, "accessibility", true, "锚已恢复（闸门重开）", "此前尝试 " + a11yAttempts + " 次")
            }
            a11yAttempts = 0
            a11yBackoffMs = A11Y_BACKOFF_BASE_MS
            a11yNextAttemptMs = 0L
            a11yGaveUp = false
            return
        }
        if (a11yGaveUp || now < a11yNextAttemptMs) return
        // 只认缓存读数：绝不在心跳节拍里 spawn 探针（探针会拉 Node 进程）。
        if (AdbChannelProbe.cached().outcome != ProbeOutcome.LIVE) return
        val outcome = try {
            AccessibilityAnchor.ensureBound(this, A11Y_HEAL_TIMEOUT_MS)
        } catch (t: Throwable) {
            HealOutcome(AnchorState.UNKNOWN, false, t::class.java.simpleName + ": " + t.message)
        }
        if (outcome.healed) {
            RuntimeDiagnostics.append(this, "accessibility", true, "锚自愈成功（闸门重开）", outcome.detail)
            a11yAttempts = 0
            a11yBackoffMs = A11Y_BACKOFF_BASE_MS
            a11yNextAttemptMs = 0L
            return
        }
        a11yAttempts++
        RuntimeDiagnostics.append(this, "accessibility", false, "锚自愈未成（第 " + a11yAttempts + "/" + A11Y_MAX_ATTEMPTS + " 次）", outcome.detail)
        a11yNextAttemptMs = now + a11yBackoffMs
        a11yBackoffMs = (a11yBackoffMs * 2).coerceAtMost(A11Y_BACKOFF_MAX_MS)
        if (a11yAttempts >= A11Y_MAX_ATTEMPTS) {
            a11yGaveUp = true
            RuntimeDiagnostics.append(
                this, "accessibility", false, "锚自愈放弃（连续 " + a11yAttempts + " 次）",
                "锚不在位 = importance=traffic，随时被 o-kill；后续只由系统重绑恢复",
            )
        }
    }

    private fun statusLine(): String {
        val runtime = when {
            !readingsCollected -> "状态采集中…"
            controlPlaneUp -> "运行时在线"
            else -> "运行时未响应"
        }
        val channel = when (AdbChannelProbe.cached().outcome) {
            ProbeOutcome.LIVE -> "通道通"
            ProbeOutcome.DEAD -> "通道不通"
            ProbeOutcome.NEVER_RUN -> "通道未验"
        }
        val anchor = when (AccessibilityAnchor.state(this)) {
            AnchorState.BOUND -> "锚在位"
            AnchorState.UNBOUND -> "锚掉线",
            AnchorState.UNKNOWN -> "锚未知",
        }
        // 定罪结论排最前：它是"这条常驻断过"的唯一可见出口。
        val interrupted = ResidencyAudit.interruption()?.let { it + " · " } ?: ""
        // 相位文案与 console 的 os.state.get 同源（lobos.os.OsInit 的 state.json 是单一源）。
        return interrupted + OsInit.stateLine(this) + " · " + runtime + " · " + channel + " · " + anchor
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
        /** 锚监护间隔（拍数）：60s x 1 = 60s。 */
        private const val A11Y_MONITOR_TICKS = 1L
        private const val A11Y_HEAL_TIMEOUT_MS = 8_000L
        private const val A11Y_BACKOFF_BASE_MS = 40_000L
        private const val A11Y_BACKOFF_MAX_MS = 5 * 60_000L
        private const val A11Y_MAX_ATTEMPTS = 5

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
