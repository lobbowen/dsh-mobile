package lobos.capability

import lobos.permissions.PermissionCatalog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * 渲染档位的**生产者** golden（债 D13 收口）。
 *
 * D13 立账时的原话是「StageStatus.NEXT 与 StepStatus.BLOCKED 在当前流程形状下不可达」，
 * 那份推演只看了聚合函数，没看完两条分支就下了结论 —— 这里就是把结论钉回实测：
 * 两档都各有**一份真实读数**能产生，所以既不删档也不留空转。
 *
 * 与 [CapabilityTierProducerTest] 的分工：那份钉的是**结论档位**（CapStatus/OsPhase/…
 * 每一档都要有实测生产者，缺一档就是编造结论）；这里钉的是**渲染档位**，
 * 说的是「这一行怎么画」，其可达性随流程形状变，所以钉的是**具体读数**而不是集合相等 ——
 * 流程真改成三行时这里会红，那时改夹具而不是删断言。
 */
class RenderTierProducerTest {

    private fun steps(e: Evidence) =
        PipelineProjection.project(e, CapabilityCatalog.evaluate(e)).associateBy { it.id }

    /**
     * F1 还挡着主链（未配对），而入口的第一个缺项已经是「可推进」的读数：
     * 第二行既不是当前步也没被前置卡住 —— 它只能是 NEXT。
     *
     * 读数取得很窄但物理成立：通道现探为 LIVE（设备侧注册还在册），本机配对记录已丢，
     * 控制面未响应。判据层刻意让「实测优先」压过前置（CapabilityCatalog.evaluate），
     * 否则一台通道明明在线的机器会被整页判红。
     */
    @Test fun 渲染档位NEXT有一份真实读数能产生() {
        val e = Evidence(
            nowMs = 1_000_000L,
            devOptionsOn = true,
            wirelessDebugOn = true,
            credentials = CredentialsState.NO_KEY,
            channel = ChannelProbe(ProbeOutcome.LIVE, 1_000_000L, "uid=2000"),
            grants = setOf(PermissionCatalog.POST_NOTIFICATIONS),
            controlPlaneUp = false,
        )
        val rows = OnboardingFlow.stages(e, CapabilityCatalog.evaluate(e))
        assertEquals(OnboardingFlow.SKELETON.size, rows.size)
        assertEquals(StageStatus.CURRENT, rows[0].status)
        assertEquals(
            "入口第一个缺项是可推进读数时，第二行必须是 NEXT —— 该档没有生产者就等于流程永远画不出「下一步」",
            StageStatus.NEXT, rows[1].status,
        )
        // 主行动全列表至多一个：NEXT 那一行不许长出第二个按钮。
        assertEquals(listOf(OnboardingFlow.F1), rows.filter { it.action != null }.map { it.id })
        assertFalse(rows.any { it.extra != null })
    }

    /**
     * 入口三要素里**只剩通道**是缺项，且它被未成立的前置卡住（还没配对）：
     * 这时段行不能画成「点一下就能推进」，也不该画成失败 —— BLOCKED 就是这一格的画法。
     *
     * 物理形状：本地控制面在线、Program 自检全绿，但配对记录不在册且通道从没探过。
     */
    @Test fun 段行BLOCKED有一份真实读数能产生() {
        val e = Evidence(
            nowMs = 1_000_000L,
            devOptionsOn = true,
            wirelessDebugOn = true,
            credentials = CredentialsState.NO_KEY,
            channel = ChannelProbe(ProbeOutcome.NEVER_RUN, 0L),
            grants = setOf(PermissionCatalog.POST_NOTIFICATIONS),
            controlPlaneUp = true,
            programChecks = listOf(CheckItem("bundle", true)),
        )
        val verdicts = CapabilityCatalog.evaluate(e)
        assertEquals(CapStatus.BLOCKED, verdicts.getValue(CapabilityCatalog.ADB_CHANNEL).status)
        assertFalse(PipelineProjection.workbenchReady(verdicts))
        val row = steps(e).getValue(PipelineProjection.S4)
        assertEquals(
            "唯一缺项被前置卡住时段行必须画 BLOCKED —— 画成 ACTION 就是催一个点不动的按钮",
            StepStatus.BLOCKED, row.status,
        )
    }
}
