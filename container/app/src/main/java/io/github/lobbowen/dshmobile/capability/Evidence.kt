package io.github.lobbowen.dshmobile.capability

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

/** 最近一次 DO 下发尝试：REJECTED 专指平台层面的拒绝（多用户设备），非用户可补救。 */
enum class OwnerAttemptOutcome { GRANTED, REJECTED, FAILED }

data class OwnerAttempt(val atMs: Long, val outcome: OwnerAttemptOutcome, val reason: String = "")

data class CheckItem(val id: String, val ok: Boolean?, val detail: String = "")

/**
 * 组件名由采集层填入。判据层要拼 dpm / settings 命令模板，但**不许** import Android
 * 类型（spec §4 的分层表：纯层可 JVM 单测钉死），所以类名字符串从外部进来。
 */
data class DeviceNames(
    val packageName: String = "",
    val dpcComponent: String = "",
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
    val deviceOwner: Boolean = false,
    val ownerAttempt: OwnerAttempt? = null,
    /** 已授权的权限 id 集（取值域 = [io.github.lobbowen.dshmobile.permissions.PermissionCatalog]）。 */
    val grants: Set<String> = emptySet(),
    val controlPlaneUp: Boolean = false,
    val kernelChecks: List<CheckItem> = emptyList(),
    val pairAttempt: PairAttempt? = null,
    val names: DeviceNames = DeviceNames(),
    val channelTtlMs: Long = CHANNEL_TTL_MS,
) {
    companion object {
        /** 通道读数的可信期：超期即视为未知（spec §2.3 退化恢复要求 ≤30s 必然变红）。 */
        const val CHANNEL_TTL_MS = 30_000L
    }

    fun granted(id: String): Boolean = grants.contains(id)

    /** 唯一允许的「通道在线」口径：探针为 LIVE **且**读数没过期。 */
    fun channelLive(): Boolean {
        if (channel.outcome != ProbeOutcome.LIVE) return false
        val age = nowMs - channel.atMs
        return age >= 0 && age < channelTtlMs
    }
}
