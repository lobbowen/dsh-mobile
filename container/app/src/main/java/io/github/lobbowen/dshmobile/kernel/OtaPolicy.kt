package io.github.lobbowen.dshmobile.kernel

/**
 * 远端内核 OTA 的**准入判定** —— 纯函数，不碰网络/Android。
 *
 * 为什么必须抽出来并单测：这是整条链路上**唯一**能挡住"不该装的包"的地方，
 * 五条判定（过期 / 重放 / 是否更新 / 版本下限 / 灰度）任何一条写反，
 * 后果都是**静默的**（要么永远不更新，要么把设备降级，要么灰度停不下来）。
 * 埋在 Android 网络流程里就只能靠真机碰运气。
 */
object OtaPolicy {

    data class Input(
        val remoteVersion: String,
        val currentVersion: String?,
        val floorVersion: String?,
        val expiresEpochMs: Long,
        val sequence: Long,
        val lastSequence: Long,
        val rolloutPercent: Int,
        val installId: String,
        val nowMs: Long,
    )

    sealed class Verdict {
        /** 拒绝（安全相关）：**不装**，且应当被记录/告警。 */
        data class Reject(val code: String, val message: String) : Verdict()
        /** 已是最新：正常状态，不是错误。 */
        data class UpToDate(val message: String) : Verdict()
        /** 灰度未命中：**约定如此**，下次启动再试，不是错误。 */
        data class Holdback(val message: String) : Verdict()
        /** 有可用更新但**只做检查**（checkOnly）：不安装。 */
        data class Available(val message: String) : Verdict()
        /** 准予安装。 */
        object Install : Verdict()
    }

    /**
     * 确定性分桶（0..99）：同一台设备对同一版本永远落在同一个桶里 —— 这才叫灰度，
     * 否则每次重启都换桶，等于随机。
     *
     * ⚠ 用 floorMod 而不是 Math.abs(hash % 100)：
     *   String.hashCode() 可能返回 Int.MIN_VALUE，而 Math.abs(Int.MIN_VALUE) 仍是负数，
     *   于是桶号变负 → "bucket >= rolloutPercent" 在 rollout=0（停发）时判为 false
     *   → **停发失效，设备照样装**。概率极低但后果是安全承诺被打破，所以按数学正确性来。
     */
    fun bucketOf(installId: String, version: String): Int =
        Math.floorMod((installId + ":" + version).hashCode(), 100)

    /**
     * @param checkOnly true 时在"是否更新"之后、灰度之前返回 [Verdict.Available] ——
     *   与历史行为一致：检查更新关心的是"有没有新版本"，不该被灰度挡住。
     */
    fun evaluate(i: Input, checkOnly: Boolean = false): Verdict {
        // ① 新鲜度：过期即拒（防"永久冻结在旧版本"）
        if (i.expiresEpochMs > 0L && i.nowMs > i.expiresEpochMs) {
            return Verdict.Reject("manifest-expired",
                "manifest 已过期（expiresEpochMs=" + i.expiresEpochMs + "）—— 拒绝使用；检查发布流水线是否仍在签发")
        }
        // ② 是否需要更新（相等 → 已是最新）
        //
        // ⚠ 这一步必须**排在防重放之前**（真机实测修正）：
        //   设备装好之后，它自己的 sequence 水位就等于 manifest 的 sequence，
        //   于是"同一份 manifest 再来一次"会被重放规则拦下 —— 技术上正确，但**归因误导**：
        //   稳定态（已是最新）被报成"疑似重放"，看日志的人会以为出了安全问题。
        //   先判"是否更新"不削弱安全性：只要远端版本确实更新，后面的重放检查照样拦。
        if (!KernelVersions.isNewer(i.remoteVersion, i.currentVersion)) {
            return Verdict.UpToDate("已是最新（本地 " + i.currentVersion + "，远端 " + i.remoteVersion + "）")
        }
        // ③ 防重放：sequence 不得低于本通道已见最大值
        if (i.sequence in 1..i.lastSequence) {
            return Verdict.Reject("manifest-replay",
                "manifest sequence=" + i.sequence + " 不高于已见 " + i.lastSequence + " —— 疑似重放，拒绝")
        }
        // ④ 版本下限：**在下载之前**就拒（省一次白下载，也少一条被绕过的路径）
        if (KernelVersions.isBelowFloor(i.remoteVersion, i.floorVersion)) {
            return Verdict.Reject("version-below-floor",
                "远端 " + i.remoteVersion + " 低于版本下限 " + i.floorVersion + " —— 拒绝（防回退）")
        }
        // ⑤ 只检查：至此已确认"有更新且不违反任何安全约束"
        if (checkOnly) {
            return Verdict.Available("发现新版本 " + i.remoteVersion + "（checkOnly：未安装）")
        }
        // ⑥ 灰度放量
        val rollout = i.rolloutPercent.coerceIn(0, 100)
        if (rollout < 100) {
            val bucket = bucketOf(i.installId, i.remoteVersion)
            if (bucket >= rollout) {
                return Verdict.Holdback("灰度未命中（bucket=" + bucket + " >= rolloutPercent=" + rollout + "）—— 本次不安装，下次启动再试")
            }
        }
        return Verdict.Install
    }
}
