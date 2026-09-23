package io.github.lobbowen.dshmobile.permissions

import android.content.Context
import android.os.Build
import android.provider.Settings

/**
 * 生命周期风险自检（不改行为，只如实上屏）。
 *
 * 三条都是**真机实测过的保活风险**，与权限不同：它们多数没有可申请的 API，
 * 只能检测 + 给出可执行动作（设置页 / adb 命令）。
 */
object LifecycleChecks {

    data class Line(val id: String, val ok: Boolean, val title: String, val detail: String)

    fun collect(ctx: Context): List<Line> {
        val center = PermissionCenter(ctx)
        val out = mutableListOf<Line>()

        // 1) 电池优化豁免
        val batt = center.batteryExempt()
        out += Line(
            "battery-optimization", batt, "电池优化",
            if (batt) "已豁免（Doze 下保活更稳）"
            else "未豁免 —— 设置→电池→不受限制；或由 UI 发 ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
        )

        // 2) Android 12+ phantom process killer：App 派生的子进程超限会被系统 SIGKILL
        val phantom = phantomProcessMonitor(ctx)
        out += Line(
            "phantom-process-killer", phantom != null, "Phantom process killer",
            when {
                phantom == null -> "非 Android 12+，无此机制"
                phantom == 0 -> "监控已关闭（settings_enable_phantom_process_monitoring=0）—— 子进程不会被批量杀（终端/多 Agent 推荐）"
                else -> "监控开启（=$phantom）：系统对 App 派生进程设上限并 SIGKILL；长跑多子进程需 " +
                    "adb shell settings put global settings_enable_phantom_process_monitoring 0"
            },
        )

        // 3) 前台服务保活前提：通知可用
        val notif = PermissionCatalog.SPECIAL.first { it.id == PermissionCatalog.POST_NOTIFICATIONS }
        val notifOk = center.isGranted(notif)
        out += Line(
            "fgs-keepalive", notifOk, "前台服务保活前提",
            if (notifOk) "通知可用：前台服务可持续常驻"
            else "通知被禁：Android 13+ 前台服务通知不可见，保活与可观测性变差（请授予通知权限）",
        )

        return out
    }

    /** 读 settings_enable_phantom_process_monitoring（Android 12+；读不到返回 null）。 */
    private fun phantomProcessMonitor(ctx: Context): Int? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
        return runCatching {
            Settings.Global.getInt(ctx.contentResolver, "settings_enable_phantom_process_monitoring", 1)
        }.getOrNull()
    }
}
