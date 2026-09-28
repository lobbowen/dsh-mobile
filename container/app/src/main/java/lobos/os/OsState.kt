package lobos.os

/**
 * Lob OS 的唯一对外状态（架构 v4 §10）。
 *
 * 三处同源：os/state.json = 常驻通知 = 控制台首行。任何一处都不许自己编状态。
 * 迁移语义：BOOTING → RUNNING → DEGRADED ⇄ RECOVERING → STOPPING。
 * Program 的状态只是子状态，对外只汇总成这一个。
 */
enum class OsPhase {
    BOOTING,
    RUNNING,
    DEGRADED,
    RECOVERING,
    STOPPING;

    val label: String
        get() = when (this) {
            BOOTING -> "启动中"
            RUNNING -> "运行中"
            DEGRADED -> "降级"
            RECOVERING -> "恢复中"
            STOPPING -> "停止中"
        }
}
