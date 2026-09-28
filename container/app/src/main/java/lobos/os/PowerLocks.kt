package lobos.os

import android.content.Context
import android.net.wifi.WifiManager

/**
 * 按需短持的**网络**电源锁（复检 AUD-G22）。
 *
 * 为什么需要：Doze / 厂商省电下，没有 WifiLock 的长下载会在息屏后被掐断，
 * 表现为"OTA 下载到一半永远不完成"。纪律：只在联网干活期间持，**必须**在 finally 释放。
 *
 * 用法：val net = PowerLocks.wifi(ctx); try { ...联网... } finally { net.close() }
 */
object PowerLocks {

    fun wifi(ctx: Context, tag: String = "lobos:net"): AutoCloseable {
        val wm = runCatching {
            ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        }.getOrNull()
        val lock = runCatching { wm?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, tag) }.getOrNull()
        runCatching { lock?.setReferenceCounted(false); lock?.acquire() }
        return AutoCloseable {
            runCatching { lock?.let { if (it.isHeld) it.release() } }
            Unit
        }
    }
}
