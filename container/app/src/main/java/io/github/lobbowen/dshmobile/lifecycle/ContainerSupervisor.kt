package io.github.lobbowen.dshmobile.lifecycle

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Process
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import io.github.lobbowen.dshmobile.NodeContainerApp
import io.github.lobbowen.dshmobile.RuntimeDiagnostics
import io.github.lobbowen.dshmobile.bridge.HostBridgeService
import io.github.lobbowen.dshmobile.capability.AdbChannelProbe
import io.github.lobbowen.dshmobile.capability.CapabilityEvidenceCollector
import io.github.lobbowen.dshmobile.capability.ProbeOutcome
import io.github.lobbowen.dshmobile.runtime.NodeRuntimeService
import io.github.lobbowen.dshmobile.ui.OnboardingActivity
import java.io.File

/**
 * L-A 容器生命周期层的**实例监督者**（:main，**常驻前台**）。
 *
 * 为什么必须前台（2026-09-26 真机定罪，修订 ADR-0006 的旧决策）：它此前刻意不占通知位，
 * 于是在 AMS 眼里就是一个最低优先级的空进程 —— 锁屏后被 ROM 清掉完全合法，而 :main 一死
 * 重拉链就此归零（唯一复活路径是用户手点图标）。「APK 不死 ⇒ 运行时不死」这条不变式
 * 的前提是 APK 真的不死，所以监督者自己必须是前台服务。它的通知同时是**状态出口**：
 * 用户随时能在通知栏看到运行时/通道现在是什么情况，而不是靠打开界面猜。
 *
 * 职责单一：持有运行时实例宿主（:node / NodeRuntimeService）的 binder 连接，
 * 按 [NodeWatchdogPolicy] 判据处置它的死亡、卡死与空壳。能力桥（HostBridgeService）、
 * 采集（ScreenCaptureService）等**不再兼任**监督 —— 监督者与桥混住曾导致两个架构
 * 错误：桥被杀时监督陪葬；桥的重拉逻辑与内核的 boot 循环互相踩（真机 2026-09-25 定罪链）。
 *
 * 监督分两半、各归其位（ADR-0006 / ARCHITECTURE §1）：
 *  - **进程级复活**归本服务（:main）：bindService(:node, BIND_AUTO_CREATE) 持一条 binder 边。
 *    :node 死 → AMS 回调 onServiceDisconnected → 立即 rebind。**rebind 只会重建进程、
 *    只跑 onCreate，不会重投 started-service 的 onStartCommand**（真机 2026-09-26 证伪，
 *    见 [NodeWatchdogPolicy] 头注）—— 所以运行时实例的 boot 循环由 :node 自己在
 *    onCreate 出生，本服务只监督「有没有出生」，绝不在死亡路径上补投 start 命令。
 *    这条边还要求 :node.onBind 返回**真 binder**（返回 null 会被当 null-binding，
 *    既不保活也无断开回调）。
 *  - **子进程退避重启**留在 :node 自家 boot 循环：那是"进程活着但内核起不来"，
 *    父监子进程是正常职责，不需要跨进程发号施令。
 *
 * 存活链（全在 L0，随 APK 冻结）：常驻前台 + 无障碍绑定（HANS 拒冻本 uid 的实证锚）
 * + 解锁/亮屏补位边（[NodeContainerApp]）。**没有进程外复活边**（2026-09-26 拍板）：复活只
 * 把壳点回来，而内核在重启时已把 running/pending 一律判 failed，复活后的「运行时在线」
 * 反而是假信息。进程真被回收时归 [ResidencyAudit] 定罪 —— 让打断可见，不是再拽一次。
 * 互保闭环：BootReceiver / Application / 桥 onCreate / :node 启动路径都会拉起本服务。
 *
 * 不变式：**APK（:main 前台 + 无障碍锚）不死，运行时环境就不死。**
 */
class ContainerSupervisor : Service() {

    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var bound = false
    private var strikes = 0
    private var lastStateChangeMs = 0L
    private var lastForceStopMs = 0L
    private var lastNotifyMs = 0L
    /** 控制面在线读数：与首页同源（[CapabilityEvidenceCollector.controlPlaneUp]），别处不再判一遍。 */
    @Volatile private var controlPlaneUp = false
    /** BORN 态读数：当前 :node 进程的 boot 循环是否真的跑起来过（状态出口与判据同源）。 */
    @Volatile private var born = false
    /** 三态是否至少采过一次。转前台与状态刷新共用同一句正文，故必须有个「还没采到」的说法，
     *  不能把默认值当结论播出去（真机判据 3 定罪 D9 的另一半）。 */
    @Volatile private var readingsCollected = false

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            markConnected(true)
        }

        override fun onServiceDisconnected(name: ComponentName) {
            // :node 进程死亡 → 立刻 rebind（后台合法；绝不调 startForegroundService，
            // :main 刚从 HANS 解冻时不满足 FGS-start 前台要求，真机 ANR 栈实锤）。
            // rebind 只重建进程并跑 onCreate —— 出生（boot 循环）由 :node 自己在 onCreate 发起。
            markConnected(false)
            RuntimeDiagnostics.append(
                this@ContainerSupervisor, "supervisor", null,
                ":node 进程断开 → rebind 重拉起", "实例状态随进程同归于尽，重建后 :node 自重写进程记录并自出生"
            )
            handler?.post { bindNode() }
        }
    }

    /** 监督者不对外提供调用面（跨进程发号施令是旧设计的 IPC 幻象）；仅维持自身生命周期。 */
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 先翻旧账再转前台：定罪结论必须在第一条状态出来之前就位（幂等，只有首次读盘）。
        ResidencyAudit.auditPreviousExit(this)
        // 每一次投递都重新自转前台：bind/普通 start 路径没有 FGS-start 特权，
        // 被拒时吞 —— 抛出会炸掉 :main，那等于把要被保活的东西亲手杀掉。
        promoteToForeground()
        ensureBridge()
        // 幂等：监督者只许一个循环（与旧双循环风暴同款防线，真机 2026-09-22 实锤
        // 双循环共享状态把活内核误判成死 → 紧循环重启 → 闪屏）。
        if (thread == null) {
            thread = HandlerThread("container-supervisor").apply { start() }
            handler = Handler(thread!!.looper)
            markConnected(false)
            bindNode()
            handler?.postDelayed(tick, NodeWatchdogPolicy.ALIVE_POLL_MS)
            RuntimeDiagnostics.append(
                this, "supervisor", true, "容器监督者就位（:main，常驻前台）",
                "绑定 :node，节拍 ${NodeWatchdogPolicy.ALIVE_POLL_MS}ms"
            )
        }
        return START_STICKY
    }

    private fun promoteToForeground() {
        try {
            // 转前台**不另写正文**：通知 1004 的正文唯一作者是 statusLine()（定罪段已由它排在最前）。
            // 真机判据 3 定罪的 D9 就是这里曾直接写 ResidencyAudit.interruption()：
            // :node 越不出生、ensureRunning 被戳得越密，每戳一次盖一次，三态结论永远上不了屏。
            startForeground(NOTIF_ID, buildNotification(statusLine()))
        } catch (t: Throwable) {
            RuntimeDiagnostics.append(
                this, "supervisor", false, "转前台失败（不影响 binder 监督边）",
                "${t::class.java.simpleName}: ${t.message}"
            )
        }
    }

    private fun markConnected(connected: Boolean) {
        bound = connected
        strikes = 0
        // 新进程（或重绑后的未知进程）一律从"没出生"起算，由下一拍读标记裁决。
        born = false
        lastStateChangeMs = SystemClock.elapsedRealtime()
    }

    private fun ensureBridge() {
        try {
            startService(Intent(this, HostBridgeService::class.java))
        } catch (e: Throwable) {
            // 罕见：本服务在 :main、桥也在 :main，同进程 startService 基本不受后台限制。
            // 失败只上屏不致命 —— :node 每次 boot 会再戳一次监督者（ensureBridge 随之后重投）。
            RuntimeDiagnostics.append(
                this, "bridge", false, "拉起 HostBridge 失败（下次被戳重投）",
                "${e::class.java.simpleName}: ${e.message}"
            )
        }
    }

    private fun bindNode() {
        if (bound) return
        val ok = try {
            bindService(Intent(this, NodeRuntimeService::class.java), connection, Context.BIND_AUTO_CREATE)
        } catch (_: Throwable) {
            false
        }
        if (!ok) {
            // bindService 返回 false：连接没建立，AMS 不会回调断开 —— 只能靠下一拍 tick 重投。
            bound = false
            RuntimeDiagnostics.append(
                this@ContainerSupervisor, "supervisor", null,
                "bindService(:node) 未建立", "下一拍（${NodeWatchdogPolicy.ALIVE_POLL_MS}ms）重试"
            )
        }
    }

    private val tick: Runnable = Runnable {
        try {
            // 进程记录由 :node 在 onCreate 即写（早于任何子进程 spawn），
            // 所以"慢启动"不会攒 strikes；攒到只可能是 :node 进程本身卡死/记录丢失。
            val record = if (bound) readNodeRecord() else null
            if (bound) { if (record != null) strikes = 0 else strikes++ } else strikes = 0
            born = birthMarkMatches(record)
            val now = SystemClock.elapsedRealtime()
            // 时间戳不可解 → 年龄按 0：判据宁可少清一次账，也不许凭一个未知数杀进程。
            val pidRecordAgeMs =
                if (record == null || record.wroteAtMs < 0) 0L else (now - record.wroteAtMs).coerceAtLeast(0L)
            val shell = record != null && !born && pidRecordAgeMs >= NodeWatchdogPolicy.BORN_GIVEUP_MS
            when (NodeWatchdogPolicy.decide(bound, strikes, born, pidRecordAgeMs, lastStateChangeMs, lastForceStopMs, now)) {
                is NodeWatchdogPolicy.Decision.Wait -> if (!bound) bindNode()
                NodeWatchdogPolicy.Decision.EscalateStop -> {
                    lastForceStopMs = now
                    RuntimeDiagnostics.append(
                        this, "supervisor", false,
                        if (shell) ":node 空壳（进程在、boot 循环从未跑起）→ 清账重建"
                        else ":node 无响应，清账重建",
                        "bound=$bound strikes=$strikes born=$born pidAge=${pidRecordAgeMs}ms —— stopService + unbind/rebind"
                    )
                    try { stopService(Intent(this, NodeRuntimeService::class.java)) } catch (_: Throwable) {}
                    try { unbindService(connection) } catch (_: Throwable) {}
                    markConnected(false)
                    bindNode()
                }
            }
            refreshStatusNotice(now)
        } catch (e: Throwable) {
            Log.e(TAG, "监督拍异常（不致命，下一拍继续）", e)
        } finally {
            handler?.postDelayed(tick, NodeWatchdogPolicy.ALIVE_POLL_MS)
        }
    }

    /**
     * 常驻通知 = 状态出口。判据一律走 capability 层现成的读法：控制面在线走
     * [CapabilityEvidenceCollector.controlPlaneUp]，通道只读缓存（探针 spawn 一次要 Node 进程，
     * 不许在监督节拍里跑）。节拍比监督慢一档：状态不是死亡判据，20s 足够。
     */
    private fun refreshStatusNotice(now: Long) {
        if (now - lastNotifyMs < NOTIFY_MS) return
        lastNotifyMs = now
        // 心跳与状态通知同拍：这一拍的落盘就是「这一时刻进程还活着」的证据，
        // 下次启动的定罪时长以它为准，精度即 NOTIFY_MS。
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

    private fun statusLine(): String {
        val runtime = when {
            // 第一拍之前 born/controlPlaneUp 都只是默认值，把它们当结论播 = 把「未知」说成「未出生」。
            // 读数一旦采过就不再退回：:node 反复重启期间 tick 一直在跑，退回会让空壳态重新变得看不见。
            !readingsCollected -> "状态采集中…"
            controlPlaneUp -> "运行时在线"
            // 空壳单独一说：进程在、boot 循环没跑过，此刻正被按 [NodeWatchdogPolicy] 清账重建。
            // 绝不写成「运行时在线」糊过去 —— 状态不真是本产品唯一对用户的承诺。
            !born -> "运行时未出生"
            else -> "运行时未响应"
        }
        val chan = AdbChannelProbe.cached()
        val channel = when (chan.outcome) {
            ProbeOutcome.LIVE -> "通道通"
            ProbeOutcome.DEAD -> "通道不通"
            ProbeOutcome.NEVER_RUN -> "通道未验"
        }
        // 定罪结论排在最前：它是「这条常驻断过」的唯一可见出口，不许被状态读数盖掉。
        val interrupted = ResidencyAudit.interruption()?.let { "$it · " } ?: ""
        return "$interrupted$runtime · $channel · ${if (bound) ":node 已绑定" else ":node 未绑定，重拉中"}"
    }

    /** 读 :node 写的进程记录：pid 在 /proc 存在**且** cmdline 与落盘一致才算活
     *  （只查存在会把"pid 被回收给别的进程"误判成 :node 还活着）。
     *  顺带带回落盘时刻 —— 「有进程没出生」判据的年龄基准，不再各读一遍文件。 */
    private fun readNodeRecord(): NodeRecord? = try {
        val lines = File(filesDir, NODE_PID_FILE).readText().trim().split("\n")
        val pid = lines[0].toIntOrNull() ?: return null
        val procCmd = File("/proc/$pid/cmdline").readBytes()
            .toString(Charsets.UTF_8).trimEnd('\u0000')
        if (procCmd.isEmpty() || (lines.size >= 2 && procCmd != lines[1])) null
        else NodeRecord(pid, lines.getOrNull(2)?.toLongOrNull() ?: -1L)
    } catch (_: Throwable) {
        null
    }

    /** BORN 判据：出生标记里的 pid 必须**等于当前进程记录的 pid** —— 沿用上一轮进程留下的
     *  标记会把新进程判成已出生，那正是本判据要抓的空壳。记录缺失即 false。 */
    private fun birthMarkMatches(record: NodeRecord?): Boolean {
        val pid = record?.pid ?: return false
        return try {
            nodeBirthFile(this@ContainerSupervisor).readText().trim().toIntOrNull() == pid
        } catch (_: Throwable) {
            false
        }
    }

    /** node.pid 一次读取的结果（pid + 落盘时刻，elapsedRealtime 语义；<0 = 时间戳不可解）。 */
    private class NodeRecord(val pid: Int, val wroteAtMs: Long)

    override fun onDestroy() {
        // 走到这里 = 系统给了正常收尾的机会，留 clean 戳；强杀不会走到这里，于是下次启动定罪。
        ResidencyAudit.markCleanStop(this)
        handler?.removeCallbacksAndMessages(null)
        thread?.quitSafely()
        thread = null
        handler = null
        if (bound) {
            try { unbindService(connection) } catch (_: Throwable) {}
            bound = false
        }
        super.onDestroy()
    }

    private fun buildNotification(text: String): Notification {
        val pi = PendingIntent.getActivity(
            this, REQ_OPEN,
            Intent(this, OnboardingActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, NodeContainerApp.SUPERVISOR_CHANNEL_ID)
            .setContentTitle("DSH 常驻监督")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()
    }

    companion object {
        const val TAG = "ContainerSupervisor"
        /** :node 进程记录文件名（:node 写、本服务读，同一常量源）。 */
        const val NODE_PID_FILE = "node.pid"
        /** :node 出生标记文件名（boot 循环入口写、本服务读；与 node.pid 同一常量源）。 */
        const val NODE_BIRTH_FILE = "node.birth"
        private const val NOTIF_ID = 1004
        private const val REQ_OPEN = 41
        /** 状态通知的刷新节拍（比监督节拍慢一档，见 [refreshStatusNotice]）。 */
        private const val NOTIFY_MS = 20_000L

        /** 拉起监督者（幂等，普通 startService）。
         *  绝不用 startForegroundService：调用点多在后台（:node onCreate / 桥 onCreate /
         *  Application），满足不了 5s FGS 契约反而炸宿主 —— 本服务自己在 onStartCommand 里
         *  转前台，投递方式因此无所谓。
         *  失败只记日志：互保闭环的其它边（BootReceiver / 无障碍连接 / 桥 onCreate /
         *  :node onCreate 与每次 boot 尝试 / Application 与解锁亮屏广播）会再戳。 */
        fun ensureRunning(context: Context) {
            try {
                context.startService(Intent(context, ContainerSupervisor::class.java))
            } catch (e: Throwable) {
                Log.w(TAG, "拉起监督者失败（等互保闭环其它边重试）", e)
            }
        }

        /** :node 侧写进程记录复用此路径（同一常量源，别处不得再拼一次字面量）。 */
        fun nodePidFile(context: Context): File = File(context.filesDir, NODE_PID_FILE)

        /** :node 出生标记复用此路径（同一常量源；写者只有 :node 的 boot 循环入口）。 */
        fun nodeBirthFile(context: Context): File = File(context.filesDir, NODE_BIRTH_FILE)

        /** :node 自身进程名（写入 node.pid 第二行，供本服务 cmdline 一致性核对）。 */
        fun selfCmdline(): String = try {
            File("/proc/self/cmdline").readBytes().toString(Charsets.UTF_8).trimEnd('\u0000')
        } catch (_: Throwable) {
            ""
        }

        fun selfPid(): Int = Process.myPid()
    }
}
