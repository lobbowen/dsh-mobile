package io.github.lobbowen.dshmobile.lifecycle

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 容器监督者活性判据（NodeWatchdogPolicy）。
 *
 * 背景（真机 2026-09-25 定罪）：ColorOS HANS 杀 :node 时不带过 :main ——
 * 旧设计里唯一会重拉 :node 的循环住在 :node 自家，同归于尽。现在监督者搬进
 * :main，本策略是它唯一的决策内核，因此逐条钉住：
 *   · 活着时绝不折腾（误 stop 会把健康内核踢成冷重启风暴）
 *   · 死亡先给 AMS 留足自愈预算，超时才允许清账
 *   · 清账必须有冷却（判据抖动时 stop/rebind 连发比不修更糟）
 *   · 所有阈值必须是正数且互相自洽（冷却 >= 自愈预算，否则升级永远不可达）
 *
 * 2026-09-26 补的第二组（空壳 :node 定罪）：POWER 一维判据会把"BIND_AUTO_CREATE 复活出来、
 * boot 循环从没跑过"的进程判成健康，所以 BORN 必须是一等判据；同时不许把"内核起不来"
 * （ONLINE=false，:node 自家退避中）误当成空壳去跨进程清账。
 */
class NodeWatchdogPolicyTest {

    private fun wait() = NodeWatchdogPolicy.Decision.Wait(NodeWatchdogPolicy.ALIVE_POLL_MS)

    @Test fun 连接正常且进程记录在_永远只是轮询等待() {
        for (strikes in listOf(0, 1, 2)) {
            assertEquals(
                "strikes=$strikes 未达升级线不得 escalate",
                wait(),
                NodeWatchdogPolicy.decide(
                    binderConnected = true, strikes = strikes,
                    born = true, pidRecordAgeMs = 0L,
                    lastStateChangeMs = 0L, lastForceStopMs = 0L, nowMs = 10_000L,
                ),
            )
        }
    }

    @Test fun 已连接但进程记录连丢三拍_判卡死升级() {
        val d = NodeWatchdogPolicy.decide(
            binderConnected = true, strikes = NodeWatchdogPolicy.STUCK_ESCALATION,
            born = false, pidRecordAgeMs = 0L,
            lastStateChangeMs = 0L, lastForceStopMs = 0L, nowMs = 60_000L,
        )
        assertEquals(NodeWatchdogPolicy.Decision.EscalateStop, d)
    }

    @Test fun 负strikes按零处理而不是绕过卡死升级() {
        // 调用方传负数（下溢/接线错）不得让 >= 判据意外成立，也不得抛异常。
        val d = NodeWatchdogPolicy.decide(
            binderConnected = true, strikes = -5,
            born = true, pidRecordAgeMs = 0L,
            lastStateChangeMs = 0L, lastForceStopMs = 0L, nowMs = 0L,
        )
        assertEquals(wait(), d)
    }

    @Test fun 断开后自愈预算内_只等不clean() {
        for (elapsed in listOf(0L, 5_000L, 29_999L)) {
            assertEquals(
                "断开 +${elapsed}ms 仍在 AMS 自愈窗口内",
                wait(),
                NodeWatchdogPolicy.decide(
                    binderConnected = false, strikes = 0,
                    born = false, pidRecordAgeMs = 0L,
                    lastStateChangeMs = 100_000L, lastForceStopMs = 0L,
                    nowMs = 100_000L + elapsed,
                ),
            )
        }
    }

    @Test fun 断开超时且从未清账_升级清账() {
        val d = NodeWatchdogPolicy.decide(
            binderConnected = false, strikes = 0,
            born = false, pidRecordAgeMs = 0L,
            lastStateChangeMs = 0L, lastForceStopMs = 0L,
            nowMs = NodeWatchdogPolicy.DEAD_GIVEUP_MS,
        )
        assertEquals(NodeWatchdogPolicy.Decision.EscalateStop, d)
    }

    @Test fun 清账后冷却窗口内_不再二次清账() {
        val lastStop = 500_000L
        for (elapsed in listOf(0L, 30_000L, NodeWatchdogPolicy.FORCE_STOP_COOLDOWN_MS - 1)) {
            assertEquals(
                "距上次清账 ${elapsed}ms，冷却未过",
                wait(),
                NodeWatchdogPolicy.decide(
                    binderConnected = false, strikes = 0,
                    born = false, pidRecordAgeMs = 0L,
                    lastStateChangeMs = lastStop, lastForceStopMs = lastStop,
                    nowMs = lastStop + elapsed,
                ),
            )
        }
    }

    @Test fun 冷却期满边界_允许再次清账() {
        // 与上一用例互补：断开自上次清账起持续存在，elapsed 恰好 == COOLDOWN → 放行。
        val lastStop = 500_000L
        val d = NodeWatchdogPolicy.decide(
            binderConnected = false, strikes = 0,
            born = false, pidRecordAgeMs = 0L,
            lastStateChangeMs = lastStop,
            lastForceStopMs = lastStop,
            nowMs = lastStop + NodeWatchdogPolicy.FORCE_STOP_COOLDOWN_MS,
        )
        assertEquals(NodeWatchdogPolicy.Decision.EscalateStop, d)
    }

    // ---- BORN 态：空壳 :node（真机 2026-09-26 定罪的第二维）----

    @Test fun 进程在但从未出生_超过容忍窗_判空壳升级() {
        val d = NodeWatchdogPolicy.decide(
            binderConnected = true, strikes = 0,
            born = false, pidRecordAgeMs = NodeWatchdogPolicy.BORN_GIVEUP_MS,
            lastStateChangeMs = 0L, lastForceStopMs = 0L, nowMs = 40_000L,
        )
        assertEquals(
            "rebind 复活出的空壳（只有 onCreate 跑过）必须被裁决成升级，否则它会被判成健康",
            NodeWatchdogPolicy.Decision.EscalateStop, d,
        )
    }

    @Test fun 出生窗内不作动作_慢启动不是病() {
        for (age in listOf(0L, 5_000L, NodeWatchdogPolicy.BORN_GIVEUP_MS - 1)) {
            assertEquals(
                "进程记录落盘 ${age}ms，仍在出生容忍窗内",
                wait(),
                NodeWatchdogPolicy.decide(
                    binderConnected = true, strikes = 0,
                    born = false, pidRecordAgeMs = age,
                    lastStateChangeMs = 0L, lastForceStopMs = 0L, nowMs = 40_000L,
                ),
            )
        }
    }

    @Test fun 已出生的进程_年龄再大也不许折腾() {
        // 内核起不来（ONLINE=false）时 :node 自家在退避重试，监督者不许跨进程清账 ——
        // 那会把"慢/失败"误伤成冷重启风暴（真机 2026-09-22 紧循环的教训）。
        for (age in listOf(60_000L, 3_600_000L)) {
            assertEquals(
                "born=true pidAge=$age 必须只是等待",
                wait(),
                NodeWatchdogPolicy.decide(
                    binderConnected = true, strikes = 0,
                    born = true, pidRecordAgeMs = age,
                    lastStateChangeMs = 0L, lastForceStopMs = 0L, nowMs = age,
                ),
            )
        }
    }

    @Test fun 空壳升级同样吃冷却_不许连发清账() {
        val lastStop = 500_000L
        assertEquals(
            "冷却未过时空壳也只等待（否则每拍 stop/rebind 比不修更糟）",
            wait(),
            NodeWatchdogPolicy.decide(
                binderConnected = true, strikes = 0,
                born = false, pidRecordAgeMs = NodeWatchdogPolicy.BORN_GIVEUP_MS,
                lastStateChangeMs = lastStop, lastForceStopMs = lastStop,
                nowMs = lastStop + NodeWatchdogPolicy.FORCE_STOP_COOLDOWN_MS - 1,
            ),
        )
    }

    @Test fun 卡死升级也吃冷却() {
        val lastStop = 500_000L
        assertEquals(
            wait(),
            NodeWatchdogPolicy.decide(
                binderConnected = true, strikes = NodeWatchdogPolicy.STUCK_ESCALATION,
                born = false, pidRecordAgeMs = 0L,
                lastStateChangeMs = lastStop, lastForceStopMs = lastStop,
                nowMs = lastStop + NodeWatchdogPolicy.FORCE_STOP_COOLDOWN_MS - 1,
            ),
        )
    }

    @Test fun 阈值自洽_冷却必须覆盖自愈预算否则升级不可达() {
        // 若 COOLDOWN < DEAD_GIVEUP，断开升级会在"还没等到giveup"前就被冷却挡死 ——
        // 判据组合出一个永不触发的死锁。这里钉住两常量的相对顺序。
        assertTrue(
            "FORCE_STOP_COOLDOWN(${NodeWatchdogPolicy.FORCE_STOP_COOLDOWN_MS}) " +
                "必须 >= DEAD_GIVEUP(${NodeWatchdogPolicy.DEAD_GIVEUP_MS})",
            NodeWatchdogPolicy.FORCE_STOP_COOLDOWN_MS >= NodeWatchdogPolicy.DEAD_GIVEUP_MS,
        )
        assertTrue(NodeWatchdogPolicy.ALIVE_POLL_MS > 0)
        assertTrue(NodeWatchdogPolicy.STUCK_ESCALATION >= 2)
        // 出生窗必须大于轮询节拍：否则一拍就判空壳，慢启动被误杀（窗 <= 节拍 = 判据不可用）。
        assertTrue(
            "BORN_GIVEUP(${NodeWatchdogPolicy.BORN_GIVEUP_MS}) 必须 > 一拍 ALIVE_POLL(${NodeWatchdogPolicy.ALIVE_POLL_MS})",
            NodeWatchdogPolicy.BORN_GIVEUP_MS > NodeWatchdogPolicy.ALIVE_POLL_MS,
        )
    }
}
