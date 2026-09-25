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
import android.app.admin.DevicePolicyManager
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
 * 管线首页（G1-1，spec §2/§5）：S0–S4 五行状态 + 每行的用户动作。
 * S0 是配对向导态：单一「开始配对」入口 → 三步实况（监听/去配对页/通知输码），
 * 探针服务只是底座，不裸露开关给用户。
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
    private var s0StartBtn: Button? = null
    private var s0GoBtn: Button? = null
    private var s0CancelBtn: Button? = null
    private var s0WizardText: TextView? = null
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
            if (id == PipelineState.S0) {
                // 配对向导实况占位：三步进度单行滚动刷新，只在向导态可见。
                s0WizardText = TextView(this).apply {
                    textSize = 13f
                    setPadding(pad / 2, 0, 0, pad / 4)
                    visibility = View.GONE
                }
                col.addView(s0WizardText)
            }
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
                text = "开始配对"
                setOnClickListener { startPairingWizard() }
                s0StartBtn = this
            },
            Button(this).apply {
                // PLP120 定罪：无线调试深链无 Activity 响应，可解析落点只有开发者选项页 —— 文案与事实一致。
                text = "去开发者选项页"
                setOnClickListener { openPairingSettings() }
                s0GoBtn = this
            },
            Button(this).apply {
                text = "退出配对"
                setOnClickListener { cancelPairingWizard() }
                s0CancelBtn = this
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
        // S0 向导态机：配对成功→整段收起；服务在线→实况三步；否则只留唯一入口按钮。
        val wizardOn = !r.adbPaired && PairingProbeService.running
        s0StartBtn?.visibility = if (r.adbPaired || wizardOn) View.GONE else View.VISIBLE
        s0GoBtn?.visibility = if (wizardOn) View.VISIBLE else View.GONE
        s0CancelBtn?.visibility = if (wizardOn) View.VISIBLE else View.GONE
        s0WizardText?.apply {
            visibility = if (wizardOn) View.VISIBLE else View.GONE
            if (wizardOn) text = wizardStatusText()
        }
        // S4 未放行时按钮直接禁用（比点了没反应诚实）。
        stepButtons[PipelineState.S4]?.firstOrNull()?.isEnabled = PipelineState.workbenchOpen(steps)
    }

    // ---- 动作 ----

    /**
     * S0 向导唯一入口：起底座（PairingProbeService = mDNS 监听 + 通知输码），
     * 本页随即进入实况态。服务侧 startProbe 幂等自行处理重复启动。
     */
    private fun startPairingWizard() {
        startService(Intent(this, PairingProbeService::class.java))
        handler.postDelayed({ refreshSoon() }, 500)
    }

    private fun cancelPairingWizard() {
        startService(Intent(this, PairingProbeService::class.java)
            .setAction(PairingProbeService.ACTION_STOP))
        ProbeJournal.append(this, "wizard", "用户退出配对向导")
        handler.postDelayed({ refreshSoon() }, 500)
    }

    /**
     * ③ 定罪动作：发深链 + 记账落点；ROM 不响应时逐级降级并如实写日志。
     * 真机定罪（2026-09-25，PLP120）：第 1 级 AOSP intent 在 ColorOS 无 Activity 响应；
     * 第 2 级必须是开发者选项页（可解析），应用信息页曾把用户带离配对路径。
     * 开发者选项未开时第 1 级必然无响应、且落点就该是开发者选项页 —— 直接走第 2 级。
     */
    private fun openPairingSettings() {
        ProbeJournal.deepLinkEmittedAt = System.currentTimeMillis()
        val devOff = lastReadings?.devOptionsOn != true
        val attempts = listOf(
            Intent("android.settings.WIRELESS_DEBUGGING_SETTINGS"),
            Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS),
        )
        for ((i, intent) in attempts.withIndex()) {
            if (devOff && i == 0) continue
            val ok = runCatching { startActivity(intent) }.isSuccess
            ProbeJournal.append(this, "deeplink",
                if (ok) "第 ${i + 1} 级 intent 已发出（${intent.action}）—— 需人工确认落在哪一页"
                else "第 ${i + 1} 级 intent 无响应（${intent.action}）")
            if (ok) return
        }
    }

    /** 向导实况 —— 只叙述 service 回报的事实，不做推断；前置（⓪）未就绪时先讲前置。 */
    private fun wizardStatusText(): String {
        val r = lastReadings
        if (r != null && !r.devOptionsOn)
            return "⓪ 请先开启开发者选项 —— 点「去开发者选项页」，打开顶部开关后回来"
        if (r != null && !r.wirelessDebugOn)
            return "⓪ 请先开启无线调试 —— 点「去开发者选项页」→ 打开「无线调试」开关，然后重按「开始配对」"
        val svc = PairingProbeService.instance
            ?: return "底座未在线（重按「开始配对」）"
        return when {
            svc.pairingInFlight -> "③ 配对进行中…（${svc.portText}）"
            svc.codeArrived && svc.lastPairingError != null ->
                "③ 配对失败：${svc.lastPairingError?.take(80)} —— 重新输码可再试"
            svc.codeArrived -> "③ 码已送达，等待结果…"
            svc.portFound -> "② ✓ 已监听到配对端口 ${svc.portText} —— 下拉通知栏「输入配对码」"
            else -> "① 监听中，暂未看到配对端口 —— 请让「使用配对码配对设备」对话框保持打开"
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
            // dpm 报错（如 ColorOS 多用户拒绝 set-device-owner）时 exit 仍是 0，光看 outcome.ok
            // 会假报成功（真机 2026-09-25 17:12:15）。唯一真值 = 系统侧 isDeviceOwnerApp 回读。
            val ownerNow = runCatching {
                (ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager)
                    ?.isDeviceOwnerApp(ctx.packageName) == true
            }.getOrDefault(false)
            val verdict = when {
                !outcome.ok -> "失败：${outcome.error ?: outcome.raw.take(200)}"
                ownerNow -> "成功：DO 已生效"
                else -> "未生效：${dpmErrorLine(outcome.raw).take(180)}"
            }
            ProbeJournal.append(ctx, "s1", "dpm 下发 $verdict")
            handler.post {
                toast(if (ownerNow) "DO 已生效" else verdict)
                refreshSoon()
            }
        }.apply { isDaemon = true }.start()
    }

    /** dpm 的拒绝理由藏在 stdout 的 Exception 行里，挑出来给人看的那一行。 */
    private fun dpmErrorLine(raw: String): String =
        raw.lineSequence().firstOrNull { "Exception" in it || "error" in it.lowercase() }
            ?: raw.trim().ifBlank { "无输出" }

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
