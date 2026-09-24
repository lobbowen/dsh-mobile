package io.github.lobbowen.dshmobile.permissions

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat

/**
 * 权限状态的**唯一查询入口** —— 免去各处散落的 `canDrawOverlays`/`isExternalStorageManager` 判断。
 * 只做只读查询；申请入口归 UI 层（MainActivity 自建 Intent）。
 */
class PermissionCenter(private val ctx: Context) {

    fun isGranted(spec: PermissionSpec): Boolean = when (spec.id) {
        PermissionCatalog.MANAGE_EXTERNAL_STORAGE ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                runCatching { Environment.isExternalStorageManager() }.getOrDefault(false)
            } else false

        PermissionCatalog.NOTIFICATION_ACCESS -> notificationListenerEnabled()

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

        else -> spec.permission?.let {
            ContextCompat.checkSelfPermission(ctx, it) == PackageManager.PERMISSION_GRANTED
        } ?: false
    }

    /** 通知使用权是否已开（读 Secure.enabled_notification_listeners）。 */
    fun notificationListenerEnabled(): Boolean = runCatching {
        val csv = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: ""
        csv.split(":").any { it.contains(ctx.packageName) }
    }.getOrDefault(false)

    /** 是否已豁免电池优化（Doze 保活前提）。 */
    fun batteryExempt(): Boolean = runCatching {
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        pm.isIgnoringBatteryOptimizations(ctx.packageName)
    }.getOrDefault(false)

}
