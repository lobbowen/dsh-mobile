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
    const val NAV_WIRELESS_DEBUG = "nav:wireless-debug"
    /** 诊断页与工作台是同一帧（MainActivity），所以落点只有一个名字。 */
    const val NAV_DIAGNOSTICS = "nav:diagnostics"

    /** 权限能力走的是「哪一档由谁给」的四分类，与 [io.github.lobbowen.dshmobile.permissions.PermTier]（Manifest 声明档）不是一回事。 */
    enum class PermTierClass { APPOP, RUNTIME, SECURE_SETTINGS, IN_APP }

    /** SILENT_* 与 AUTO 的执行器 id，由 [CapabilityAcquisitionRunner] 映射成真实命令。 */
    const val EXEC_DEVICE_OWNER = "dpm-set-device-owner"
    const val EXEC_REPROBE = "adb-channel-reprobe"
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
            // 落点 = 无线调试页（NAV_WIRELESS_DEBUG）。深链在 ColorOS/PLP120 上无 Activity 响应
            // （spec §7③ 定罪），所以 [CapabilityNavigation] 先问系统能不能解析、不能才退到
            // 开发者选项页 —— 承诺「直达」是假话，承诺「一定跳到一个能拨开关的页」才是真话。
            acquirer = { listOf(Acquisition(AcquireKind.USER_TAP, "打开无线调试页", NAV_WIRELESS_DEBUG)) },
        ),
        // 通知发送登记在 **S0**（不是 S2）：它是上面 ADB_CREDENTIALS 的硬前置，见那里的注释。
        // 无 requires —— 它自己必须在「拔掉 ADB、开发者选项还没开」时就能达成，
        // 否则首启授权冲刺会被自己的前置锁死（onboarding-flow-spec §2.2）。
        perm(
            PermissionCatalog.POST_NOTIFICATIONS, "通知发送", PermTierClass.RUNTIME,
            segment = S0,
        ),
        Capability(
            id = ADB_CREDENTIALS, title = "ADB 配对凭据", segment = S0,
            // post_notifications 是**物理**前置，不是优先级偏好：主路径的输码交互走通知栏
            // RemoteInput（ui-onboarding-spec §3.2），通知不可见时输码入口根本不存在 ——
            // PermissionCatalog 给它的 note「notif.post 会被系统静默丢弃」就是这条的案底。
            // 过去它登记在 S2，于是 S0 唯一动作「开始配对」在全新安装上永远走不通
            // （onboarding-flow-spec §0 表第 3 行）。
            requires = setOf(DEV_OPTIONS, WIRELESS_DEBUG, PermissionCatalog.POST_NOTIFICATIONS),
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
        perm(
            PermissionCatalog.BATTERY_OPTIMIZATION, "电池优化豁免", PermTierClass.APPOP,
            anchor = true, note = "不豁免则 Doze 下整机被冻结",
        ),
        perm(
            PermissionCatalog.NOTIFICATION_ACCESS, "通知读取", PermTierClass.SECURE_SETTINGS,
            anchor = true, note = "既是面板的通知能力，也是后台存活的一票",
            bridgeToken = "notification_access",
        ),
        perm(
            PermissionCatalog.ACCESSIBILITY, "无障碍服务", PermTierClass.SECURE_SETTINGS,
            anchor = true,
            note = "实证唯一挡得住 ColorOS HANS 冻整个 uid 的锚（ContainerSupervisor 的托底边）",
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
            // **不给「重启运行时」按钮**：它的实现是 destroy 当前实例（运行时服务的重启动作
            // 语义），首页一度把它当 F3 的主行动 —— 用户点开界面就可能把正在跑的
            // 内核拆掉再等 30s（真机 2026-09-26 定罪「打开 App 就崩」）。运行时的死活归监督者
            // （ContainerSupervisor + :node 自家退避循环），界面只给一条看启动日志的路。
            acquirer = { listOf(Acquisition(AcquireKind.USER_TAP, "看运行时启动日志", NAV_DIAGNOSTICS)) },
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

    /**
     * 权限类能力：判据一律读 [Evidence.grants]，取法链按档位派生（表外的第二把尺子就此消灭）。
     *
     * [segment] 默认 S2，但**不**由档位决定：通知发送虽然是个普通运行时权限，它在流程上是
     * S0 配对的前置（见 [ADB_CREDENTIALS] 的 requires），所以登记在 S0。
     */
    private fun perm(
        id: String,
        title: String,
        tier: PermTierClass,
        segment: String = S2,
        optional: Boolean = false,
        note: String = "",
        bridgeToken: String? = null,
        anchor: Boolean = false,
    ): Capability {
        // id 必须真在 PermissionCatalog 里：查不到定义 = 采集器永远不会填这个读数 = 幽灵绿灯。
        require(PermissionCatalog.byId(id) != null) { "$id 不在 PermissionCatalog.ALL 里，判据无从取数" }
        return Capability(
            id = id, title = title, segment = segment, optional = optional,
            bridgeToken = bridgeToken, keepAliveAnchor = anchor,
            judge = { e ->
                if (e.granted(id)) CapVerdict(CapStatus.GRANTED, "已授权")
                else CapVerdict(CapStatus.ACTION, if (note.isEmpty()) "未授权" else "未授权（$note）")
            },
            acquirer = { e -> permAcquirers(id, tier, e) },
        )
    }

    /** 取法链（主 → 降级）。核心不变式：DO/ADB **缺席**时链条只是变短，能力不会变成 BLOCKED。 */
    private fun permAcquirers(id: String, tier: PermTierClass, e: Evidence): List<Acquisition> {
        val tap = when (tier) {
            PermTierClass.RUNTIME -> Acquisition(AcquireKind.RUNTIME_DIALOG, "系统弹窗授权", id)
            PermTierClass.IN_APP -> Acquisition(AcquireKind.USER_TAP, "去诊断页授权", NAV_DIAGNOSTICS)
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
        // 权限类能力的 id 必须真的在 PermissionCatalog 里 —— 这条校验住在 [perm] 的构造里
        // （档位归属会影响段，S0 也有权限能力，按 segment 过滤会漏）。
        // 一个令牌挂在两项上 = 桥门禁会被其中一项的失败误伤；写重名直接崩。
        val tokens = ALL.mapNotNull { it.bridgeToken }
        require(tokens.size == tokens.toSet().size) {
            "桥令牌重复：" + tokens.groupBy { it }.filter { it.value.size > 1 }.keys
        }
    }

    /**
     * 按声明（= 拓扑）序求值；[Capability.requires] 未达成才下 BLOCKED。
     *
     * **实测优先于推断**：judge 直接读到「已经达成」（凭据在册、探针 LIVE、控制面在线）时不再被
     * 前置的缺位改成 BLOCKED。否则 ROM 回收掉通知权限会把一台通道明明在线的老设备整页判红 ——
     * 而 onboarding-flow-spec §2.2 的认领规则要求那些授权落回 F6 补齐清单，不是让 F3/F4 变红。
     * BLOCKED 回答的是「前置没齐，现在还不该做」，不能回答「已经做完的事没做」。
     */
    fun evaluate(e: Evidence): Map<String, CapVerdict> {
        val out = LinkedHashMap<String, CapVerdict>()
        for (c in ALL) {
            val verdict = c.judge(e)
            if (verdict.status == CapStatus.GRANTED) { out[c.id] = verdict; continue }
            val waiting = c.requires.firstOrNull { req ->
                val v = out[req]
                v != null && v.status != CapStatus.GRANTED && v.status != CapStatus.UNREACHABLE
            }
            out[c.id] = if (waiting != null) CapVerdict(CapStatus.BLOCKED, "等待 " + titleOf(waiting)) else verdict
        }
        return out
    }

    /**
     * **未经 DAG 门控**的原始判据（桥令牌派生用，见 [BridgeTokens]）。
     * 首页渲染一律走 [evaluate]；这里出现 BLOCKED 是不可能的 —— 门控只发生在 evaluate。
     */
    fun rawJudge(id: String, e: Evidence): CapVerdict? = byId(id)?.judge?.invoke(e)

    fun byId(id: String): Capability? = ALL.firstOrNull { it.id == id }

    fun titleOf(id: String): String = byId(id)?.title ?: id

    /**
     * 某能力的硬前置，**按登记表声明序**返回。[Capability.requires] 是 Set，迭代序不保证稳定，
     * 而这里出来的顺序会变成用户实际被引导的先后（P0 冲刺项、配对现场引导），所以必须归一。
     * 推导只此一处：冲刺清单、配对闸门、流程认领集都走它，不许各自再 filter 一遍。
     */
    fun requiresInOrder(id: String): List<String> {
        val req = byId(id)?.requires ?: return emptyList()
        return ALL.filter { req.contains(it.id) }.map { it.id }
    }
}
