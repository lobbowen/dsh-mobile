package io.github.lobbowen.dshmobile.ui

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import io.github.lobbowen.dshmobile.bridge.AdbClientRunner
import io.github.lobbowen.dshmobile.bridge.MdnsWatcher
import io.github.lobbowen.dshmobile.capability.AdbChannelProbe
import io.github.lobbowen.dshmobile.capability.AttemptStore
import io.github.lobbowen.dshmobile.capability.PipelineRefresh
import io.github.lobbowen.dshmobile.permissions.PermissionCatalog
import io.github.lobbowen.dshmobile.permissions.PermissionCenter

/**
 * S0 配对的底座服务（ADR-0007 主路径的载体；UI 面在 OnboardingActivity 向导态）：
 *
 * · 全程不拉 Activity —— 输码走通知栏 RemoteInput，用户盯着的系统配对对话框
 *   不会被夺焦销毁（这是整个设计成立的前提，禁改）。
 * · 端口**只认在册的 mDNS 记录**：pairing 记录给配对端口、connect 记录给连接端口，
 *   用户不手输 IP:Port。`_adb-tls-pairing._tcp` 只在配对对话框开着期间在册，记录一消失
 *   端口立即作废（[MdnsWatcher.Sink.onLost]）—— 拿上一轮的端口去配对必然连不上，
 *   这正是真机上「端口显示得出来却配不通」的成因。宁可说「没见到端口记录」，
 *   也不伪造一个（历史上回落 127.0.0.1 就是这种假动作）。
 * · 收到码后转调 [AdbClientRunner.pair]（一次性 Node 进程做 SPAKE2/TLS）：结论进
 *   [AttemptStore] 类型化记账（判据层唯一的失败来源），通知与探针日志只是它的人读镜像。
 *
 * 普通 started service：通知是常态通知不是 FGS（探针跑完即 stop，不占常驻资源；
 * :main 的存活由无障碍+ContainerSupervisor 链托底，与保活主线一致）。
 */
class PairingProbeService : Service() {

    private var watcher: MdnsWatcher? = null

    // mDNS 解析出的最新端点（②的产出，也是配对的地址来源）
    @Volatile private var pairingHost: String? = null
    @Volatile private var pairingPort: Int = 0
    @Volatile private var connectPort: Int = 0
    @Volatile private var busy = false

    // ---- 探针实况：仅**本服务自己**用（mDNS 回调驱动），上屏走通知文案。
    //      配对成败不在这里 —— 它进 AttemptStore 类型化记账，判据层读那份，不读文案。 ----
    /**
     * 配对端口**当前是否在册**。它不是「见过一次端口」：对话框关掉记录就消失，
     * 此时任何端口都是废值，用它配对只会得到一条没有意义的失败归因。
     */
    @Volatile private var pairingLive = false
    /**
     * 本轮被通知权限挡在门外（F4 补齐行负责把它变成动作，这里只留事实，不猜状态）。
     */
    @Volatile var notificationBlocked = false; private set
    /**
     * 本轮探测起点（真正重挂 browse 时才刷新）。④ 的 browse→首记录延迟以它为原点。
     */
    @Volatile private var roundStartMs = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        // 向导读的是「当前实例」，不是布尔量：重启竞态下旧实例 onDestroy 不得清空新引用。
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureChannel()
        when (intent?.action) {
            ACTION_STOP -> {
                running = false
                // 探针从未 startForeground（常态通知），撤通知直接 cancel —— 不碰
                // 已废弃的 stopForeground(boolean)，也不依赖 onDestroy 时机。
                (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF)
                PipelineRefresh.notifyChanged()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_SUBMIT -> handleCode(intent)
            else -> startProbe()
        }
        return START_STICKY
    }

    private fun startProbe() {
        // 输码入口是通知栏 —— 通知不可见时「开始配对」就是一个按钮形状的谎言：`nm.notify()`
        // 在 Android 13+ 缺 POST_NOTIFICATIONS 时不抛异常、只是不显示（PermissionCatalog 给
        // 它的 note 就是这句），runCatching 抓不到，用户只看到向导停在「监听中」。
        // 所以挂通知之前先自证，缺了就不起 browse（欠账由 P0 冲刺/F4 补齐行负责变成动作，
        // onboarding-flow-spec §3）。
        if (!notificationsUsable()) {
            notificationBlocked = true
            ProbeJournal.append(
                this, "svc",
                "通知权限未授予 → 不起 browse：输码通知发不出去（Android 13+ 静默丢弃，notify 不抛异常）",
            )
            PipelineRefresh.notifyChanged()
            stopSelf()
            return
        }
        notificationBlocked = false
        // 「开始配对」可重复按：**端口在册**时不重抖 browse（stop/start 会丢记录，
        // 而记录一丢就是几秒钟的空白）；不在册（含从未出现、或对话框已关被作废）则照常
        // 往下重挂监听 —— 服务被系统重建后 running 残留为 true、watcher 却是新的，
        // 此时必须允许重入，否则向导永远停在「监听中」。
        if (running && pairingLive) { renderStatus(); return }
        running = true
        pairingHost = null; pairingPort = 0; pairingLive = false; connectPort = 0
        val w = watcher ?: MdnsWatcher(applicationContext).also { watcher = it }
        roundStartMs = System.currentTimeMillis()
        ProbeJournal.browsePairingStartedAt = roundStartMs
        ProbeJournal.browseConnectStartedAt = roundStartMs
        ProbeJournal.append(this, "svc", "探针启动：开始 browse ${MdnsWatcher.TYPE_PAIRING} + ${MdnsWatcher.TYPE_CONNECT}")
        val sink = object : MdnsWatcher.Sink {
            override fun onRecord(type: String, host: String?, port: Int, name: String, ageMs: Long) {
                val now = System.currentTimeMillis()
                if (type == MdnsWatcher.TYPE_PAIRING) {
                    pairingHost = host; pairingPort = port
                    pairingLive = true
                    if (ProbeJournal.pairingRecordFirstSeenAt == 0L) ProbeJournal.pairingRecordFirstSeenAt = now
                    ProbeJournal.append(this@PairingProbeService, "mdns", "pairing 记录 $name host=${host ?: "?"} port=$port browse后 ${ageMs}ms")
                } else {
                    if (connectPort != port) {
                        // 端口轮换是**现场事实**，不该等 TTL 到期才发现：看见新的 connect 端口就
                        // 作废通道缓存，下一轮采集现探（onboarding-flow-spec §2.3 事件表）。
                        AdbChannelProbe.invalidate()
                        ProbeJournal.append(
                            this@PairingProbeService, "mdns",
                            "connect 端口变化 $connectPort→$port → 通道缓存作废",
                        )
                    }
                    connectPort = port
                    if (ProbeJournal.connectRecordFirstSeenAt == 0L) ProbeJournal.connectRecordFirstSeenAt = now
                    ProbeJournal.append(this@PairingProbeService, "mdns", "connect 记录 $name port=$port browse后 ${ageMs}ms")
                }
                renderStatus()
            }

            override fun onLost(type: String, name: String) {
                // 身份对不上也一律作废：部分协议栈的 onServiceLost 不带实例名，
                // 「不确定是不是它」时的安全动作是重新等一条记录，而不是续用一个可能已死的端口。
                if (type == MdnsWatcher.TYPE_PAIRING) {
                    if (!pairingLive) return
                    pairingLive = false; pairingHost = null; pairingPort = 0
                    ProbeJournal.append(
                        this@PairingProbeService, "mdns",
                        "pairing 记录消失（${name.ifBlank { "无实例名" }}）→ 端口读数作废",
                    )
                } else if (connectPort > 0) {
                    connectPort = 0
                    AdbChannelProbe.invalidate()
                    ProbeJournal.append(
                        this@PairingProbeService, "mdns",
                        "connect 记录消失（${name.ifBlank { "无实例名" }}）→ 端点作废、通道缓存作废",
                    )
                } else return
                renderStatus()
            }

            override fun onLog(message: String) {
                ProbeJournal.append(this@PairingProbeService, "mdns", message)
            }
        }
        w.start(MdnsWatcher.TYPE_PAIRING, roundStartMs, sink)
        w.start(MdnsWatcher.TYPE_CONNECT, roundStartMs, sink)
        renderStatus()
        // ② 定罪素材：对话框开着却长时间无记录，也要在日志里留下「等多久没等到」。
        Handler(Looper.getMainLooper()).postDelayed({
            if (running && !pairingLive)
                ProbeJournal.append(this, "mdns", "45s 内未见 pairing 记录（对话框若已打开 = ②时序定罪样本）")
        }, 45_000L)
    }

    /** RemoteInput 取码 → 配对。取不到码（用户点了发送但空）也要记账——③ 的一部分。 */
    private fun handleCode(intent: Intent) {
        ProbeJournal.codeReceivedAt = System.currentTimeMillis()
        val code = extractCode(intent)
        ProbeJournal.append(this, "pair", "快捷回复送达：code=${code?.length ?: 0} 位")
        if (code.isNullOrBlank()) {
            renderStatus("配对码为空")
            return
        }
        if (busy) { renderStatus("上一次配对仍在进行"); return }
        // 端点必须**此刻在册**：没有 pairing 记录就是「对话框没开/已关」，此时发配对
        // 只会拿到一条归因不明的超时失败（真机上那条假失败又会把 adb_credentials 判成 FAILED）。
        val host = pairingHost
        val pport = pairingPort
        if (!pairingLive || host == null || pport <= 0) {
            ProbeJournal.append(this, "pair", "无在册 mDNS 配对端点 → 未发起配对（不伪造地址）")
            renderStatus("配对端口不在册 —— 请在「无线调试」页点「与配对设备配对」，让对话框保持打开")
            return
        }
        busy = true
        renderStatus("配对进行中（$host:$pport）")
        Thread {
            val outcome = AdbClientRunner.pair(
                applicationContext, host, pport, code,
                connectPort.takeIf { it > 0 }, PAIR_TIMEOUT_MS,
            )
            busy = false
            val reason = if (outcome.ok) "" else (outcome.error ?: outcome.raw.take(200))
            AttemptStore.recordPair(System.currentTimeMillis(), outcome.ok, reason)
            ProbeJournal.append(
                this, "pair",
                if (outcome.ok) "配对成功（${host}:${pport}）：${outcome.json?.optString("guid")?.take(16)}"
                else "配对失败：$reason",
            )
            renderStatus(
                if (outcome.ok) "已配对 —— S0 凭据在册" else "失败：${reason.take(80)}",
                stickyError = !outcome.ok,
            )
            // 成功即作废通道缓存：下一轮采集必须现探，不把配对前的 DEAD 读数续过来。
            if (outcome.ok) AdbChannelProbe.invalidate()
            PipelineRefresh.notifyChanged()
        }.apply { isDaemon = true }.start()
    }

    /**
     * 通知能不能真的显示。授权状态一律经 [PermissionCenter] 查（判据单一出口，spec §2.5），
     * 这里只决定「这一步要不要往下走」，不自己判一遍。
     */
    private fun notificationsUsable(): Boolean {
        val spec = PermissionCatalog.byId(PermissionCatalog.POST_NOTIFICATIONS) ?: return true
        return PermissionCenter(applicationContext).isGranted(spec)
    }

    private fun renderStatus(override: String? = null, stickyError: Boolean = false) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // 文案只描述**在册读数**：pairing 记录消失后这里必须退回「等记录」，
        // 不许把上一轮的端口继续报成「已发现」（真机上端口对不上就是这么来的）。
        val status = override ?: when {
            pairingLive -> "配对端口 $pairingPort 在册 —— 下拉本通知「输入配对码」"
            connectPort > 0 ->
                "无线调试在线（连接端口 $connectPort），未见到配对对话框记录 —— 点「与配对设备配对」后即出现"
            else -> "等待 mDNS 记录：把「与配对设备配对」对话框开着，端口出现后这里就能输码"
        }
        val builder = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("DSH · S0 配对探针")
            .setContentText(status)
            .setStyle(NotificationCompat.BigTextStyle().bigText(status))
            .setOngoing(true)
            .setContentIntent(openAppIntent())
        if (stickyError) builder.color = 0xFFD64545.toInt()
        // 输码动作：RemoteInput 挂在「输入配对码」上 —— 点按弹输入框，不发 intent；
        // 发送键经 result Intent 回到本 Service（ACTION_SUBMIT）。
        val replyInput = RemoteInput.Builder(EXTRA_CODE).setLabel("6 位配对码").build()
        val replyAction = NotificationCompat.Action.Builder(
            0, "输入配对码", submitIntent(),
        ).addRemoteInput(replyInput).setAllowGeneratedReplies(true).build()
        builder.addAction(replyAction)
        // 通知是本设计的命门：POST_NOTIFICATIONS 被拒 / ROM 拦截等失败过去被 runCatching
        // 静默吞掉，导致③从未成立却查不出来 —— 异常必须进探针日志留案底。
        runCatching { nm.notify(NOTIF, builder.build()) }
            .onFailure { ProbeJournal.append(this, "svc", "通知发布失败：${it::class.java.simpleName}: ${it.message}") }
    }

    private fun extractCode(intent: Intent): String? {
        val results = RemoteInput.getResultsFromIntent(intent) ?: return null
        val raw = results.getCharSequence(EXTRA_CODE) ?: return null
        // 只留数字：剪贴板粘贴带来的空白/连字符是常态噪声，剥掉它而不是报错。
        return raw.filter { it.isDigit() }.toString().takeIf { it.isNotEmpty() }
    }

    private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
        this, REQ_OPEN,
        Intent(this, OnboardingActivity::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or immutability(),
    )

    private fun submitIntent(): PendingIntent = PendingIntent.getService(
        this, REQ_SUBMIT,
        Intent(this, PairingProbeService::class.java).setAction(ACTION_SUBMIT),
        // 系统铁律（Android 12+ 强制）：挂 RemoteInput 的动作 PendingIntent 必须 mutable ——
        // SystemUI 要把用户输入回填进 intent。此前写死 FLAG_IMMUTABLE 让 nm.notify() 直接抛
        // IllegalArgumentException，且被 runCatching 吞了整整一代（③从未成立的根因，真机案底
        // 2026-09-25 16:31:57）。
        PendingIntent.FLAG_UPDATE_CURRENT or mutableFlag(),
    )

    private fun mutableFlag(): Int =
        // = PendingIntent.FLAG_MUTABLE 的字面值：compileSdk 里没有这个常量（targetSdk 28 时代），
        // 且低版本运行时读取该字段会 NoSuchFieldError，只能用 int。
        if (Build.VERSION.SDK_INT >= 31) 1 shl 18 else 0

    /** targetSdk 28 不强制 immutable，但真机是 Android 17 —— 一律显式声明，杜绝 hijack 面。 */
    private fun immutability(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "S0 配对探针", NotificationManager.IMPORTANCE_HIGH)
                    .apply { description = "无线 ADB 配对输码快捷回复（探针期）" },
            )
        }
    }

    override fun onDestroy() {
        running = false
        if (instance === this) instance = null
        watcher?.stopAll()
        super.onDestroy()
    }

    companion object {
        const val ACTION_SUBMIT = "dsh.action.PAIR_SUBMIT"
        const val ACTION_STOP = "dsh.action.PAIR_STOP"
        const val EXTRA_CODE = "pair_code"
        /** 同进程（:main）的首页据此切换按钮文案；跨进程场景不适用（探针就在 :main）。 */
        @Volatile var running: Boolean = false
        /** 当前活着的 service 实例；向导态读它的实况字段。 */
        @Volatile var instance: PairingProbeService? = null
        private const val CHANNEL = "dsh_pairing_probe"
        private const val NOTIF = 3637
        private const val REQ_OPEN = 31
        private const val REQ_SUBMIT = 32
        private const val PAIR_TIMEOUT_MS = 30_000L
    }
}
