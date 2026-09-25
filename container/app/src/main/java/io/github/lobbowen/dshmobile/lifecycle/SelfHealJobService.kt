package io.github.lobbowen.dshmobile.lifecycle

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.util.Log

/**
 * 进程级自愈边（flow-spec §2.4 的常驻前提）。
 *
 * 为什么要有它：其余所有拉起边（无障碍绑定、解锁/亮屏广播、:node 回戳、UI 进入）都要求
 * **进程还活着**。ROM 在锁屏后把整个 :main 回收时，这些边一起消失 —— 用户看到的就是
 * 「锁屏之后 App 被清掉，再打开一切从头来」。JobScheduler 的任务由系统在册，
 * 到点会重新创建进程并回调 [SelfHealJobService]，这是无 root 条件下唯一一条进程外唤醒边。
 *
 * 与 2026-09-25「不加第二唤醒机制（闹钟心跳）」的拍板的关系：那次否掉的是**周期性叫醒内核干活**
 * （心跳本身会占用资源并制造新的冻结面）；这里不做任何业务，只在 15 分钟一次的节拍上
 * 戳一句「确保监督链在册」，成本是一次 startService。锁屏实测被清（2026-09-26）证明
 * 单靠无障碍锚不足以常驻，故按 ADR-0006 的修订补上这条边。
 */
object SelfHeal {

    private const val JOB_ID = 7788
    private const val TAG = "SelfHeal"
    /** 系统对 setPeriodic 的下限就是 15 分钟；再密只会被静默拉长，白占电量。 */
    private const val INTERVAL_MS = 15 * 60 * 1000L

    @Volatile
    private var scheduled = false

    /** 幂等：已在册就不再戳（重复 schedule 会重置周期，反而把自愈推后）。 */
    fun schedule(ctx: Context) {
        if (scheduled) return
        val scheduler = ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler ?: return
        val pending = runCatching { scheduler.allPendingJobs.any { it.id == JOB_ID } }.getOrDefault(false)
        if (pending) { scheduled = true; return }
        val job = JobInfo.Builder(
            JOB_ID,
            ComponentName(ctx.packageName, SelfHealJobService::class.java.name),
        )
            .setPeriodic(INTERVAL_MS)
            .build()
        runCatching { scheduler.schedule(job) }.onSuccess { scheduled = true }.onFailure {
            Log.w(TAG, "周期自愈任务排不进（等下一次被戳）", it)
        }
    }
}

/** 任务体：只做一件事 —— 戳监督者（幂等），然后立刻交还系统。 */
class SelfHealJobService : JobService() {

    override fun onStartJob(params: JobParameters?): Boolean {
        ContainerSupervisor.ensureRunning(applicationContext)
        return false // 没有后台活儿：true 意味着"我还要跑"，会占着 job 槽位
    }

    override fun onStopJob(params: JobParameters?): Boolean = true
}
