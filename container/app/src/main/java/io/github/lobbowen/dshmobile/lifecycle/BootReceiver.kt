package io.github.lobbowen.dshmobile.lifecycle

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import io.github.lobbowen.dshmobile.RuntimeDiagnostics
import io.github.lobbowen.dshmobile.runtime.NodeRuntimeService

/**
 * 开机/覆盖安装后的**启动链路正源**（L-A，ADR-0006）：
 *
 *   BootReceiver → ContainerSupervisor（监督者）
 *                    ├─ startService → HostBridgeService（L-B 能力桥）
 *                    └─ bindService(BIND_AUTO_CREATE) → NodeRuntimeService（:node，L-C 宿主）
 *
 * 只戳监督者这**一个**入口，由它按正确顺序拉起各层 —— 旧实现直接并启桥 + :node
 * 两个服务，是为了绕开":node 自己监督自己"的自锁而多点点火；监督者独立成层后，
 * 多点点火反而制造启动竞态（谁先谁后全靠运气）。
 *
 * 兜底边：NodeRuntimeService 的直启保留（监督者启动被 ROM 拒时的第二条腿 ——
 * :node 的 onCreate 会反向 ensureRunning 监督者，环照样闭合）。
 *
 * MY_PACKAGE_REPLACED：覆盖安装后系统会杀掉进程且**不**自动重启服务，这是
 * 「每次更新 APK 都要手动拉起」的唯一自动复活时机。
 * startForegroundService 在部分 ROM 的后台/开机窗口会抛 Exception（FGS-start 限制），
 * 接收器里绝不允许未捕获异常（会连带主进程崩），统一 try/catch 上屏。
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == "android.intent.action.QUICKBOOT_POWERON" ||
            action == Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            Log.i(TAG, "BootReceiver: $action -> 拉起 ContainerSupervisor（+ :node 兜底边）")
            // 监督者自己会在 onStartCommand 里转前台（常驻状态通知 1004），所以这里
            // 普通 startService 即可 —— 开机窗口用 startForegroundService 反而可能被 ROM 拒。
            // 若被后台启动限制拒：下一行 :node 兜底边被拉起后，其 onCreate 会再戳一次。
            startQuietly(context, Intent(context, ContainerSupervisor::class.java), bootSafe = false)
            // 兜底边是**前台服务**（有通知 1001）→ O+ 必须 startForegroundService。
            startQuietly(context, Intent(context, NodeRuntimeService::class.java), bootSafe = true)
            // 进入本接收器 = 进程刚被系统重建：**保护要从第一毫秒生效**（预防），
            // 不是「被杀后再拉起」（自愈）。做两件事：
            //  · 量一次加固效果（KillAudit）：把系统退出史里的 o-kill 次数与每次的
            //    description/reason/importance 落盘；
            //  · 确保保护生效（AccessibilityAnchor）：锚在 = ColorOS 判决停在
            //    importance=accessibility，锚掉 = 判决降级 = 即将被杀（机制见 NodeWatchdogPolicy 头注）。
            // 三个 action（开机 / 快速开机 / 覆盖安装）共用这条既有分支，**不新增任何接收面**，
            // 唤醒面因此不变；动作自己丢后台线程，绝不阻塞接收器主线程。
            ensureProtectionActive(context)
        }
    }

    /**
     * 让保护在进程存在的第一毫秒生效（**预防**；本设计不提供死后恢复，唯一路径是不被杀）。
     * 全部在后台线程：查退出史是对 system_server 的 binder 调用，确保锚在位要等系统绑定 ——
     * 在广播接收器里同步做，超时就是 ROM 判的 ANR。worker 内每步各自兜异常：后台线程的
     * 未捕获异常会直接终止整个进程，那比「保护晚一拍生效」更糟。
     */
    private fun ensureProtectionActive(context: Context) {
        val appCtx = context.applicationContext ?: context
        Thread({
            try {
                runCatching { KillAudit.auditOnce(appCtx) }
                runCatching {
                    AccessibilityAnchor.ensureBound(appCtx, NodeWatchdogPolicy.ANCHOR_ACTIVATION_BUDGET_MS)
                }
            } catch (_: Throwable) {
                // 见方法头注：吞掉一切，绝不让后台线程把异常抛到默认处理器。
            }
        }, "protection-active").start()
    }

    private fun startQuietly(context: Context, svc: Intent, bootSafe: Boolean) {
        try {
            if (bootSafe && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                context.startForegroundService(svc)
            } else {
                context.startService(svc)
            }
        } catch (e: Throwable) {
            Log.e(TAG, "拉起 ${svc.component?.shortClassName} 失败", e)
            RuntimeDiagnostics.append(
                context, "boot", false, "拉起 ${svc.component?.shortClassName} 失败",
                "${e::class.java.simpleName}: ${e.message}"
            )
        }
    }

    companion object {
        const val TAG = "BootReceiver"
    }
}
