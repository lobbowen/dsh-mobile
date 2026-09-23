package com.example.nodecontainer.permissions

import android.Manifest
import android.provider.Settings

/**
 * 权限分档 —— 决定「能不能拿、怎么拿」。对齐 docs/ANDROID-PERMISSION-PLAN.md 的五档：
 * NORMAL/T0 安装即得、RUNTIME/T1 运行时弹窗、APPOP/T1 AppOps 设置页、
 * SETTINGS/T1 特殊设置页、SERVICE_TOGGLE/T1 服务开关、DEVICE_ADMIN/T4、ADB_ONLY/T3。
 */
enum class PermTier { NORMAL, RUNTIME, APPOP, SETTINGS, SERVICE_TOGGLE, DEVICE_ADMIN, ADB_ONLY }

/**
 * 一条权限的声明。**[PermissionCatalog] 是容器侧权限的唯一事实源**：
 * 状态查询、申请引导、诊断上屏都从这里派生。
 */
data class PermissionSpec(
    val id: String,
    val label: String,
    val tier: PermTier,
    val permission: String? = null,
    val settingsAction: String? = null,
    /** 未授权时的补充说明（会被拼进诊断行）。 */
    val note: String = "",
)

object PermissionCatalog {

    const val MANAGE_EXTERNAL_STORAGE = "manage-external-storage"
    const val NOTIFICATION_ACCESS = "notification-access"
    const val POST_NOTIFICATIONS = "post-notifications"
    const val REQUEST_INSTALL_PACKAGES = "request-install-packages"
    const val SYSTEM_ALERT_WINDOW = "system-alert-window"
    const val BATTERY_OPTIMIZATION = "battery-optimization"

    /** 「标准特殊权限」五项 —— 与 ProvisioningProbe.special-perms 逐条对应。 */
    val SPECIAL: List<PermissionSpec> = listOf(
        PermissionSpec(
            MANAGE_EXTERNAL_STORAGE, "MANAGE_EXTERNAL_STORAGE", PermTier.APPOP,
            settingsAction = Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
            note = "已声明，需跳设置页或由 Device Owner 静默授予",
        ),
        PermissionSpec(
            NOTIFICATION_ACCESS, "通知访问", PermTier.SETTINGS,
            settingsAction = "android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS",
        ),
        PermissionSpec(
            POST_NOTIFICATIONS, "POST_NOTIFICATIONS", PermTier.RUNTIME,
            permission = Manifest.permission.POST_NOTIFICATIONS,
            note = "notif.post 会被系统静默丢弃",
        ),
        PermissionSpec(
            REQUEST_INSTALL_PACKAGES, "REQUEST_INSTALL_PACKAGES", PermTier.APPOP,
            settingsAction = Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            note = "Device Owner 可经 setPermissionGrantState 直接授予",
        ),
        PermissionSpec(
            SYSTEM_ALERT_WINDOW, "SYSTEM_ALERT_WINDOW", PermTier.APPOP,
            settingsAction = Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            note = "Device Owner 可静默授予，无需用户点确认",
        ),
    )

    /** 生命周期相关（不算「控制面能力」，但决定保活质量）。 */
    val LIFECYCLE: List<PermissionSpec> = listOf(
        PermissionSpec(
            BATTERY_OPTIMIZATION, "电池优化豁免", PermTier.APPOP,
            settingsAction = Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            note = "不豁免则 Doze 下更易被杀",
        ),
    )

    val ALL: List<PermissionSpec> = SPECIAL + LIFECYCLE
}
