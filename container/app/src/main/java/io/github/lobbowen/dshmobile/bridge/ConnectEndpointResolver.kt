package io.github.lobbowen.dshmobile.bridge

import android.content.Context
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 无线 ADB 连接端点的现问现答。
 *
 * connect 端口在无线调试重启 / Wi-Fi 重连后会**继续轮换**（真机 2026-09-25：17:08 配对时
 * 记下的 35633，17:36 已 ECONNREFUSED，同一时刻 mDNS 发布的 44019 一打就通）。所以
 * `files/adb/state.json` 只承载身份/凭据，端口每次现问。实测首记录 6~40ms，3s 上界富余。
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

    /** 一次性 browse connect 记录，拿到即收手；超时/无记录返回 null（调用方自行回落）。 */
    fun resolve(context: Context, timeoutMs: Long = RESOLVE_TIMEOUT_MS): Endpoint? {
        val found = arrayOfNulls<Endpoint>(1)
        val latch = CountDownLatch(1)
        val watcher = MdnsWatcher(context)
        val sink = object : MdnsWatcher.Sink {
            override fun onRecord(type: String, host: String?, port: Int, name: String, ageMs: Long) {
                if (type != MdnsWatcher.TYPE_CONNECT || found[0] != null) return
                found[0] = Endpoint(host, port)
                latch.countDown()
            }

            override fun onLog(message: String) {}
        }
        watcher.start(MdnsWatcher.TYPE_CONNECT, System.currentTimeMillis(), sink)
        try {
            if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) return null
            return found[0]?.takeIf { !it.host.isNullOrBlank() && (it.port ?: 0) > 0 }
        } finally {
            watcher.stopAll()
        }
    }

    private const val RESOLVE_TIMEOUT_MS = 3_000L
}
