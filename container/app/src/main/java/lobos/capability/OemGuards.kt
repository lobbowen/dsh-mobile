package lobos.capability

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONObject
import java.io.File

/**
 * 厂商省电白名单的**引导与回执**（复检 AUD-G21，五层里的「豁免层」）。
 *
 * 事实边界（不伪造）：ColorOS 的卡片锁 / 完全后台 / 速冻白名单 / 启动管理**没有公开读接口**，
 * 深链也随 ROM 版本漂移。能做到的只有三件：
 *   ① 多级降级的跳转目标（厂商 Activity → 应用详情页）；
 *   ② 用户在页面上拨完后点「我已完成」→ 回执落盘 `files/os/oem-guards.json`；
 *   ③ 把回执当判据上屏（`ACTION`/`GRANTED`），**不**假装系统回读到了白名单。
 */
object OemGuards {

    const val CARD_LOCK = "oem-card-lock"
    const val FULL_BACKGROUND = "oem-full-background"
    const val FREEZE_WHITELIST = "oem-freeze-whitelist"
    const val STARTUP_MANAGER = "oem-startup-manager"

    val KEYS = listOf(CARD_LOCK, FULL_BACKGROUND, FREEZE_WHITELIST, STARTUP_MANAGER)

    private fun file(ctx: Context) = File(File(ctx.filesDir, "os"), "oem-guards.json")

    fun vendor(): String = (Build.MANUFACTURER + "/" + Build.BRAND).trim()

    fun isColorOs(): Boolean {
        val v = vendor().lowercase()
        return v.contains("oppo") || v.contains("oneplus") || v.contains("realme")
    }

    fun confirmed(ctx: Context, key: String): Boolean = runCatching {
        val f = file(ctx)
        if (!f.exists()) false else JSONObject(f.readText()).optLong(key, 0L) > 0L
    }.getOrDefault(false)

    fun confirmedAll(ctx: Context): Set<String> = KEYS.filter { confirmed(ctx, it) }.toSet()

    @Synchronized
    fun confirm(ctx: Context, keys: List<String> = KEYS) {
        runCatching {
            val f = file(ctx)
            val o = if (f.exists()) JSONObject(f.readText()) else JSONObject()
            keys.forEach { o.put(it, System.currentTimeMillis()) }
            f.parentFile?.mkdirs()
            f.writeText(o.toString())
        }
    }

    private fun componentIntent(pkg: String, cls: String): Intent =
        Intent().setComponent(ComponentName(pkg, cls))

    private fun appDetails(ctx: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).setData(Uri.fromParts("package", ctx.packageName, null))

    /** 候选目标（按优先级）。非 ColorOS 机型只有应用详情页这一个诚实落点。 */
    fun candidates(ctx: Context, key: String): List<Intent> = when (key) {
        STARTUP_MANAGER -> listOf(
            componentIntent("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
            componentIntent("com.oplus.safecenter", "com.oplus.safecenter.startup.StartupAppListActivity"),
            appDetails(ctx),
        )
        CARD_LOCK -> listOf(
            componentIntent("com.coloros.safecenter", "com.coloros.safecenter.permission.PermissionManagerActivity"),
            componentIntent("com.oplus.safecenter", "com.oplus.safecenter.permission.PermissionManagerActivity"),
            appDetails(ctx),
        )
        FULL_BACKGROUND -> listOf(
            componentIntent("com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity"),
            componentIntent("com.oplus.battery", "com.oplus.powermanager.fuelgaue.PowerUsageModelActivity"),
            appDetails(ctx),
        )
        FREEZE_WHITELIST -> listOf(
            componentIntent("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
            appDetails(ctx),
        )
        else -> listOf(appDetails(ctx))
    }

    /** 选第一个"系统接得住"的落点；返回 (intent, 归因)。全不可用时退应用详情页。 */
    fun resolve(ctx: Context, key: String): Pair<Intent, String> {
        val list = candidates(ctx, key)
        for (i in list.indices) {
            val intent = list[i]
            val ok = runCatching { intent.resolveActivity(ctx.packageManager) != null }.getOrDefault(false)
            if (ok) return intent to if (i == list.size - 1) "应用详情页（厂商入口未命中）" else "厂商页命中（候选 #" + (i + 1) + "）"
        }
        return appDetails(ctx) to "应用详情页（无可用候选）"
    }
}
