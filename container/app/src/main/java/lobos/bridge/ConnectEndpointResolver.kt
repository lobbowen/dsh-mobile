package lobos.bridge

import android.content.Context
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 无线 ADB 连接端点的现问现答（常驻发现版）。
 *
 * connect 端口在无线调试重启 / Wi-Fi 重连后会**继续轮换**（真机 2026-09-25：17:08 配对时
 * 记下的 35633，17:36 已 ECONNREFUSED，同一时刻 mDNS 发布的 44019 一打就通）。所以
 * files/adb/state.json 只承载身份/凭据，端口每次现问。实测首记录 6~40ms，3s 上界富余。
 *
 * ── 为什么改成常驻 watcher（2026-09-27 根治"无限连接断开"）──────────────────────
 * 旧 resolve() 每次 new MdnsWatcher + start + stopAll：探针每 10s 一次，就每 10s
 * 新起一次 NsdManager browse 再立刻收掉，NSD 注册/注销与组播锁反复横跳。
 * 现在 watcher 只 start 一次；onLost（记录真没了）才 stop→start 重问一次；resolve()
 * 只是读缓存或等一次 onRecord。shellArgs 仍是纯函数语义（JVM 测试盯着）。
 */
object ConnectEndpointResolver {

    /** host/port 任一未知即按未知处理（Node 侧自会回落到 state.json 的历史值）。 */
    data class Endpoint(val host: String? = null, val port: Int? = null)

    /**
     * shell 子进程的参数装配。刻意留成不碰 Android 的纯函数 —— 「用现场端口而不是
     * 吃 state.json 的旧端口」这条规则本身必须能在 JVM 单测里被钉红。
     */
    fun shellArgs(cmd: String, timeoutMs: Long, endpoint: Endpoint): MutableList<String> {
        val args = mutableListOf("shell", "--cmd", cmd, "--timeout-ms", timeoutMs.toString())
        endpoint.host?.takeIf { it.isNotBlank() }?.let { args += listOf("--host", it) }
        endpoint.port?.takeIf { it > 0 }?.let { args += listOf("--connect-port", it.toString()) }
        return args
    }

    private val lock = Any()
    private var watcher: MdnsWatcher? = null

    /** 在册记录：onRecord 覆盖、onLost 作废。这是比 state.json 更新鲜的唯一端口读数。 */
    @Volatile
    private var cached: Endpoint? = null

    /** 正在等记录的 resolve()：一次 onRecord 唤醒所有等待者（不再是"一问一停"）。 */
    private val waiters = CopyOnWriteArrayList<CountDownLatch>()

    private val sink = object : MdnsWatcher.Sink {
        override fun onRecord(type: String, host: String?, port: Int, name: String, ageMs: Long) {
            if (type != MdnsWatcher.TYPE_CONNECT) return
            if (host.isNullOrBlank() || port <= 0) return
            cached = Endpoint(host, port)
            releaseWaiters()
        }

        override fun onLost(type: String, name: String) {
            if (type != MdnsWatcher.TYPE_CONNECT) return
            // 记录消失即作废：不许拿旧端口续命（真机案底：界面端口与对话框端口不一致）。
            cached = null
            rebrowse()
        }

        override fun onLog(message: String) {}
    }

    private fun releaseWaiters() {
        val ws = waiters.toList()
        waiters.clear()
        for (w in ws) w.countDown()
    }

    private fun ensureStarted(context: Context) {
        synchronized(lock) {
            if (watcher == null) {
                watcher = MdnsWatcher(context.applicationContext).also {
                    it.start(MdnsWatcher.TYPE_CONNECT, System.currentTimeMillis(), sink)
                }
            }
        }
    }

    /** onLost 才重问：stop→start 拿一次新 browse，避免系统把 browse 停掉后永远等不到新记录。 */
    private fun rebrowse() {
        val w = synchronized(lock) { watcher } ?: return
        runCatching { w.stop(MdnsWatcher.TYPE_CONNECT) }
        w.start(MdnsWatcher.TYPE_CONNECT, System.currentTimeMillis(), sink)
    }

    /**
     * 在常驻 browse 上等一条 connect 记录；已有缓存立即返回，超时/无记录返回 null
     * （调用方自行回落 state.json）。**不再 stopAll** —— watcher 的生命周期归它自己。
     */
    fun resolve(context: Context, timeoutMs: Long = RESOLVE_TIMEOUT_MS): Endpoint? {
        ensureStarted(context)
        cached?.let { return it }
        val latch = CountDownLatch(1)
        waiters.add(latch)
        try {
            cached?.let { return it } // 注册与首读之间的竞态兜底
            if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) return null
            return cached
        } finally {
            waiters.remove(latch)
        }
    }

    private const val RESOLVE_TIMEOUT_MS = 3_000L
}
