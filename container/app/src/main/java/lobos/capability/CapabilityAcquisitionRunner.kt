package lobos.capability

import android.content.Context
import lobos.RuntimeDiagnostics
import lobos.bridge.AdbClientRunner
import lobos.lifecycle.AccessibilityAnchor
import lobos.permissions.PermissionCatalog
import lobos.permissions.PermissionCenter

/** 一次静默取法的结果。[verified] 单独成列：**下发成功不等于生效**（真机教训）。 */
data class AcquisitionResult(val ok: Boolean, val verified: Boolean, val detail: String)

/** 自动流一行：[attempted]=是否真的下发过；[ok]=系统侧回读是否确认生效。 */
data class AutoFlowStep(val capId: String, val attempted: Boolean, val ok: Boolean, val detail: String)

/**
 * 静默取法的执行器（spec §2.1：判据层只声明 `SILENT_VIA_*` + 执行器 id，命令在这里拼）。
 *
 * 四条共同规矩：
 * 1. 一律经 [AdbClientRunner.shell] 现问端点下发（不缓存 host:port，见 ConnectEndpointResolver）；
 * 2. **命令 exit 0 不算结论**，必须系统侧回读（再读一次系统设置）；
 * 3. 跑到了 shell 的每一项都把结局记进 [PermissionLedger]（经 [AttemptOutcomeRule]），
 *    「这项归 adb 还是归人」从此只由实测决定；
 * 4. 结论同时写 [RuntimeDiagnostics]，与常驻通知/诊断页同源，不另造状态出口。
 */
object CapabilityAcquisitionRunner {

    private const val DEFAULT_TIMEOUT_MS = 20_000L

    /** 自动流单项的重试上限与退避：失败不阻塞后续，但不许无限刷 AMS。 */
    private const val AUTO_FLOW_MAX_ATTEMPTS = 2
    private const val AUTO_FLOW_BACKOFF_MS = 1_500L

    @Synchronized
    fun run(
        ctx: Context,
        executor: String,
        capId: String? = null,
        timeoutMs: Long = DEFAULT_TIMEOUT_MS,
    ): AcquisitionResult = when (executor) {
        CapabilityCatalog.EXEC_NOTIFICATION_LISTENER -> enableNotificationListener(ctx, timeoutMs)
        CapabilityCatalog.EXEC_ACCESSIBILITY -> healAccessibilityAnchor(ctx, timeoutMs)
        CapabilityCatalog.EXEC_BATTERY_WHITELIST -> whitelistBattery(ctx, timeoutMs)
        CapabilityCatalog.EXEC_APPOPS_ALLOW -> setAppOps(ctx, capId, timeoutMs)
        CapabilityCatalog.EXEC_PM_GRANT -> grantRuntimePerm(ctx, capId, timeoutMs)
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
    fun dispatch(ctx: Context, capId: String, acq: Acquisition): AcquisitionResult? {
        val executor = acq.target
        return when (acq.kind) {
            AcquireKind.AUTO, AcquireKind.SILENT_VIA_ADB ->
                if (executor == null) AcquisitionResult(false, false, "取法缺执行器")
                else run(ctx, executor, capId)
            else -> null
        }
    }

    /**
     * 配对后自动流的**唯一执行入口**：[ids] 按顺序串行跑（**不并发** —— 多条 settings put
     * 并发会互相覆盖服务名单），单项失败不阻塞后续，单项内退避重试有上限。
     *
     * 三条取舍：
     *  - 先读判据：已 GRANTED 的项直接跳过 —— ROM 回收掉的项判据不是 GRANTED，会重新进这一轮；
     *  - 只接受取法链首项是 SILENT_* 的项：实测账上已经记着「adb 这条路走不通」的项不在链首，
     *    于是它们交回冲刺弹人，而不是每开一次屏就把同一条命令重放一遍；
     *  - 每项结局落 [PermissionLedger]，下一轮的取法链与冲刺差集都从它推导。
     */
    @Synchronized
    fun runAutoFlow(ctx: Context, ids: List<String>, timeoutMs: Long = DEFAULT_TIMEOUT_MS): List<AutoFlowStep> {
        val out = mutableListOf<AutoFlowStep>()
        for (id in ids) {
            val verdict = CapabilityCatalog.evaluate(CapabilityEvidenceCollector.systemReads(ctx))[id]
            if (verdict?.status == CapStatus.GRANTED) {
                out += AutoFlowStep(id, false, true, "判据=GRANTED，跳过（不重试）")
                continue
            }
            val acq = CapabilityCatalog.byId(id)
                ?.acquirer(CapabilityEvidenceCollector.systemReads(ctx))
                ?.firstOrNull()
            val target = acq?.target
            if (acq == null || target == null || acq.kind != AcquireKind.SILENT_VIA_ADB) {
                out += AutoFlowStep(id, false, false, "取法链首项不是静默取法，交回冲刺弹人（不挡入口）")
                continue
            }

            var result: AcquisitionResult? = null
            var attempt = 0
            while (attempt < AUTO_FLOW_MAX_ATTEMPTS) {
                attempt++
                result = run(ctx, target, id, timeoutMs)
                if (result.verified || result.ok) break
                if (attempt < AUTO_FLOW_MAX_ATTEMPTS) sleepQuietly(AUTO_FLOW_BACKOFF_MS * attempt)
            }
            val r = result ?: AcquisitionResult(false, false, "未执行")
            val outcome = AttemptOutcomeRule.of(r.ok, r.verified, r.detail)
            if (outcome != null) PermissionLedger.record(ctx, id, outcome, r.detail)
            out += AutoFlowStep(id, true, r.verified, acq.label + "（第 " + attempt + " 次）：" + r.detail)
            RuntimeDiagnostics.append(
                ctx, "autoflow",
                if (r.verified) true else if (r.ok) null else false,
                id + (if (r.verified) " 已生效" else " 未生效"),
                r.detail + (outcome?.let { "｜记账 " + it.name } ?: "｜未记账（本次没有下发成功）"),
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

    /** 「我已完成」：把厂商四项开关的回执落盘（系统无公开读接口，这是唯一诚实判据）。 */
    private fun confirmOemGuards(ctx: Context): AcquisitionResult {
        OemGuards.confirm(ctx)
        return AcquisitionResult(true, true, "已记录四项厂商开关回执（下一轮判据生效）")
    }

    /**
     * 无障碍锚：**不自建实现**，只调 [AccessibilityAnchor.ensureBound]（契约冻结）。
     * 三级自愈（名单合并 / 总开关置 1 / 先摘后写逼重绑）全在锚对象里，本层只做结果翻译。
     */
    private fun healAccessibilityAnchor(ctx: Context, timeoutMs: Long): AcquisitionResult {
        val outcome = AccessibilityAnchor.ensureBound(ctx, timeoutMs)
        // 「名单在、绑定无」是这一项唯一会骗人的形态（真机实证：总开关为 0 时就是这个形状）。
        // 不点破，下一轮还照同一条命令重放；点破了，人才知道该去系统页拨一次总开关。
        val listedNotBound = !outcome.healed && PermissionCenter(ctx).accessibilityEnabledInSettings()
        return AcquisitionResult(
            ok = outcome.issued,
            verified = outcome.healed,
            detail = "锚 " + outcome.state + "：" + outcome.detail +
                (if (listedNotBound) "（名单已登记，系统未绑定服务实例）" else ""),
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
            // 这里的 verified 回答的是**这条命令的目标**（勾选已登记），不是「能力可用」：
            // 绑定由系统异步完成，绿灯要等实例连上（判据 = notificationListenerBound）。
            // 两者的差别必须在文案里说清，否则「adb 已开」会被读成「notif.read 能用了」。
            readBack -> AcquisitionResult(true, true, "系统已记录勾选" +
                (if (center.notificationListenerBound()) "，服务已绑定" else "，等待系统绑定服务"))
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

    /**
     * AppOps 试开：命令与操作名都取自判据表（[PermissionSpec.appOpsOp]），本层不认项、不猜名字。
     *
     * 这一条存在的意义是**把「试」变成事实**：过去 AppOps 三项从没被 adb 下发过，就先按档位
     * 钉成了「只能人点」。成不成由系统回读说话（[PermissionCenter.isGranted]），
     * 结局由 [AttemptOutcomeRule] 记账；本机大概率回一行拒绝，那也正是账本要留的证据。
     */
    private fun setAppOps(ctx: Context, capId: String?, timeoutMs: Long): AcquisitionResult {
        val spec = capId?.let { PermissionCatalog.byId(it) }
            ?: return AcquisitionResult(false, false, "取法缺能力 id 或 id 不在判据表：" + (capId ?: "无"))
        val op = spec.appOpsOp
        if (op.isNullOrBlank()) {
            return AcquisitionResult(false, false, "判据表未登记 AppOps 操作名：" + spec.id)
        }
        val outcome = AdbClientRunner.shell(
            ctx, "appops set " + ctx.packageName + " " + op + " allow", null, null, timeoutMs,
        )
        val readBack = PermissionCenter(ctx).isGranted(spec)
        return when {
            readBack -> AcquisitionResult(true, true, op + " 已置为 allow")
            !outcome.ok -> AcquisitionResult(false, false, "下发失败：" +
                (outcome.error ?: commandText(outcome).take(160)))
            else -> AcquisitionResult(true, false, "命令已下发，回读未见生效：" + commandText(outcome).take(160))
        }
    }

    /**
     * 运行时权限试授：权限名取自判据表（[PermissionSpec.permission]），本层不认项、不猜名字。
     * 回读与判据同一把尺子（[PermissionCenter.isGranted] = `checkSelfPermission`），
     * 命令 exit 0 不算数 —— 被拒的那一行由 [AttemptOutcomeRule] 原样留账。
     */
    private fun grantRuntimePerm(ctx: Context, capId: String?, timeoutMs: Long): AcquisitionResult {
        val spec = capId?.let { PermissionCatalog.byId(it) }
            ?: return AcquisitionResult(false, false, "取法缺能力 id 或 id 不在判据表：" + (capId ?: "无"))
        val permName = spec.permission
        if (permName.isNullOrBlank()) {
            return AcquisitionResult(false, false, "判据表未登记 Android 权限名：" + spec.id)
        }
        val outcome = AdbClientRunner.shell(
            ctx, "pm grant " + ctx.packageName + " " + permName, null, null, timeoutMs,
        )
        val readBack = PermissionCenter(ctx).isGranted(spec)
        return when {
            readBack -> AcquisitionResult(true, true, permName + " 已授予")
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
