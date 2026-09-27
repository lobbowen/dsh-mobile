package io.github.lobbowen.dshmobile.capability

import android.content.Context
import io.github.lobbowen.dshmobile.bridge.AdbClientRunner

/**
 * ADB 通道的**活探针**：优先读常驻通道状态，按期在常驻通道上重跑 id 验 uid=2000。
 *
 * 为什么必须有它（v1 没有）：凭据在册只说明「以前配成功过」，而 adbd 的 connect 端口在
 * 无线调试重启 / Wi-Fi 重连后持续轮换（真机 2026-09-25：17:08 记下 35633，17:36 已
 * ECONNREFUSED，现场发布的是 44019）。所以 S0 的绿必须由这里产生，且**过期即失效** ——
 * 缓存续绿就是那次假绿的机制本身。
 *
 * ── 为什么不再"每次验活都新建连接"（2026-09-27 根治"无限连接断开"）──────────────
 * 旧 probe() 每次都 解析 mDNS + 让 Kotlin 新起 node + 新建 TCP/TLS，adbd 侧于是每次
 * 都重走 TlsConnection 初始化/超时清理。现在：
 *   · 两次重验之间只调 [AdbClientRunner.channel] 读常驻连接状态（零 dial、零 spawn）；
 *   · 到重验点才在**同一条常驻会话**上跑 PROBE_CMD，复用连接而不是新建；
 *   · 连接一断，下一次通道读数就翻 DEAD，不必等重验间隔。
 * PROBE_CMD 选 id：输出含 uid=2000 才算通道真的能执行 shell（exit 0 不够 —— dpm 那次
 * 就是 exit 0 但实际报错，见 [CapabilityCriteria.isDeviceOwner] 的同款教训）。
 */
object AdbChannelProbe {

    /** 探针命令与期望标记：判据层的常量，别处不许另写一份。 */
    private const val PROBE_CMD = "id"
    private const val PROBE_MARK = "uid=2000"
    private const val SHELL_TIMEOUT_MS = 8_000L
    private const val CHANNEL_TIMEOUT_MS = 2_000L

    /** 上次为 DEAD/NEVER_RUN 时的重试冷却；轮询是 2s 一次，不能每次都发帧/起进程。 */
    private const val RETRY_COOLDOWN_MS = 5_000L

    /**
     * LIVE 时的**重验**间隔（约 60s）。注意它是"多久愿意真跑一次 id"，不是读数可信期：
     * [Evidence.CHANNEL_TTL_MS] 仍是 30s 的"不新鲜即红"，不许放宽。中间那段由
     * 常驻连接状态续读（连接在 = 读数刷到 now），所以不会出现红-绿每分钟翻转。
     */
    private const val REPROBE_MS = 60_000L

    @Volatile
    private var cached: ChannelProbe = ChannelProbe(ProbeOutcome.NEVER_RUN)

    /** 上次真跑 PROBE_CMD 并拿到 uid=2000 的时刻；与 atMs 分开，避免续读把重验间隔吃掉。 */
    @Volatile
    private var lastVerifyMs = 0L

    /** 缓存读数（体检/离线渲染用，绝不触发 spawn）。 */
    fun cached(): ChannelProbe = cached

    /** 强制下一次 [probe] 真跑（配对成功、用户点「重测通道」时调用）。 */
    fun invalidate() {
        cached = ChannelProbe(ProbeOutcome.NEVER_RUN)
        lastVerifyMs = 0L
    }

    /**
     * 取通道读数：LIVE 且距上次验活未到重验间隔、或 DEAD 且仍在冷却内 → 直接用缓存；
     * 否则真探一次。同步执行（调用方必须在 IO 线程），且整段加锁避免轮询与事件刷新并发。
     */
    @Synchronized
    fun probe(ctx: Context, nowMs: Long = System.currentTimeMillis()): ChannelProbe {
        val prev = cached
        val age = nowMs - prev.atMs
        if (prev.outcome == ProbeOutcome.DEAD && age >= 0 && age < RETRY_COOLDOWN_MS) return prev

        if (CapabilityCriteria.credentialsState(ctx) != CredentialsState.PAIRED) {
            // 无凭据时不写缓存：配好之后第一次探针必须立刻真跑。
            return ChannelProbe(ProbeOutcome.NEVER_RUN, nowMs, "凭据未在册")
        }

        // 只读常驻通道状态：不新建 TCP/TLS、不新起 node。
        val channel = AdbClientRunner.channel(ctx, CHANNEL_TIMEOUT_MS)
        val ready = channel.json?.optBoolean("ready", false) == true
        val verifyAge = nowMs - lastVerifyMs

        if (prev.outcome == ProbeOutcome.LIVE && lastVerifyMs > 0 &&
            verifyAge >= 0 && verifyAge < REPROBE_MS) {
            // 距上次验活不到重验间隔：连接还在就续读并把 atMs 刷到 now。
            val refreshed = if (ready) {
                val h = channel.json?.optString("host", "") ?: ""
                val p = channel.json?.optInt("port", 0) ?: 0
                ChannelProbe(ProbeOutcome.LIVE, nowMs,
                    if (h.isNotBlank() && p > 0) "常驻通道在线 @" + h + ":" + p else "常驻通道在线")
            } else {
                // 常驻连接已断开：立刻翻 DEAD，不必等重验点 —— 这就是"连接 close 即失效"。
                ChannelProbe(ProbeOutcome.DEAD, nowMs, "常驻通道已断开")
            }
            cached = refreshed
            return refreshed
        }

        // 到重验点 / 首次探 / 曾 DEAD 冷却已过：在常驻通道上跑轻量 id（复用连接，不新起 node）。
        val outcome = AdbClientRunner.shell(ctx, PROBE_CMD, null, null, SHELL_TIMEOUT_MS)
        val stdout = outcome.json?.optString("out", "") ?: ""
        return when {
            outcome.ok && PROBE_MARK in stdout -> {
                lastVerifyMs = nowMs
                ChannelProbe(ProbeOutcome.LIVE, nowMs, "shell 在线（" + PROBE_MARK + " 已验）")
            }
            outcome.ok ->
                ChannelProbe(ProbeOutcome.DEAD, nowMs, "已连通但拿不到 shell uid：" + stdout.take(80))
            else ->
                ChannelProbe(ProbeOutcome.DEAD, nowMs, outcome.error ?: ("shell 失败 exit=" + outcome.exitCode))
        }.also { cached = it }
    }
}
