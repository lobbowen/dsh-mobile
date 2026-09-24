package io.github.lobbowen.dshmobile.ui

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import io.github.lobbowen.dshmobile.bridge.AdbClientRunner

/**
 * S0 配对探针服务（ADR-0007 主路径的载体）：
 *
 * · **全程不拉 Activity** —— 输码走通知栏 RemoteInput，用户盯着的系统配对对话框
 *   不会被夺焦销毁（这是整个设计成立的前提，禁改）。
 * · 端口来自本机 mDNS（pairing 记录给配对端口，connect 记录给连接端口），
 *   用户不手输 IP:Port；mDNS 拿不到时通知里的输码仍可用（回落 host=127.0.0.1）。
 * · 收到码后转调 [AdbClientRunner.pair]（一次性 Node 进程做 SPAKE2/TLS），
 *   结果写探针日志 + 更新通知。
 *
 * 普通 started service：通知是常态通知不是 FGS（探针跑完即 stop，不占常驻资源；
 * :main 的存活由无障碍+ContainerSupervisor 链托底，与保活主线一致）。
 */
class PairingProbeService : Service() {

    private var watcher: MdnsWatcher? = null
    private var lastBrowseAt = 0L

    // mDNS 解析出的最新端点（②的产出，也是自动配对的地址来源）
    @Volatile private var pairingHost: String? = null
    @Volatile private var pairingPort: Int = 0
    @Volatile private var connectPort: Int = 0
    @Volatile private var busy = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureChannel()
        when (intent?.action) {
            ACTION_STOP -> {
                running = false
                // 探针从未 startForeground（常态通知），撤通知直接 cancel —— 不碰
                // 已废弃的 stopForeground(boolean)，也不依赖 onDestroy 时机。
                (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_SUBMIT -> handleCode(intent)
            else -> startProbe()
        }
        return START_STICKY
    }

    private fun startProbe() {
        running = true
        val w = watcher ?: MdnsWatcher(applicationContext).also { watcher = it }
        lastBrowseAt = System.currentTimeMillis()
        ProbeJournal.browsePairingStartedAt = lastBrowseAt
        ProbeJournal.browseConnectStartedAt = lastBrowseAt
        ProbeJournal.append(this, "svc", "探针启动：开始 browse ${MdnsWatcher.TYPE_PAIRING} + ${MdnsWatcher.TYPE_CONNECT}")
        val sink = object : MdnsWatcher.Sink {
            override fun onRecord(type: String, host: String?, port: Int, name: String, ageMs: Long) {
                val now = System.currentTimeMillis()
                if (type == MdnsWatcher.TYPE_PAIRING) {
                    pairingHost = host; pairingPort = port
                    if (ProbeJournal.pairingRecordFirstSeenAt == 0L) ProbeJournal.pairingRecordFirstSeenAt = now
                    ProbeJournal.append(this@PairingProbeService, "mdns", "pairing 记录 $name host=${host ?: "?"} port=$port browse后 ${ageMs}ms")
                } else {
                    connectPort = port
                    if (ProbeJournal.connectRecordFirstSeenAt == 0L) ProbeJournal.connectRecordFirstSeenAt = now
                    ProbeJournal.append(this@PairingProbeService, "mdns", "connect 记录 $name port=$port browse后 ${ageMs}ms")
                }
                renderStatus()
            }

            override fun onLog(message: String) {
                ProbeJournal.append(this@PairingProbeService, "mdns", message)
            }
        }
        w.start(MdnsWatcher.TYPE_PAIRING, lastBrowseAt, sink)
        w.start(MdnsWatcher.TYPE_CONNECT, lastBrowseAt, sink)
        renderStatus()
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
        // host 回落 127.0.0.1：同机无线调试 adbd 在回环同样接受配对（②未定罪前的安全垫）。
        val host = pairingHost ?: "127.0.0.1"
        val pport = pairingPort
        if (pport <= 0 && host == "127.0.0.1") {
            ProbeJournal.append(this, "pair", "无 mDNS 配对端口且无手输通道 —— 等待记录出现后重试")
            renderStatus("等 mDNS 配对端口…")
            return
        }
        busy = true
        renderStatus("配对进行中（$host:${pport.takeIf { it > 0 } ?: "端口待发现"}）")
        Thread {
            val outcome = AdbClientRunner.pair(
                applicationContext, host, pport, code,
                connectPort.takeIf { it > 0 }, PAIR_TIMEOUT_MS,
            )
            busy = false
            ProbeJournal.append(
                this, "pair",
                if (outcome.ok) "配对成功（${host}:${pport}）：${outcome.json?.optString("guid")?.take(16)}"
                else "配对失败：${outcome.error ?: outcome.raw.take(200)}",
            )
            renderStatus(
                if (outcome.ok) "已配对 —— S0 变绿" else "失败：${outcome.error?.take(80) ?: "见日志"}",
                stickyError = !outcome.ok,
            )
            PipelineProbe.notifyChanged(this)
        }.apply { isDaemon = true }.start()
    }

    private fun renderStatus(override: String? = null, stickyError: Boolean = false) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val status = override ?: when {
            pairingPort > 0 -> "已发现配对端口 $pairingPort —— 下拉本通知「输入配对码」"
            connectPort > 0 -> "无线调试在线（连接端口 $connectPort），未见到配对对话框记录"
            else -> "等待 mDNS 记录（先点「去开无线调试」，再开配对对话框）"
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
        runCatching { nm.notify(NOTIF, builder.build()) }
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
        PendingIntent.FLAG_UPDATE_CURRENT or immutability(),
    )

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
        watcher?.stopAll()
        super.onDestroy()
    }

    companion object {
        const val ACTION_SUBMIT = "dsh.action.PAIR_SUBMIT"
        const val ACTION_STOP = "dsh.action.PAIR_STOP"
        const val EXTRA_CODE = "pair_code"
        /** 同进程（:main）的首页据此切换按钮文案；跨进程场景不适用（探针就在 :main）。 */
        @Volatile var running: Boolean = false
        private const val CHANNEL = "dsh_pairing_probe"
        private const val NOTIF = 3637
        private const val REQ_OPEN = 31
        private const val REQ_SUBMIT = 32
        private const val PAIR_TIMEOUT_MS = 30_000L
    }
}
