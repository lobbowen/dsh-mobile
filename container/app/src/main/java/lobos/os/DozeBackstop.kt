package lobos.os

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import lobos.lifecycle.DozeBackstopReceiver

/**
 * Doze 兜底唤醒（复检 AUD-G22）。
 *
 * 语义边界：**不是**复活机制（ADR-0006 D4）。它只做一件事 —— 被系统挂起/进入 Doze 后，
 * 周期性给唯一生命周期一次"确保宿主在"的幂等投递，让 OS 有机会把自己转回前台。
 *
 * 用 setAndAllowWhileIdle（非精确）而非 setExact*：不需要 SCHEDULE_EXACT_ALARM，
 * 目的只是穿透 Doze，不是精确时刻。
 */
object DozeBackstop {

    const val ACTION = "lobos.action.DOZE_BACKSTOP"

    /** 3 小时一次：比任何 OEM 省电策略的"冻结"更频繁，又远低于任何精确唤醒的门槛。 */
    private const val INTERVAL_MS = 3 * 60 * 60 * 1000L

    fun schedule(ctx: Context) {
        runCatching {
            val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val pi = PendingIntent.getBroadcast(
                ctx,
                0,
                Intent(ctx, DozeBackstopReceiver::class.java).setAction(ACTION),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            am.setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + INTERVAL_MS,
                pi,
            )
        }
    }
}
