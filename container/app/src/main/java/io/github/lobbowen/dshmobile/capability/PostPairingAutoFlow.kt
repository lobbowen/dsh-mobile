package io.github.lobbowen.dshmobile.capability

/**
 * 配对后的**自动适配流**（纯逻辑、不 import Android、可由 JVM 单测钉死）。
 *
 * 为什么需要它：配对成功后仍有一批「有 ADB 就能免人手」的能力（无障碍 / 通知读取 /
 * 电池白名单 / DO 派生的 AppOps）。旧实现把这些塞在开屏的授权冲刺里，用户面对的就是
 * 一排系统页；本流把它们收成一条静默队列，用户只看到「开始配对」与「进入工作台」两个动作。
 *
 * 三条纪律：
 *  1. 取法链首项必须是 SILENT_*（本层不发明手段，只按登记表判「这条能不能静默办」）；
 *  2. **始终包含 [CapabilityCatalog.DEVICE_OWNER]**：它是 AppOps 档唯一的静默前提，
 *     必须由本流尝试（本机不可达时由判据落 UNREACHABLE，执行器不重试、不阻塞）；
 *  3. [ready] 在「凭据在册」或「通道在线」任一成立时为 true —— 配对刚成功那一帧
 *     凭据已在册而探针还没 LIVE，所以不能只等通道（否则自动流会被推迟到下一世）。
 */
object PostPairingAutoFlow {

    /**
     * 按 [CapabilityCatalog.ALL] 声明序给出本次要静默办的能力 id。
     *
     * 判据（纯函数）：非 optional 且未 GRANTED 且取法链首项是 SILENT_VIA_*；
     * 另外**无条件**带上 DEVICE_OWNER（第 2 条纪律）。
     */
    fun plan(e: Evidence): List<String> = CapabilityCatalog.ALL
        .filter { c ->
            c.id == CapabilityCatalog.DEVICE_OWNER ||
                (!c.optional && !e.granted(c.id) && silentFirst(c, e))
        }
        .map { it.id }

    /**
     * 自动流是否可以开始。幂等、可重入：只读快照，不写任何状态。
     *
     * 凭据在册**或**通道在线 —— 前者覆盖「刚配好、探针还没跑」的那一帧。
     */
    fun ready(e: Evidence): Boolean =
        e.credentials == CredentialsState.PAIRED || e.channelLive()

    private fun silentFirst(c: Capability, e: Evidence): Boolean {
        val kind = c.acquirer(e).firstOrNull()?.kind ?: return false
        // 等价于需求里的「SILENT_ 开头」，但用枚举比较，改枚举名也不会静默失配。
        return kind == AcquireKind.SILENT_VIA_ADB || kind == AcquireKind.SILENT_VIA_DO
    }
}
