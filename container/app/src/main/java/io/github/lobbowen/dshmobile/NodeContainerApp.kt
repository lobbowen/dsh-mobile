package io.github.lobbowen.dshmobile

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.SystemClock
import io.github.lobbowen.dshmobile.lifecycle.AccessibilityAnchor
import io.github.lobbowen.dshmobile.lifecycle.AnchorState
import io.github.lobbowen.dshmobile.lifecycle.ContainerSupervisor
import io.github.lobbowen.dshmobile.lifecycle.KillAudit
import io.github.lobbowen.dshmobile.lifecycle.NodeWatchdogPolicy

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
        // 保护必须在进程存在的第一毫秒生效（预防，不是自愈）：Application.onCreate 是进程
        // 每一次被创建（开机 / 覆盖安装 / 重启）都必经的钩子。机制见 NodeWatchdogPolicy 头注。
        ensureProtectionActive()
        registerWakeupEdges()
    }

    /**
     * **预防，不是自愈**：进程存在的第一毫秒就把锚挂上，让 ColorOS 的判决停在
     * importance=accessibility（锚在 ⟺ 保护档；锚掉 = 判决降级 = 即将被杀，机制见
     * NodeWatchdogPolicy 头注）。
     *
     * 本设计**不提供死后恢复**：被杀后拉起来的只是空壳，agent 的工作已经断。所以这里只做
     * 两件「活着时才有意义」的事：
     *  · 量一次加固效果（KillAudit）：把系统退出史里的 o-kill 次数与每次的
     *    description/reason/importance 落盘，回答「加固到底有没有把判决捂住」；
     *  · 确保保护生效（AccessibilityAnchor.ensureBound）：在
     *    [NodeWatchdogPolicy.ANCHOR_ACTIVATION_BUDGET_MS] 这个硬上界内把锚挂上，超时即
     *    「保护没能从第一毫秒生效」，记【判决降级告警】。
     *
     * 纪律：全在后台线程（查退出史是 binder 调用、挂锚要等系统绑定，绝不许占主线程），
     * 也不在启动链里硬等 —— worker 只发起，超时由 ensureBound 自己收敛，onCreate 立即返回。
     *
     * :main 与 :node 的 Application.onCreate 都会走到这里：任何进程出生都是让保护生效的机会
     * （ensureBound 按契约幂等），而 KillAudit 只让正主进程落盘，避免两份退出史互顶。
     */
    private fun ensureProtectionActive() {
        val appCtx = applicationContext
        Thread({
            try {
                runCatching { KillAudit.auditOnce(appCtx) }
                val startedMs = SystemClock.elapsedRealtime()
                val outcome = runCatching {
                    AccessibilityAnchor.ensureBound(appCtx, NodeWatchdogPolicy.ANCHOR_ACTIVATION_BUDGET_MS)
                }.getOrNull()
                val elapsedMs = SystemClock.elapsedRealtime() - startedMs
                // 判决状态两个方向都要留痕 —— 可度量才谈得上验证「加固是否有效」。
                // 这是告警，不是恢复：锚没挂上 = 判决掉出 accessibility = 即将被杀。
                runCatching {
                    when {
                        outcome == null -> RuntimeDiagnostics.append(
                            appCtx, "anchor", false, "判决降级告警：锚状态未知",
                            "ensureBound 调用失败 耗时=${elapsedMs}ms（保护激活上界 " +
                                "${NodeWatchdogPolicy.ANCHOR_ACTIVATION_BUDGET_MS}ms）—— " +
                                "本设计不提供死后恢复，判据与机制见 NodeWatchdogPolicy"
                        )
                        NodeWatchdogPolicy.verdictDegraded(outcome.state != AnchorState.BOUND) ->
                            RuntimeDiagnostics.append(
                                appCtx, "anchor", false, "判决降级告警：锚未生效",
                                "state=${outcome.state} healed=${outcome.healed} 耗时=${elapsedMs}ms" +
                                    "（保护激活上界 ${NodeWatchdogPolicy.ANCHOR_ACTIVATION_BUDGET_MS}ms）—— " +
                                    "锚不在位则 ColorOS 判决停在 importance=traffic，随后会被 o-kill；" +
                                    "本设计不提供死后恢复"
                            )
                        else -> RuntimeDiagnostics.append(
                            appCtx, "anchor", true, "保护生效：锚在位",
                            "state=${outcome.state} 耗时=${elapsedMs}ms —— " +
                                "ColorOS 判决停在 importance=accessibility"
                        )
                    }
                }
            } catch (_: Throwable) {
                // 后台线程绝不能把异常抛给默认处理器：那会直接终止整个进程（比不生效更糟）。
            }
        }, "protection-active").start()
    }

    /**
     * 解锁/亮屏补位边：进程还活着但监督链被 ROM 掐掉时，这两下把它戳回来。
     * 进程整体被回收时本边无效，也**不做复活**（2026-09-26 拍板：复活回来的是壳，任务在
     * 重启那一刻已被内核判 failed）—— 那种情况归 lifecycle/ResidencyAudit 定罪，把中断显示出来。
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
