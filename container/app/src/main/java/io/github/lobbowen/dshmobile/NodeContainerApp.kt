package io.github.lobbowen.dshmobile

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import io.github.lobbowen.dshmobile.lifecycle.ContainerSupervisor

/**
 * 应用入口（每个进程各跑一次：:main 与 :node 都会到这里）。
 *
 * 两件事：
 * 1. 前台服务所需的通知渠道（Android 8+ 缺渠道会让 startForeground 抛异常）；
 * 2. **进程一起来就戳监督者** —— 常驻是底座，不是流程里某一步的用户动作。
 *    过去 :node 只有进了诊断页（MainActivity）或被 UI 动作戳才起来，全新安装的用户
 *    在「补完一堆授权」之前运行时根本不在册（真机 2026-09-26 定罪）。
 */
class NodeContainerApp : Application() {

    companion object {
        const val NOTIFICATION_CHANNEL_ID = "node_runtime"
        /** 监督者的常驻通知渠道：优先级低（不响），但它是前台服务的硬前置。 */
        const val SUPERVISOR_CHANNEL_ID = "container_supervisor"
    }

    override fun onCreate() {
        super.onCreate()
        createChannels()
        ContainerSupervisor.ensureRunning(this)
        registerWakeupEdges()
    }

    /**
     * 解锁/亮屏补位边：进程还活着但监督链被 ROM 掐掉时，这两下把它戳回来。
     * 进程整体被回收时本边无效 —— 那条路归 JobScheduler 的周期戳（lifecycle/SelfHealJobService）。
     *
     * 用两参重载而不是 RECEIVER_NOT_EXPORTED：那个标志位的强制只作用于 targetSdk 33+，
     * 本包 targetSdk=28（SELinux exec 域的决定，见 app/build.gradle），带上它只会多出
     * 一个编译期依赖，换不到任何行为差别。
     */
    private fun registerWakeupEdges() {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                ContainerSupervisor.ensureRunning(context)
            }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_USER_PRESENT)
            addAction(Intent.ACTION_SCREEN_ON)
        }
        runCatching { registerReceiver(receiver, filter) }
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                NOTIFICATION_CHANNEL_ID, "Node Runtime", NotificationManager.IMPORTANCE_LOW
            ).apply { description = "Node.js 运行时前台服务" }
        )
        nm.createNotificationChannel(
            NotificationChannel(
                SUPERVISOR_CHANNEL_ID, "DSH 常驻监督", NotificationManager.IMPORTANCE_LOW
            ).apply { description = "运行时存活状态（常驻前台，锁屏不被清）" }
        )
    }
}
