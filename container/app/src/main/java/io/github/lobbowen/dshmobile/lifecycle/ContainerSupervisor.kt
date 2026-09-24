package io.github.lobbowen.dshmobile.lifecycle

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
import io.github.lobbowen.dshmobile.RuntimeDiagnostics
import io.github.lobbowen.dshmobile.bridge.HostBridgeService
import io.github.lobbowen.dshmobile.runtime.NodeRuntimeService
import java.io.File

/**
 * L-A 容器生命周期层的**实例监督者**（:main，常驻，无通知）。
 *
 * 职责单一：持有运行时实例宿主（:node / NodeRuntimeService）的 binder 连接，
 * 按 [NodeWatchdogPolicy] 判据处置它的死亡与卡死。能力桥（HostBridgeService）、
 * 采集（ScreenCaptureService）等**不再兼任**监督 —— 监督者与桥混住曾导致两个架构
 * 错误：桥被杀时监督陪葬；桥的重拉逻辑与内核的 boot 循环互相踩（真机 2026-09-25 定罪链，ADR-0006）。
 *
 * 监督分两半、各归其位（ADR-0006 / ARCHITECTURE §1）：
 *  - **进程级复活**归本服务（:main）：bindService(:node, BIND_AUTO_CREATE) 持一条 binder 边。
 *    :node 死 → AMS 回调 onServiceDisconnected → 立即 rebind，随之重建进程并重投
 *    started-service 的 onStartCommand。这条边要求 :node.onBind 返回**真 binder**
 *    （返回 null 会被当 null-binding，既不保活也无断开回调）。
 *  - **子进程退避重启**留在 :node 自家 boot 循环：那是"进程活着但内核起不来"，
 *    父监子进程是正常职责，不需要跨进程发号施令 —— 跨进程 binder 只能拿代理、
 *    调不了 :node 的方法，为省一条退避循环硬上 AIDL 属于过度设计。
 *
 * 卡死（binder 边在但进程记录连续丢失）才升级：stopService 解 started 状态 +
 * unbind/rebind 强制重建 —— 判据与冷却收敛在 [NodeWatchdogPolicy.decide]，CI 钉死。
 *
 * 保活权威链（全在 L0，随 APK 冻结）：无障碍绑定 → HANS 拒冻本 uid
 * （实证 `cannot transition from R to M, importance=accessibility`）→ :main 常驻有
 * CPU → 本服务秒级发现 :node 异常并处置。互保闭环：BootReceiver / 桥 onCreate /
 * :node 启动路径都会拉起本服务，任一侧活着环就能转起来。
 *
 * 不变式：**APK（:main + 无障碍锚）不死，运行时环境就不死。**
 * 未来接入 Python/Go 等第二运行时：在此再加一条 binder 边（独立 host service），
 * **禁止**运行时进程自己拉自己（"自己陪葬自己抢救"就是旧设计的根病）。
 */
class ContainerSupervisor : Service() {

    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var bound = false
    private var strikes = 0
    private var lastStateChangeMs = 0L
    private var lastForceStopMs = 0L

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            markConnected(true)
        }

        override fun onServiceDisconnected(name: ComponentName) {
            // :node 进程死亡 → 立刻 rebind（后台合法；绝不调 startForegroundService，
            // :main 刚从 HANS 解冻时不满足 FGS-start 前台要求，真机 ANR 栈实锤）。
            markConnected(false)
            RuntimeDiagnostics.append(
                this@ContainerSupervisor, "supervisor", null,
                ":node 进程断开 → rebind 重拉起", "实例状态随进程同归于尽，重建后 :node 自会重写进程记录"
            )
            handler?.post { bindNode() }
        }
    }

    /** 监督者不对外提供调用面（跨进程发号施令是旧设计的 IPC 幻象）；仅维持自身生命周期。 */
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // L-B 能力桥同样归 L-A 确保（正确的启动链路：监督者 → 桥 + 实例宿主；
        // 内核 connect 的那一刻桥必须在册）。每次被戳都确保一次：桥的 startService
        // 幂等，而这正是"桥曾被后台启动限制拒过一次"的自愈路径。
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
                this, "supervisor", true, "容器监督者就位（:main）",
                "绑定 :node，节拍 ${NodeWatchdogPolicy.ALIVE_POLL_MS}ms"
            )
        }
        return START_STICKY
    }

    private fun markConnected(connected: Boolean) {
        bound = connected
        strikes = 0
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
            if (bound) { if (nodeAlive()) strikes = 0 else strikes++ } else strikes = 0
            val now = SystemClock.elapsedRealtime()
            when (NodeWatchdogPolicy.decide(bound, strikes, lastStateChangeMs, lastForceStopMs, now)) {
                is NodeWatchdogPolicy.Decision.Wait -> if (!bound) bindNode()
                NodeWatchdogPolicy.Decision.EscalateStop -> {
                    lastForceStopMs = now
                    RuntimeDiagnostics.append(
                        this, "supervisor", false,
                        ":node 无响应，清账重建",
                        "bound=$bound strikes=$strikes —— stopService + unbind/rebind"
                    )
                    try { stopService(Intent(this, NodeRuntimeService::class.java)) } catch (_: Throwable) {}
                    try { unbindService(connection) } catch (_: Throwable) {}
                    markConnected(false)
                    bindNode()
                }
            }
        } catch (e: Throwable) {
            Log.e(TAG, "监督拍异常（不致命，下一拍继续）", e)
        } finally {
            handler?.postDelayed(tick, NodeWatchdogPolicy.ALIVE_POLL_MS)
        }
    }

    /** 读 :node 写的进程记录：pid 在 /proc 存在**且** cmdline 与落盘一致才算活
     *  （只查存在会把"pid 被回收给别的进程"误判成 :node 还活着）。 */
    private fun nodeAlive(): Boolean = try {
        val lines = File(filesDir, NODE_PID_FILE).readText().trim().split("\n")
        val pid = lines[0].toIntOrNull() ?: return false
        val procCmd = File("/proc/$pid/cmdline").readBytes()
            .toString(Charsets.UTF_8).trimEnd('\u0000')
        procCmd.isNotEmpty() && (lines.size < 2 || procCmd == lines[1])
    } catch (_: Throwable) {
        false
    }

    override fun onDestroy() {
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

    companion object {
        const val TAG = "ContainerSupervisor"
        /** :node 进程记录文件名（:node 写、本服务读，同一常量源）。 */
        const val NODE_PID_FILE = "node.pid"

        /** 拉起监督者（幂等，普通 startService）。
         *  绝不用 startForegroundService：监督者刻意不占通知位，且调用点多在后台
         *  （:node onCreate / 桥 onCreate）—— 满足不了 5s FGS 契约反而炸宿主。
         *  失败只记日志：互保闭环的其它边（BootReceiver / 无障碍连接 / 桥）会再试。 */
        fun ensureRunning(context: Context) {
            try {
                context.startService(Intent(context, ContainerSupervisor::class.java))
            } catch (e: Throwable) {
                Log.w(TAG, "拉起监督者失败（等互保闭环其它边重试）", e)
            }
        }

        /** :node 侧写进程记录复用此路径（同一常量源，别处不得再拼一次字面量）。 */
        fun nodePidFile(context: Context): File = File(context.filesDir, NODE_PID_FILE)

        /** :node 自身进程名（写入 node.pid 第二行，供本服务 cmdline 一致性核对）。 */
        fun selfCmdline(): String = try {
            File("/proc/self/cmdline").readBytes().toString(Charsets.UTF_8).trimEnd('\u0000')
        } catch (_: Throwable) {
            ""
        }

        fun selfPid(): Int = Process.myPid()
    }
}
