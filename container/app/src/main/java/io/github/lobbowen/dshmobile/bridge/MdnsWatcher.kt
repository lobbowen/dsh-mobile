package io.github.lobbowen.dshmobile.bridge

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

        /**
         * 记录消失。**这是端口读数的另一半事实**：`_adb-tls-pairing._tcp` 只在配对对话框
         * 开着期间在册，对话框一关端口就作废 —— 拿上一个端口去配对必然连不上
         * （真机 2026-09-25：界面上显示的端口与对话框里的端口不一致即此因）。
         *
         * @param name 消失的服务实例名；**部分协议栈传 null/空**，那时调用方必须按
         *   「这类记录已不可信」处理，不许拿旧值续命。
         */
        fun onLost(type: String, name: String)

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
                // service 可能是 null（协议栈只报「没了」不给身份）—— 仍必须上抛，
                // 让调用方把这一类的读数作废；这里吞掉就等于把旧端口留在界面上。
                sink.onLost(type, service?.serviceName ?: "")
                sink.onLog("记录消失 $type → ${service?.serviceName ?: "未知实例（整类作废）"}")
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
