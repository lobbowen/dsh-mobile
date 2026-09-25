package io.github.lobbowen.dshmobile.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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
import io.github.lobbowen.dshmobile.capability.AcquireKind
import io.github.lobbowen.dshmobile.capability.Acquisition
import io.github.lobbowen.dshmobile.capability.BridgeTokens
import io.github.lobbowen.dshmobile.capability.CapabilityAcquisitionRunner
import io.github.lobbowen.dshmobile.capability.CapabilityCatalog
import io.github.lobbowen.dshmobile.capability.CapabilityEvidenceCollector
import io.github.lobbowen.dshmobile.capability.CapabilityNavigation
import io.github.lobbowen.dshmobile.capability.CapStatus
import io.github.lobbowen.dshmobile.capability.CredentialsState
import io.github.lobbowen.dshmobile.capability.Evidence
import io.github.lobbowen.dshmobile.capability.PipelineProjection
import io.github.lobbowen.dshmobile.capability.PipelineRefresh
import io.github.lobbowen.dshmobile.capability.PipelineStep
import io.github.lobbowen.dshmobile.capability.StepStatus

/**
 * 开场管线首页（spec §1/§5）：段投影五行 + 每行**一个**动作 + 一个工作台入口。
 *
 * 职责边界（spec §4 分层表）：这里只渲染 [PipelineProjection] 给出的枚举，并按
 * [Acquisition.kind] 把动作转交 capability 层 —— 判据、命令、intent 目标、按钮文案
 * 全部来自登记表。v1 在此处硬编码 `buttonsFor(stepId)` 并就地拼 `dpm` 命令，
 * 是「GUI 只管跑通、不管逻辑归属」的直接产物。
 *
 * 纯代码布局（无 XML）：行结构由段投影动态生成，写死 layout 反而两头维护。
 */
class OnboardingActivity : AppCompatActivity() {

    private val handler = Handler(Looper.getMainLooper())
    private val rowTexts = mutableMapOf<String, TextView>()
    private val rowButtons = mutableMapOf<String, Button>()
    private var wizardText: TextView? = null
    private var diagnosticsBtn: Button? = null
    private var steps: List<PipelineStep> = emptyList()
    private var lastEvidence: Evidence? = null

    @Volatile private var refreshInFlight = false
    @Volatile private var actionInFlight = false

    private val requestRuntimePerm = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { refreshSoon() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildLayout())
        PipelineRefresh.subscribe(onChange)
        refreshSoon()
        handler.post(poller)
    }

    override fun onDestroy() {
        PipelineRefresh.unsubscribe(onChange)
        handler.removeCallbacks(poller)
        super.onDestroy()
    }

    // ---- 布局：一段一行，一行一个动作 ----

    private fun buildLayout(): View {
        val pad = (16f * resources.displayMetrics.density).toInt()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        col.addView(TextView(this).apply {
            text = "DSH 工作台"
            textSize = 20f
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, pad / 2)
        })
        for (seg in listOf(
            CapabilityCatalog.S0, CapabilityCatalog.S1, CapabilityCatalog.S2,
            CapabilityCatalog.S3, PipelineProjection.S4,
        )) {
            val tv = TextView(this).apply { textSize = 15f; setPadding(0, pad / 2, 0, pad / 4) }
            rowTexts[seg] = tv
            col.addView(tv)
            if (seg == CapabilityCatalog.S0) {
                // 向导实况：只叙述 service 回报的事实，不在此推断（推断归判据层）。
                wizardText = TextView(this).apply {
                    textSize = 13f
                    setPadding(pad / 2, 0, 0, pad / 4)
                    visibility = View.GONE
                }
                col.addView(wizardText)
            }
            val btn = Button(this).apply { visibility = View.GONE }
            rowButtons[seg] = btn
            col.addView(btn)
            if (seg == CapabilityCatalog.S3) {
                // 灾难兜底页只在 S3 未绿时可达（spec §1：其余时刻首页只讲状态与入口）。
                diagnosticsBtn = Button(this).apply {
                    text = "诊断页"
                    visibility = View.GONE
                    setOnClickListener { openWorkbench() }
                }
                col.addView(diagnosticsBtn)
            }
        }
        // 探针期义务：设备侧 adb 已关，剪贴板是唯一证据出口。定罪靠文件里的时间戳，
        // 不靠记忆 —— 报告同时带判据结论，便于核对「首页说的」与「日志做的」是否一致。
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

    // ---- 采集与渲染 ----

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
            val snapshot = runCatching { CapabilityEvidenceCollector.collect(this) }.getOrNull()
            refreshInFlight = false
            if (snapshot != null) handler.post { render(snapshot) }
        }.apply { isDaemon = true }.start()
    }

    private fun render(e: Evidence) {
        lastEvidence = e
        steps = PipelineProjection.project(e, CapabilityCatalog.evaluate(e))
        for (s in steps) {
            rowTexts[s.id]?.text = "${s.id} ${s.title} ${mark(s.status)} ${s.detail}"
            val btn = rowButtons[s.id] ?: continue
            btn.setOnClickListener { onAction(s, btn) }
            if (s.id == PipelineProjection.S4) {
                // S4 是入口本身：文案固定，未放行就禁用（比点了没反应诚实）。
                btn.visibility = View.VISIBLE
                btn.text = "进入工作台"
                btn.isEnabled = s.status == StepStatus.DONE
            } else {
                btn.visibility = if (s.pending == null) View.GONE else View.VISIBLE
                btn.text = s.pending?.label ?: ""
                btn.isEnabled = true
            }
        }
        diagnosticsBtn?.visibility =
            if (stepOf(CapabilityCatalog.S3)?.status == StepStatus.DONE) View.GONE else View.VISIBLE
        renderWizard(e)
    }

    private fun mark(s: StepStatus): String = when (s) {
        StepStatus.DONE -> "[完成]"
        StepStatus.ACTION -> "[待操作]"
        StepStatus.BLOCKED -> "[等待]"
        StepStatus.FAILED -> "[失败]"
        StepStatus.UNREACHABLE -> "[不可得]"
    }

    private fun stepOf(id: String): PipelineStep? = steps.firstOrNull { it.id == id }

    /**
     * S0 向导只在「凭据未在册且底座在线」时占屏；前置未就绪时先讲前置 —— 文案直接取
     * 登记表里那两项的 detail，不在这里重判一遍条件（v1 在此复制过一遍前置判断）。
     */
    private fun renderWizard(e: Evidence) {
        val tv = wizardText ?: return
        if (e.credentials == CredentialsState.PAIRED || !PairingProbeService.running) {
            tv.visibility = View.GONE
            return
        }
        tv.visibility = View.VISIBLE
        val verdicts = CapabilityCatalog.evaluate(e)
        val gap = listOf(CapabilityCatalog.DEV_OPTIONS, CapabilityCatalog.WIRELESS_DEBUG)
            .firstOrNull { verdicts[it]?.status != CapStatus.GRANTED }
        if (gap != null) {
            tv.text = "前置未就绪：" + CapabilityCatalog.titleOf(gap) + " —— " +
                (verdicts[gap]?.detail ?: "")
            return
        }
        val svc = PairingProbeService.instance
        // 失败读数只认**本轮**的（AttemptStore 是类型化事实，不是文案猜测）。
        val failed = e.pairAttempt?.takeIf { !it.ok && it.atMs >= (svc?.roundStartMs ?: 0L) }
        tv.text = when {
            svc == null -> "底座未在线（重按「开始配对」）"
            svc.pairingInFlight -> "③ 配对进行中…（${svc.portText}）"
            failed != null -> "③ 配对失败：" + failed.reason.take(80) + " —— 重新输码可再试"
            svc.codeArrived -> "③ 码已送达，等待结果…"
            svc.portFound -> "② ✓ 已监听到配对端口 ${svc.portText} —— 下拉通知栏「输入配对码」"
            else -> "① 监听中，暂未看到配对端口 —— 请让「使用配对码配对设备」对话框保持打开"
        }
    }

    // ---- 动作：一律转交 capability 层 ----

    private fun onAction(step: PipelineStep, btn: Button) {
        if (step.id == PipelineProjection.S4) {
            if (step.status == StepStatus.DONE) openWorkbench()
            // 未放行时按钮已禁用；此分支不落 else，避免「点了没反应」。
            return
        }
        val acq = step.pending ?: return
        when (acq.kind) {
            AcquireKind.USER_CODE -> startPairingWizard()
            AcquireKind.RUNTIME_DIALOG -> requestRuntimePermission(acq)
            AcquireKind.USER_TAP -> {
                val jumped = CapabilityNavigation.launch(this, acq) { note ->
                    ProbeJournal.append(this, "deeplink",
                        "${step.pendingCapId} ${acq.label}：$note")
                }
                ProbeJournal.append(this, "deeplink",
                    "${step.pendingCapId} ${acq.label}：${if (jumped) "intent 已发出" else "无响应"}")
                if (!jumped) toast("授权页打不开：${acq.label}")
                handler.postDelayed({ refreshSoon() }, REFRESH_AFTER_TAP_MS)
            }
            else -> runAcquisition(step, acq, btn)
        }
    }

    private fun requestRuntimePermission(acq: Acquisition) {
        val perm = CapabilityNavigation.runtimePermission(acq)
        if (perm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestRuntimePerm.launch(perm)
        } else {
            toast("本机系统不需要这一步")
        }
    }

    private fun runAcquisition(step: PipelineStep, acq: Acquisition, btn: Button) {
        if (actionInFlight) return
        actionInFlight = true
        btn.isEnabled = false
        toast("${acq.label} 执行中…")
        Thread {
            val ctx = applicationContext
            val result = runCatching { CapabilityAcquisitionRunner.dispatch(ctx, acq) }.getOrNull()
            handler.post {
                actionInFlight = false
                btn.isEnabled = true
                result?.detail?.let {
                    ProbeJournal.append(ctx, "acq", "${step.pendingCapId} ${acq.label}：$it")
                    toast(if (result.verified) "已生效" else it)
                }
                refreshSoon()
            }
        }.apply { isDaemon = true }.start()
    }

    /** S0 向导唯一入口：起底座（mDNS 监听 + 通知输码），配对结果经 AttemptStore 类型化回流。 */
    private fun startPairingWizard() {
        startService(Intent(this, PairingProbeService::class.java))
        handler.postDelayed({ refreshSoon() }, REFRESH_AFTER_TAP_MS)
    }

    /** 控制面板 / 灾难兜底诊断页同帧（MainActivity）：S4 绿是面板，S3 红时它是唯一证据出口。 */
    private fun openWorkbench() {
        startActivity(Intent(this, MainActivity::class.java))
    }

    /**
     * 探针报告：判据结论（能力登记表原样）+ 定罪案底（[ProbeJournal]）。
     * 读文件与拼串放后台线程 —— 主线程只做剪贴板写入。
     */
    private fun copyReport() {
        val e = lastEvidence
        toast("报告生成中…")
        Thread {
            val ctx = applicationContext
            val report = buildString {
                appendLine("== DSH 开场管线报告 ==")
                appendLine("${Build.MANUFACTURER} ${Build.MODEL} · API ${Build.VERSION.SDK_INT} · " +
                    "APK ${BuildConfig.VERSION_NAME}#${BuildConfig.VERSION_CODE}")
                if (e != null) {
                    appendLine("---- 能力判据 ----")
                    val verdicts = CapabilityCatalog.evaluate(e)
                    CapabilityCatalog.ALL.forEach { c ->
                        val v = verdicts[c.id]
                        appendLine(
                            "${c.segment} ${c.id}${if (c.optional) "*" else ""} " +
                                "${v?.status} ${v?.detail}｜取法 " +
                                c.acquirer(e).joinToString(">") { it.label }
                        )
                    }
                    appendLine("桥令牌：" + BridgeTokens.from(e).sorted().joinToString())
                }
                appendLine("---- 四项定罪 ----")
                appendLine(ProbeJournal.verdicts())
                appendLine("---- probe-journal ----")
                appendLine(ProbeJournal.readAll(ctx))
            }
            handler.post {
                runCatching {
                    (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                        .setPrimaryClip(ClipData.newPlainText("DSH 管线报告", report))
                    toast("已复制 —— 设备 adb 关闭，剪贴板是唯一导出通道")
                }.onFailure { toast("复制失败：${it.message}") }
            }
        }.apply { isDaemon = true }.start()
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    companion object {
        private const val POLL_MS = 2_000L

        /** 发完 intent 后补一次采集：用户可能在设置页里已经把这一步做完了。 */
        private const val REFRESH_AFTER_TAP_MS = 600L
    }
}
