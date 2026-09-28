package lobos.runtime

import lobos.os.Backoff

/**
 * 监督循环的**退避与重启策略** —— 纯逻辑，不依赖 Android。
 *
 * 为什么值得单独抽出来测：这里的每条规则都源自**真机事故**，而写错的后果很重 ——
 * 退避不增长会形成**紧循环风暴**（把设备拖死），退避过早清零也一样。
 */
object SupervisorPolicy {

    /**
     * 一次 boot 尝试的**三种归宿**（纯枚举，CI 可钉）。
     *
     * 以前只有 `Boolean`，于是「没有可跑的内核」和「内核拉不起来」被压成同一个 false：
     * 前者是**合法状态**（首装尚未成功，见 [lobos.ota.ProgramOtaResolution]），重试它只会
     * 变成每 30s 一次的 OTA 轰炸；后者才需要退避重试。两者混在一起时，屏幕上的
     * 「启动成功」还靠 spawn 探针点亮端口来兑现（真机 2026-09-28 定罪的 D15）。
     */
    enum class BootOutcome {
        /** 进程已起且控制面（127.0.0.1:36360/status）实测就绪。唯一算成功的归宿。 */
        RUNNING,

        /** 有内核，但这一拍没跑起来（缺资产 / spawn 失败 / 控制面超时）→ 退避重试。 */
        FAILED,

        /** 没有内核包可跑 → **不重试**，等一次明确的外界动作（装包 / 用户点重试）。 */
        NO_PROGRAM,
    }

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
        Backoff.exponential(restartCount, BACKOFF_BASE_MS, BACKOFF_MAX_MS)

    /**
     * 下一次的 restartCount。
     *
     * 本次**成功启动且存活 >= [STABLE_MS]** → 清零（认作稳定）；
     * 其余情况（拉不起来 / 起来即死）→ 单调 +1，使退避持续增长。
     */
    fun nextRestartCount(currentCount: Int, bootOk: Boolean, aliveMs: Long): Int =
        if (bootOk && aliveMs >= STABLE_MS) 0 else currentCount + 1

    /** 只有 [BootOutcome.RUNNING] 算成功。判据收在这里：D15 的形状就是「成功」有了第二个来源（探针端口点亮）。 */
    fun bootSucceeded(outcome: BootOutcome): Boolean = outcome == BootOutcome.RUNNING

    /**
     * 这一轮之后循环还继不继续。只有 [BootOutcome.NO_PROGRAM] 停手：没有可跑的东西，
     * 退避重试变不出内核，只会把「等装包」伪装成「一直在努力」（每 30s 一次 OTA 往返）。
     * 恢复一律由明确动作发起（装包后的重拉、诊断页重试、下次开屏），不做周期自愈。
     */
    fun keepsLooping(outcome: BootOutcome): Boolean = outcome != BootOutcome.NO_PROGRAM

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
