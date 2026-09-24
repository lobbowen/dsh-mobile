package io.github.lobbowen.dshmobile.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import io.github.lobbowen.dshmobile.BuildConfig
import io.github.lobbowen.dshmobile.MainActivity
import io.github.lobbowen.dshmobile.bridge.AdbClientRunner
import io.github.lobbowen.dshmobile.lifecycle.ContainerSupervisor
import io.github.lobbowen.dshmobile.lifecycle.DeviceAdminReceiver
import io.github.lobbowen.dshmobile.permissions.PermissionCatalog
import io.github.lobbowen.dshmobile.permissions.PermTier
import io.github.lobbowen.dshmobile.runtime.NodeRuntimeService

/**
 * 管线首页（G1-1 探针版，spec §2/§5）：S0–S4 五行状态 + 每行的用户动作。
 *
 * 职责边界（spec §4）：这里**只取读数、渲染、发 intent** —— 状态机语义全在
 * [PipelineState]（JVM 单测钉死），采集全在 [PipelineProbe]。探针期额外义务：
 * 每次③相关动作与深链结果都要落 [ProbeJournal]，定罪靠的是文件里的时间戳而非记忆。
 *
 * 纯代码布局（无 XML）：五行结构由状态机动态生成，写死 layout 反而两头维护。
 */
class OnboardingActivity : AppCompatActivity() {

    private val handler = Handler(Looper.getMainLooper())
    private val stepTexts = mutableMapOf<String, TextView>()
    private val stepButtons = mutableMapOf<String, MutableList<Button>>()
    private var s0ProbeBtn: Button? = null
    private var s2Btn: Button? = null
    private var lastReadings: PipelineReadings? = null
    @Volatile private var refreshInFlight = false

    private val requestNotif = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { refreshSoon() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildLayout())
        PipelineProbe.subscribe(onChange)
        refreshSoon()
        handler.post(poller)
    }

    override fun onDestroy() {
        PipelineProbe.unsubscribe(onChange)
        handler.removeCallbacks(poller)
        super.onDestroy()
    }

    // ---- 布局 ----

    private fun buildLayout(): View {
        val pad = (16f * resources.displayMetrics.density).toInt()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        col.addView(TextView(this).apply {
            text = "DSH 开场管线（探针版）"
            textSize = 20f
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, pad / 2)
        })
        col.addView(TextView(this).apply {
            text = "四项真机定罪进行中：行为以探针日志为准，勿据此页下结论"
            textSize = 12f
            setPadding(0, 0, 0, pad)
        })
        for (id in listOf(PipelineState.S0, PipelineState.S1, PipelineState.S2,
                PipelineState.S3, PipelineState.S4)) {
            val tv = TextView(this).apply { textSize = 15f; setPadding(0, pad / 2, 0, pad / 4) }
            stepTexts[id] = tv
            col.addView(tv)
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            val btns = mutableListOf<Button>()
            buttonsFor(id).forEach { b -> row.addView(b); btns += b }
            stepButtons[id] = btns
            col.addView(row)
        }
        col.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, pad, 0, 0)
            addView(Button(context).apply {
                text = "复制探针报告"
                setOnClickListener { copyReport() }
            })
            addView(Button(context).apply {
                text = "清空探针日志"
                setOnClickListener {
                    ProbeJournal.clear(this@OnboardingActivity)
                    toast("探针日志已清空")
                }
            })
        })
        return ScrollView(this).apply { addView(col) }
    }

    private fun buttonsFor(id: String): List<Button> = when (id) {
        PipelineState.S0 -> listOf(
            Button(this).apply {
                text = "配对探针 开/关"
                setOnClickListener { toggleProbe() }
                s0ProbeBtn = this
            },
            Button(this).apply {
                text = "去开无线调试"
                setOnClickListener { openWirelessDebugging() }
            },
        )
        PipelineState.S1 -> listOf(
            Button(this).apply {
                text = "经 ADB 激活"
                setOnClickListener { activateDeviceOwner() }
            },
            Button(this).apply {
                text = "复制命令"
                setOnClickListener { copyToClipboard("DO 命令", deviceOwnerCommand()) }
            },
        )
        PipelineState.S2 -> listOf(
            Button(this).apply {
                text = "补下一项权限"
                s2Btn = this
                setOnClickListener { requestNextPermission() }
            },
        )
        PipelineState.S3 -> listOf(
            Button(this).apply {
                text = "重试运行时"
                setOnClickListener { retryRuntime() }
            },
            Button(this).apply {
                text = "诊断页"
                setOnClickListener { startActivity(Intent(this@OnboardingActivity, MainActivity::class.java)) }
            },
        )
        PipelineState.S4 -> listOf(
            Button(this).apply {
                text = "进入工作台"
                setOnClickListener { startActivity(Intent(this@OnboardingActivity, MainActivity::class.java)) }
            },
        )
        else -> emptyList()
    }

    // ---- 采集与渲染（2s 轮询 + 事件即时刷新） ----

    private val onChange: () -> Unit = { refreshSoon() }
    private val poller = object : Runnable {
        override fun run() {
            refreshSoon()
            handler.postDelayed(this, POLL_MS)
        }
    }

    private fun refreshSoon() {
        if (refreshInFlight) return
        refreshInFlight = true
        Thread {
            val readings = runCatching { PipelineProbe.snapshot(this) }
                .getOrNull()
            refreshInFlight = false
            if (readings != null) handler.post { render(readings) }
        }.apply { isDaemon = true }.start()
    }

    private fun render(r: PipelineReadings) {
        lastReadings = r
        val steps = PipelineState.evaluate(r)
        for (s in steps) {
            val mark = when (s.status) {
                StepStatus.DONE -> "[完成]"
                StepStatus.ACTION -> "[待操作]"
                StepStatus.BLOCKED -> "[等待]"
                StepStatus.FAILED -> "[失败]"
            }
            stepTexts[s.id]?.text = "${s.id} ${s.title} $mark ${s.detail}"
        }
        s2Btn?.isEnabled = r.missingPermissions.isNotEmpty()
        // S0 按钮文案跟随服务状态；S4 未放行时按钮直接禁用（比点了没反应诚实）。
        s0ProbeBtn?.text = if (PairingProbeService.running) "停止配对探针" else "启动配对探针"
        stepButtons[PipelineState.S4]?.firstOrNull()?.isEnabled = PipelineState.workbenchOpen(steps)
    }

    // ---- 动作 ----

    private fun toggleProbe() {
        val svc = Intent(this, PairingProbeService::class.java)
        if (PairingProbeService.running) {
            svc.action = PairingProbeService.ACTION_STOP
        }
        startService(svc)
        handler.postDelayed({ refreshSoon() }, 800)
    }

    /** ③ 定罪动作：发深链 + 记账落点；ROM 不响应时逐级降级并如实写日志。 */
    private fun openWirelessDebugging() {
        ProbeJournal.deepLinkEmittedAt = System.currentTimeMillis()
        val attempts = listOf(
            Intent("android.settings.WIRELESS_DEBUGGING_SETTINGS"),
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).setData(Uri.parse("package:$packageName")),
        )
        for ((i, intent) in attempts.withIndex()) {
            val ok = runCatching { startActivity(intent) }.isSuccess
            ProbeJournal.append(this, "deeplink",
                if (ok) "第 ${i + 1} 级 intent 已发出（${intent.action}）—— 需人工确认落在哪一页"
                else "第 ${i + 1} 级 intent 无响应（${intent.action}）")
            if (ok) return
        }
    }

    private fun deviceOwnerCommand(): String =
        "dpm set-device-owner $packageName/${DeviceAdminReceiver::class.java.name}"

    /** S1 主路径：经已配对的 ADB shell 通道下发 dpm；失败把真实错误写进两份日志。 */
    private fun activateDeviceOwner() {
        toast("经 ADB 下发中…")
        Thread {
            val ctx = applicationContext
            val cmd = deviceOwnerCommand()
            val outcome = AdbClientRunner.shell(ctx, cmd, null, null, 20_000L)
            ProbeJournal.append(ctx, "s1", "dpm 下发 ${if (outcome.ok) "成功" else "失败"}：${outcome.error ?: outcome.raw.take(200)}")
            handler.post {
                toast(if (outcome.ok) "命令已执行，回读确认中" else "失败：${outcome.error?.take(80) ?: "见探针日志"}")
                refreshSoon()
            }
        }.apply { isDaemon = true }.start()
    }

    private fun requestNextPermission() {
        val missing = lastReadings?.missingPermissions.orEmpty()
        if (missing.isEmpty()) { toast("权限已全部就绪"); return }
        val spec = PermissionCatalog.ALL.first { it.id == missing.first() }
        when {
            spec.tier == PermTier.RUNTIME && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                spec.permission != null -> requestNotif.launch(spec.permission)
            spec.settingsAction != null -> {
                // 多数 AppOps 页以 package 数据定位到「本应用」，个别（通知使用权）不吃 data，
                // 被拒时去掉 data 重发一次，两级都失败才承认 ROM 没这个入口。
                val withData = runCatching {
                    startActivity(Intent(spec.settingsAction).setData(Uri.parse("package:$packageName")))
                }.isSuccess
                if (!withData) runCatching { startActivity(Intent(spec.settingsAction)) }
                    .onFailure { toast("授权页打不开：${spec.label}") }
            }
            else -> toast("缺少引导入口：${spec.label}")
        }
    }

    private fun retryRuntime() {
        ContainerSupervisor.ensureRunning(this)
        val svc = Intent(this, NodeRuntimeService::class.java)
            .setAction(NodeRuntimeService.ACTION_RESTART)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svc)
        else startService(svc)
        toast("已请求重启运行时 —— 细节日志看诊断页")
    }

    private fun copyReport() {
        toast("报告生成中…")
        Thread {
            val ctx = applicationContext
            val report = buildString {
                appendLine("== DSH 开场管线探针报告 ==")
                appendLine("${Build.MANUFACTURER} ${Build.MODEL} · API ${Build.VERSION.SDK_INT} · APK ${BuildConfig.VERSION_NAME}#${BuildConfig.VERSION_CODE}")
                appendLine(ProbeJournal.verdicts())
                appendLine("---- probe-journal ----")
                appendLine(ProbeJournal.readAll(ctx))
            }
            handler.post { copyToClipboard("探针报告", report); refreshSoon() }
        }.apply { isDaemon = true }.start()
    }

    private fun copyToClipboard(label: String, text: String) {
        runCatching {
            (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                .setPrimaryClip(ClipData.newPlainText(label, text))
            toast("已复制 —— 设备 adb 关闭，剪贴板是唯一导出通道")
        }.onFailure { toast("复制失败：${it.message}") }
    }

    private fun toast(msg: String) =
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    companion object {
        private const val POLL_MS = 2_000L
    }
}
