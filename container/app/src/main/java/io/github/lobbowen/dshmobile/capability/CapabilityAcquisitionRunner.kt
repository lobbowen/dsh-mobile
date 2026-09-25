package io.github.lobbowen.dshmobile.capability

import android.content.Context
import android.content.Intent
import android.os.Build
import io.github.lobbowen.dshmobile.bridge.AdbClientRunner
import io.github.lobbowen.dshmobile.lifecycle.ContainerSupervisor
import io.github.lobbowen.dshmobile.permissions.PermissionCatalog
import io.github.lobbowen.dshmobile.permissions.PermissionCenter
import io.github.lobbowen.dshmobile.runtime.NodeRuntimeService

/** 一次静默取法的结果。[verified] 单独成列：**下发成功不等于生效**（DO 的真机教训）。 */
data class AcquisitionResult(val ok: Boolean, val verified: Boolean, val detail: String)

/**
 * 静默取法的执行器（spec §2.1：判据层只声明 `SILENT_VIA_*` + 执行器 id，命令在这里拼）。
 *
 * 三条共同规矩：
 * 1. 一律经 [AdbClientRunner.shell] 现问端点下发（不缓存 host:port，见 ConnectEndpointResolver）；
 * 2. **命令 exit 0 不算结论**，必须系统侧回读（`isDeviceOwnerApp` / 再读一次 Secure 设置）；
 * 3. 结论写进 [AttemptStore]，供下一轮判据归因（例如多用户设备上的 DO → UNREACHABLE）。
 */
object CapabilityAcquisitionRunner {

    private const val DEFAULT_TIMEOUT_MS = 20_000L

    /** 平台级拒绝标记：DO 之外的场景不产生 UNREACHABLE。 */
    private const val MULTI_USER_MARK = "several users"

    @Synchronized
    fun run(ctx: Context, executor: String, timeoutMs: Long = DEFAULT_TIMEOUT_MS): AcquisitionResult =
        when (executor) {
            CapabilityCatalog.EXEC_DEVICE_OWNER -> setDeviceOwner(ctx, timeoutMs)
            CapabilityCatalog.EXEC_NOTIFICATION_LISTENER ->
                enableSecureService(ctx, SecureService.NOTIFICATION_LISTENER, timeoutMs)
            CapabilityCatalog.EXEC_ACCESSIBILITY ->
                enableSecureService(ctx, SecureService.ACCESSIBILITY, timeoutMs)
            CapabilityCatalog.EXEC_REPROBE -> reprobeChannel(ctx)
            CapabilityCatalog.EXEC_RETRY_RUNTIME -> restartRuntime(ctx)
            CapabilityCatalog.EXEC_RERUN_SELFCHECK -> rerunSelfCheck(ctx)
            else -> AcquisitionResult(false, false, "未知执行器：$executor")
        }

    /**
     * GUI 的唯一动作入口：返回 null 表示这条取法要由界面自己发（跳设置页 / 系统弹窗 /
     * 起配对向导），非 null 表示已在本层执行完毕。这样「谁执行什么」只有一处定义，
     * Activity 里不再出现按 stepId 硬编码的按钮语义（v1 的 buttonsFor）。
     */
    fun dispatch(ctx: Context, acq: Acquisition): AcquisitionResult? {
        val executor = acq.target
        return when (acq.kind) {
            AcquireKind.AUTO, AcquireKind.SILENT_VIA_ADB, AcquireKind.SILENT_VIA_DO ->
                if (executor == null) AcquisitionResult(false, false, "取法缺执行器") else run(ctx, executor)
            else -> null
        }
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

    private fun restartRuntime(ctx: Context): AcquisitionResult {
        ContainerSupervisor.ensureRunning(ctx)
        val svc = Intent(ctx, NodeRuntimeService::class.java).setAction(NodeRuntimeService.ACTION_RESTART)
        return runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(svc)
            else ctx.startService(svc)
            AcquisitionResult(true, false, "已请求重启运行时（在线与否由下一轮探针定）")
        }.getOrElse {
            AcquisitionResult(false, false, "重启请求失败：${it::class.java.simpleName}: ${it.message}")
        }
    }

    private fun rerunSelfCheck(ctx: Context): AcquisitionResult {
        CapabilityEvidenceCollector.forgetKernelChecks()
        val items = CapabilityEvidenceCollector.collect(ctx).kernelChecks
        val bad = items.filter { it.ok != true }.map { it.id }
        return AcquisitionResult(
            ok = bad.isEmpty(),
            verified = bad.isEmpty(),
            detail = if (bad.isEmpty()) "自检 ${items.size} 项通过" else "未通过/未知：" + bad.joinToString(),
        )
    }

    private fun setDeviceOwner(ctx: Context, timeoutMs: Long): AcquisitionResult {
        val names = CapabilityCriteria.names(ctx)
        val outcome = AdbClientRunner.shell(
            ctx, "dpm set-device-owner ${names.dpcComponent}", null, null, timeoutMs,
        )
        val now = System.currentTimeMillis()
        // 唯一真值 = 系统侧回读。dpm 抛 IllegalStateException 时 exit 仍是 0
        // （真机 2026-09-25 17:12:15），只看 outcome.ok 会假报成功。
        if (CapabilityCriteria.isDeviceOwner(ctx)) {
            AttemptStore.recordOwner(now, OwnerAttemptOutcome.GRANTED)
            return AcquisitionResult(true, true, "DO 已生效")
        }
        val output = commandText(outcome)
        val rejected = MULTI_USER_MARK in output
        AttemptStore.recordOwner(
            now,
            if (rejected) OwnerAttemptOutcome.REJECTED else OwnerAttemptOutcome.FAILED,
            output.ifBlank { outcome.error ?: "无输出" },
        )
        return AcquisitionResult(
            ok = outcome.ok,
            verified = false,
            detail = (if (rejected) "平台拒绝（多用户设备，DO 不可得）：" else "未生效：") +
                output.take(180),
        )
    }

    private enum class SecureService { ACCESSIBILITY, NOTIFICATION_LISTENER }

    private fun enableSecureService(
        ctx: Context,
        which: SecureService,
        timeoutMs: Long,
    ): AcquisitionResult {
        val center = PermissionCenter(ctx)
        val names = CapabilityCriteria.names(ctx)
        val ours: String
        val key: String
        val current: String
        when (which) {
            SecureService.ACCESSIBILITY -> {
                ours = names.accessibilityComponent
                key = PermissionCatalog.SECURE_KEY_ACCESSIBILITY
                current = center.accessibilityServicesValue()
            }
            SecureService.NOTIFICATION_LISTENER -> {
                ours = names.notificationListenerComponent
                key = PermissionCatalog.SECURE_KEY_NOTIFICATION_LISTENER
                current = center.notificationListenersValue()
            }
        }
        if (ours.isBlank()) return AcquisitionResult(false, false, "组件名未解析，不能下发")
        val merged = (current.split(":").filter { it.isNotBlank() && it != ours } + ours).joinToString(":")
        val outcome = AdbClientRunner.shell(ctx, "settings put secure $key $merged", null, null, timeoutMs)
        val readBack = when (which) {
            SecureService.ACCESSIBILITY -> center.accessibilityEnabledInSettings()
            SecureService.NOTIFICATION_LISTENER -> center.notificationListenerEnabled()
        }
        return when {
            // 系统勾选已回读成功，但服务实例绑定是异步的 —— 下一轮采集自然变绿，这里不冒充绿。
            readBack -> AcquisitionResult(true, false, "系统已记录勾选，等待服务绑定")
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
}
