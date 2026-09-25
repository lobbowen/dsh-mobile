package io.github.lobbowen.dshmobile.capability

/**
 * 「点开始配对那一下」的现场判定（flow-spec §2.1 F1）。
 *
 * 为什么需要它：配对的前置（开发者选项 / 无线调试 / 通知）不再各占一行卡，用户按配对时
 * 必须**当场**得到「现在差什么、去哪个页面修」的答案。让 Activity 自己 `if (devOptionsOn)`
 * 就是第二把尺子 —— 所以推导住这里，UI 只执行 [Decision]。
 *
 * 顺序即优先级：[CapabilityCatalog.ADB_CREDENTIALS] 的 requires 声明序（环境开关在前，
 * 输码入口在后）。缺哪项就把用户送去**那项自己的**取法链首项，本层不发明动作。
 */
object PairingGate {

    /**
     * [jump] 是这一跳要交给 [CapabilityNavigation] / 系统弹窗的取法；
     * [ready] 只说明「现场无可引导的缺口」，配对成不成功仍由判据层读数说话。
     */
    data class Decision(val gapCapId: String?, val notice: String, val jump: Acquisition?, val ready: Boolean)

    /** 引导顺序 = 配对的硬前置声明序（[CapabilityCatalog.requiresInOrder]），与判据同源。 */
    private val GATE_ORDER: List<String> =
        CapabilityCatalog.requiresInOrder(CapabilityCatalog.ADB_CREDENTIALS)

    fun decide(e: Evidence, v: Map<String, CapVerdict>): Decision {
        val gap = GATE_ORDER.firstOrNull { v[it]?.status != CapStatus.GRANTED }
        if (gap != null) {
            return Decision(
                gap,
                // 文案取自判据本身：说「未开启」的那张表与送我去哪页的那个动作必须同源。
                "还差一步：" + CapabilityCatalog.titleOf(gap) + " —— " + (v[gap]?.detail ?: "未达成"),
                firstAcquirer(gap, e),
                ready = false,
            )
        }
        return Decision(
            null,
            "环境就绪：在「无线调试」页点「与配对设备配对」，端口一出现就能输码",
            firstAcquirer(CapabilityCatalog.WIRELESS_DEBUG, e),
            ready = true,
        )
    }

    private fun firstAcquirer(id: String, e: Evidence): Acquisition? =
        CapabilityCatalog.byId(id)?.acquirer?.invoke(e)?.firstOrNull()
}
