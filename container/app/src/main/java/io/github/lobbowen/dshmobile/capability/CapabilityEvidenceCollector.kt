package io.github.lobbowen.dshmobile.capability

import android.content.Context
import io.github.lobbowen.dshmobile.kernelota.KernelSelfCheck
import io.github.lobbowen.dshmobile.permissions.PermissionCatalog
import io.github.lobbowen.dshmobile.permissions.PermissionCenter
import io.github.lobbowen.dshmobile.runtime.GuestAdapter
import java.net.HttpURLConnection
import java.net.URL

/**
 * 证据采集（spec §2.4）：唯一允许把 Android 侧读数变成 [Evidence] 的地方。
 *
 * 除 [AdbChannelProbe]（自带 TTL 缓存，避免每轮 spawn Node）与内核自检（贵：要拉 manifest）
 * 之外一律现读 —— 缓存是假绿的温床，v1 的「凭据在册 = S0 绿」就是拿旧事实续命。
 */
object CapabilityEvidenceCollector {

    /** 自检含网络往返（manifest 8s 超时），所以节流；过期前重复渲染用缓存结果。 */
    private const val KERNEL_CHECK_TTL_MS = 5 * 60_000L

    private var kernelChecksAt = 0L
    private var kernelChecks: List<CheckItem> = emptyList()

    /** 含 IO（探针会 spawn Node），**禁止主线程调用**。 */
    @Synchronized
    fun collect(ctx: Context, nowMs: Long = System.currentTimeMillis()): Evidence {
        val center = PermissionCenter(ctx)
        val grants = PermissionCatalog.ALL.filter { center.isGranted(it) }.map { it.id }.toSet()
        val up = controlPlaneUp()
        return Evidence(
            nowMs = nowMs,
            devOptionsOn = CapabilityCriteria.devOptionsOn(ctx),
            wirelessDebugOn = CapabilityCriteria.wirelessDebugOn(ctx),
            credentials = CapabilityCriteria.credentialsState(ctx),
            channel = AdbChannelProbe.probe(ctx, nowMs),
            deviceOwner = CapabilityCriteria.isDeviceOwner(ctx),
            ownerAttempt = AttemptStore.lastOwner,
            grants = grants,
            controlPlaneUp = up,
            kernelChecks = kernelChecks(ctx, nowMs, up),
            pairAttempt = AttemptStore.lastPair,
            names = CapabilityCriteria.names(ctx),
        )
    }

    /** 让下一轮采集强制重跑自检（用户在 S3 点「重跑自检」时用）。 */
    fun forgetKernelChecks() {
        kernelChecksAt = 0L
        kernelChecks = emptyList()
    }

    /**
     * 便宜采集：只读系统侧事实（Settings/文件/服务实例），**不 spawn 探针、不打控制面**。
     *
     * 给谁用：桥令牌（每次 handshake/方法调用都要算，见 [BridgeTokens]）与开机体检
     * （[io.github.lobbowen.dshmobile.ProvisioningProbe]，跑在 :node，跨进程读不到探针缓存）。
     * 因此 [Evidence.controlPlaneUp] 恒为 false、[Evidence.kernelChecks] 恒为空 —— 这两项
     * 的事实来源在 :main 的探针里，这里**不做任何断言**，消费方也不得据此判绿
     * （RUNTIME / KERNEL_BUNDLE 两项只在 [collect] 的完整采集里有意义）。
     */
    fun systemReads(ctx: Context, nowMs: Long = System.currentTimeMillis()): Evidence {
        val center = PermissionCenter(ctx)
        return Evidence(
            nowMs = nowMs,
            devOptionsOn = CapabilityCriteria.devOptionsOn(ctx),
            wirelessDebugOn = CapabilityCriteria.wirelessDebugOn(ctx),
            credentials = CapabilityCriteria.credentialsState(ctx),
            channel = AdbChannelProbe.cached(),
            deviceOwner = CapabilityCriteria.isDeviceOwner(ctx),
            ownerAttempt = AttemptStore.lastOwner,
            grants = PermissionCatalog.ALL.filter { center.isGranted(it) }.map { it.id }.toSet(),
            pairAttempt = AttemptStore.lastPair,
            names = CapabilityCriteria.names(ctx),
        )
    }

    /** 自检结论失效时刻：运行时掉线时清零，重新上线立即重跑（不把上一世的绿续过来）。 */
    private fun kernelChecks(ctx: Context, nowMs: Long, controlPlaneUp: Boolean): List<CheckItem> {
        if (!controlPlaneUp) {
            kernelChecksAt = 0L
            kernelChecks = emptyList()
            return emptyList()
        }
        if (kernelChecks.isEmpty() || nowMs - kernelChecksAt >= KERNEL_CHECK_TTL_MS) {
            kernelChecks = runCatching {
                KernelSelfCheck.run(ctx).map { CheckItem(it.id, it.ok, it.detail) }
            }.getOrDefault(emptyList())
            kernelChecksAt = nowMs
        }
        return kernelChecks
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
}
