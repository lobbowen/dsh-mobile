package io.github.lobbowen.dshmobile.capability

import io.github.lobbowen.dshmobile.permissions.PermissionCatalog

/**
 * 能力登记表（spec §2.2）—— 「这台设备到底能不能干 X」的**唯一事实源**。
 *
 * 三条硬规则，违反任何一条都算架构回归：
 * 1. 判据只住这里（`judge` 是纯函数），别处一律通过 [CapabilityCriteria] / 本表取结论；
 *    CI 里 `capability-single-source-gate-test.js` 会扫判据表达式在表外的复写。
 * 2. [Capability.requires] 只放**硬**前置。`device-owner` 不在任何 requires 里 ——
 *    它在多用户设备上根本不可得（真机 2026-09-25：`dpm` 报 `several users`），
 *    v1 把它当前置导致 S2/S3/S4 永久锁死。
 * 3. 除 [ADB_CHANNEL] 外，任何能力的绿都必须能在**没有 ADB** 的机器上达成
 *    （取法链自动落到 USER_TAP/RUNTIME_DIALOG）。
 *
 * 声明顺序 = 拓扑序；[init] 会校验 id 唯一、requires 指向更早声明的项、权限 id 存在，
 * 写错直接抛（宁可初始化崩，也不要静默给出错误的 BLOCKED）。
 */
object CapabilityCatalog {

    const val S0 = "S0"
    const val S1 = "S1"
    const val S2 = "S2"
    const val S3 = "S3"

    const val DEV_OPTIONS = "dev-options"
    const val WIRELESS_DEBUG = "wireless-debug"
    const val ADB_CREDENTIALS = "adb-credentials"
    const val ADB_CHANNEL = "adb-channel"
    const val DEVICE_OWNER = "device-owner"
    const val RUNTIME = "runtime"
    const val KERNEL_BUNDLE = "kernel-bundle"

    /** USER_TAP 的非权限落点（[CapabilityNavigation] 解析成 Intent）。 */
    const val NAV_DEV_OPTIONS = "nav:dev-options"
    const val NAV_SCREEN_CAPTURE = "nav:screen-capture"

    /** 权限能力走的是「哪一档由谁给」的四分类，与 [io.github.lobbowen.dshmobile.permissions.PermTier]（Manifest 声明档）不是一回事。 */
    enum class PermTierClass { APPOP, RUNTIME, SECURE_SETTINGS, IN_APP }

    /** SILENT_* 的执行器 id，由 [CapabilityAcquisitionRunner] 映射成真实命令。 */
    const val EXEC_DEVICE_OWNER = "dpm-set-device-owner"
    const val EXEC_REPROBE = "adb-channel-reprobe"
    const val EXEC_RETRY_RUNTIME = "runtime-restart"
    const val EXEC_RERUN_SELFCHECK = "kernel-selfcheck-rerun"
    const val EXEC_NOTIFICATION_LISTENER = "settings-put-notification-listener"
    const val EXEC_ACCESSIBILITY = "settings-put-accessibility-service"

    /** dpm 在多用户设备上的平台级拒绝；命中即 UNREACHABLE，不再重复下发。 */
    const val OWNER_REJECTED_MARK = "several users"

    val ALL: List<Capability> = listOf(
        Capability(
            id = DEV_OPTIONS, title = "开发者选项", segment = S0,
            judge = { e ->
                if (e.devOptionsOn) CapVerdict(CapStatus.GRANTED, "已开启")
                else CapVerdict(CapStatus.ACTION, "未开启：顶部总开关先打开")
            },
            acquirer = { listOf(Acquisition(AcquireKind.USER_TAP, "去开发者选项页", NAV_DEV_OPTIONS)) },
        ),
        Capability(
            id = WIRELESS_DEBUG, title = "无线调试", segment = S0, requires = setOf(DEV_OPTIONS),
            judge = { e ->
                if (e.wirelessDebugOn) CapVerdict(CapStatus.GRANTED, "已开启")
                else CapVerdict(CapStatus.ACTION, "未开启：同一页里的「无线调试」开关")
            },
            // PLP120 定罪（spec §7③）：WIRELESS_DEBUGGING_SETTINGS 深链无 Activity 响应，
            // 可解析落点只有开发者选项页 —— 文案与事实一致，不承诺直达。
            acquirer = { listOf(Acquisition(AcquireKind.USER_TAP, "去开发者选项页", NAV_DEV_OPTIONS)) },
        ),
        Capability(
            id = ADB_CREDENTIALS, title = "ADB 配对凭据", segment = S0,
            requires = setOf(DEV_OPTIONS, WIRELESS_DEBUG),
            judge = { e ->
                when {
                    e.credentials == CredentialsState.PAIRED ->
                        CapVerdict(CapStatus.GRANTED, "身份与配对记录在册")
                    e.pairAttempt != null && !e.pairAttempt.ok ->
                        CapVerdict(CapStatus.FAILED, e.pairAttempt.reason)
                    else -> CapVerdict(CapStatus.ACTION, "无线配对（一次 6 位码）")
                }
            },
            acquirer = { listOf(Acquisition(AcquireKind.USER_CODE, "开始配对")) },
            bridgeToken = "adb_shell",
        ),
        Capability(
            // S0 的真判据：凭据在册只说明「以前配过」，通道通不通必须现探。
            id = ADB_CHANNEL, title = "ADB 通道", segment = S0, requires = setOf(ADB_CREDENTIALS),
            judge = { e ->
                val age = e.nowMs - e.channel.atMs
                when {
                    e.channelLive() -> CapVerdict(CapStatus.GRANTED, e.channel.detail)
                    e.channel.outcome == ProbeOutcome.NEVER_RUN ->
                        CapVerdict(CapStatus.ACTION, "通道未校验（探针待跑）")
                    e.channel.outcome == ProbeOutcome.DEAD ->
                        CapVerdict(CapStatus.FAILED, "通道不通：" + e.channel.detail)
                    else -> CapVerdict(
                        CapStatus.FAILED,
                        "通道读数已过期 ${age}ms（>${e.channelTtlMs}ms），重测中",
                    )
                }
            },
            acquirer = { listOf(Acquisition(AcquireKind.AUTO, "重测通道", EXEC_REPROBE)) },
        ),
        Capability(
            id = DEVICE_OWNER, title = "Device Owner", segment = S1, optional = true,
            requires = setOf(ADB_CHANNEL), bridgeToken = "device_owner",
            judge = { e ->
                when {
                    e.deviceOwner -> CapVerdict(CapStatus.GRANTED, "已激活：静默授予可用")
                    e.ownerAttempt?.outcome == OwnerAttemptOutcome.REJECTED -> CapVerdict(
                        CapStatus.UNREACHABLE,
                        "平台拒绝（多用户设备，如应用分身）：" + e.ownerAttempt.reason,
                    )
                    e.ownerAttempt?.outcome == OwnerAttemptOutcome.FAILED ->
                        CapVerdict(CapStatus.FAILED, e.ownerAttempt.reason)
                    else -> CapVerdict(CapStatus.ACTION, "可选加速器：跳过不影响放行")
                }
            },
            acquirer = {
                listOf(Acquisition(AcquireKind.SILENT_VIA_ADB, "经 ADB 激活", EXEC_DEVICE_OWNER))
            },
        ),
        // ---- S2：每项按自己的获取通道登记；DO 在位时静默路径升为主路径（见 [permAcquirers]）----
        perm(
            PermissionCatalog.MANAGE_EXTERNAL_STORAGE, "全部文件访问", PermTierClass.APPOP,
            note = "AppOps 档：shell 已无 MANAGE_APP_OPS_MODES，只能人点",
            bridgeToken = "manage_external_storage",
        ),
        perm(PermissionCatalog.REQUEST_INSTALL_PACKAGES, "安装未知应用", PermTierClass.APPOP),
        perm(PermissionCatalog.SYSTEM_ALERT_WINDOW, "悬浮窗", PermTierClass.APPOP),
        perm(PermissionCatalog.POST_NOTIFICATIONS, "通知发送", PermTierClass.RUNTIME),
        perm(PermissionCatalog.BATTERY_OPTIMIZATION, "电池优化豁免", PermTierClass.APPOP),
        perm(
            PermissionCatalog.NOTIFICATION_ACCESS, "通知读取", PermTierClass.SECURE_SETTINGS,
            bridgeToken = "notification_access",
        ),
        perm(
            PermissionCatalog.ACCESSIBILITY, "无障碍服务", PermTierClass.SECURE_SETTINGS,
            bridgeToken = "accessibility",
        ),
        perm(
            PermissionCatalog.MEDIAPROJECTION, "屏幕捕获授权", PermTierClass.IN_APP,
            optional = true, note = "每次会话授权，物理不可预置",
            bridgeToken = "mediaprojection",
        ),
        Capability(
            id = RUNTIME, title = "运行时", segment = S3,
            judge = { e ->
                if (e.controlPlaneUp) CapVerdict(CapStatus.GRANTED, "控制面在线")
                else CapVerdict(CapStatus.ACTION, "控制面未响应")
            },
            acquirer = { listOf(Acquisition(AcquireKind.AUTO, "重启运行时", EXEC_RETRY_RUNTIME)) },
        ),
        Capability(
            id = KERNEL_BUNDLE, title = "内核包", segment = S3, requires = setOf(RUNTIME),
            // 「未测到」不算通过（KernelSelfCheck 设计要点②）：未知项一律 ACTION，不续绿。
            judge = { e ->
                val failed = e.kernelChecks.filter { it.ok == false }.map { it.id }
                val unknown = e.kernelChecks.filter { it.ok == null }.map { it.id}
                when {
                    e.kernelChecks.isEmpty() -> CapVerdict(CapStatus.ACTION, "内核自检待跑")
                    failed.isNotEmpty() -> CapVerdict(CapStatus.FAILED, "自检失败：" + failed.joinToString())
                    unknown.isNotEmpty() -> CapVerdict(CapStatus.ACTION, "自检有未知项：" + unknown.joinToString())
                    else -> CapVerdict(CapStatus.GRANTED, "自检 ${e.kernelChecks.size} 项通过")
                }
            },
            acquirer = { listOf(Acquisition(AcquireKind.AUTO, "重跑自检", EXEC_RERUN_SELFCHECK)) },
        ),
    )

    /** 权限类能力：判据一律读 [Evidence.grants]，取法链按档位派生（表外的第二把尺子就此消灭）。 */
    private fun perm(
        id: String,
        title: String,
        tier: PermTierClass,
        optional: Boolean = false,
        note: String = "",
        bridgeToken: String? = null,
    ): Capability = Capability(
        id = id, title = title, segment = S2, optional = optional,
        bridgeToken = bridgeToken,
        judge = { e ->
            if (e.granted(id)) CapVerdict(CapStatus.GRANTED, "已授权")
            else CapVerdict(CapStatus.ACTION, if (note.isEmpty()) "未授权" else "未授权（$note）")
        },
        acquirer = { e -> permAcquirers(id, tier, e) },
    )

    /** 取法链（主 → 降级）。核心不变式：DO/ADB **缺席**时链条只是变短，能力不会变成 BLOCKED。 */
    private fun permAcquirers(id: String, tier: PermTierClass, e: Evidence): List<Acquisition> {
        val tap = when (tier) {
            PermTierClass.RUNTIME -> Acquisition(AcquireKind.RUNTIME_DIALOG, "系统弹窗授权", id)
            PermTierClass.IN_APP -> Acquisition(AcquireKind.USER_TAP, "去诊断页授权", NAV_SCREEN_CAPTURE)
            PermTierClass.SECURE_SETTINGS -> Acquisition(AcquireKind.USER_TAP, "去系统授权页", id)
            PermTierClass.APPOP -> Acquisition(AcquireKind.USER_TAP, "去系统授权页", id)
        }
        val silent = when (tier) {
            PermTierClass.SECURE_SETTINGS -> when (id) {
                PermissionCatalog.NOTIFICATION_ACCESS ->
                    Acquisition(AcquireKind.SILENT_VIA_ADB, "经 ADB 静默开启", EXEC_NOTIFICATION_LISTENER)
                PermissionCatalog.ACCESSIBILITY ->
                    Acquisition(AcquireKind.SILENT_VIA_ADB, "经 ADB 静默开启", EXEC_ACCESSIBILITY)
                else -> null
            }
            // 只有 AppOps 档 DO 能静默授予；SECURE_SETTINGS 档 shell 就能办，用不着 DO。
            PermTierClass.APPOP -> Acquisition(AcquireKind.SILENT_VIA_DO, "DO 静默授予", id)
            else -> null
        }
        val out = mutableListOf<Acquisition>()
        if (silent != null) {
            val usable = when (tier) {
                PermTierClass.SECURE_SETTINGS -> e.channelLive()
                else -> e.deviceOwner
            }
            if (usable) out += silent
        }
        out += tap
        return out
    }

    init {
        val seen = HashSet<String>()
        ALL.forEachIndexed { i, c ->
            require(seen.add(c.id)) { "能力 id 重复: ${c.id}" }
            c.requires.forEach { r ->
                val idx = ALL.indexOfFirst { it.id == r }
                require(idx in 0 until i) { "能力 ${c.id} 的前置 $r 必须是更早声明的项（拓扑序被破坏）" }
            }
            // 加速器不许当任何人的前置 —— v1 的死穴，钉成结构性约束。
            ALL.filter { it.optional }.forEach { o ->
                require(o.id !in c.requires) { "optional 能力 ${o.id} 不得作为 ${c.id} 的前置" }
            }
        }
        // 权限类能力的 id 必须真的在 PermissionCatalog 里（否则判据永远查不到 = 幽灵绿灯）
        val known = PermissionCatalog.ALL.map { it.id }.toSet()
        ALL.filter { it.segment == S2 }.forEach { c ->
            require(c.id in known) { "${c.id} 不在 PermissionCatalog.ALL 里，判据无从取数" }
        }
        // 一个令牌挂在两项上 = 桥门禁会被其中一项的失败误伤；写重名直接崩。
        val tokens = ALL.mapNotNull { it.bridgeToken }
        require(tokens.size == tokens.toSet().size) {
            "桥令牌重复：" + tokens.groupBy { it }.filter { it.value.size > 1 }.keys
        }
    }

    /** 按声明（= 拓扑）序求值；[Capability.requires] 未达成才下 BLOCKED。 */
    fun evaluate(e: Evidence): Map<String, CapVerdict> {
        val out = LinkedHashMap<String, CapVerdict>()
        for (c in ALL) {
            val waiting = c.requires.firstOrNull { req ->
                val v = out[req]
                v != null && v.status != CapStatus.GRANTED && v.status != CapStatus.UNREACHABLE
            }
            out[c.id] = if (waiting != null) {
                CapVerdict(CapStatus.BLOCKED, "等待 " + titleOf(waiting))
            } else {
                c.judge(e)
            }
        }
        return out
    }

    /**
     * **未经 DAG 门控**的原始判据（桥令牌派生用，见 [BridgeTokens]）。
     * 首页渲染一律走 [evaluate]；这里出现 BLOCKED 是不可能的 —— 门控只发生在 evaluate。
     */
    fun rawJudge(id: String, e: Evidence): CapVerdict? = byId(id)?.judge?.invoke(e)

    /** 未达成且**阻塞放行**的能力（optional 与 UNREACHABLE 不计），按拓扑序。 */
    fun blockingGaps(verdicts: Map<String, CapVerdict>): List<Pair<Capability, CapVerdict>> =
        ALL.filter { !it.optional }.mapNotNull { c ->
            val v = verdicts[c.id] ?: return@mapNotNull null
            if (v.status == CapStatus.GRANTED) null else c to v
        }

    fun byId(id: String): Capability? = ALL.firstOrNull { it.id == id }

    fun titleOf(id: String): String = byId(id)?.title ?: id
}
