package lobos.capability

import android.content.Context
import lobos.RuntimeDiagnostics
import lobos.bridge.AdbClientRunner
import lobos.lifecycle.AccessibilityAnchor
import lobos.permissions.PermissionCatalog
import lobos.permissions.PermissionCenter

/** 一次静默取法的结果。[verified] 单独成列：**下发成功不等于生效**（DO 的真机教训）。 */
data class AcquisitionResult(val ok: Boolean, val verified: Boolean, val detail: String)

/** 自动流一行：[attempted]=是否真的下发过；[ok]=系统侧回读是否确认生效。 */
data class AutoFlowStep(val capId: String, val attempted: Boolean, val ok: Boolean, val detail: String)

/**
 * 静默取法的执行器（spec §2.1：判据层只声明 `SILENT_VIA_*` + 执行器 id，命令在这里拼）。
 *
 * 三条共同规矩：
 * 1. 一律经 [AdbClientRunner.shell] 现问端点下发（不缓存 host:port，见 ConnectEndpointResolver）；
 * 2. **命令 exit 0 不算结论**，必须系统侧回读（再读一次系统设置）；
 * 3. 结论写进 [AttemptStore]，供下一轮判据归因（例如多用户设备上的 DO → UNREACHABLE）。
 */
object CapabilityAcquisitionRunner {

    private const val DEFAULT_TIMEOUT_MS = 20_000L

    /** 自动流单项的重试上限与退避：失败不阻塞后续，但不许无限刷 AMS。 */
    private const val AUTO_FLOW_MAX_ATTEMPTS = 2
    private const val AUTO_FLOW_BACKOFF_MS = 1_500L

    @Synchronized
    fun run(ctx: Context, executor: String, timeoutMs: Long = DEFAULT_TIMEOUT_MS): AcquisitionResult =
        when (executor) {
            CapabilityCatalog.EXEC_NOTIFICATION_LISTENER -> enableNotificationListener(ctx, timeoutMs)
            CapabilityCatalog.EXEC_ACCESSIBILITY -> healAccessibilityAnchor(ctx, timeoutMs)
            CapabilityCatalog.EXEC_BATTERY_WHITELIST -> whitelistBattery(ctx, timeoutMs)
            CapabilityCatalog.EXEC_REPROBE -> reprobeChannel(ctx)
            CapabilityCatalog.EXEC_RERUN_SELFCHECK -> rerunSelfCheck(ctx)
            CapabilityCatalog.EXEC_OEM_CONFIRM -> confirmOemGuards(ctx)
            else -> AcquisitionResult(false, false, "未知执行器：" + executor)
        }

    /**
     * GUI 的唯一动作入口：返回 null 表示这条取法要由界面自己发（跳设置页 / 系统弹窗 /
     * 起配对向导），非 null 表示已在本层执行完毕。这样「谁执行什么」只有一处定义，
     * Activity 里不再出现按 stepId 硬编码的按钮语义（v1 的 buttonsFor）。
     */
    fun dispatch(ctx: Context, acq: Acquisition): AcquisitionResult? {
        val executor = acq.target
        return when (acq.kind) {
            AcquireKind.AUTO, AcquireKind.SILENT_VIA_ADB ->
                if (executor == null) AcquisitionResult(false, false, "取法缺执行器") else run(ctx, executor)
            else -> null
        }
    }

    /**
     * 配对后自动流的**唯一执行入口**：[ids] 按顺序串行跑（**不并发** —— 多条 settings put
     * 并发会互相覆盖服务名单），单项失败不阻塞后续，单项内退避重试有上限。
     *
     * 三条取舍：
     *  - 先读判据：已 GRANTED 或已 UNREACHABLE 的项直接跳过（**不重试**）—— 多用户设备的 DO
     *    拒绝是平台事实，重试只会制造噪声；
     *  - 只接受取法链首项是 SILENT_* 的项：其余交回欠账（不挡入口，也不在开屏问）；
     *  - 每项结论写 [RuntimeDiagnostics]，与常驻通知/诊断页同源，不另造状态出口。
     */
    @Synchronized
    /** 「我已完成」：把厂商四项开关的回执落盘（系统无公开读接口，这是唯一诚实判据）。 */
    private fun confirmOemGuards(ctx: Context): AcquisitionResult {
        OemGuards.confirm(ctx)
        return AcquisitionResult(true, true, "已记录四项厂商开关回执（下一轮判据生效）")
    }

    fun runAutoFlow(
        ctx: Context,
        ids: List<String>,
        timeoutMs: Long = DEFAULT_TIMEOUT_MS,
    ): List<AutoFlowStep> {
        val out = mutableListOf<AutoFlowStep>()
        for (id in ids) {
            val verdict = CapabilityCatalog.evaluate(CapabilityEvidenceCollector.systemReads(ctx))[id]
            if (verdict?.status == CapStatus.GRANTED) {
                out += AutoFlowStep(id, false, true, "判据=GRANTED，跳过（不重试）")
                continue
            }
            if (verdict?.status == CapStatus.UNREACHABLE) {
                out += AutoFlowStep(id, false, false, "判据=UNREACHABLE，跳过（平台不可得，不重试）")
                continue
            }
            val acq = CapabilityCatalog.byId(id)
                ?.acquirer(CapabilityEvidenceCollector.systemReads(ctx))
                ?.firstOrNull()
            val target = acq?.target
            if (acq == null || target == null ||
                acq.kind != AcquireKind.SILENT_VIA_ADB
            ) {
                out += AutoFlowStep(id, false, false, "取法链首项不是静默取法，交回欠账（不挡入口）")
                continue
            }

            var result: AcquisitionResult? = null
            var attempt = 0
            while (attempt < AUTO_FLOW_MAX_ATTEMPTS) {
                attempt++
                result = run(ctx, target, timeoutMs)
                if (result.verified || result.ok) break
                // 平台级拒绝（如多用户设备的 DO）重试没有意义：判据只会再给同一个 UNREACHABLE。
                if (CapabilityCatalog.evaluate(
                        CapabilityEvidenceCollector.systemReads(ctx)
                    )[id]?.status == CapStatus.UNREACHABLE
                ) {
                    break
                }
                if (attempt < AUTO_FLOW_MAX_ATTEMPTS) sleepQuietly(AUTO_FLOW_BACKOFF_MS * attempt)
            }
            val r = result ?: AcquisitionResult(false, false, "未执行")
            out += AutoFlowStep(id, true, r.verified, acq.label + "（第 " + attempt + " 次）：" + r.detail)
            RuntimeDiagnostics.append(
                ctx, "autoflow",
                if (r.verified) true else if (r.ok) null else false,
                id + (if (r.verified) " 已生效" else " 未生效"),
                r.detail,
            )
        }
        return out
    }

    private fun reprobeChannel(ctx: Context): AcquisitionResult {
        AdbChannelProbe.invalidate()
        val p = AdbChannelProbe.probe(ctx)
        return AcquisitionResult(
            ok = p.outcome == ProbeOutcome.LIVE,
            verified = p.outcome == ProbeOutcome.LIVE,
            detail = p.detail.ifBlank { p.outcome.name },
        )
    }

    private fun rerunSelfCheck(ctx: Context): AcquisitionResult {
        CapabilityEvidenceCollector.forgetKernelChecks()
        val items = CapabilityEvidenceCollector.collect(ctx).programChecks
        val bad = items.filter { it.ok != true }.map { it.id }
        return AcquisitionResult(
            ok = bad.isEmpty(),
            verified = bad.isEmpty(),
            detail = if (bad.isEmpty()) "自检 " + items.size + " 项通过" else "未通过/未知：" + bad.joinToString(),
        )
    }

    /**
     * 无障碍锚：**不自建实现**，只调 [AccessibilityAnchor.ensureBound]（契约冻结）。
     * 三级自愈（名单合并 / 总开关置 1 / 先摘后写逼重绑）全在锚对象里，本层只做结果翻译。
     */
    private fun healAccessibilityAnchor(ctx: Context, timeoutMs: Long): AcquisitionResult {
        val outcome = AccessibilityAnchor.ensureBound(ctx, timeoutMs)
        return AcquisitionResult(
            ok = outcome.healed,
            verified = outcome.healed,
            detail = "锚 " + outcome.state + "：" + outcome.detail,
        )
    }

    private fun enableNotificationListener(ctx: Context, timeoutMs: Long): AcquisitionResult {
        val center = PermissionCenter(ctx)
        val names = CapabilityCriteria.names(ctx)
        val ours = names.notificationListenerComponent
        if (ours.isBlank()) return AcquisitionResult(false, false, "组件名未解析，不能下发")
        val current = center.notificationListenersValue()
        val merged = (current.split(":").filter { it.isNotBlank() && it != ours } + ours).joinToString(":")
        val outcome = AdbClientRunner.shell(
            ctx,
            "settings put secure " + PermissionCatalog.SECURE_KEY_NOTIFICATION_LISTENER + " " + merged,
            null, null, timeoutMs,
        )
        val readBack = center.notificationListenerEnabled()
        return when {
            // 系统勾选已回读成功，但服务实例绑定是异步的 —— 下一轮采集自然变绿，这里不冒充绿。
            readBack -> AcquisitionResult(true, false, "系统已记录勾选，等待服务绑定")
            !outcome.ok -> AcquisitionResult(false, false, "下发失败：" +
                (outcome.error ?: commandText(outcome).take(160)))
            else -> AcquisitionResult(true, false, "命令已下发，回读未见生效：" + commandText(outcome).take(160))
        }
    }

    /**
     * 电池白名单：真机实证 uid=2000 可用 `dumpsys deviceidle whitelist +<pkg>`。
     * 真值仍以系统侧回读为准（[PermissionCenter.batteryExempt]），命令 exit 0 不算数。
     */
    private fun whitelistBattery(ctx: Context, timeoutMs: Long): AcquisitionResult {
        val outcome = AdbClientRunner.shell(
            ctx, "dumpsys deviceidle whitelist +" + ctx.packageName, null, null, timeoutMs,
        )
        val readBack = PermissionCenter(ctx).batteryExempt()
        return when {
            readBack -> AcquisitionResult(true, true, "已加入 Doze 白名单")
            !outcome.ok -> AcquisitionResult(false, false, "下发失败：" +
                (outcome.error ?: commandText(outcome).take(160)))
            else -> AcquisitionResult(true, false, "命令已下发，回读未见生效：" + commandText(outcome).take(160))
        }
    }

    private fun commandText(outcome: AdbClientRunner.AdbOutcome): String {
        val out = outcome.json?.optString("out", "").orEmpty()
        val logs = outcome.json?.optString("logs", "").orEmpty()
        return (out + "\n" + logs + "\n" + outcome.raw).lineSequence()
            .firstOrNull { "Exception" in it || "error" in it.lowercase() }
            ?: (outcome.error ?: out.trim().ifBlank { "无输出" })
    }

    private fun sleepQuietly(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }
}
