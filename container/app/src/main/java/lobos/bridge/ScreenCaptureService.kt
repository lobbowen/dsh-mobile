package lobos.bridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import lobos.OsApplication
import lobos.RuntimeDiagnostics

/**
 * 截屏会话的**临时**前台服务（复检 A5 落地）。
 *
 * 为什么必须有：Android 14 (API 34) 起，持有 MediaProjection 的进程必须同时运行一个
 * foregroundServiceType=mediaProjection 的前台服务，否则 getMediaProjection 直接抛
 * SecurityException —— 这条早在 P5 就写进了 ScreenCaptureController 的头注，但一直没接线。
 *
 * 语义边界：**只在截屏会话期间存在**。稳态仍是「1 进程 / 1 FGS / 1 通知」；
 * 截屏结束（用户撤销 / 投影停止 / 进程重启）立刻 stopSelf。
 */
class ScreenCaptureService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        promote()
        val code = intent?.getIntExtra(ScreenCaptureController.EXTRA_RESULT_CODE, 0) ?: 0
        @Suppress("DEPRECATION")
        val data = intent?.getParcelableExtra<Intent>(ScreenCaptureController.EXTRA_RESULT_DATA)
        if (code != 0 && data != null) {
            // 前台服务已就绪，此刻创建投影才符合 API 34 的次序要求。
            ScreenCaptureController.startProjectionFromService(this, code, data)
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        RuntimeDiagnostics.append(this, "screenshot", null, "截屏会话前台服务已停")
        super.onDestroy()
    }

    private fun promote() {
        val notif = buildNotification()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
            } else {
                startForeground(NOTIF_ID, notif)
            }
        } catch (t: Throwable) {
            RuntimeDiagnostics.append(this, "screenshot", false, "截屏会话转前台失败", t::class.java.simpleName + ": " + t.message)
        }
    }

    private fun buildNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(OsApplication.SUPERVISOR_CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(OsApplication.SUPERVISOR_CHANNEL_ID, "Lob OS 常驻", NotificationManager.IMPORTANCE_LOW),
                )
            }
        }
        return NotificationCompat.Builder(this, OsApplication.SUPERVISOR_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentTitle("Lob OS 截屏会话")
            .setContentText("仅在截屏期间存在，结束即停")
            .setOngoing(true)
            .build()
    }

    companion object {
        /** 截屏会话通知 id：与宿主（1004）**必须不同**，否则会顶掉常驻通知。 */
        const val NOTIF_ID = 1005

        fun start(ctx: Context, resultCode: Int, data: Intent) {
            val i = Intent(ctx, ScreenCaptureService::class.java)
                .putExtra(ScreenCaptureController.EXTRA_RESULT_CODE, resultCode)
                .putExtra(ScreenCaptureController.EXTRA_RESULT_DATA, data)
            runCatching { ctx.startForegroundService(i) }.onFailure {
                RuntimeDiagnostics.append(ctx, "screenshot", false, "截屏会话无法启动", it::class.java.simpleName)
            }
        }

        fun stop(ctx: Context) {
            runCatching { ctx.stopService(Intent(ctx, ScreenCaptureService::class.java)) }
        }
    }
}
