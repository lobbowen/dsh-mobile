package lobos.permissions

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import lobos.bridge.NotificationStore
import lobos.bridge.ScreenCaptureController
import lobos.lifecycle.OsAccessibilityService

/**
 * 权限/授权状态的**唯一查询入口** —— 免去各处散落的 `canDrawOverlays`/`isExternalStorageManager` 判断。
 * 只做只读查询；「怎么拿」由 `capability/CapabilityCatalog` 的取法链决定（spec §2.1/§4）。
 */
class PermissionCenter(private val ctx: Context) {

    fun isGranted(spec: PermissionSpec): Boolean = when (spec.id) {
        PermissionCatalog.MANAGE_EXTERNAL_STORAGE ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                runCatching { Environment.isExternalStorageManager() }.getOrDefault(false)
            } else false

        // 这两项都是**服务开关**，一律以**实例已绑定**为准：设置串可能在系统回收服务后仍残留，
        // 残留串会让桥侧门禁放行、执行时拿不到服务对象（notif.read 自己的门槛就是
        // NotificationStore.connected，判据与执行体不同源 = 同一件事两把尺子）。
        PermissionCatalog.ACCESSIBILITY -> OsAccessibilityService.isReady()
        PermissionCatalog.NOTIFICATION_ACCESS -> notificationListenerBound()

        PermissionCatalog.POST_NOTIFICATIONS ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) ==
                    PackageManager.PERMISSION_GRANTED
            } else true

        PermissionCatalog.REQUEST_INSTALL_PACKAGES ->
            runCatching { ctx.packageManager.canRequestPackageInstalls() }.getOrDefault(false)

        PermissionCatalog.SYSTEM_ALERT_WINDOW ->
            runCatching { Settings.canDrawOverlays(ctx) }.getOrDefault(false)

        PermissionCatalog.BATTERY_OPTIMIZATION -> batteryExempt()

        PermissionCatalog.MEDIAPROJECTION -> ScreenCaptureController.isReady()

        else -> spec.permission?.let {
            ContextCompat.checkSelfPermission(ctx, it) == PackageManager.PERMISSION_GRANTED
        } ?: false
    }

    /**
     * 无障碍是否在 Secure 设置里被勾选（只用于「名单在、绑定无」的归因文案，不是绿判据）。
     * 三态判定本身住 [lobos.lifecycle.AccessibilityAnchor.state]，这里不再包一层同名出口。
     */
    fun accessibilityEnabledInSettings(): Boolean =
        accessibilityServicesValue().split(":").any { it.contains(ctx.packageName) }

    /** Secure 里已登记的无障碍服务原值（合并写入时需要，字面量只住 PermissionCatalog）。 */
    fun accessibilityServicesValue(): String = secureString(PermissionCatalog.SECURE_KEY_ACCESSIBILITY)

    /**
     * 通知使用权在 Secure 里有没有被勾选（adb 静默下发的回读就是它）。**不是绿判据**：
     * 勾选残留而服务未绑定时 `notif.read` 依然不可用，绿判据走 [notificationListenerBound]。
     */
    fun notificationListenerEnabled(): Boolean =
        notificationListenersValue().split(":").any { it.contains(ctx.packageName) }

    /** 监听服务实例是否已被系统绑定 —— 与 `notif.read` 执行体同一把尺子（NotificationStore）。 */
    fun notificationListenerBound(): Boolean = NotificationStore.connected

    /** Secure 里已登记的通知监听器原值。 */
    fun notificationListenersValue(): String = secureString(PermissionCatalog.SECURE_KEY_NOTIFICATION_LISTENER)

    private fun secureString(key: String): String = runCatching {
        Settings.Secure.getString(ctx.contentResolver, key) ?: ""
    }.getOrDefault("")

    /** 是否已豁免电池优化（Doze 保活前提）。 */
    fun batteryExempt(): Boolean = runCatching {
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        pm.isIgnoringBatteryOptimizations(ctx.packageName)
    }.getOrDefault(false)

}
