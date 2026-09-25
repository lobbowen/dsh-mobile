package io.github.lobbowen.dshmobile.ui

/**
 * 开场管线 S0–S4 的**纯判定**（无 Android 依赖，JVM 单测钉死）。
 *
 * 分层纪律（ui-onboarding-spec §4）：检测/决策逻辑不住 GUI 层 —— Activity 只负责
 * 取读数、调这里的 evaluate、渲染结果。改状态机语义=改这里+改单测，不用碰界面。
 */
enum class StepStatus {
    /** 条件已满足 */
    DONE,
    /** 前置就绪，等用户一步操作 */
    ACTION,
    /** 前置未就绪，本段不可动 */
    BLOCKED,
    /** 尝试过且失败（detail 给原因） */
    FAILED,
}

data class PipelineStep(
    val id: String,
    val title: String,
    val status: StepStatus,
    val detail: String,
)

/** GUI 采集的原始读数；全部是「有没有」级别，不含推断。 */
data class PipelineReadings(
    val adbPaired: Boolean,
    val deviceOwner: Boolean,
    /** PermissionCatalog.ALL 中**未授权**的 id 列表（空=全绿）。 */
    val missingPermissions: List<String>,
    val runtimeUp: Boolean,
    /** S0 最近一次配对尝试的失败原因（成功或未尝试为 null）。 */
    val lastPairError: String? = null,
    /** 开发者选项总开关（Settings.Global.DEVELOPMENT_SETTINGS_ENABLED）。S0 前置检测。 */
    val devOptionsOn: Boolean = false,
    /** 无线调试是否开着（Settings.Global.ADB_WIFI_ENABLED，=1 才算）。S0 前置检测。 */
    val wirelessDebugOn: Boolean = false,
)

object PipelineState {

    const val S0 = "S0"
    const val S1 = "S1"
    const val S2 = "S2"
    const val S3 = "S3"
    const val S4 = "S4"

    /** 依赖顺序评估：前一段不 DONE，后一段只能 BLOCKED。 */
    fun evaluate(r: PipelineReadings): List<PipelineStep> {
        val s0 = when {
            r.adbPaired -> PipelineStep(S0, "ADB 通道", StepStatus.DONE, "已配对")
            r.lastPairError != null -> PipelineStep(S0, "ADB 通道", StepStatus.FAILED, r.lastPairError)
            !r.devOptionsOn -> PipelineStep(S0, "ADB 通道", StepStatus.ACTION, "先开启开发者选项")
            !r.wirelessDebugOn -> PipelineStep(S0, "ADB 通道", StepStatus.ACTION, "先开启无线调试")
            else -> PipelineStep(S0, "ADB 通道", StepStatus.ACTION, "无线配对（一次 6 位码）")
        }
        val s1 = when {
            s0.status != StepStatus.DONE -> PipelineStep(S1, "Device Owner", StepStatus.BLOCKED, "等待 S0")
            r.deviceOwner -> PipelineStep(S1, "Device Owner", StepStatus.DONE, "已激活")
            else -> PipelineStep(S1, "Device Owner", StepStatus.ACTION, "经 ADB 下发 dpm 命令")
        }
        val s2 = when {
            s1.status != StepStatus.DONE -> PipelineStep(S2, "权限集", StepStatus.BLOCKED, "等待 S1（DO 静默授予主路径）")
            r.missingPermissions.isEmpty() -> PipelineStep(S2, "权限集", StepStatus.DONE, "全部就绪")
            else -> PipelineStep(S2, "权限集", StepStatus.ACTION, "缺 " + r.missingPermissions.joinToString())
        }
        val s3 = when {
            s2.status != StepStatus.DONE -> PipelineStep(S3, "运行时+内核", StepStatus.BLOCKED, "等待 S2")
            r.runtimeUp -> PipelineStep(S3, "运行时+内核", StepStatus.DONE, "控制面在线")
            else -> PipelineStep(S3, "运行时+内核", StepStatus.ACTION, "启动/重试")
        }
        val s4 = when {
            s3.status != StepStatus.DONE -> PipelineStep(S4, "工作台", StepStatus.BLOCKED, "等待 S3")
            else -> PipelineStep(S4, "工作台", StepStatus.DONE, "可进入控制面板")
        }
        return listOf(s0, s1, s2, s3, s4)
    }

    /** 首页是否放行 S4 入口。 */
    fun workbenchOpen(steps: List<PipelineStep>): Boolean =
        steps.lastOrNull()?.status == StepStatus.DONE
}
