package io.github.lobbowen.dshmobile.capability

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

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

    /** 时间线保留条数：再多也读不完一条通知，用户要看的是「刚才那几下分别是什么结果」。 */
    private const val TIMELINE_KEEP = 6

    @Volatile
    var lastPair: PairAttempt? = null
        private set

    /** 本轮进程内的全部配对尝试（旧→新，最多 [TIMELINE_KEEP] 条）。 */
    @Volatile
    var pairAttempts: List<PairAttempt> = emptyList()
        private set

    /** 累计次数（含被时间线挤出保留窗的早期尝试）—— 「第 N 次」的 N 由它给，不许由下标猜。 */
    @Volatile
    private var pairCount = 0

    @Volatile
    var lastOwner: OwnerAttempt? = null
        private set

    fun recordPair(atMs: Long, ok: Boolean, reason: String = "") {
        val attempt = PairAttempt(atMs, ok, reason)
        lastPair = attempt
        pairCount += 1
        pairAttempts = (pairAttempts + attempt).takeLast(TIMELINE_KEEP)
    }

    fun recordOwner(atMs: Long, outcome: OwnerAttemptOutcome, reason: String = "") {
        lastOwner = OwnerAttempt(atMs, outcome, reason)
    }

    /**
     * 人读配对时间线（新→旧）。通知与首页**共用这一份文案**：真机定罪（2026-09-26）是
     * 「配对到底成没成没人说得出」，两处各写一套措辞就等于第二个事实源。
     * 纯格式化、无判据 —— 结论一律来自 [PairAttempt.ok]，不在这里重新推断。
     */
    fun humanPairTimeline(): List<String> {
        if (pairAttempts.isEmpty()) return emptyList()
        val fmt = SimpleDateFormat("HH:mm:ss", Locale.US)
        val firstIndex = pairCount - pairAttempts.size + 1
        return pairAttempts.mapIndexed { i, a ->
            "第 ${firstIndex + i} 次 ${fmt.format(Date(a.atMs))} " +
                if (a.ok) "成功" else "失败：" + a.reason.ifBlank { "未归因" }.take(60)
        }.reversed()
    }
}
