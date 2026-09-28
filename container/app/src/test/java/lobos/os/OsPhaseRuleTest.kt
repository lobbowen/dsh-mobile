package lobos.os

import lobos.capability.ProbeOutcome
import lobos.lifecycle.AnchorState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 相位判据 golden（架构 v4 §10，C1 三处同源的**判据侧**）。
 *
 * 钉的是「读数 → 相位」这条纯函数：落盘与通知渲染都在 OsInit/OsHostService，它们不可由 JVM 测，
 * 所以判据必须能从那些 Android 细节里拔出来住在这儿，否则「DEGRADED 到底可不可达」只能靠真机撞。
 * 真机 2026-09-28 的定罪正是这件事：全仓只有 RUNNING / STOPPING 两个迁移点，DEGRADED 永远不可达，
 * 而通知正文用另一把尺子现场拼装降级字样 —— 于是相位串同源、结论不同源。
 */
class OsPhaseRuleTest {

    private fun facts(
        collected: Boolean = true,
        control: Boolean = true,
        channel: ProbeOutcome = ProbeOutcome.LIVE,
        anchor: AnchorState = AnchorState.BOUND,
    ) = OsFacts(readingsCollected = collected, controlPlaneUp = control, channel = channel, anchor = anchor)

    @Test fun 降级只认控制面与锚_通道不通不判降级() {
        // 控制面不在线 = 面板干活没着落；锚不在位 = 判决降到 traffic 随时被 o-kill。这两个才是常驻相位。
        assertEquals(OsPhase.DEGRADED, OsPhaseRule.next(OsPhase.RUNNING, facts(control = false)))
        assertEquals(OsPhase.DEGRADED, OsPhaseRule.next(OsPhase.RUNNING, facts(anchor = AnchorState.UNBOUND)))
        // 通道不通是「配对手没了」，归入口判据（PipelineProjection.GATING）管，不谎报常驻降级。
        assertNull(OsPhaseRule.next(OsPhase.RUNNING, facts(channel = ProbeOutcome.DEAD)))
        assertNull(OsPhaseRule.next(OsPhase.RUNNING, facts(channel = ProbeOutcome.NEVER_RUN)))
    }

    @Test fun 锚读数取不到既不判降级也不判保护生效() {
        // UNKNOWN = 采集失败。判成降级会伪造一次并不存在的判决掉线；判成在位是谎报保护。
        // 所以相位不动，而可见性由状态行单列「锚未知」承担（OsInit.statusLine）。
        assertFalse(OsPhaseRule.degraded(facts(anchor = AnchorState.UNKNOWN)))
        assertNull(OsPhaseRule.next(OsPhase.RUNNING, facts(anchor = AnchorState.UNKNOWN)))
        assertEquals(3, AnchorState.values().size)
    }

    @Test fun DEGRADED双向都可达_恢复也要回到RUNNING() {
        // 「⇄」两个方向都必须有生产者，否则又是一个零生产者档位（债表 D10 定罪的形状）。
        assertEquals(OsPhase.DEGRADED, OsPhaseRule.next(OsPhase.RUNNING, facts(control = false)))
        assertEquals(OsPhase.RUNNING, OsPhaseRule.next(OsPhase.DEGRADED, facts()))
        // 已经在降级且读数依旧差：不重复翻转，Journal 才只记翻转点。
        assertNull(OsPhaseRule.next(OsPhase.DEGRADED, facts(control = false)))
    }

    @Test fun 没采到读数不许拿初值判相位() {
        // 服务刚起来的 controlPlaneUp=false 是「还没采」，不是「运行时未响应」。
        val none = facts(collected = false, control = false, channel = ProbeOutcome.NEVER_RUN,
            anchor = AnchorState.UNKNOWN)
        assertNull(OsPhaseRule.next(OsPhase.RUNNING, none))
        // 全默认构造（OsSnapshot 无 state.json 时的那份）同样不许触发降级。
        assertNull(OsPhaseRule.next(OsPhase.BOOTING, OsFacts()))
    }

    @Test fun BOOTING与STOPPING不由读数改写() {
        // 那两个边是生命周期事件（宿主就绪 / 宿主销毁），归 OsInit.transition；
        // 把销毁后的文件改成「降级」等于谎报一次判决掉线。
        assertNull(OsPhaseRule.next(OsPhase.BOOTING, facts(control = false)))
        assertNull(OsPhaseRule.next(OsPhase.STOPPING, facts(anchor = AnchorState.UNBOUND)))
    }

    @Test fun 翻转归因只说读数里有的事() {
        assertEquals("控制面不在线", OsPhaseRule.reason(OsPhase.DEGRADED, facts(control = false)))
        assertEquals("锚不在位", OsPhaseRule.reason(OsPhase.DEGRADED, facts(control = true, anchor = AnchorState.UNBOUND)))
        assertEquals("读数恢复", OsPhaseRule.reason(OsPhase.RUNNING, facts()))
    }

    @Test fun 每个相位都有落盘文案_没有一档是被悄悄删掉的() {
        // 相位枚举少一档就必须是**拍过板**的少一档（见债表 D11：RECOVERING 因零生产者被删），
        // 不许是某人写 when 时漏了一支 —— label 全覆盖才谈得上三处同源都渲染得出来。
        val labels = OsPhase.values().map { it.label }.toSet()
        assertEquals(OsPhase.values().size, labels.size)
        assertTrue(labels.containsAll(listOf("启动中", "运行中", "降级", "停止中")))
        // 反向也钉：多一档 = 又一个零生产者相位（D10 定罪的形状）。加档位必须同时在这里给它
        // 一条能被实测打出来的路径，而不是让散文去猜「恢复中」算不算降级。
        assertEquals(4, OsPhase.values().size)
    }
}
