package io.github.lobbowen.dshmobile

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * 通知监听服务 —— `notif.read` 能力的**真实载体**。
 *
 * 档位 T1（用户手动）：必须在「设置 → 通知 → 通知使用权」里开启，**无法由 Device Owner 静默授予**。
 * 未连接时 `notif.read` 返回 `-32001`（能力缺失），不做任何伪造。
 */
class DshNotificationListenerService : NotificationListenerService() {

    override fun onListenerConnected() {
        super.onListenerConnected()
        NotificationStore.connected = true
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        NotificationStore.connected = false
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn != null) NotificationStore.onPosted(sbn)
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        NotificationStore.onRemoved(sbn?.key)
    }
}
