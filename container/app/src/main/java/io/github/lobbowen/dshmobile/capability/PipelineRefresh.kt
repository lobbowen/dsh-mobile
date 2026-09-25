package io.github.lobbowen.dshmobile.capability

import android.os.Handler
import android.os.Looper

/**
 * 「事实变了，请重采一次」的进程内通知（配对成功、用户完成授权、静默下发之后）。
 *
 * 为什么要有它：S0 的绿靠活探针，但探针有 TTL 与冷却；用户刚做完一步却还要等下一轮
 * 轮询才变绿，就会被读成「没反应」，进而诱导我把判据写成乐观置绿 —— 那是假绿的另一条路。
 */
object PipelineRefresh {

    private val listeners = mutableListOf<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())

    @Synchronized
    fun subscribe(onChange: () -> Unit) {
        listeners += onChange
    }

    @Synchronized
    fun unsubscribe(onChange: () -> Unit) {
        listeners -= onChange
    }

    fun notifyChanged() {
        val snapshot: List<() -> Unit>
        synchronized(this) { snapshot = listeners.toList() }
        main.post { snapshot.forEach { runCatching { it() } } }
    }
}
