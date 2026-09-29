package lobos.lifecycle

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ComponentName
import android.content.Context
import android.os.SystemClock
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import lobos.RuntimeDiagnostics
import lobos.bridge.AdbClientRunner
import lobos.capability.CapabilityCriteria
import lobos.permissions.PermissionCatalog

/** 锚（无障碍服务）的三态。BOUND = 判决停在 importance=accessibility（ColorOS 不冻本 uid）。 */
enum class AnchorState { BOUND, UNBOUND, UNKNOWN }

/**
 * 一次挂锚动作的结果。
 * state  动作之后实测到的锚状态
 * bound  是否已达 BOUND
 * issued 是否真的往系统写过（本地 secure 写 / ADB 通道任一成功下发）—— 静默实测账的「下发过没有」
 *        只看这一位：没下发过就绝不能记账成「adb 办不成」
 * detail 用了哪条下发路径（名单 / 总开关），失败时含原因
 */
data class BindOutcome(
    val state: AnchorState,
    val bound: Boolean,
    val issued: Boolean,
    val detail: String,
)

/**
 * 常驻锚（OsAccessibilityService）的唯一操作面：状态判定 + 挂锚动作。
 *
 * 真机实证（2026-09-27 07:08）：锚在位 <=> OplusHansManager 打
 * "cannot transition from R to M, importance=accessibility"；锚掉 <=> importance=traffic -> 随后 o-kill。
 * 锚层是五层保活组合里唯一被 ROM 显式承认的判决锚；本对象只做两件事：如实报状态、
 * 把锚挂上去（名单不在就补，在而没绑就先摘后写逼 AMS 重绑）。
 *
 * **写名单只是半条路**：同一批实证里，总开关 `accessibility_enabled` 为 0 时系统根本不绑定服务
 * （名单在、绑定无、还进 Crashed services），置 1 才立刻重绑。所以本对象把「名单 + 总开关」
 * 当作**一次**动作发，缺一个键就是半截实现 —— 全仓只有这里写这两个键。
 *
 * 本产品**没有任何死后恢复**（进程死了就是死了，底下的工作一起死，把它拉回来没有意义）：
 * 本对象只在进程出生的第一毫秒被调用一次（OsApplication / BootReceiver / 能力采集执行器），
 * 监护层（OsHostService）只读状态、不碰这里。
 */
object AccessibilityAnchor {

    private const val TAG = "AccessibilityAnchor"

    /**
     * 本服务组件的「包/类」串**只有一个来源** —— [CapabilityCriteria.names]（采集层按
     * `applicationId/类全名` 拼）。这里以前自己拼 `packageName + ".lifecycle.X"`：本应用
     * namespace 是 `lobos` 而 applicationId 是 `lobos.app`，于是写进系统的是一个不存在的类名，
     * 名单写了也不绑、回读也永远对不上 —— 组件名两处拼必然漂移，漂移的方向是静默失败。
     */
    private fun componentString(ctx: Context): String =
        CapabilityCriteria.names(ctx).accessibilityComponent

    private fun component(ctx: Context): ComponentName? = ComponentName.unflattenFromString(componentString(ctx))

    private fun enabledList(ctx: Context): List<String> = try {
        Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
            ?.split(':')?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList()
    } catch (_: Throwable) {
        emptyList()
    }

    /** 无障碍总开关的当前值（Secure 存的是字符串，读法与写法同源，不另造 int 通道）。 */
    private fun masterSwitch(ctx: Context): String = try {
        Settings.Secure.getString(ctx.contentResolver, PermissionCatalog.SECURE_KEY_ACCESSIBILITY_ENABLED) ?: ""
    } catch (_: Throwable) {
        ""
    }

    /** 实测锚状态：只认系统给的已启用列表，不用"我们写过设置"当结论。 */
    fun state(ctx: Context): AnchorState {
        val c = component(ctx) ?: return AnchorState.UNKNOWN   // 组件名解析不出 = 采集失败，不是锚掉了
        return try {
            val am = ctx.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
            val enabled = am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            val match = enabled.any { info ->
                val si = info.resolveInfo?.serviceInfo ?: return@any false
                si.packageName == c.packageName && si.name == c.className
            }
            if (match) AnchorState.BOUND else AnchorState.UNBOUND
        } catch (_: Throwable) {
            AnchorState.UNKNOWN
        }
    }

    fun isBound(ctx: Context): Boolean = state(ctx) == AnchorState.BOUND

    /**
     * 挂锚：已在位直接返回；否则把本服务补进 enabled_accessibility_services（总开关不为 1 时
     * 一并置 1）并回读验证。下发优先级：① 本地写 secure 设置（需 WRITE_SECURE_SETTINGS，置备期经
     * adb 授予）；② 退到 ADB 通道（AdbClientRunner.shell）。两条都不通时如实返回失败，绝不伪造成功。
     *
     * [timeoutMs] 是**整次动作**的硬上界（= [AnchorPolicy.ACTIVATION_BUDGET_MS]）：ADB 通道按剩余
     * 预算下发，预算用尽就不再发起 —— 上界要真的封顶，才配叫「保护激活预算」。
     */
    fun ensureBound(ctx: Context, timeoutMs: Long): BindOutcome {
        if (isBound(ctx)) return BindOutcome(AnchorState.BOUND, true, false, "锚在位，无需动作")

        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        val c = component(ctx)
            ?: return BindOutcome(AnchorState.UNKNOWN, false, false, "组件名解析不出，不能下发")
        val flat = c.flattenToString()
        val cur = enabledList(ctx)
        val without = cur.filter { it != flat }.joinToString(":")
        val joined = (cur.filter { it != flat } + flat).joinToString(":")
        val needMaster = masterSwitch(ctx) != "1"

        val wrote = try {
            // 先摘后写：名单里已有本组件却仍未绑定 = AMS 缓存了坏状态，摘掉再写逼它重绑。
            if (cur.contains(flat)) {
                Settings.Secure.putString(
                    ctx.contentResolver, PermissionCatalog.SECURE_KEY_ACCESSIBILITY, without,
                )
            }
            Settings.Secure.putString(
                ctx.contentResolver, PermissionCatalog.SECURE_KEY_ACCESSIBILITY, joined,
            )
            if (needMaster) {
                Settings.Secure.putString(
                    ctx.contentResolver, PermissionCatalog.SECURE_KEY_ACCESSIBILITY_ENABLED, "1",
                )
            }
            true
        } catch (_: Throwable) {
            false
        }
        var how = if (wrote) "本地写 secure 设置" else "本地无 WRITE_SECURE_SETTINGS，走 ADB 通道"
        var issued = wrote

        if (!wrote) {
            val out = adbPut(ctx, PermissionCatalog.SECURE_KEY_ACCESSIBILITY, "'" + joined + "'", deadline)
            issued = out?.ok == true
            how = when {
                out == null -> how + "失败：保护激活预算（" + timeoutMs + "ms）已用尽"
                out.ok -> how + "：写入服务名单" + (if (needMaster) "、总开关" else "")
                else -> how + "失败：" + (out.error ?: out.raw.take(120))
            }
            if (needMaster && out?.ok == true) {
                val master = adbPut(ctx, PermissionCatalog.SECURE_KEY_ACCESSIBILITY_ENABLED, "1", deadline)
                if (master?.ok != true) how += "；总开关未置上（" + (master?.error ?: "预算用尽") + "）"
            }
        } else if (needMaster) {
            how += "，总开关一并置 1"
        }

        val st = state(ctx)
        val bound = st == AnchorState.BOUND
        RuntimeDiagnostics.append(
            ctx, "accessibility", bound,
            if (bound) "锚已挂上（闸门开着）" else "挂锚未成：" + st,
            how + "；timeout=" + timeoutMs + "ms",
        )
        return BindOutcome(st, bound, issued, how + "；state=" + st)
    }

    /** 在剩余激活预算内发一条 secure 写；预算已尽返回 null（不越过硬上界去等一条不会回来的命令）。 */
    private fun adbPut(ctx: Context, key: String, value: String, deadlineMs: Long): AdbClientRunner.AdbOutcome? {
        val left = deadlineMs - SystemClock.elapsedRealtime()
        if (left <= 0L) return null
        return try {
            AdbClientRunner.shell(
                ctx, "settings put secure " + key + " " + value, null, null, left,
            )
        } catch (_: Throwable) {
            null
        }
    }
}
