package io.github.lobbowen.dshmobile.lifecycle

/**
 * 容器监督者（ContainerSupervisor，:main）对运行时实例宿主（:node 进程）的**存活判据**。
 * 纯逻辑，不依赖 Android —— 由 CI JVM 测试逐条钉死。
 *
 * 三态判据（2026-09-26 真机定罪后补齐，缺任何一态都会把「空壳」判成健康）：
 *  - **POWER** binder 边在册 **且** `node.pid` 记录指向的进程还在 —— 只证明"进程存在"。
 *  - **BORN**  该进程的 boot 循环真的跑起来过（`node.birth` 记的 pid == 进程记录的 pid）。
 *  - **ONLINE** 控制面可达（[CapabilityEvidenceCollector.controlPlaneUp]）—— 只进状态出口，
 *    不做判据：内核起不来时 :node 自家 boot 循环已在按 [SupervisorPolicy] 退避重试，
 *    跨进程再发一道清账指令只会打断它（且"ONLINE=false"是合法状态，不是要修的病）。
 *
 * 为什么要 BORN 这一维：旧判据只有 POWER。`bindService(BIND_AUTO_CREATE)` 复活 :node 时
 * **只跑 onCreate**，而 boot 循环当年挂在 onStartCommand 上；ROM 的 cached-kill 之后 AMS
 * 不会重投 start 命令 —— 于是进程在、通知在、pid 在，boot 一次没跑，空壳被监督者判成健康。
 * （ADR-0006 §2.1 旧叙述「rebind 随之重建进程并重投 onStartCommand」即此处被证伪的句子。）
 * 正解不是往死亡路径再补投一条 start（那是被否决的"用重试伪装正常"），而是
 * ① :node 在 onCreate 自己出生（任何创建路径都出生），② 本判据把「有 POWER 无 BORN」
 * 认成非法态：按既有清账动作处置，并让它出现在状态出口上。
 *
 * 分层背景（ADR-0006 / ARCHITECTURE §1）：
 * 真机定罪（2026-09-25）：ColorOS HANS 按 UID 冻结整个 App，:node 即使挂 FGS 也会被杀；
 * 旧设计里唯一会重拉 :node 的循环住在 :node 自家 —— 进程死它同归于尽。
 * 自此监督分两半、各归其位：
 *  - **进程级复活**归 :main 的 ContainerSupervisor（本判据）：绑定 :node，
 *    断开→rebind，久断/卡死/空壳→清账重建。监督者与被监督者必须异进程，这是铁律。
 *  - **启动失败退避**留在 :node 自家的串行 boot 循环（SupervisorPolicy）：
 *    那是"进程活着但内核起不来"，不需要跨进程发号施令 —— :node 与自己同进程
 *    重试是唯一无 IPC 失真风险的位置（跨进程 binder 方法调用需 AIDL，为省一条
 *    退避循环引入它属于过度设计）。
 *
 * 状态机（每拍调用一次 [decide]）：
 *   未连接 ──bindService(BIND_AUTO_CREATE) 自愈──▶ 已连接
 *      │ 超过 DEAD_GIVEUP_MS 仍无连接且冷却已过 ──▶ EscalateStop（stop+unbind+rebind 清账）
 *   已连接 ──连续 STUCK_ESCALATION 拍查不到 :node 进程记录（node.pid）──▶ EscalateStop
 *   已连接 ──进程记录在册但超过 BORN_GIVEUP_MS 仍无出生标记（空壳）──▶ EscalateStop
 *
 * 三条升级路径共用 FORCE_STOP_COOLDOWN_MS：判据抖动时 stop/rebind 连发比不修更糟。
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

    /**
     * 「进程在却从未出生」的容忍窗口。基准 = 进程记录（node.pid）的落盘时刻，
     * 出生标记在 boot 循环入口就写（毫秒级），所以这一窗口只是给 ROM 线程调度留余量，
     * 不是给"慢启动"留的 —— 慢启动由 :node 自己退避，监督者不许因此清账。
     */
    const val BORN_GIVEUP_MS = 30_000L

    sealed class Decision {
        /** 本拍不动作，[waitMs] 后再看。 */
        data class Wait(val waitMs: Long) : Decision()
        /** 清账重建：stopService + unbind/rebind（rebind 触发的 onCreate 会自出生）。 */
        object EscalateStop : Decision()
    }

    /**
     * @param binderConnected 是否持有 :node 的 binder 连接
     * @param strikes 连续观测「已连接但 :node 进程记录丢失」的拍数（<0 按 0；未连接时调用方传 0）
     * @param born 出生标记是否属于当前进程记录里的 pid（无进程记录时传 false）
     * @param pidRecordAgeMs 进程记录落盘至今的毫秒数；记录缺失或时间戳不可解时传 0（宁可不清账）
     * @param lastStateChangeMs 最近一次连接状态变化时刻（elapsedRealtime 语义）
     * @param lastForceStopMs 上次清账实际执行时刻；从未执行传 0
     * @param nowMs 当前流逝时间（单调钟）
     */
    fun decide(
        binderConnected: Boolean,
        strikes: Int,
        born: Boolean,
        pidRecordAgeMs: Long,
        lastStateChangeMs: Long,
        lastForceStopMs: Long,
        nowMs: Long,
    ): Decision {
        if (!binderConnected) {
            return if (nowMs - lastStateChangeMs >= DEAD_GIVEUP_MS) {
                escalateOrWait(lastForceStopMs, nowMs)
            } else {
                Decision.Wait(ALIVE_POLL_MS)
            }
        }
        if (strikes.coerceAtLeast(0) >= STUCK_ESCALATION) return escalateOrWait(lastForceStopMs, nowMs)
        // 空壳 :node：进程在、pid 在，但 boot 循环从没跑起来。
        if (!born && pidRecordAgeMs >= BORN_GIVEUP_MS) return escalateOrWait(lastForceStopMs, nowMs)
        return Decision.Wait(ALIVE_POLL_MS)
    }

    private fun escalateOrWait(lastForceStopMs: Long, nowMs: Long): Decision =
        if (lastForceStopMs == 0L || nowMs - lastForceStopMs >= FORCE_STOP_COOLDOWN_MS) {
            Decision.EscalateStop
        } else {
            Decision.Wait(ALIVE_POLL_MS)
        }
}
