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
            // 监督者是普通 started service（刻意不占通知位）→ 普通 startService。
            // 若被后台启动限制拒：下一行 :node 兜底边被拉起后，其 onCreate 会再戳一次。
            startQuietly(context, Intent(context, ContainerSupervisor::class.java), bootSafe = false)
            // 兜底边是**前台服务**（有通知 1001）→ O+ 必须 startForegroundService。
            startQuietly(context, Intent(context, NodeRuntimeService::class.java), bootSafe = true)
        }
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
