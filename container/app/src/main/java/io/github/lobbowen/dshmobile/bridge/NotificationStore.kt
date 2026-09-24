package io.github.lobbowen.dshmobile.bridge

import android.app.Notification
import android.service.notification.StatusBarNotification
import java.util.concurrent.ConcurrentLinkedDeque
import org.json.JSONArray
import org.json.JSONObject

/**
 * 通知监听缓冲区（进程内单例）。
 *
 * 为什么可以是单例：`DshNotificationListenerService` 与 `HostBridgeService` 都在**主进程**
 * （Manifest 未给二者指定 `android:process`），所以直接共享内存即可，无需文件/跨进程通道。
 */
object NotificationStore {

    /** 只保留最近 N 条，避免长期运行内存无界增长。 */
    private const val MAX = 200

    private val items = ConcurrentLinkedDeque<JSONObject>()

    /** 监听服务是否已连接（用户在系统设置里开启后由系统绑定）。 */
    @Volatile
    var connected: Boolean = false

    fun onPosted(sbn: StatusBarNotification) {
        val n = sbn.notification ?: return
        val ex = n.extras
        val obj = JSONObject().apply {
            put("pkg", sbn.packageName)
            put("key", sbn.key)
            put("postTime", sbn.postTime)
            put("title", ex?.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: "")
            put("text", ex?.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: "")
            put("ongoing", sbn.isOngoing)
            put("clearable", sbn.isClearable)
        }
        items.addFirst(obj)
        while (items.size > MAX) items.pollLast()
    }

    fun onRemoved(key: String?) {
        if (key == null) return
        items.removeIf { it.optString("key") == key }
    }

    fun snapshot(limit: Int): JSONArray {
        val arr = JSONArray()
        var i = 0
        for (o in items) {
            if (i++ >= limit) break
            arr.put(o)
        }
        return arr
    }
}
