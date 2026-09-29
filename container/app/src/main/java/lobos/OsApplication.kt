package lobos

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.SystemClock
import lobos.lifecycle.AccessibilityAnchor
import lobos.lifecycle.AnchorState
import lobos.lifecycle.OsHostService
import lobos.os.KillAudit
import lobos.lifecycle.AnchorPolicy
import lobos.lifecycle.AnchorVerdict

/**
 * 应用入口（进程生命周期内各跑一次）。
 *
 * 两件事：
 * 1. 前台服务所需的通知渠道（Android 8+ 缺渠道会让 startForeground 抛异常）；
 * 2. **进程一起来就戳监督者** —— 常驻是底座，不是流程里某一步的用户动作。
 *    过去运行时实例只有进了诊断页（MainActivity）或被 UI 动作戳才起来，全新安装的用户
 *    在「补完一堆授权」之前运行时根本不在册（真机 2026-09-26 定罪）。
 */
class OsApplication : Application() {

    companion object {
        /** 监督者的常驻通知渠道：优先级低（不响），但它是前台服务的硬前置。 */
        const val SUPERVISOR_CHANNEL_ID = "lobos_host"
    }

    override fun onCreate() {
        super.onCreate()
        createChannels()
        OsHostService.ensureRunning(this)
        // 保护必须在进程存在的第一毫秒生效：Application.onCreate 是进程
        // 每一次被创建（开机 / 覆盖安装 / 重启）都必经的钩子。机制见 AnchorPolicy 头注。
        ensureProtectionActive()
        registerWakeupEdges()
    }

    /**
     * **保护激活**：进程存在的第一毫秒就把锚挂上，让 ColorOS 的判决停在
     * importance=accessibility（锚在 ⟺ 保护档；锚掉 = 判决降级 = 即将被杀，机制见
     * AnchorPolicy 头注）。
     *
     * 本设计没有任何死后恢复：进程死了就是死了，底下跑的任务一起死，把壳点回来不救回任何东西。
     * 所以这里只做两件「活着时才有意义」的事：
     *  · 量一次加固效果（KillAudit）：把系统退出史里每一次退出的 reason/description/importance
     *    逐条落盘（统计走 os.journal.metrics，不在这里攒计数器），回答「加固到底有没有把判决捂住」；
     *  · 确保保护生效（AccessibilityAnchor.ensureBound）：在
     *    [AnchorPolicy.ACTIVATION_BUDGET_MS] 这个硬上界内把锚挂上，超时即
     *    「保护没能从第一毫秒生效」，记【判决降级告警】。
     *
     * 纪律：全在后台线程（查退出史是 binder 调用、挂锚要等系统绑定，绝不许占主线程），
     * 也不在启动链里硬等 —— worker 只发起，超时由 ensureBound 自己收敛，onCreate 立即返回。
     *
     * Application.onCreate 都会走到这里：进程出生就是让保护生效的机会
     * （ensureBound 按契约幂等），而 KillAudit 只让正主进程落盘，避免两份退出史互顶。
     */
    private fun ensureProtectionActive() {
        val appCtx = applicationContext
        Thread({
            try {
                runCatching { KillAudit.auditOnce(appCtx) }
                val startedMs = SystemClock.elapsedRealtime()
                val outcome = runCatching {
                    AccessibilityAnchor.ensureBound(appCtx, AnchorPolicy.ACTIVATION_BUDGET_MS)
                }.getOrNull()
                val elapsedMs = SystemClock.elapsedRealtime() - startedMs
                // 判决状态两个方向都要留痕 —— 可度量才谈得上验证「加固是否有效」。
                // 这是告警，不是恢复：锚没挂上 = 判决掉出 accessibility = 即将被杀。
                runCatching {
                    // 判决逐项列举 AnchorVerdict：**没有 else**。旧写法用 `when { … else -> … }`，
                    // 于是「读不到锚状态」和「锚在位」共用一条 else —— 采集失败会被播成保护生效。
                    when (AnchorPolicy.verdict(outcome?.state ?: AnchorState.UNKNOWN)) {
                        AnchorVerdict.PROTECTED -> RuntimeDiagnostics.append(
                            appCtx, "anchor", true, "保护生效：锚在位",
                            "state=${outcome?.state} bound=${outcome?.bound} 耗时=${elapsedMs}ms —— " +
                                "ColorOS 判决停在 importance=accessibility"
                        )
                        AnchorVerdict.DEGRADED -> RuntimeDiagnostics.append(
                            appCtx, "anchor", false, "判决降级告警：锚未生效",
                            "state=${outcome?.state} bound=${outcome?.bound} 耗时=${elapsedMs}ms" +
                                "（保护激活上界 ${AnchorPolicy.ACTIVATION_BUDGET_MS}ms）—— " +
                                "锚不在位则 ColorOS 判决停在 importance=traffic，随后会被 o-kill；" +
                                "本设计不提供死后恢复"
                        )
                        AnchorVerdict.UNKNOWN -> RuntimeDiagnostics.append(
                            appCtx, "anchor", false,
                            if (outcome == null) "判决降级告警：锚状态未知" else "判决降级告警：锚读数取不到",
                            (if (outcome == null) "ensureBound 调用失败" else "state=UNKNOWN：组件名解析不出或系统服务查不动") +
                                " 耗时=${elapsedMs}ms（保护激活上界 ${AnchorPolicy.ACTIVATION_BUDGET_MS}ms）—— " +
                                "取不到读数不等于保护生效，也不许记成「adb 办不成」，判据见 AnchorPolicy"
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
                OsHostService.ensureRunning(context)
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
                SUPERVISOR_CHANNEL_ID, "Lob OS 常驻", NotificationManager.IMPORTANCE_LOW
            ).apply { description = "OS 宿主状态（唯一前台服务，锁屏常驻）" }
        )
    }
}
