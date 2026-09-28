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

    /** 判决降级判据：true = 锚不在位 = 判决掉出 accessibility。 */
    fun verdictDegraded(anchorBound: Boolean): Boolean = !anchorBound
}
