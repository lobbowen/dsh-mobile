package io.github.lobbowen.dshmobile.capability

import android.content.Context
import io.github.lobbowen.dshmobile.bridge.AdbClientRunner
import io.github.lobbowen.dshmobile.bridge.ConnectEndpointResolver

/**
 * ADB 通道的**活探针**：现问 mDNS 端点 → 经该端点跑一条 shell → 断言拿到 shell uid。
 *
 * 为什么必须有它（v1 没有）：凭据在册只说明「以前配成功过」，而 adbd 的 connect 端口在
 * 无线调试重启 / Wi-Fi 重连后持续轮换（真机 2026-09-25：17:08 记下 35633，17:36 已
 * ECONNREFUSED，现场发布的是 44019）。所以 S0 的绿必须由这里产生，且**过期即失效** ——
 * 缓存续绿就是那次假绿的机制本身。
 *
 * 探针命令选 `id`：输出含 `uid=2000` 才算通道真的能执行 shell（exit 0 不够 ——
 * dpm 那次就是 exit 0 但实际报错，见 [CapabilityCriteria.isDeviceOwner] 的同款教训）。
 */
object AdbChannelProbe {

    /** 探针命令与期望标记：判据层的常量，别处不许另写一份。 */
    private const val PROBE_CMD = "id"
    private const val PROBE_MARK = "uid=2000"
    private const val SHELL_TIMEOUT_MS = 8_000L

    /** 上次为 DEAD/NEVER_RUN 时的重试冷却：轮询是 2s 一次，不能每次都 spawn Node。 */
    private const val RETRY_COOLDOWN_MS = 5_000L

    @Volatile
    private var cached: ChannelProbe = ChannelProbe(ProbeOutcome.NEVER_RUN)

    /** 缓存读数（体检/离线渲染用，绝不触发 spawn）。 */
    fun cached(): ChannelProbe = cached

    /** 强制下一次 [probe] 真跑（配对成功、用户点「重测通道」时调用）。 */
    fun invalidate() {
        cached = ChannelProbe(ProbeOutcome.NEVER_RUN)
    }

    /**
     * 取通道读数：LIVE 且未过期、或 DEAD 且仍在冷却内 → 直接用缓存；否则真探一次。
     * 同步执行（调用方必须在 IO 线程），且整段加锁避免轮询与事件刷新并发 spawn。
     */
    @Synchronized
    fun probe(ctx: Context, nowMs: Long = System.currentTimeMillis()): ChannelProbe {
        val prev = cached
        val age = nowMs - prev.atMs
        val reusable = (prev.outcome == ProbeOutcome.LIVE && age >= 0 && age < Evidence.CHANNEL_TTL_MS) ||
            (prev.outcome == ProbeOutcome.DEAD && age >= 0 && age < RETRY_COOLDOWN_MS)
        if (reusable) return prev

        if (CapabilityCriteria.credentialsState(ctx) != CredentialsState.PAIRED) {
            // 无凭据时不写缓存：配好之后第一次探针必须立刻真跑。
            return ChannelProbe(ProbeOutcome.NEVER_RUN, nowMs, "凭据未在册")
        }
        val endpoint = ConnectEndpointResolver.resolve(ctx)
        if (endpoint == null || endpoint.host.isNullOrBlank() || (endpoint.port ?: 0) <= 0) {
            return ChannelProbe(ProbeOutcome.DEAD, nowMs, "现场无 mDNS connect 记录").also { cached = it }
        }
        val outcome = AdbClientRunner.shell(
            ctx, PROBE_CMD, endpoint.host, endpoint.port, SHELL_TIMEOUT_MS,
        )
        val stdout = outcome.json?.optString("out", "") ?: ""
        return when {
            outcome.ok && PROBE_MARK in stdout ->
                ChannelProbe(ProbeOutcome.LIVE, nowMs, "shell 在线 @${endpoint.host}:${endpoint.port}")
            outcome.ok ->
                ChannelProbe(ProbeOutcome.DEAD, nowMs, "已连通但拿不到 shell uid：" + stdout.take(80))
            else -> ChannelProbe(ProbeOutcome.DEAD, nowMs, outcome.error ?: "shell 失败 exit=${outcome.exitCode}")
        }.also { cached = it }
    }
}
