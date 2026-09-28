package lobos.ui.setup

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import lobos.BuildConfig
import lobos.ChannelStatusText
import lobos.MainActivity
import lobos.capability.AcquireKind
import lobos.capability.Acquisition
import lobos.capability.AdbChannelProbe
import lobos.capability.AttemptStore
import lobos.capability.BridgeTokens
import lobos.capability.CapabilityAcquisitionRunner
import lobos.capability.CapabilityCatalog
import lobos.capability.CapabilityEvidenceCollector
import lobos.capability.CapabilityNavigation
import lobos.capability.CapVerdict
import lobos.capability.Evidence
import lobos.capability.OnboardingFlow
import lobos.capability.PairingGate
import lobos.capability.PermissionSprint
import lobos.capability.PipelineProjection
import lobos.capability.PipelineRefresh
import lobos.capability.PostPairingAutoFlow
import lobos.capability.StageStatus
import lobos.capability.StepStatus
import lobos.lifecycle.ResidencyAudit
import lobos.ui.PairingProbeService
import lobos.ui.ProbeJournal

/**
 * 开场首页：渲染 [OnboardingFlow] 的两张阶段卡（**当前阶段 + 一个动作**），下面是 S0–S4
 * 判据核对（[PipelineProjection] 的段行，探针期兼作证据出口）。
 *
 * 开屏的**授权冲刺不在这里出现**：P0（[PermissionSprint]）在每次采集后静默把「还该要的
 * 第一项」抛给系统弹窗/系统授权页，界面上没有一排「请先授权」的卡 —— 用户第一眼看到的
 * 就是 F1「开始配对」（onboarding-flow-spec §2）。
 *
 * 职责边界（ui-onboarding-spec §4）：这里只渲染枚举、按 [Acquisition.kind] 把动作转交
 * capability 层。判据、命令、intent 目标、按钮文案全部来自登记表；「下一步是什么」来自
 * 阶段机 —— 首页不再自己推断顺序（v1 的 `buttonsFor(stepId)` 与「每段一个随机待办按钮」
 * 就是自己推断的产物，真机上从 S0 就走不下去）。
 *
 * 纯代码布局（无 XML）：行结构由阶段机动态生成，写死 layout 反而两头维护。
 */
class SetupActivity : AppCompatActivity() {

    private val handler = Handler(Looper.getMainLooper())
    private val stageTexts = mutableMapOf<String, TextView>()
    private val stageButtons = mutableMapOf<String, Button>()
    private var criteriaText: TextView? = null
    private var recentText: TextView? = null
    /** 顶部通道状态条：channelLive()==false 时红条常驻，可点重测。 */
    private var channelBar: TextView? = null
    /** 自动流的进度文案（只有一行，不产生按钮）。 */
    private var progressText: TextView? = null
    /** F4 折叠欠账：一行摘要 + 展开明细（都不是入口动作）。 */
    private var debtsText: TextView? = null
    private var debtsDetail: TextView? = null
    private var enterBtn: Button? = null
    private var lastEvidence: Evidence? = null
    /** 本次前台会话里自动流已尝试过的能力 id；plan 减去它 = 还欠的静默项（可重入）。 */
    private val autoFlowAttempted = mutableSetOf<String>()
    /** 自动流是否正在跑（防重入：多条 settings 下发不许并发）。 */
    @Volatile private var autoFlowRunning = false
    /** 最近一次自动流结论文案。 */
    private var autoFlowNotice = ""

    @Volatile private var refreshInFlight = false
    @Volatile private var actionInFlight = false
    /** 本次开屏已经抛过问题的授权项。见 [lobos.capability.PermissionSprint.pending]。 */
    private val sprintAsked = mutableSetOf<String>()
    /** 冲刺链一次只走一步：等系统把上一步的结果交回来再继续。 */
    @Volatile private var sprintWaiting = false
    /** 只有可见（resumed）时才允许冲刺继续抛系统页。 */
    @Volatile private var resumed = false
    /** 配对冻结到期时刻（单调钟）；见 [startPairing] 的 R6 说明。 */
    @Volatile private var sprintFrozenUntilMs = 0L

    /** 本次 RUNTIME_DIALOG 申请的权限名；launcher 全页面共用，回调里靠它归因。 */
    private var pendingRuntimePerm: String? = null

    private val requestRuntimePerm = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        val perm = pendingRuntimePerm
        pendingRuntimePerm = null
        if (!granted) openAppDetailsAfterDenial(perm)
        sprintWaiting = false
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
        resumed = true
        // 用户刚在系统页里做完（或拒掉）一步 → 冲刺链可以继续走下一步了。
        sprintWaiting = false
        AdbChannelProbe.invalidate()
        refreshSoon()
        handler.post(poller)
    }

    override fun onPause() {
        // 暂停期间绝不再抛新的系统页：那会把用户刚打开的授权页压在下面。
        resumed = false
        handler.removeCallbacks(poller)
        super.onPause()
    }

    override fun onDestroy() {
        PipelineRefresh.unsubscribe(onChange)
        handler.removeCallbacks(poller)
        super.onDestroy()
    }

    // ---- 布局：通道状态条 + 阶段卡两行 + 自动流进度 + 折叠欠账 + 判据核对 + 探针期导出通道 ----

    private fun buildLayout(): View {
        val pad = (16f * resources.displayMetrics.density).toInt()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        col.addView(TextView(this).apply {
            text = "Lob OS 工作台"
            textSize = 20f
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, pad / 2)
        })
        // 「刚刚发生了什么」常驻在标题下面：配对发生在系统页 + 通知栏里，用户回到本界面时
        // 第一眼必须看到上一次尝试的结论，而不是从阶段卡里自己反推（真机定罪 2026-09-26
        // 「回到界面又不知道点什么」）。文案与通知共用 AttemptStore 那一份，两处不许各说各话。
        recentText = TextView(this).apply {
            textSize = 13f
            setPadding(0, 0, 0, pad / 2)
            text = recentActions()
        }
        col.addView(recentText)
        // 顶部通道状态条：通道一断就红条常驻（可点重测），不让用户在「通道已死」的界面上
        // 对着按钮猜。工作台（MainActivity）那份不在本文件授权范围内，见 REPORT 遗留项。
        channelBar = TextView(this).apply {
            textSize = 13f
            setPadding(pad / 2, pad / 2, pad / 2, pad / 2)
            setBackgroundColor(0xFFFFEBEE.toInt())
            setTextColor(0xFFC62828.toInt())
            setOnClickListener { retestChannel() }
            visibility = View.GONE
        }
        col.addView(channelBar)
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
            // 每行一律给一个动作按钮；动作内容由阶段机给，这里不猜（F3 现在只有「看启动日志」）。
            // 本版阶段机不再产生次要按钮（F4 已折叠成一行欠账文案），主按钮全页至多一个。
            // 「进入工作台」是入口本身，另置一个按钮，未放行时禁用（比点了没反应诚实）。
            val btn = Button(this).apply { visibility = View.GONE }
            stageButtons[stage.id] = btn
            col.addView(btn)
            if (stage.id == OnboardingFlow.F3) {
                enterBtn = Button(this).apply {
                    text = "进入工作台"
                    visibility = View.GONE
                    isEnabled = false
                    setOnClickListener { openWorkbench() }
                }
                col.addView(enterBtn)
            }
        }
        // 自动流进度：只是一行文案，**不产生按钮**。
        progressText = TextView(this).apply {
            textSize = 12f
            setPadding(0, pad / 2, 0, 0)
        }
        col.addView(progressText)
        // F4 折叠欠账：一行摘要，点开看明细；刻意不是入口动作。
        debtsText = TextView(this).apply {
            textSize = 12f
            setPadding(0, pad / 2, 0, 0)
            setOnClickListener {
                debtsDetail?.visibility =
                    if (debtsDetail?.visibility == View.VISIBLE) View.GONE else View.VISIBLE
            }
        }
        col.addView(debtsText)
        debtsDetail = TextView(this).apply {
            textSize = 11f
            setPadding(pad / 2, 0, 0, 0)
            visibility = View.GONE
        }
        col.addView(debtsDetail)
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
                    ProbeJournal.clear(this@SetupActivity)
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
        recentText?.text = recentActions()
        val verdicts = CapabilityCatalog.evaluate(e)
        val stages = OnboardingFlow.stages(e, verdicts)
        for (s in stages) {
            val tv = stageTexts[s.id] ?: continue
            val blocked = PairingProbeService.instance?.notificationBlocked == true &&
                s.id == OnboardingFlow.F1
            tv.text = "${s.id} ${s.title} ${mark(s.status)}" +
                (if (blocked) " 通知权限缺失 → 输码通知发不出去" else "") +
                (if (s.detail.isBlank()) "" else "｜${s.detail}")
            val acq = s.action
            val btn = stageButtons[s.id] ?: continue
            btn.visibility = if (acq == null) View.GONE else View.VISIBLE
            btn.text = acq?.label ?: ""
            btn.isEnabled = true
            if (acq != null) btn.setOnClickListener { dispatch(s.actionCapId ?: "", acq, btn) }
        }
        // 顶部通道状态条：LIVE==false 常驻红条，可点重测。
        val live = e.channelLive()
        channelBar?.visibility = if (live) View.GONE else View.VISIBLE
        channelBar?.text = ChannelStatusText.DOWN

        // P0 静默授权冲刺：界面上不出卡，每次采集后把「还该要且本轮没要过」的第一项要掉。
        advanceSprint(e)

        // 配对成功后的自动适配流：**同一前台会话内立即跑**（见 [maybeRunAutoFlow] 的注释）。
        maybeRunAutoFlow(e)
        val pendingAuto = pendingAutoIds(e)

        // F4 折叠欠账：只给一行文案，不给按钮。
        renderDebts(verdicts)

        val ready = OnboardingFlow.readyToEnter(verdicts)
        // 「完成后才 enable」：自动流没跑完之前不放行，避免用户在静默配置中途进面板。
        // 刻意**不做自动跳转**：产品承诺是「走完出现【进入工作台】」，auto 跳会把刚出现的
        // 按钮直接吞掉（那会让"走完"看起来像"没走完"）。
        // 入口只看 GATING（凭据 + 通道 + 运行时 + 内核包）：静默流在后台跑，**不许挡门** ——
        // 用户要的是「通道正常就直接看到进入工作台」，不是「等自动配置跑完才放行」。
        val enterable = ready
        enterBtn?.visibility = if (ready) View.VISIBLE else View.GONE
        enterBtn?.isEnabled = enterable
        progressText?.text = autoFlowProgress(e, pendingAuto)
        criteriaText?.text = "判据核对：" +
            PipelineProjection.project(e, verdicts).joinToString("  ") {
                "${it.id}${segMark(it.status)}${it.detail}"
            }
    }

    /**
     * 冲刺链**一次一步**：[lobos.capability.PermissionSprint.next] 给谁，
     * 就直接把它的首项取法交给 [dispatch] —— 与阶段卡共用同一条动作通道，所以这里
     * 不出现任何「自己拼的弹窗/自己拼的 intent」。
     * 只在 resumed 时推进：暂停中再发 intent 会把用户正在看的系统页压在下面。
     * 配对冻结期内同样不推进：见 [startPairing]。
     */
    private fun advanceSprint(e: Evidence) {
        if (!resumed || sprintWaiting) return
        if (SystemClock.elapsedRealtime() < sprintFrozenUntilMs) return
        val step = PermissionSprint.next(e, sprintAsked) ?: return
        val (capId, acq) = step
        sprintAsked += capId
        sprintWaiting = true
        ProbeJournal.append(this, "perm", "P0 冲刺 $capId → ${acq.kind} ${acq.label}")
        // 没发出去（系统页打不开 / 本机压根不要求这一步）就不许占住整条链：
        // 占住的后果不是「少弹一个窗」，而是后面所有授权这一整轮都要不到。
        // 记入 asked 是故意的 —— 失败也不在同一轮里重试，欠账归配对后的自动流 / 折叠欠账行。
        if (!dispatch(capId, acq, null)) sprintWaiting = false
    }

    /**
     * 「刚刚」区块：先说**这条常驻有没有断过**（[ResidencyAudit.interruption]，与常驻通知
     * 首行同一份文案源），再说最近三次配对尝试的结论（[AttemptStore.humanPairTimeline]，
     * 与配对通知同一份文案源）。空账本时说清「下一步从哪开始」，而不是留一片空白。
     */
    private fun recentActions(): String {
        val lines = AttemptStore.humanPairTimeline().take(3)
        val recent = if (lines.isEmpty()) {
            "最近动作：还没有过一次配对尝试 —— 点下面标着「下一步」的那个按钮"
        } else {
            "最近动作：\n" + lines.joinToString("\n")
        }
        // 定罪行排在最前：它讲的是「上次常驻是被回收的」，比任何一次配对尝试都更早上发生、
        // 也更该被看见 —— 这条常驻断过却只显示「运行时在线」，就是假绿。
        val audit = ResidencyAudit.interruption()
        return if (audit == null) recent else "$audit\n$recent"
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

    /**
     * 把一条取法交出去。返回值只说明**有没有真的发出去**（系统接了 intent / 弹窗起了），
     * 不代表用户完成了授权 —— 完成与否由下一轮采集的读数说话。
     * [btn] 可为 null：P0 冲刺与配对入口的跳转都不是按钮触发的。
     */
    private fun dispatch(capId: String, acq: Acquisition, btn: Button?): Boolean {
        val sent = when (acq.kind) {
            AcquireKind.USER_CODE -> { startPairing(); true }
            AcquireKind.RUNTIME_DIALOG -> requestRuntimePermission(acq)
            AcquireKind.USER_TAP -> {
                val jumped = CapabilityNavigation.launch(this, acq) { note ->
                    ProbeJournal.append(this, "deeplink", "$capId ${acq.label}：$note")
                }
                if (!jumped) toast("授权页打不开：${acq.label}")
                jumped
            }
            else -> { runAcquisition(capId, acq, btn); true }
        }
        // 发完动作立刻补一次采集：用户可能在设置页里已经把这一步做完了。
        handler.postDelayed({ refreshSoon() }, REFRESH_AFTER_TAP_MS)
        return sent
    }

    /**
     * F1「开始配对」那一下（flow-spec §2.1）：**同一瞬间**两件事 ——
     * ① 起探针（browse 必须早于系统配对对话框，才接得住那条只活几分钟的 pairing 记录）；
     * ② 现读环境，按缺项把用户送到能修它的页面（缺开关→设置页，缺通知→授权页）。
     * 「差哪个开关」由 [PairingGate] 判，判据不住在首页。
     *
     * ③ 冻结 P0 冲刺一段时间：用户此刻在系统的「无线调试」页里输码，从他手上那个页面回到
     * 本界面的那一帧，旧实现会立刻把下一个授权页甩到他脸上（真机定罪「回到界面一堆乱七八糟」）。
     * 冻结是有上限的（到期自动解冻），不是一条需要谁来解的锁 —— 配对期间的欠账由配对后的
     * 自动适配流接着办，办不成才落进折叠欠账行。
     */
    private fun startPairing() {
        AdbChannelProbe.invalidate()
        sprintFrozenUntilMs = SystemClock.elapsedRealtime() + SPRINT_FREEZE_MS
        startService(Intent(this, PairingProbeService::class.java))
        ProbeJournal.append(this, "pair", "用户点「开始配对」→ 探针已起，现场核对开发者环境")
        if (lastEvidence == null) {
            toast("环境读数还没到位，稍等一下再点")
            return
        }
        Thread {
            // 现场采一次：拿 2s 轮询的旧读数判「开关开没开」= 用户明明刚开了却被引导去开第二次。
            val e = runCatching { CapabilityEvidenceCollector.collect(this) }.getOrNull()
            val decision = e?.let { PairingGate.decide(it, CapabilityCatalog.evaluate(it)) }
            handler.post {
                if (decision == null) {
                    toast("环境读数采集失败，请再点一次「开始配对」")
                    return@post
                }
                toast(decision.notice)
                ProbeJournal.append(this, "pair", "配对现场判定：${decision.notice}")
                val acq = decision.jump ?: return@post
                dispatch(decision.gapCapId ?: CapabilityCatalog.WIRELESS_DEBUG, acq, null)
                refreshSoon()
            }
        }.apply { isDaemon = true }.start()
    }

    /** 返回「弹窗真的起来了没」。API 32 及以下系统压根不要这个权限 → 链不许停在这一步（见 [advanceSprint]）。 */
    private fun requestRuntimePermission(acq: Acquisition): Boolean {
        val perm = CapabilityNavigation.runtimePermission(acq)
        if (perm == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            toast("本机系统不需要这一步")
            return false
        }
        pendingRuntimePerm = perm
        requestRuntimePerm.launch(perm)
        return true
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

    private fun runAcquisition(capId: String, acq: Acquisition, btn: Button?) {
        if (actionInFlight) return
        actionInFlight = true
        btn?.isEnabled = false
        toast("${acq.label} 执行中…")
        Thread {
            val ctx = applicationContext
            val result = runCatching { CapabilityAcquisitionRunner.dispatch(ctx, acq) }.getOrNull()
            handler.post {
                actionInFlight = false
                btn?.isEnabled = true
                // 静默取法跑完 = 这一步有结论了，冲刺链可以继续（P0 也走这条通道）。
                sprintWaiting = false
                result?.detail?.let {
                    ProbeJournal.append(ctx, "acq", "$capId ${acq.label}：$it")
                    toast(if (result.verified) "已生效" else it)
                }
                refreshSoon()
            }
        }.apply { isDaemon = true }.start()
    }

    /**
     * 通道条点击：作废缓存并重测（动作取登记表的取法链首项，不自拼命令）。
     */
    private fun retestChannel() {
        AdbChannelProbe.invalidate()
        val e = lastEvidence ?: Evidence()
        val acq = CapabilityCatalog.byId(CapabilityCatalog.ADB_CHANNEL)
            ?.acquirer?.invoke(e)?.firstOrNull()
        if (acq == null) {
            refreshSoon()
            return
        }
        toast("正在重测 ADB 通道…")
        dispatch(CapabilityCatalog.ADB_CHANNEL, acq, null)
    }

    /**
     * 配对成功后的自动适配流。
     *
     * **必须在本前台会话内立即跑**：配对期间 [PairingProbeService] 的前台服务还活着，
     * 进程不可能已经被 HANS 冻/杀；一旦改成「后台定时唤醒」，锚没绑 → :main 被清理 →
     * 那条唤醒永远等不到，就掉回「静默通道永远等不到」的循环依赖。
     *
     * 凭据在册那一帧探针可能还没 LIVE（plan 里只有 DO），等通道 LIVE 后 plan 变长，
     * 下一次 render 再补跑剩下的 —— [autoFlowAttempted] 保证同一项不重复下发（幂等、可重入）。
     */
    private fun maybeRunAutoFlow(e: Evidence) {
        if (!resumed || autoFlowRunning) return
        val ids = pendingAutoIds(e)
        if (ids.isEmpty()) return
        autoFlowRunning = true
        autoFlowAttempted += ids
        ProbeJournal.append(this, "autoflow", "自动适配流启动：" + ids.joinToString())
        Thread {
            val ctx = applicationContext
            val steps = runCatching { CapabilityAcquisitionRunner.runAutoFlow(ctx, ids) }
                .getOrNull().orEmpty()
            val summary = steps.joinToString("；") {
                CapabilityCatalog.titleOf(it.capId) + "=" + (if (it.ok) "OK" else "未成")
            }
            handler.post {
                autoFlowRunning = false
                autoFlowNotice = if (summary.isBlank()) "自动适配流无结论" else "自动适配流：" + summary
                ProbeJournal.append(ctx, "autoflow", autoFlowNotice)
                refreshSoon()
            }
        }.apply { isDaemon = true }.start()
    }

    /** 自动流适用时的完整 plan；未就绪时返回空（视为「不该跑」，不挡入口）。 */
    private fun autoFlowIds(e: Evidence): List<String> =
        if (PostPairingAutoFlow.ready(e)) PostPairingAutoFlow.plan(e) else emptyList()

    /** plan 减去本次会话已尝试过的项 = 还欠的静默项。 */
    private fun pendingAutoIds(e: Evidence): List<String> =
        autoFlowIds(e).filter { it !in autoFlowAttempted }

    /** 自动流进度：一行文案（不产生按钮）。 */
    private fun autoFlowProgress(e: Evidence, pending: List<String>): String {
        if (!PostPairingAutoFlow.ready(e)) return ""
        if (autoFlowRunning) return "自动配置中：正在静默完成剩余授权…"
        if (pending.isNotEmpty()) return "自动配置待续：还欠 ${pending.size} 项，通道一就绪就接着办"
        if (autoFlowNotice.isNotBlank()) return autoFlowNotice
        return if (autoFlowAttempted.isEmpty()) "" else "自动配置已完成：${autoFlowAttempted.size} 项"
    }

    /**
     * F4 折叠欠账：一行摘要 + 点开明细。刻意**不给按钮** —— 静默能办的由自动流办，
     * 剩下的欠账不挡入口，进面板后各功能自行降级提示（避免又长出一排授权按钮）。
     */
    private fun renderDebts(verdicts: Map<String, CapVerdict>) {
        val debts = OnboardingFlow.debts(verdicts)
        debtsText?.text = if (debts.isEmpty()) {
            "欠账（不挡入口）：无"
        } else {
            "欠账（不挡入口）：${debts.size} 项 · 点此展开"
        }
        debtsDetail?.text = debts.joinToString("\n") {
            "· " + it.title + "：" + (verdicts[it.id]?.detail ?: "")
        }
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
                appendLine("== Lob OS 开场管线报告 ==")
                appendLine("${Build.MANUFACTURER} ${Build.MODEL} · API ${Build.VERSION.SDK_INT} · " +
                    "APK ${BuildConfig.VERSION_NAME}#${BuildConfig.VERSION_CODE}")
                // 定罪结论与常驻通知首行同源；没有它，报告读起来就像这条常驻从来没断过。
                appendLine("---- 常驻定罪 ----")
                appendLine(ResidencyAudit.interruption() ?: "上次收尾是正常退出（或本机首次装），无可定罪的中断")
                if (e != null) {
                    val verdicts = CapabilityCatalog.evaluate(e)
                    appendLine("---- 流程阶段 ----")
                    OnboardingFlow.stages(e, verdicts).forEach {
                        appendLine("${it.id} ${it.title} ${it.status} ${it.detail}")
                    }
                    // P0 不在界面上出现，所以报告是它唯一的可核对出口：本轮要过哪些、还缺哪些。
                    appendLine(
                        "---- P0 授权冲刺（静默） ----" +
                            "\n顺序 ${PermissionSprint.ORDER.joinToString()}" +
                            "\n已抛问题 ${sprintAsked.joinToString().ifBlank { "无" }}" +
                            "\n仍待要 ${PermissionSprint.pending(e, sprintAsked).joinToString().ifBlank { "无" }}" +
                            "\n配对现场判定 " + PairingGate.decide(e, verdicts).notice,
                    )
                    appendLine("---- 配对尝试（与通知同源） ----")
                    appendLine(AttemptStore.humanPairTimeline().joinToString("\n").ifBlank { "无" })
                    appendLine("---- 能力判据 ----")
                    // 诊断页把"豁免层"（厂商省电四项）一并列出：它不进引导管线，但必须可见可核。
                    (CapabilityCatalog.ALL + CapabilityCatalog.OEM_GUARDS).forEach { c ->
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
                        .setPrimaryClip(ClipData.newPlainText("Lob OS 管线报告", report))
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

        /** 点「开始配对」后冻结 P0 冲刺的时长；到期自动解冻，不需要谁来解锁。 */
        private const val SPRINT_FREEZE_MS = 5 * 60_000L
    }
}
