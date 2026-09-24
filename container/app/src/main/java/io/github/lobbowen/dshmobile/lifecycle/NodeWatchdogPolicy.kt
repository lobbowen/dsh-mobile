package io.github.lobbowen.dshmobile.lifecycle

/**
 * 容器监督者（ContainerSupervisor，:main）对运行时实例宿主（:node 进程）的**存活判据**。
 * 纯逻辑，不依赖 Android —— 由 CI JVM 测试逐条钉死。
 *
 * 分层背景（ADR-0006 / ARCHITECTURE §1）：
 * 真机定罪（2026-09-25）：ColorOS HANS 按 UID 冻结整个 App，:node 即使挂 FGS
 * 也会被杀；旧设计里唯一会重拉 :node 的循环住在 :node 自家 —— 进程死它同归于尽。
 * 自此监督分两半、各归其位：
 *  - **进程级复活**归 :main 的 ContainerSupervisor（本判据）：绑定 :node，
 *    断开→rebind，久断/卡死→清账重建。监督者与被监督者必须异进程，这是铁律。
 *  - **启动失败退避**留在 :node 自家的串行 boot 循环（SupervisorPolicy）：
 *    那是"进程活着但内核起不来"，不需要跨进程发号施令 —— :node 与自己同进程
 *    重试是唯一无 IPC 失真风险的位置（跨进程 binder 方法调用需 AIDL，为省一条
 *    退避循环引入它属于过度设计）。
 *
 * 状态机（每拍调用一次 [decide]）：
 *   未连接 ──bindService(BIND_AUTO_CREATE) 自愈──▶ 已连接
 *      │ 超过 DEAD_GIVEUP_MS 仍无连接且冷却已过 ──▶ EscalateStop（stop+unbind+rebind 清账）
 *   已连接 ──连续 STUCK_ESCALATION 拍查不到 :node 进程记录（node.pid）──▶ EscalateStop
 *
 * 刻意不做：闹钟心跳等第二唤醒机制（用户 2026-09-25 拍板：保活路径已找到，
 * 叠加机制=叠加风险）。死亡后的**拉起**走 rebind（bindService 是后台合法调用；
 * 真机 ANR 栈实锤过在死亡路径上调 startForegroundService 会炸）。
 */
object NodeWatchdogPolicy {

    /** 轮询节奏：也是 binder 断连后 rebind 失败的重试节奏。 */
    const val ALIVE_POLL_MS = 5_000L

    /** 等 AMS 自愈（START_STICKY/重绑）的预算；超时才允许清账。 */
    const val DEAD_GIVEUP_MS = 30_000L

    /** 连续多少拍「已连接却查不到 :node 进程记录」→ 判内部卡死，允许清账。 */
    const val STUCK_ESCALATION = 3

    /** 清账冷却：判据抖动时 stop/rebind 连发比不修更糟。 */
    const val FORCE_STOP_COOLDOWN_MS = 60_000L

    sealed class Decision {
        /** 本拍不动作，[waitMs] 后再看。 */
        data class Wait(val waitMs: Long) : Decision()
        /** 清账重建：stopService + unbind/rebind。 */
        object EscalateStop : Decision()
    }

    /**
     * @param binderConnected 是否持有 :node 的 binder 连接
     * @param strikes 连续观测「已连接但 :node 进程记录丢失」的拍数（<0 按 0；未连接时调用方传 0）
     * @param lastStateChangeMs 最近一次连接状态变化时刻（elapsedRealtime 语义）
     * @param lastForceStopMs 上次清账实际执行时刻；从未执行传 0
     * @param nowMs 当前流逝时间（单调钟）
     */
    fun decide(
        binderConnected: Boolean,
        strikes: Int,
        lastStateChangeMs: Long,
        lastForceStopMs: Long,
        nowMs: Long,
    ): Decision {
        if (!binderConnected) {
            return if (nowMs - lastStateChangeMs >= DEAD_GIVEUP_MS &&
                (lastForceStopMs == 0L || nowMs - lastForceStopMs >= FORCE_STOP_COOLDOWN_MS)
            ) Decision.EscalateStop else Decision.Wait(ALIVE_POLL_MS)
        }
        if (strikes.coerceAtLeast(0) >= STUCK_ESCALATION) return Decision.EscalateStop
        return Decision.Wait(ALIVE_POLL_MS)
    }
}
