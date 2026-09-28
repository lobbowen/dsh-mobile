package lobos.lifecycle

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import lobos.RuntimeDiagnostics
import lobos.bridge.AdbClientRunner
import lobos.permissions.PermissionCatalog

/** 锚（无障碍服务）的三态。BOUND = 判决停在 importance=accessibility（ColorOS 不冻本 uid）。 */
enum class AnchorState { BOUND, UNBOUND, UNKNOWN }

/**
 * 一次 ensureBound 的结果。
 * state  动作之后实测到的锚状态
 * healed 是否已达 BOUND
 * detail 用了哪条下发路径（本地 secure 写 / ADB 通道），失败时含原因
 */
data class HealOutcome(val state: AnchorState, val healed: Boolean, val detail: String)

/**
 * 常驻锚（OsAccessibilityService）的唯一操作面：状态判定 + 幂等自愈。
 *
 * 真机实证（2026-09-27 07:08）：锚在位 <=> OplusHansManager 打
 * "cannot transition from R to M, importance=accessibility"；锚掉 <=> importance=traffic -> 随后 o-kill。
 * 锚层是五层保活组合里唯一被 ROM 显式承认的判决锚；本对象只做两件事：如实报状态、
 * 在掉线时把它挂回去（先摘后写，逼 AMS 重绑）。
 *
 * 本产品不提供死后恢复：这里只做"被杀之前"的预防性自愈。
 */
object AccessibilityAnchor {

    private const val TAG = "AccessibilityAnchor"

    private fun component(ctx: Context): ComponentName =
        ComponentName(ctx.packageName, ctx.packageName + ".lifecycle.OsAccessibilityService")

    private fun enabledList(ctx: Context): List<String> = try {
        Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
            ?.split(':')?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList()
    } catch (_: Throwable) {
        emptyList()
    }

    /** 实测锚状态：只认系统给的已启用列表，不用"我们写过设置"当结论。 */
    fun state(ctx: Context): AnchorState = try {
        val am = ctx.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
        val c = component(ctx)
        val enabled = am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
        val match = enabled.any { info ->
            val si = info.resolveInfo?.serviceInfo ?: return@any false
            si.packageName == c.packageName && si.name == c.className
        }
        if (match) AnchorState.BOUND else AnchorState.UNBOUND
    } catch (_: Throwable) {
        AnchorState.UNKNOWN
    }

    fun isBound(ctx: Context): Boolean = state(ctx) == AnchorState.BOUND

    /**
     * 幂等自愈：已在位直接返回；否则把本服务补进 enabled_accessibility_services 并回读验证。
     * 下发优先级：① 本地写 secure 设置（需 WRITE_SECURE_SETTINGS，置备期经 adb 授予）；
     * ② 退到 ADB 通道（AdbClientRunner.shell）。两条都不通时如实返回失败，绝不伪造成功。
     */
    fun ensureBound(ctx: Context, timeoutMs: Long): HealOutcome {
        if (isBound(ctx)) return HealOutcome(AnchorState.BOUND, true, "锚在位，无需动作")

        val c = component(ctx)
        val flat = c.flattenToString()
        val cur = enabledList(ctx)
        val without = cur.filter { it != flat }
        val with = without + flat
        val joined = with.joinToString(":")

        val wrote = try {
            if (cur.contains(flat)) {
                Settings.Secure.putString(
                    ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
                    without.joinToString(":"),
                )
            }
            Settings.Secure.putString(
                ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, joined,
            )
            true
        } catch (_: Throwable) {
            false
        }
        var how = if (wrote) "本地写 secure 设置" else "本地无 WRITE_SECURE_SETTINGS，走 ADB 通道"

        if (!wrote) {
            val cmd = "settings put secure " + PermissionCatalog.SECURE_KEY_ACCESSIBILITY + " '" + joined + "'"
            val out = try {
                AdbClientRunner.shell(ctx, cmd, null, null, timeoutMs)
            } catch (_: Throwable) {
                null
            }
            how = if (out != null && out.ok) "ADB 通道写入" else "ADB 通道不可用"
        }

        val st = state(ctx)
        val healed = st == AnchorState.BOUND
        RuntimeDiagnostics.append(
            ctx, "accessibility", healed,
            if (healed) "锚已恢复（闸门重开）" else "锚自愈未成：" + st,
            how + "；timeout=" + timeoutMs + "ms",
        )
        return HealOutcome(st, healed, how + "；state=" + st)
    }
}
