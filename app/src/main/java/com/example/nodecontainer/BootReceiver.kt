package com.example.nodecontainer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * 开机自启：收到 BOOT_COMPLETED（含厂商 QUICKBOOT_POWERON）后拉起 NodeRuntimeService。
 * 保证容器（L0）在内核（L1）需要之前就位 —— 这是“冻结 APK 是地基”的落地。
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
            Log.i(TAG, "BootReceiver: $action -> 启动 NodeRuntimeService")
            val svc = Intent(context, NodeRuntimeService::class.java)
            try {
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                    context.startForegroundService(svc)
                } else {
                    context.startService(svc)
                }
            } catch (e: Throwable) {
                Log.e(TAG, "拉起 NodeRuntimeService 失败", e)
                RuntimeDiagnostics.append(
                    context, "boot", false, "$action 后拉起服务失败",
                    "${e::class.java.simpleName}: ${e.message}"
                )
            }
        }
    }

    companion object {
        const val TAG = "BootReceiver"
    }
}
