package io.github.lobbowen.dshmobile.lifecycle

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Device Owner 接收器。容器在受管配置/设备所有者模式下借此获得静默装卸应用、
 * 锁屏、设密码、Kiosk、用户限制等特权 —— 这些能力经 HostBridge 的方法门禁对外暴露
 * （见 HostBridgeService.kt 的 device_owner 方法组）。
 *
 * 激活命令的**唯一**权威文本在 docs/runbook/provisioning.md（人读）与
 * capability/CapabilityAcquisitionRunner（机器下发）两处；这里刻意不抄第三份 ——
 * 组件名一改，抄来的命令就是假的（CI 的判据单一真值门禁会拦这种复写）。
 */
class DeviceAdminReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) {
        Log.i(TAG, "Device Owner 已启用")
    }

    override fun onDisabled(context: Context, intent: Intent) {
        Log.i(TAG, "Device Owner 已停用")
    }

    companion object {
        const val TAG = "DeviceAdminReceiver"
    }
}
