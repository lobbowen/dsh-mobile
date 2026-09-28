package lobos.lifecycle

/**
 * 常驻锚（AccessibilityService）的策略常量与降级判据。
 *
 * 定位：这是**五层保活组合**里"锚层"的唯一判据源（见 docs/plans/os-v4-execution-plan.md）。
 * 与已删除的 AnchorPolicy 的关键区别：
 *  - 这里**没有**进程监督/三态/清账/rebind —— 单进程化后，运行时实例不再是独立 Android 进程，
 *    实例监督归 OsInit（lobos.os），不再需要跨进程 watchdog；
 *  - 这里只有两件事：锚必须在进程存在的第一毫秒挂上（硬上界），以及"没挂上=判决降级"的判据。
 *
 * 判决代理指标（真机实证）：锚在位 ⟺ ColorOS 判决停在 importance=accessibility；锚掉 = 即将 o-kill。
 * 本产品不提供死后恢复：唯一路径是不被杀（因此这里只做告警，不做复活）。
 */
object AnchorPolicy {
    /** 保护激活预算（毫秒）：ensureBound 的硬上界，超时即"判决降级"。 */
    const val ACTIVATION_BUDGET_MS = 5_000L

    /**
     * 锚判决的唯一取数口：**入参是实测读数本身**，不是一个布尔。
     *
     * 这里以前写的是 `verdictDegraded(anchorBound: Boolean) = !anchorBound`，而调用方传进来的是
     * `outcome.state != AnchorState.BOUND` —— 两次取反互相抵消，锚掉线反而落进「保护生效：锚在位」
     * 那一条（真机 2026-09-28 定罪的自我矛盾 journal 就出自这里）。判据不收布尔，就是不让
     * 「已经被反过一次的值」再被反一次：取反这件事在本仓只住在这一处，且这一处由 `when`
     * 逐项列举 [AnchorState]，新增锚状态时编译会逼这里表态。
     */
    fun verdict(state: AnchorState): AnchorVerdict = when (state) {
        AnchorState.BOUND -> AnchorVerdict.PROTECTED
        AnchorState.UNBOUND -> AnchorVerdict.DEGRADED
        AnchorState.UNKNOWN -> AnchorVerdict.UNKNOWN
    }
}

/**
 * 保护动作之后，ColorOS 的 importance 判决**实际**落在哪一档。
 *
 * 三态而不是布尔：「读不到」既不是「在位」也不是「掉线」，把它并进任何一边都会造出假话。
 */
enum class AnchorVerdict {
    /** 锚在位：判决停在 importance=accessibility，本 uid 不被冻。 */
    PROTECTED,

    /** 锚不在位：判决已降到 importance=traffic，随时被 o-kill。 */
    DEGRADED,

    /** 取不到读数（组件名解析不出 / 系统服务查不动）—— **不许**当成保护生效。 */
    UNKNOWN,
}
