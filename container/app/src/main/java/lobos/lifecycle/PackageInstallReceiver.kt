package lobos.lifecycle

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log
import lobos.RuntimeDiagnostics
import lobos.bridge.CapabilityBroker

/**
 * PackageInstaller 会话结果接收器。
 *
 * 背景：安装/卸载只走「用户手动同意」路径 —— PackageInstaller（需 REQUEST_INSTALL_PACKAGES）
 * 提交会话后由系统弹确认框，不申请任何静默/替换特权。
 * 而 PackageInstaller 的 createSession → commit 是**异步**的：commit 只提交，真正结果
 * 由 commit 时传入的 PendingIntent 广播回传（STATUS_PENDING_USER_ACTION / STATUS_SUCCESS /
 * STATUS_FAILURE…）。没有这个接收器，装卸就成了"提交后无法观测"的盲操作。
 *
 * 结果落 RuntimeDiagnostics，屏幕上直接可见（与容器一贯的"每步可观测"一致）。
 */
class PackageInstallReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: ""
        val pkg = intent.getStringExtra(CapabilityBroker.EXTRA_PKG) ?: ""
        val target = intent.getStringExtra(PackageInstaller.EXTRA_PACKAGE_NAME) ?: pkg

        val ok = status == PackageInstaller.STATUS_SUCCESS
        val stage = if (intent.action == ACTION_UNINSTALLED) "pkg-uninstall" else "pkg-install"

        RuntimeDiagnostics.append(
            context, stage, ok,
            "${if (ok) "成功" else "失败"}：$target",
            "status=$status${if (message.isNotBlank()) ", message=$message" else ""}"
        )
        Log.i(TAG, "$stage target=$target status=$status msg=$message")

        // PENDING_USER_ACTION 是常规的"需要用户点确认"分支：本产品只走这条路径，
        // 出现即拉起系统确认界面。
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try {
                    context.startActivity(confirm)
                } catch (e: Throwable) {
                    Log.w(TAG, "无法拉起安装确认界面", e)
                }
            }
        }
    }

    companion object {
        const val TAG = "PackageInstallReceiver"
        const val ACTION_UNINSTALLED = "lobos.PKG_UNINSTALLED"
    }
}
