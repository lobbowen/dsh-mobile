package io.github.lobbowen.dshmobile.ui

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager

/**
 * adb 无线调试的 mDNS 发现器（②④ 两项定罪的探针，也是主路径的端口来源）。
 *
 * 两种服务类型（语义见 ADR-0007 §2.2）：
 *   · `_adb-tls-pairing._tcp` —— 只在「配对设备」对话框打开期间发布；
 *   · `_adb-tls-connect._tcp` —— 无线调试开关开着即常驻。
 *
 * 为什么自建 MulticastLock：NSD 底层组播在部分 ROM 上不自动续持，锁 API 24 起需要
 * 显式申请；与 targetSdk 无关。**必须 finally 释放**，否则整机组播省电报废。
 */
class MdnsWatcher(private val context: Context) {

    interface Sink {
        /** @param ageMs browse 发起→记录出现的毫秒差（④ 的原料） */
        fun onRecord(type: String, host: String?, port: Int, name: String, ageMs: Long)
        fun onLog(message: String)
    }

    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val wifi: WifiManager? =
        context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    private var multicastLock: WifiManager.MulticastLock? = null

    // 每种类型只 browse 一条；重入前先 stop，防 NSD 重复注册抛 IllegalArgumentException。
    private val browses = mutableMapOf<String, NsdManager.DiscoveryListener>()

    fun start(type: String, browseStartedAt: Long, sink: Sink) {
        if (browses.containsKey(type)) return
        acquireMulticast()
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String?) {
                sink.onLog("browse 已启动 $type")
            }

            override fun onServiceFound(service: NsdServiceInfo?) {
                val s = service ?: return
                sink.onLog("发现记录 $type → ${s.serviceName}（解析中…）")
                resolve(s, type, browseStartedAt, sink)
            }

            override fun onServiceLost(service: NsdServiceInfo?) {
                sink.onLog("记录消失 $type → ${service?.serviceName ?: "?"}")
            }

            override fun onDiscoveryStopped(serviceType: String?) {
                sink.onLog("browse 已停止 $type")
            }

            override fun onStartDiscoveryFailed(serviceType: String?, errorCode: Int) {
                sink.onLog("browse 启动失败 $type code=$errorCode")
            }

            override fun onStopDiscoveryFailed(serviceType: String?, errorCode: Int) {
                sink.onLog("browse 停止失败 $type code=$errorCode")
            }
        }
        browses[type] = listener
        runCatching { nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener) }
            .onFailure { sink.onLog("browse 注册异常 $type: ${it::class.java.simpleName}: ${it.message}") }
    }

    fun stop(type: String) {
        val l: NsdManager.DiscoveryListener? = browses.remove(type)
        if (l != null) runCatching { nsd.stopServiceDiscovery(l) }
        if (browses.isEmpty()) releaseMulticast()
    }

    fun stopAll() {
        browses.keys.toList().forEach { stop(it) }
        releaseMulticast()
    }

    // 官方姿势：把 onServiceFound 交付的对象原样交给 resolveService（重建 name+type 在
    // 部分栈上不保证命中）。host getter 在 API 33 起 deprecated 但仍全版本可用。
    @Suppress("DEPRECATION")
    private fun resolve(found: NsdServiceInfo, type: String, startedAt: Long, sink: Sink) {
        nsd.resolveService(found, object : NsdManager.ResolveListener {
            override fun onResolveFailed(info: NsdServiceInfo?, errorCode: Int) {
                sink.onLog("解析失败 ${info?.serviceName ?: found.serviceName} code=$errorCode")
            }

            override fun onServiceResolved(info: NsdServiceInfo?) {
                if (info == null) return
                val host = runCatching { info.host?.hostAddress }.getOrNull()
                val age = if (startedAt > 0) System.currentTimeMillis() - startedAt else -1L
                sink.onRecord(type, host, info.port, info.serviceName, age)
            }
        })
    }

    private fun acquireMulticast() {
        if (multicastLock?.isHeld == true) return
        multicastLock = runCatching {
            wifi?.createMulticastLock("dsh-adb-mdns")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        }.getOrNull()
    }

    private fun releaseMulticast() {
        runCatching { multicastLock?.release() }
        multicastLock = null
    }

    companion object {
        const val TYPE_PAIRING = "_adb-tls-pairing._tcp"
        const val TYPE_CONNECT = "_adb-tls-connect._tcp"
    }
}
