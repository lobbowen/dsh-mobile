package io.github.lobbowen.dshmobile

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import org.lsposed.hiddenapibypass.HiddenApiBypass

/**
 * 应用入口：仅做一件事——注册前台服务所需的通知渠道。
 * （Android 8+ 要求前台服务先有渠道，否则 startForeground 抛异常。）
 */
class NodeContainerApp : Application() {
    companion object {
        const val NOTIFICATION_CHANNEL_ID = "node_runtime"
    }

    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)
        // Shizuku API 内部依赖隐藏 API；Android 9+ 需显式豁免（与 Shizuku 官方 demo 一致）。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try { HiddenApiBypass.addHiddenApiExemptions("L") } catch (_: Throwable) { }
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "Node Runtime",
                NotificationManager.IMPORTANCE_LOW
            ).apply { description = "Node.js 运行时前台服务" }
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }
}
