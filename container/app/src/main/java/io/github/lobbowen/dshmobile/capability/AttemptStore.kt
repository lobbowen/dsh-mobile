package io.github.lobbowen.dshmobile.capability

/**
 * 配对 / Device Owner 下发的**类型化**尝试记录。
 *
 * 为什么不用日志反解（v1 的做法：`ProbeJournal` 里扫 `[pair]` 行再 `substringAfter` 猜
 * 成功失败）：判据输入变成文案的函数，改一句提示语就会静默改变状态机语义，而且 JVM 单测
 * 钉不住。案底仍然照常写 [io.github.lobbowen.dshmobile.ui.ProbeJournal]，但那是给人看的。
 *
 * 存活在 :main 进程内存里即可：配对服务与首页同进程（AndroidManifest 未给这两者指定
 * 独立 process），进程重启后 FAILED 归零、由探针与用户动作重新得出事实 —— 这比
 * 「凭旧文案一直红着」更诚实。
 */
object AttemptStore {

    @Volatile
    var lastPair: PairAttempt? = null
        private set

    @Volatile
    var lastOwner: OwnerAttempt? = null
        private set

    fun recordPair(atMs: Long, ok: Boolean, reason: String = "") {
        lastPair = PairAttempt(atMs, ok, reason)
    }

    fun recordOwner(atMs: Long, outcome: OwnerAttemptOutcome, reason: String = "") {
        lastOwner = OwnerAttempt(atMs, outcome, reason)
    }
}
