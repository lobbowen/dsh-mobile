package lobos.capability

/**
 * 探针读数的**类型化**结果。住在 [Evidence] 里，判据层靠它下结论。
 *
 * 为什么要有 NEVER_RUN 这一档：v1 把「没测到」和「测出不通」都渲染成黄灯待办，
 * 于是端口轮换后（真机 2026-09-25 17:36）首页拿着「凭据在册」这个旧事实一路绿到 S3。
 * LIVE 之外的任何状态都不许产生 DONE —— spec §8-2「假绿免疫」。
 */
enum class ProbeOutcome {
    /** 探针跑过且通道可用。 */
    LIVE,
    /** 探针跑过且明确不通（detail 给归因）。 */
    DEAD,
    /** 从没探过（无凭据 / 进程刚起）。 */
    NEVER_RUN,
}

data class ChannelProbe(
    val outcome: ProbeOutcome,
    val atMs: Long = 0L,
    val detail: String = "",
)

/** 凭据在册程度。注意：这只回答「密钥与配对记录在不在」，**不等于通道可用**（spec §2.2）。 */
enum class CredentialsState { NO_KEY, PAIRED }

/** 最近一次配对尝试的类型化结论 —— 取代 v1 的「扫日志文本猜状态」。 */
data class PairAttempt(val atMs: Long, val ok: Boolean, val reason: String = "")

/**
 * adb **实测过一次**静默取法之后的结局。取值域就是 `files/os/permission-ledger.json` 的账本词汇，
 * 它是「这项归 adb 还是归人」的唯一依据 —— 取代旧实现里按档位预先判死（`usable = false`）。
 */
enum class AttemptOutcome(val human: String) {
    /** 下发过且系统侧回读确认生效：清单上打勾。 */
    SILENT_OK("adb 已开"),
    /** 命令跑到了 shell、系统没报错，但回读未见生效：这条要人点一次。 */
    NEEDS_TAP("adb 下发未见生效"),
    /** 系统明确拒绝这条命令（错误行原样留账）：adb 这条路在本机不通，要人点。 */
    UNSUPPORTED("adb 被系统拒绝"),
}

/** 一条静默实测的账：结论 + 时刻 + 系统自己的那一行（给人看的证据，不重写一遍）。 */
data class SilentAttempt(val outcome: AttemptOutcome, val atMs: Long, val detail: String)

/**
 * 结局分类 —— 「能不能静默办」从此只由实测结果推导，不再由档位预判。
 *
 * 两条取舍：
 *  - **命令没跑到 shell 就不记账**（返回 null）：通道半路死了不能算「adb 办不成」，
 *    那是设备状态而不是这条路的事实，下一轮还该试。
 *  - 拒绝词汇表只用来区分「系统不让走」与「让走了但没生效」：两者的**人点动作相同**、
 *    上屏归因不同；系统原始行始终随账存着，误分类可核。
 */
object AttemptOutcomeRule {

    /** 系统服务侧的拒绝形态：命令到了 shell，但服务不让 uid=2000 做这件事。 */
    private val REFUSAL_MARKS = listOf(
        "SecurityException", "Security exception", "Permission Denial", "not allowed",
        "Unknown operation", "does not exist",
    )

    fun of(issued: Boolean, verified: Boolean, systemText: String): AttemptOutcome? {
        if (!issued) return null
        if (verified) return AttemptOutcome.SILENT_OK
        val refused = REFUSAL_MARKS.any { systemText.contains(it, ignoreCase = true) }
        return if (refused) AttemptOutcome.UNSUPPORTED else AttemptOutcome.NEEDS_TAP
    }
}

data class CheckItem(val id: String, val ok: Boolean?, val detail: String = "")

/**
 * 组件名由采集层填入。判据层要拼 settings 命令模板，但**不许** import Android
 * 类型（spec §4 的分层表：纯层可 JVM 单测钉死），所以类名字符串从外部进来。
 */
data class DeviceNames(
    val packageName: String = "",
    val accessibilityComponent: String = "",
    val notificationListenerComponent: String = "",
)

/**
 * 一次采集的全量证据快照。除 [channel] 外都是「现读现用」，不跨轮缓存。
 */
data class Evidence(
    val nowMs: Long = 0L,
    val devOptionsOn: Boolean = false,
    val wirelessDebugOn: Boolean = false,
    val credentials: CredentialsState = CredentialsState.NO_KEY,
    val channel: ChannelProbe = ChannelProbe(ProbeOutcome.NEVER_RUN),
    /** 已授权的权限 id 集（取值域 = [lobos.permissions.PermissionCatalog]）。 */
    val grants: Set<String> = emptySet(),
    /**
     * adb 静默取法的实测账（key = 能力 id）。缺席 = 还没试过，
     * 而「还没试过」在取法链上等价于「先试」，绝不等价于「只能人点」。
     */
    val permissionAttempts: Map<String, SilentAttempt> = emptyMap(),
    val controlPlaneUp: Boolean = false,
    val programChecks: List<CheckItem> = emptyList(),

    /** 用户对厂商省电白名单四项开关的「已完成」回执（AUD-G21；系统无公开读接口）。 */
    val oemGuards: Set<String> = emptySet(),
    val pairAttempt: PairAttempt? = null,
    val names: DeviceNames = DeviceNames(),
    val channelTtlMs: Long = CHANNEL_TTL_MS,
) {
    companion object {
        /** 通道读数的可信期：超期即视为未知（spec §2.3 退化恢复要求 ≤30s 必然变红）。 */
        const val CHANNEL_TTL_MS = 30_000L
    }

    fun granted(id: String): Boolean = grants.contains(id)

    /** 这项的 adb 实测结局；null = 还没实测过 —— 「没试过」永远先试，不许当成「办不成」。 */
    fun attemptOutcome(id: String): AttemptOutcome? = permissionAttempts[id]?.outcome

    /** 唯一允许的「通道在线」口径：探针为 LIVE **且**读数没过期。 */
    fun channelLive(): Boolean {
        if (channel.outcome != ProbeOutcome.LIVE) return false
        val age = nowMs - channel.atMs
        return age >= 0 && age < channelTtlMs
    }
}
