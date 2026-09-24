package io.github.lobbowen.dshmobile.runtime

/**
 * 监督循环的**退避与重启策略** —— 纯逻辑，不依赖 Android。
 *
 * 为什么值得单独抽出来测：这里的每条规则都源自**真机事故**，而写错的后果很重 ——
 * 退避不增长会形成**紧循环风暴**（把设备拖死），退避过早清零也一样。
 */
object SupervisorPolicy {

    const val BACKOFF_BASE_MS = 1_000L
    const val BACKOFF_MAX_MS = 30_000L

    /**
     * 存活多久算「稳定」，才允许把退避清零。
     *
     * ⚠ 判据是**存活时长**，不是「health 探到 200」。
     * 真机事故（2026-09-22）：残留守卫占着控制面端口时，新进程秒死，
     * 但健康探测照样秒回 200（**假成功**）。若据此清零，退避永远停在 1s，
     * 形成紧循环风暴。
     */
    const val STABLE_MS = 15_000L

    /**
     * 第 [restartCount] 次重启前的退避：指数增长，尝试 5 次后封顶 [BACKOFF_MAX_MS]。
     *
     * 序列：1s → 2s → 4s → 8s → 16s → 30s → 30s → …
     *
     * 下界也用 coerceIn 夹住：Kotlin 的 shl 对负数移位会按 31 取模，
     * 得到难以预料的值。restartCount 实际只会从 0 递增，但这里不依赖那个前提。
     */
    fun backoffMs(restartCount: Int): Long =
        minOf(BACKOFF_BASE_MS shl restartCount.coerceIn(0, 5), BACKOFF_MAX_MS)

    /**
     * 下一次的 restartCount。
     *
     * 本次**成功启动且存活 >= [STABLE_MS]** → 清零（认作稳定）；
     * 其余情况（拉不起来 / 起来即死）→ 单调 +1，使退避持续增长。
     */
    fun nextRestartCount(currentCount: Int, bootOk: Boolean, aliveMs: Long): Int =
        if (bootOk && aliveMs >= STABLE_MS) 0 else currentCount + 1

    /**
     * 退出时的补充归因。
     *
     * 「曾就绪后退出」与「从未拉起来」的排查方向完全不同：前者要查启动后崩溃 /
     * 单实例锁冲突，后者要查二进制与权限。旧实现在就绪时直接 return，
     * 导致前者的 exitCode/stderr 永远进不了诊断（真机 2026-09-22 的盲区）。
     */
    fun exitNote(wasReady: Boolean): String =
        if (wasReady) "（曾就绪后退出 —— 排查方向：启动后崩溃/单实例锁冲突，而非拉不起）" else ""
}
