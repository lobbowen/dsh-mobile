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
import io.github.lobbowen.dshmobile.capability.AdbChannelProbe
import io.github.lobbowen.dshmobile.capability.BridgeTokens
import io.github.lobbowen.dshmobile.capability.CapabilityAcquisitionRunner
import io.github.lobbowen.dshmobile.capability.CapabilityCatalog
import io.github.lobbowen.dshmobile.capability.CapabilityEvidenceCollector
import io.github.lobbowen.dshmobile.capability.CapabilityNavigation
import io.github.lobbowen.dshmobile.capability.Evidence
import io.github.lobbowen.dshmobile.capability.OnboardingFlow
import io.github.lobbowen.dshmobile.capability.PipelineProjection
import io.github.lobbowen.dshmobile.capability.PipelineRefresh
import io.github.lobbowen.dshmobile.capability.StageStatus
import io.github.lobbowen.dshmobile.capability.StepStatus

/**
 * 开场首页：渲染 [OnboardingFlow] 的六张阶段卡（**当前阶段 + 一个动作**），下面是 S0–S4
 * 判据核对（[PipelineProjection] 的段行，探针期兼作证据出口）。
 *
 * 职责边界（ui-onboarding-spec §4）：这里只渲染枚举、按 [Acquisition.kind] 把动作转交
 * capability 层。判据、命令、intent 目标、按钮文案全部来自登记表；「下一步是什么」来自
 * 阶段机 —— 首页不再自己推断顺序（v1 的 `buttonsFor(stepId)` 与「每段一个随机待办按钮」
 * 就是自己推断的产物，真机上从 S0 就走不下去）。
 *
 * 纯代码布局（无 XML）：行结构由阶段机动态生成，写死 layout 反而两头维护。
 */
class OnboardingActivity : AppCompatActivity() {

    private val handler = Handler(Looper.getMainLooper())
    private val stageTexts = mutableMapOf<String, TextView>()
    private val stageButtons = mutableMapOf<String, Button>()
    private val stageExtraButtons = mutableMapOf<String, Button>()
    private var criteriaText: TextView? = null
    private var enterBtn: Button? = null
    private var lastEvidence: Evidence? = null

    @Volatile private var refreshInFlight = false
    @Volatile private var actionInFlight = false
    /** 自动跳转只做一次；入口重新变红时才解锁（否则从面板回来会被再次弹走）。 */
    private var autoEntered = false
    /** F3 的底座自动挂起也只试一次，避免被拒后每 2s 起一次服务。 */
    private var wizardAutoStarted = false

    /** 本次 RUNTIME_DIALOG 申请的权限名；launcher 全页面共用，回调里靠它归因。 */
    private var pendingRuntimePerm: String? = null

    private val requestRuntimePerm = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        val perm = pendingRuntimePerm
        pendingRuntimePerm = null
        if (!granted) openAppDetailsAfterDenial(perm)
        refreshSoon()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildLayout())
        PipelineRefresh.subscribe(onChange)
    }

    /**
     * 回前台是**最强的新鲜度事件**：用户可能刚在设置页把开关拨了、刚给完权限，
     * 也可能端口已经轮换过一轮。作废通道缓存并立即重采，不等 TTL（flow-spec §2.3）。
     */
    override fun onResume() {
        super.onResume()
        AdbChannelProbe.invalidate()
        refreshSoon()
        handler.post(poller)
    }

    override fun onPause() {
        handler.removeCallbacks(poller)
        super.onPause()
    }

    override fun onDestroy() {
        PipelineRefresh.unsubscribe(onChange)
        handler.removeCallbacks(poller)
        super.onDestroy()
    }

    // ---- 布局：阶段卡六行 + 判据核对 + 探针期导出通道 ----

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
        for (stage in OnboardingFlow.SKELETON) {
            val tv = TextView(this).apply {
                textSize = 15f
                setPadding(0, pad / 2, 0, 0)
                text = "${stage.id} ${stage.title}"
            }
            stageTexts[stage.id] = tv
            col.addView(tv)
            col.addView(TextView(this).apply {
                textSize = 12f
                setPadding(pad / 2, 0, 0, pad / 4)
                text = stage.why
            })
            // 每行一律给一个动作按钮：F5 的动作可能是「重启运行时」（AUTO）。
            // 次要按钮只挂在阶段机给出的那一行（冲刺欠账 / F6 补齐），主按钮全页至多一个。
            // 「进入工作台」是入口本身，另置一个按钮，未放行时禁用（比点了没反应诚实）。
            val btn = Button(this).apply { visibility = View.GONE }
            stageButtons[stage.id] = btn
            col.addView(btn)
            val extra = Button(this).apply { visibility = View.GONE }
            stageExtraButtons[stage.id] = extra
            col.addView(extra)
            if (stage.id == OnboardingFlow.F5) {
                enterBtn = Button(this).apply {
                    text = "进入工作台"
                    visibility = View.GONE
                    isEnabled = false
                    setOnClickListener { openWorkbench() }
                }
                col.addView(enterBtn)
            }
        }
        criteriaText = TextView(this).apply {
            textSize = 11f
            setPadding(0, pad, 0, 0)
        }
        col.addView(criteriaText)
        // 探针期义务：设备侧 adb 已关，剪贴板是唯一证据出口。报告同时带判据结论与配对案底，
        // 便于核对「首页说的」与「日志做的」是否一致。
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
        val verdicts = CapabilityCatalog.evaluate(e)
        val stages = OnboardingFlow.stages(e, verdicts)
        for (s in stages) {
            val tv = stageTexts[s.id] ?: continue
            val blocked = PairingProbeService.instance?.notificationBlocked == true &&
                s.id == OnboardingFlow.F3
            tv.text = "${s.id} ${s.title} ${mark(s.status)}" +
                (if (blocked) " 通知权限缺失 → 回到上一步" else "") +
                (if (s.detail.isBlank()) "" else "｜${s.detail}")
            val acq = s.action
            val btn = stageButtons[s.id] ?: continue
            btn.visibility = if (acq == null) View.GONE else View.VISIBLE
            btn.text = acq?.label ?: ""
            btn.isEnabled = true
            if (acq != null) btn.setOnClickListener { dispatch(s.actionCapId ?: "", acq, btn) }
            val sec = s.extra
            val extra = stageExtraButtons[s.id] ?: continue
            extra.visibility = if (sec == null) View.GONE else View.VISIBLE
            extra.text = sec?.let { "补：${it.label}" } ?: ""
            extra.isEnabled = true
            if (sec != null) extra.setOnClickListener { dispatch(s.extraCapId ?: "", sec, extra) }
        }
        val ready = OnboardingFlow.readyToEnter(verdicts)
        enterBtn?.visibility = if (ready) View.VISIBLE else View.GONE
        enterBtn?.isEnabled = ready
        if (ready && !autoEntered) {
            autoEntered = true
            openWorkbench()
        } else if (!ready) {
            autoEntered = false
        }
        // 前置齐了就自动挂出输码通知（flow-spec §2.1 F3：不等人点「开始配对」）。
        // 认「唯一可动作行」而不是某个状态：失败重试那一步同样是当前步。
        val cur = stages.firstOrNull { it.action != null }
        if (cur?.id == OnboardingFlow.F3 && cur.action?.kind == AcquireKind.USER_CODE &&
            !PairingProbeService.running && !wizardAutoStarted
        ) {
            wizardAutoStarted = true
            startPairingWizard()
        }
        criteriaText?.text = "判据核对：" +
            PipelineProjection.project(e, verdicts).joinToString("  ") {
                "${it.id}${segMark(it.status)}${it.detail}"
            }
    }

    private fun mark(s: StageStatus): String = when (s) {
        StageStatus.DONE -> "[完成]"
        StageStatus.CURRENT -> "[下一步]"
        StageStatus.NEXT -> "[待办]"
        StageStatus.BLOCKED -> "[等待]"
        StageStatus.FAILED -> "[失败]"
        StageStatus.UNREACHABLE -> "[不可得]"
    }

    /** 判据核对行（段投影）的标记：与阶段卡的词分开，两处口径不同不要混用。 */
    private fun segMark(s: StepStatus): String = when (s) {
        StepStatus.DONE -> "[完成]"
        StepStatus.ACTION -> "[待办]"
        StepStatus.BLOCKED -> "[等待]"
        StepStatus.FAILED -> "[失败]"
        StepStatus.UNREACHABLE -> "[不可得]"
    }

    // ---- 动作：一律转交 capability 层 ----

    private fun dispatch(capId: String, acq: Acquisition, btn: Button) {
        when (acq.kind) {
            AcquireKind.USER_CODE -> startPairingWizard()
            AcquireKind.RUNTIME_DIALOG -> requestRuntimePermission(acq)
            AcquireKind.USER_TAP -> {
                val jumped = CapabilityNavigation.launch(this, acq) { note ->
                    ProbeJournal.append(this, "deeplink", "$capId ${acq.label}：$note")
                }
                if (!jumped) toast("授权页打不开：${acq.label}")
            }
            else -> runAcquisition(capId, acq, btn)
        }
        // 发完动作立刻补一次采集：用户可能在设置页里已经把这一步做完了。
        handler.postDelayed({ refreshSoon() }, REFRESH_AFTER_TAP_MS)
    }

    private fun requestRuntimePermission(acq: Acquisition) {
        val perm = CapabilityNavigation.runtimePermission(acq)
        if (perm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pendingRuntimePerm = perm
            requestRuntimePerm.launch(perm)
        } else {
            toast("本机系统不需要这一步")
        }
    }

    /**
     * 拒绝之后弹窗不会再来：这里若不跳详情页，F1 的主按钮就成了按了没反应的谎言
     * （与 `PairingProbeService.startProbe` 对 `notify()` 的自证同一条理由）。
     */
    private fun openAppDetailsAfterDenial(perm: String?) {
        if (perm == null) return
        ProbeJournal.append(
            this, "perm",
            "$perm 弹窗结果=未授予（多半勾了「不再询问」）→ 跳本应用详情页，给一条能走的路",
        )
        val jumped = runCatching { startActivity(CapabilityNavigation.appDetailsIntent(this)) }.isSuccess
        if (!jumped) toast("系统权限页打不开：$perm 需手动开启")
    }

    private fun runAcquisition(capId: String, acq: Acquisition, btn: Button) {
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
                    ProbeJournal.append(ctx, "acq", "$capId ${acq.label}：$it")
                    toast(if (result.verified) "已生效" else it)
                }
                refreshSoon()
            }
        }.apply { isDaemon = true }.start()
    }

    /** F3 的底座：起 mDNS 监听 + 输码通知。缺通知权限时服务会自己退回 F1（PairingProbeService）。 */
    private fun startPairingWizard() {
        startService(Intent(this, PairingProbeService::class.java))
        handler.postDelayed({ refreshSoon() }, REFRESH_AFTER_TAP_MS)
    }

    /** 控制面板 / 灾难兜底诊断页同帧（MainActivity）：入口绿是面板，S3 红时它是唯一证据出口。 */
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
                    val verdicts = CapabilityCatalog.evaluate(e)
                    appendLine("---- 流程阶段 ----")
                    OnboardingFlow.stages(e, verdicts).forEach {
                        appendLine("${it.id} ${it.title} ${it.status} ${it.detail}")
                    }
                    appendLine("---- 能力判据 ----")
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

        /** 发完动作后的补采时刻（真正的实时性由 onResume / PipelineRefresh / 探针事件保证）。 */
        private const val REFRESH_AFTER_TAP_MS = 800L
    }
}
