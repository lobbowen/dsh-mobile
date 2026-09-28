package lobos.capability

import android.content.Context
import android.provider.Settings
import lobos.bridge.OsNotificationListenerService
import lobos.lifecycle.OsAccessibilityService
import java.io.File

/**
 * 系统侧判据的**唯一出口**（spec §2.5）。
 *
 * 为什么必须收口：同一件事（凭据在不在册、DO 有没有生效、开关开没开）此前有四处各自手写的
 * 表达式（`AdbClientRunner.isPaired` / `ProvisioningProbe` / `CapabilityBroker.deviceCapabilities`
 * / `ProgramOtaSelfCheck`），只有注释在约束它们一致 —— 真机 2026-09-25 的假绿就是从这种复制里长出来的。
 * 现在业务层一律调这里或调 [CapabilityCatalog]，CI 门禁 `capability-single-source-gate-test.js`
 * 负责让「在别处再写一遍」变红。
 */
object CapabilityCriteria {

    fun credentialsState(ctx: Context): CredentialsState {
        val dir = File(ctx.filesDir, "adb")
        val paired = File(dir, "state.json").isFile && File(dir, "adbkey.pem").isFile
        return if (paired) CredentialsState.PAIRED else CredentialsState.NO_KEY
    }

    fun devOptionsOn(ctx: Context): Boolean =
        globalInt(ctx, "development_settings_enabled") == 1

    /** 无线调试开关：Settings.Global 里的公开键，读不到按 false（宁缺勿误导）。 */
    fun wirelessDebugOn(ctx: Context): Boolean = globalInt(ctx, "adb_wifi_enabled") == 1

    fun names(ctx: Context): DeviceNames = DeviceNames(
        packageName = ctx.packageName,
        dpcComponent = "",
        accessibilityComponent = "${ctx.packageName}/${OsAccessibilityService::class.java.name}",
        notificationListenerComponent = "${ctx.packageName}/" +
            OsNotificationListenerService::class.java.name,
    )

    private fun globalInt(ctx: Context, name: String): Int = runCatching {
        Settings.Global.getInt(ctx.contentResolver, name, 0)
    }.getOrDefault(0)
}
