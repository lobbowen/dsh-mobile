package io.github.lobbowen.dshmobile

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import io.github.lobbowen.dshmobile.bridge.ScreenCaptureService
import io.github.lobbowen.dshmobile.kernelota.KernelManager
import io.github.lobbowen.dshmobile.lifecycle.DeviceAdminReceiver
import io.github.lobbowen.dshmobile.lifecycle.DshAccessibilityService
import io.github.lobbowen.dshmobile.permissions.LifecycleChecks
import io.github.lobbowen.dshmobile.permissions.PermissionCatalog
import io.github.lobbowen.dshmobile.permissions.PermissionCenter
import java.io.File

/**
 * 预置自检探针（docs/runbook/provisioning.md §4）—— 「这台设备现在到底能干什么」的**唯一事实来源**。
 *
 * 为什么需要它：控制面能力（Device Owner / 无障碍 / ADB 无线调试 / MediaProjection / 特殊权限）
 * 是**焊死在设备 + APK 里**的，无法经内核包热更新获得。设备换机、恢复出厂、`dpm remove-active-admin`
 * 之后，能力会**静默消失**——内核侧只会看到桥握手少了几组，却不知道是「没预置」还是「预置坏了」。
 * 探针把这件事变成开机可见的体检报告，落 files/diagnostics.txt，由 MainActivity 轮询渲染。
 *
 * 复用 [RuntimeDiagnostics]（文件型跨进程），因此探针可在 :node 进程跑、UI 进程读。
 */
object ProvisioningProbe {

    /** 检查项 id —— 与 docs/runbook/provisioning.md §4 逐条对齐。 */
    const val DEVICE_OWNER = "device-owner"
    const val ACCESSIBILITY = "accessibility"
    const val ADB_SHELL = "adb-shell"
    const val MEDIAPROJECTION = "mediaprojection"
    const val SPECIAL_PERMS = "special-perms"
    const val LIFECYCLE = "lifecycle"

    /** 与 [ScreenCaptureService.GRANT_FILE] 保持一致（探针提示文案里引用）。 */
    private const val GRANT_FILE = ScreenCaptureService.GRANT_FILE

    /**
     * 跑全量体检并把结果写入诊断日志。
     * @return 通过项数 / 总项数
     */
    fun run(ctx: Context): Pair<Int, Int> {
        val results = listOf(
            checkDeviceOwner(ctx),
            checkAccessibility(ctx),
            checkAdbShell(ctx),
            checkMediaProjection(ctx),
            checkSpecialPerms(ctx),
            checkLifecycle(ctx)
        )
        for (r in results) {
            RuntimeDiagnostics.append(
                ctx,
                "probe:${r.id}",
                r.ok,
                "${r.label} —— ${r.status}",
                r.hint
            )
        }
        val passed = results.count { it.ok }
        RuntimeDiagnostics.append(
            ctx,
            "probe",
            passed == results.size,
            "预置体检：$passed/${results.size} 项通过",
            if (passed == results.size) "全部控制面能力就绪"
            else "缺失项对应的 bridge 方法组会返回 -32001（这是预期降级，不是崩溃）"
        )
        // 附一份机器可读快照，便于内核对账 / 脚本解析。
        writeSnapshot(ctx, results)
        return passed to results.size
    }

    // ---- 各项检查 ----

    private fun checkDeviceOwner(ctx: Context): ProbeResult {
        val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
            ?: return ProbeResult(DEVICE_OWNER, "Device Owner (DPC)", false, "DevicePolicyManager 不可用", "")

        val owner = try { dpm.isDeviceOwnerApp(ctx.packageName) } catch (_: Throwable) { false }
        if (!owner) {
            return ProbeResult(
                DEVICE_OWNER, "Device Owner (DPC)", false, "未激活",
                "预置命令：adb shell dpm set-device-owner " +
                    "${ctx.packageName}/${DeviceAdminReceiver::class.java.name}\n" +
                    "⚠ 需设备未添加任何账号且未设置锁屏密码；激活后影响 bridge:device_policy 整组及 app.install/uninstall"
            )
        }

        // 进一步摸清真正可用的策略面：device_admin.xml 声明的 uses-policies 与实际授予是否一致。
        val active = try {
            dpm.getActiveAdmins()?.count { it.packageName == ctx.packageName } ?: 0
        } catch (_: Throwable) { 0 }
        return ProbeResult(
            DEVICE_OWNER, "Device Owner (DPC)", true, "已激活",
            "活动管理员数=$active；device_admin.xml 已声明 11 条 uses-policies"
        )
    }

    private fun checkAccessibility(ctx: Context): ProbeResult {
        // 三层判定：① 系统设置里是否勾选（配置层）② 服务实例是否真连上（运行层）③ 能力令牌
        val inSettings = try {
            val csv = Settings.Secure.getString(
                ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: ""
            csv.split(":").any { it.contains("DshAccessibilityService") }
        } catch (_: Throwable) { false }

        val bound = DshAccessibilityService.isReady()

        return when {
            bound -> ProbeResult(
                ACCESSIBILITY, "AccessibilityService", true, "已连接（ui_automation 可用）",
                "手势(dispatchGesture) / 节点树(getWindows+rootInActiveWindow) / 文本(ACTION_SET_TEXT) 全部就绪"
            )
            inSettings -> ProbeResult(
                ACCESSIBILITY, "AccessibilityService", false, "设置已勾选但服务未连接",
                "系统可能刚回收过服务（常见于低内存/省电模式）。打开本 App 或重启设备会重新绑定；" +
                    "若持续如此，检查 accessibility_service_config.xml 是否被 ROM 拒绝"
            )
            else -> ProbeResult(
                ACCESSIBILITY, "AccessibilityService", false, "未启用",
                "提前台：设置 → 无障碍 → 已下载的服务 → DSH 容器 → 开启\n" +
                    "或 adb shell settings put secure enabled_accessibility_services " +
                    "${ctx.packageName}/${DshAccessibilityService::class.java.name}\n" +
                    "开启后 bridge:ui_automation 整组解锁（Agent 操作手机的核心通道）"
            )
        }
    }

    /**
     * ADB 无线调试通道探测：未配密钥 / 已配密钥未配对 / 已配对可用。
     *
     * 为什么必须细分：这三种状态对调用方的**处置方式完全不同**——
     * · 未配密钥 → 什么都不用做，首次 pair 自动生成（这不是故障）；
     * · 未配对 → 需用户在设备无线调试弹窗输入配对码，走 shell.pair；
     * · 已配对 → adb_shell 能力置位，shell.exec 可用（host/端口存在 state.json 里）。
     * 只报「不可用」会让内核既不知道该不该重试，也不知道该提示用户做什么。
     *
     * 判定刻意用**文件存在性**而非 spawn `cli.js status`：探针在每次开机跑，
     * 多 spawn 一次 Node 不值当；且门禁的判据本来就是这个文件
     * （见 HostBridgeService.deviceCapabilities），两边必须同一把尺子。
     */
    private fun checkAdbShell(ctx: Context): ProbeResult {
        val hasKey = File(ctx.filesDir, "adb/adbkey.pem").exists()
        val paired = File(ctx.filesDir, "adb/state.json").exists()
        val status = when {
            paired -> "已配对（adb_shell 能力已置位，shell.exec 可用）"
            hasKey -> "已有 ADB 身份密钥，但未配对"
            else -> "尚无 ADB 身份密钥（首次配对时自动生成，无需预置）"
        }
        return ProbeResult(
            ADB_SHELL, "ADB 无线调试（shell 通道）", paired, status,
            if (paired) "端点与凭据在 files/adb/；设备重启后连接端口会变，需重新配对。"
            else "设备开启 开发者选项 → 无线调试，在面板输入配对弹窗给的 6 位码（bridge shell.pair）。\n" +
                "配对成功后 bridge:shell 整组解锁（shell.exec 以 shell uid(2000) 执行）"
        )
    }

    private fun checkMediaProjection(ctx: Context): ProbeResult {
        // MediaProjection 的授权是**运行时、每次会话**的（弹窗授权 + 前台服务类型），
        // 无法像 DO 那样一次性预置。此处只校验「平台版本 + 前台服务类型声明」这两个硬前提。
        val apiOk = Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP
        val fgsDeclared = try {
            // Android 14+ 截屏必须声明 FOREGROUND_SERVICE_MEDIA_PROJECTION
            val pi = ctx.packageManager.getPackageInfo(
                ctx.packageName,
                PackageManager.GET_PERMISSIONS
            )
            pi.requestedPermissions?.contains("android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION") == true
        } catch (_: Throwable) { false }

        // P5 已落地：ScreenCaptureService 真实存在，判定维度从「声明」升级为「授权是否已生效」。
        val granted = ScreenCaptureService.isReady()
        val hasCachedGrant = ScreenCaptureService.loadGrant(ctx) != null

        val status = when {
            !apiOk -> "平台不支持（需 API 21+）"
            granted -> "已授权，截屏可用"
            hasCachedGrant -> "有缓存授权，服务未启动（点「授权屏幕捕获」或重启 App）"
            fgsDeclared -> "未授权（点诊断面板的「授权屏幕捕获」按钮）"
            else -> "⚠ 未声明 FOREGROUND_SERVICE_MEDIA_PROJECTION"
        }

        return ProbeResult(
            MEDIAPROJECTION, "MediaProjection（截屏）",
            ok = apiOk && fgsDeclared,
            status = status,
            hint = if (granted) {
                "ui.screenshot 可用。默认返回 PNG 落盘路径，传 inline=true 可内联 base64。"
            } else {
                "① Manifest 声明 FOREGROUND_SERVICE_MEDIA_PROJECTION" +
                    (if (fgsDeclared) "（已声明 ✓）" else "（⚠ 当前未声明）") + "\n" +
                    "② 用户在 App 内点一次「授权屏幕捕获」完成系统弹窗授权（**不可预置**，这是与 Device Owner 的本质区别）；\n" +
                    "③ 授权缓存于 files/$GRANT_FILE，进程重启后自动复用。"
            }
        )
    }

    private fun checkSpecialPerms(ctx: Context): ProbeResult {
        val center = PermissionCenter(ctx)
        val items = mutableListOf<String>()
        var okCount = 0
        for (spec in PermissionCatalog.SPECIAL) {
            val granted = center.isGranted(spec)
            if (granted) okCount++
            items += spec.label + "=" + (if (granted) "已授权" else "未授权") +
                (if (!granted && spec.note.isNotEmpty()) "（" + spec.note + "）" else "")
        }
        return ProbeResult(
            SPECIAL_PERMS, "标准特殊权限", okCount == PermissionCatalog.SPECIAL.size,
            "$okCount/${PermissionCatalog.SPECIAL.size} 已就绪",
            items.joinToString("\n")
        )
    }

    /** 生命周期风险（电池优化 / phantom process killer / 前台保活前提）。 */
    private fun checkLifecycle(ctx: Context): ProbeResult {
        val lines = LifecycleChecks.collect(ctx)
        val ok = lines.count { it.ok }
        return ProbeResult(
            LIFECYCLE, "生命周期风险", ok == lines.size, "$ok/${lines.size} 项就绪",
            lines.joinToString("\n") { it.title + "=" + it.detail }
        )
    }

    // ---- 机器可读快照 ----

    private fun writeSnapshot(ctx: Context, results: List<ProbeResult>) {
        try {
            val obj = org.json.JSONObject().apply {
                put("schema", 1)
                // 两条版本流各自的身份 + 协议版本：排查"为什么某功能没生效"先看这三个值（ADR-0004 §5）。
                put("appVersion", BuildConfig.VERSION_NAME)
                put("appVersionCode", BuildConfig.VERSION_CODE)
                put("bridgeProtocol", BuildConfig.BRIDGE_PROTOCOL)
                put("kernelVersion", KernelManager(ctx).currentVersion() ?: "")
                // C1/C2 可观测：版本下限（只增不减）与"已安装但尚未提交"的版本。
                put("kernelFloor", KernelManager(ctx).floorVersion() ?: "")
                put("kernelPending", KernelManager(ctx).pending()?.version ?: "")
                put("checkedAt", System.currentTimeMillis())
                put("androidApi", Build.VERSION.SDK_INT)
                put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
                put("checks", org.json.JSONArray().apply {
                    for (r in results) {
                        put(org.json.JSONObject().apply {
                            put("id", r.id)
                            put("label", r.label)
                            put("ok", r.ok)
                            put("status", r.status)
                            put("hint", r.hint)
                        })
                    }
                })
            }
            File(ctx.filesDir, "provisioning.json").writeText(obj.toString(2))
        } catch (_: Throwable) {
            // 探针失败绝不影响启动流程
        }
    }

    data class ProbeResult(
        val id: String,
        val label: String,
        val ok: Boolean,
        val status: String,
        val hint: String
    )
}
