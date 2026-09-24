package io.github.lobbowen.dshmobile.ui

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import io.github.lobbowen.dshmobile.bridge.AdbClientRunner
import io.github.lobbowen.dshmobile.permissions.PermissionCatalog
import io.github.lobbowen.dshmobile.permissions.PermissionCenter
import io.github.lobbowen.dshmobile.runtime.GuestAdapter
import java.net.HttpURLConnection
import java.net.URL

/**
 * 管线读数采集器：把 [PipelineReadings] 的四个「有没有」从系统里取出来。
 *
 * 分层纪律（spec §4）：判定语义在 [PipelineState]（纯函数、JVM 单测），这里只做采集。
 * 判据与 ProvisioningProbe / HostBridgeService 用同一把尺子（state.json 存在性、
 * isDeviceOwnerApp、PermissionCenter、36360/status），三处不一致会直接导致
 * 「首页说绿、桥说没能力」这类最难排查的错位。
 */
object PipelineProbe {

    /** 采集一次全量读数。含网络/IO 调用，**禁止主线程调用**（Activity 里放工作线程）。 */
    fun snapshot(ctx: Context): PipelineReadings {
        val paired = AdbClientRunner.isPaired(ctx)
        val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
        val owner = runCatching { dpm?.isDeviceOwnerApp(ctx.packageName) == true }.getOrDefault(false)
        val center = PermissionCenter(ctx)
        val missing = PermissionCatalog.ALL.filter { !center.isGranted(it) }.map { it.id }
        return PipelineReadings(
            adbPaired = paired,
            deviceOwner = owner,
            missingPermissions = missing,
            runtimeUp = controlPlaneUp(),
            lastPairError = if (paired) null else lastPairError(ctx),
        )
    }

    /** S0 最近一次配对尝试的失败原因：扫探针日志最后一条 [pair] 结论行。 */
    private fun lastPairError(ctx: Context): String? {
        val text = ProbeJournal.readAll(ctx)
        val line = text.lineSequence().lastOrNull { "[pair]" in it } ?: return null
        if ("配对成功" in line) return null
        return line.substringAfter("[pair]").trim().takeIf { "失败" in it || "为空" in it }
    }

    /** 控制面在线判定 —— 超时姿势与 MainActivity.isPortUp 同款（忙≠死，真机 2026-09-22）。 */
    fun controlPlaneUp(): Boolean = try {
        val c = URL("http://127.0.0.1:${GuestAdapter.KERNEL_CONTROL_PORT}/status")
            .openConnection() as HttpURLConnection
        c.connectTimeout = 300
        c.readTimeout = 1500
        c.requestMethod = "GET"
        c.responseCode == 200
    } catch (_: Throwable) {
        false
    }

    // ---- 变更通知（配对完成等事件让首页立即重采，而不是等下一轮轮询） ----

    private val listeners = mutableListOf<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())

    @Synchronized
    fun subscribe(onChange: () -> Unit) {
        listeners += onChange
    }

    @Synchronized
    fun unsubscribe(onChange: () -> Unit) {
        listeners -= onChange
    }

    fun notifyChanged(ctx: Context) {
        ProbeJournal.append(ctx, "probe", "管线读数变更通知已发出")
        val snapshotOf: List<() -> Unit>
        synchronized(this) { snapshotOf = listeners.toList() }
        main.post { snapshotOf.forEach { runCatching { it() } } }
    }
}
