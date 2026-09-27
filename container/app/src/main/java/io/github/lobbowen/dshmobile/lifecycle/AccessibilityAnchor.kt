package io.github.lobbowen.dshmobile.lifecycle

import android.content.Context
import io.github.lobbowen.dshmobile.bridge.AdbClientRunner
import io.github.lobbowen.dshmobile.capability.AdbChannelProbe
import io.github.lobbowen.dshmobile.capability.CapabilityCriteria
import io.github.lobbowen.dshmobile.capability.Evidence
import io.github.lobbowen.dshmobile.capability.ProbeOutcome
import io.github.lobbowen.dshmobile.permissions.PermissionCatalog
import io.github.lobbowen.dshmobile.permissions.PermissionCenter

/**
 * 无障碍锚（ui_automation 执行体的服务实例）的四态。
 *
 * 为什么要分出 LISTED_NOT_BOUND：设置串可能在系统回收服务后仍残留 —— 真机现在就是
 * 「名单在、绑定无、服务在 Crashed services 里」。拿设置串当绿判据就是假绿，
 * 真判据只有服务实例绑定（[DshAccessibilityService.isReady]）。
 */
enum class AnchorState { BOUND, LISTED_NOT_BOUND, NOT_LISTED, UNKNOWN }

/** 一次 [AccessibilityAnchor.ensureBound] 的结论。[healed] 只在服务实例真绑上时为 true。 */
data class HealOutcome(val state: AnchorState, val healed: Boolean, val detail: String)

/**
 * 无障碍锚的**持续监护与无感自愈**（契约冻结：其他层按本对象调用，不要另写一份）。
 *
 * 为什么它是保活链的根边（真机 2026-09-27 07:08 实测）：
 *  - 锚在位 → OplusHansManager 连续打 `cannot transition from R to M, importance=accessibility`
 *    （HANS 拒绝把本 uid 转出 Running，即拒绝冻/杀）；
 *  - 锚不在位 → `importance=traffic`，随时会被 o-kill。
 * 所以**锚在位 = 闸门开着**，锚掉线是「即将被杀」的前兆。监护要的是**预防**，不是死后自愈：
 * 进程一旦已经被 o-kill，自愈成功也换不回那一世的内核状态。
 *
 * 真机实证的自愈顺序（必须按此顺序，不能省步）：
 *  ① 名单缺我们 → 合并写回（保留别人已登记的项，绝不整串覆盖）；
 *  ② `settings put secure accessibility_enabled 1` —— 总开关为 0 时系统根本不绑服务
 *     （这就是当前源码里那个零引用的 key）；
 *  ③ 名单在、绑定无 → **先摘掉、等约 1 秒、再写回**逼 AMS 重绑。实证：此时重写同一个
 *     字符串不会触发重绑，必须先制造一次「名单变化」；
 *  ④ 仍不绑 → `healed=false` + 归因（绝不用「设置串已写」冒充成功）。
 *
 * 命令一律经 [AdbClientRunner.shell] 现问端点下发（不自己 spawn Node）；调用前只认缓存里的
 * 通道读数，通道不 LIVE 就直接返回未愈/UNKNOWN —— 不硬等，免得把监督线程钉死。
 *
 * 分层纪律：本对象只读/写系统设置并读服务实例，不在这里发明判据 —— 组件名来自
 * [CapabilityCriteria.names]，键名来自 [PermissionCatalog]，权限绿判据仍归
 * [PermissionCenter] 与 capability 层。App 读不到别 uid 的 HANS 日志，所以
 * 「判决状态」只能以锚状态作代理上屏（这一点是设计事实，不是偷懒）。
 */
object AccessibilityAnchor {

    /** 摘掉名单后等 AMS 感知的时间（实证 1s 足够触发下一次读名单）。 */
    private const val STRIP_WAIT_MS = 1_000L

    /** 写回后等服务绑定的轮询预算（实证 3s 内重绑；这里只是上限，绑上即返回）。 */
    private const val REBIND_WAIT_MS = 3_000L

    /** 绑定状态轮询步长。 */
    private const val POLL_STEP_MS = 250L

    /** 真判据：服务实例已连（isReady()），**不认设置串**。 */
    fun isBound(ctx: Context): Boolean = DshAccessibilityService.isReady()

    /** 四态读法（[AnchorState.LISTED_NOT_BOUND] 就是「假绿」那一档的归因出口）。 */
    fun state(ctx: Context): AnchorState {
        if (isBound(ctx)) return AnchorState.BOUND
        // 组件名都解析不出来 → 无从判断名单里有没有我们，只能 UNKNOWN。
        if (CapabilityCriteria.names(ctx).accessibilityComponent.isBlank()) return AnchorState.UNKNOWN
        return if (PermissionCenter(ctx).accessibilityEnabledInSettings()) {
            AnchorState.LISTED_NOT_BOUND
        } else {
            AnchorState.NOT_LISTED
        }
    }

    /**
     * 幂等、**单次**尝试的三级自愈（循环/退避/次数上限由调用方负责，见
     * [ContainerSupervisor] 的锚监护与
     * [io.github.lobbowen.dshmobile.capability.CapabilityAcquisitionRunner] 的串行队列）。
     */
    fun ensureBound(ctx: Context, timeoutMs: Long): HealOutcome {
        if (isBound(ctx)) return HealOutcome(AnchorState.BOUND, true, "锚已在位（闸门开着）")

        val ours = CapabilityCriteria.names(ctx).accessibilityComponent
        if (ours.isBlank()) return HealOutcome(AnchorState.UNKNOWN, false, "组件名未解析，不能下发")

        // 通道护栏：缓存读数不是「LIVE 且未过期」时下发必然失败，直接返回，不硬等。
        // 鲜度用 Evidence.CHANNEL_TTL_MS（判据层的唯一可信期），不在这里另写一个 TTL —
        // 陈旧 LIVE 会让这里连发 3 条 settings 命令，把调用线程钉住几十秒。
        val channel = AdbChannelProbe.cached()
        val channelAge = System.currentTimeMillis() - channel.atMs
        if (channel.outcome != ProbeOutcome.LIVE || channelAge < 0 || channelAge >= Evidence.CHANNEL_TTL_MS) {
            return HealOutcome(
                state(ctx), false,
                "ADB 通道不可用（cached=" + channel.outcome + "，age=" + channelAge + "ms），未尝试自愈",
            )
        }

        val center = PermissionCenter(ctx)
        val listKey = PermissionCatalog.SECURE_KEY_ACCESSIBILITY
        val enabledKey = PermissionCatalog.SECURE_KEY_ACCESSIBILITY_ENABLED

        // ① 名单缺我们 → 合并写回。
        if (!center.accessibilityEnabledInSettings()) {
            val merged = mergedList(center.accessibilityServicesValue(), ours)
            if (!put(ctx, listKey, merged, timeoutMs)) {
                return HealOutcome(state(ctx), false, "名单合并写回失败（settings put 未成功）")
            }
        }

        // ② 总开关置 1（幂等）。实证：总开关为 0 时系统根本不绑，光有名单没用。
        put(ctx, enabledKey, "1", timeoutMs)

        if (awaitBound(REBIND_WAIT_MS)) {
            return HealOutcome(AnchorState.BOUND, true, "名单与总开关补齐后已绑定")
        }

        // ③ 名单在、绑定无（多半已进 Crashed services）→ 先摘掉、等 1s、再写回。
        val current = center.accessibilityServicesValue()
        val stripped = stripList(current, ours)
        put(ctx, listKey, stripped, timeoutMs)
        sleepQuietly(STRIP_WAIT_MS)
        put(ctx, listKey, mergedList(stripped, ours), timeoutMs)
        if (awaitBound(REBIND_WAIT_MS)) {
            return HealOutcome(AnchorState.BOUND, true, "摘除重写后已绑定（闸门重新打开）")
        }

        // ④ 归因：仍不绑就如实说未愈。
        return HealOutcome(
            state(ctx), false,
            "三级自愈后仍未绑定：系统可能仍在绑定冷却或把服务留在 Crashed；" +
                "名单=" + center.accessibilityEnabledInSettings() + "，通道=" + channel.outcome,
        )
    }

    /** settings put secure <key> <value>；空值要显式给 ''，否则 adbd 会当成少了参数。 */
    private fun put(ctx: Context, key: String, value: String, timeoutMs: Long): Boolean {
        val arg = if (value.isEmpty()) "''" else value
        return try {
            AdbClientRunner.shell(ctx, "settings put secure " + key + " " + arg, null, null, timeoutMs).ok
        } catch (_: Throwable) {
            false
        }
    }

    /** 合并写入：保留别人已登记的项（按 ':' 分隔），把我们的组件追加到末尾。 */
    private fun mergedList(current: String, ours: String): String =
        (current.split(":").filter { it.isNotBlank() && it != ours } + ours).joinToString(":")

    /** 摘掉我们这一项，其余原样保留。 */
    private fun stripList(current: String, ours: String): String =
        current.split(":").filter { it.isNotBlank() && it != ours }.joinToString(":")

    /** 轮询等待绑定：能停就停（服务一连上立刻返回），最多等 budgetMs。 */
    private fun awaitBound(budgetMs: Long): Boolean {
        var waited = 0L
        while (waited < budgetMs) {
            if (DshAccessibilityService.isReady()) return true
            sleepQuietly(POLL_STEP_MS)
            waited += POLL_STEP_MS
        }
        return DshAccessibilityService.isReady()
    }

    private fun sleepQuietly(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }
}
