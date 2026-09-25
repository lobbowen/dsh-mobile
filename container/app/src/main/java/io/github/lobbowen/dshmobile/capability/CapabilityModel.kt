package io.github.lobbowen.dshmobile.capability

/** 一项能力的判定结果（spec §2.1）。 */
enum class CapStatus {
    /** 判据为真。 */
    GRANTED,
    /** 前置就绪，差用户一步（点授权页 / 输 6 位码）。 */
    ACTION,
    /** 硬前置未达成 —— 只允许由 [Capability.requires] 产生。 */
    BLOCKED,
    /** 试过且失败，detail 带类型化归因。 */
    FAILED,
    /** 平台层面拒绝且非用户可补救（如多用户设备上的 Device Owner）：灰显，不阻塞下游。 */
    UNREACHABLE,
}

/** 取法档位。`acquirer` 给出的**顺序即主路径→降级**，GUI 只发第一项。 */
enum class AcquireKind {
    /** 我方自动完成（重拉服务、跑探针）。 */
    AUTO,
    /** 跳系统设置页/授权页，用户点一下。target = settings action。 */
    USER_TAP,
    /** 系统运行时权限弹窗（`requestPermissions`），target = 权限 id。 */
    RUNTIME_DIALOG,
    /** 用户必须人眼读、人手输 6 位配对码（§3 通知栏 RemoteInput）。 */
    USER_CODE,
    /** 经已通的 ADB shell 通道静默下发。target = [_capability 执行器 id]。 */
    SILENT_VIA_ADB,
    /** 经 Device Owner 静默授予（加速器位；DO 不在位时链条里根本不该出现它）。 */
    SILENT_VIA_DO,
}

data class Acquisition(
    val kind: AcquireKind,
    val label: String,
    /** USER_TAP → settings action；SILENT_* → `CapabilityAcquisitionRunner` 的执行器 id。 */
    val target: String? = null,
)

data class CapVerdict(val status: CapStatus, val detail: String = "")

/**
 * 一条能力的完整规格（spec §2.1 的八项里，`evidence`/`failure` 体现在 [judge] 的
 * 输入输出类型上，不再有独立的字符串猜测通道）。
 *
 * [requires] 是**硬**前置：只有这里未达成才允许渲染 BLOCKED。取法链是软依赖
 * （DO 在位就多一条静默路径，不在位就少一条），所以 `device-owner` 不出现在任何
 * requires 集合里 —— v1 把加速器当前置，是 S0–S4 永久锁死的根因（spec §2.0-2）。
 */
data class Capability(
    val id: String,
    val title: String,
    val segment: String,
    val optional: Boolean = false,
    val requires: Set<String> = emptySet(),
    val judge: (Evidence) -> CapVerdict,
    val acquirer: (Evidence) -> List<Acquisition> = { emptyList() },
    /**
     * 该能力达成时向内核置位的**桥能力令牌**名（L0↔L1 契约，见 [BridgeTokens]）。
     * null = 这项能力不对应桥令牌。写在这里而不是桥侧另建一张映射表：令牌与判据同源，
     * 才不会出现「首页绿了、桥门禁却放行/拦错」。
     */
    val bridgeToken: String? = null,
    /**
     * 保活锚：缺了它整个进程在锁屏后会被 ROM 清掉（电池豁免 / 无障碍绑定 / 通知使用权）。
     * 单独成立一个事实而不是让冲刺层手写一份清单 —— 冲刺的提问顺序、F4 欠账归谁，
     * 都从这一位推导；手写清单必然与登记表漂移（v1 的「第二张权限表」就是这么烂掉的）。
     */
    val keepAliveAnchor: Boolean = false,
)
