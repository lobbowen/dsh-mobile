package io.github.lobbowen.dshmobile.capability

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import io.github.lobbowen.dshmobile.MainActivity
import io.github.lobbowen.dshmobile.permissions.PermTier
import io.github.lobbowen.dshmobile.permissions.PermissionCatalog

/**
 * USER_TAP 档取法的 intent 装配（spec §4：GUI 不再自己按 stepId 硬编码跳转目标）。
 *
 * 两级降级是**真机定罪**留下的：多数 AppOps 页要 `package:` data 才能定位到本应用，
 * 个别页（通知使用权）不吃 data，被拒时必须去掉 data 重发一次，两级都失败才承认
 * ROM 没这个入口。这段判断与 ROM 事实有关，不该散在 Activity 里。
 */
object CapabilityNavigation {

    /** 返回 null = 这条取法不是「跳页面」（AUTO / USER_CODE / SILENT_* / RUNTIME_DIALOG）。 */
    fun intentFor(ctx: Context, acq: Acquisition): Intent? {
        if (acq.kind != AcquireKind.USER_TAP) return null
        return when (acq.target) {
            CapabilityCatalog.NAV_DEV_OPTIONS -> Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
            CapabilityCatalog.NAV_SCREEN_CAPTURE -> Intent(ctx, MainActivity::class.java)
            else -> Intent(PermissionCatalog.byId(acq.target ?: "")?.settingsAction ?: return null)
        }
    }

    /** RUNTIME_DIALOG 档要申请的 Manifest 权限名（非该档返回 null）。 */
    fun runtimePermission(acq: Acquisition): String? {
        if (acq.kind != AcquireKind.RUNTIME_DIALOG) return null
        val spec = PermissionCatalog.byId(acq.target ?: "") ?: return null
        return if (spec.tier == PermTier.RUNTIME) spec.permission else null
    }

    /**
     * RUNTIME 弹窗被拒后的出口：勾了「不再询问」之后系统弹窗永远不再出现，
     * 只剩本应用详情页（flow-spec §3 降级链）。目标依然留在 capability 层，
     * 首页不自己拼 intent（ui-onboarding-spec §4）。
     */
    fun appDetailsIntent(ctx: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.fromParts("package", ctx.packageName, null))

    /**
     * 无线调试页落点。**先问系统这个 action 到底有没有 Activity 响应**再决定跳哪：
     * ColorOS/PLP120 上 `WIRELESS_DEBUGGING_SETTINGS` 无响应（spec §7③ 定罪），此时唯一
     * 诚实的落点是开发者选项页。不带 `package:` data —— 那是本应用专属设置页，
     * 我们要的是能拨「无线调试」总开关的那一页。
     */
    fun wirelessDebugIntent(ctx: Context): Pair<Intent, String> {
        val deep = Intent(WIRELESS_DEBUG_SETTINGS_ACTION)
        val resolved = runCatching { deep.resolveActivity(ctx.packageManager) }.getOrNull()
        return if (resolved != null) {
            deep to "深链命中 $WIRELESS_DEBUG_SETTINGS_ACTION"
        } else {
            Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS) to
                "深链无 Activity 响应（本机已知）→ 落开发者选项页"
        }
    }

    /**
     * 发出跳转；返回值只说明「系统接了这个 intent」，**不代表用户完成了授权**
     * （完成与否由下一轮 [CapabilityEvidenceCollector] 的读数决定）。
     */
    fun launch(ctx: Context, acq: Acquisition, deepLinkEmitted: (String) -> Unit = {}): Boolean {
        if (acq.kind == AcquireKind.USER_TAP && acq.target == CapabilityCatalog.NAV_WIRELESS_DEBUG) {
            val (intent, note) = wirelessDebugIntent(ctx)
            val ok = runCatching {
                ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }.isSuccess
            deepLinkEmitted(note)
            return ok
        }
        val intent = intentFor(ctx, acq) ?: return false
        // 自家页面（截屏授权入口）不需要 package data，也不需要两级降级。
        if (intent.component != null) return runCatching {
            ctx.startActivity(Intent(intent).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            deepLinkEmitted("组件直投：${intent.component?.className}")
        }.isSuccess
        val described = intent.action ?: return false
        // 非 Activity context（Service/Application）必须 NEW_TASK；Activity context 带上也无害。
        val withData = runCatching {
            ctx.startActivity(
                Intent(intent).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .setData(Uri.parse("package:${ctx.packageName}"))
            )
            deepLinkEmitted("带 package data：$described")
        }.isSuccess
        if (withData) return true
        return runCatching {
            ctx.startActivity(Intent(intent).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            deepLinkEmitted("去 data 重发：$described")
        }.isSuccess
    }

    /**
     * AOSP 公开 action，字符串常量在 compileSdk 里**没有**对应字段（`Settings` 未导出），
     * 只能裸写；因此它必须住在这里 —— CI 的单真值门禁（`capability-single-source-gate`）
     * 不允许别处再出现同一个串。
     */
    const val WIRELESS_DEBUG_SETTINGS_ACTION = "android.settings.WIRELESS_DEBUGGING_SETTINGS"
}
