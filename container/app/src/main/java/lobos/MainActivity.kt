package lobos

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import lobos.bridge.ScreenCaptureController
import lobos.capability.AdbChannelProbe
import lobos.capability.CapabilityAcquisitionRunner
import lobos.capability.CapabilityCatalog
import lobos.capability.Evidence
import lobos.ota.ProgramManager
import lobos.ota.ProgramOtaUpdater
import lobos.ota.ProgramOtaSelfCheck
import lobos.lifecycle.OsHostService
import lobos.runtime.InstanceHost
import lobos.permissions.PermissionCatalog
import lobos.permissions.PermissionCenter
import lobos.runtime.GuestAdapter

/**
 * 入口 Activity，也是“可观测”面板 + 内核 UI 宿主帧：
 * - 内核未就绪时显示“启动诊断”文本（逐阶段、带时间戳的状态，来自 RuntimeDiagnostics）。
 * - 探测到内核控制面（127.0.0.1:CONSOLE_PORT）就绪后，切换到 WebView 加载**内核同源托管的宿主帧**
 * （http://127.0.0.1:<port>/__host）。宿主帧内以 iframe 嵌内核面板（同源）—— 这样面板既满足
 * `hasHostBridge()`（window.parent !== window），又满足内核 Origin 闸（同源→写操作不被 403）。
 * - 面板经 postMessage 发 lobos:panel-update-request → 宿主帧转交本 Activity（LobosNative.onRequest）
 * → 经 ACTION_RESTART 重跑 runtime 的 boot 流程（重读 CURRENT / 触发 OTA）→ 回灌 lobos:panel-update-result（**严格按面板契约**）。
 * - 提供“重试”按钮：清空诊断、经 ACTION_RESTART 让运行时重走全流程
 *   （监督者 binder 边在册，stopService 已杀不死 runtime —— 旧写法已随之删除）。
 * - 提供“授权屏幕捕获”按钮：MediaProjection 授权**无法预置**，
 * 必须由用户点系统弹窗。授权结果缓存到 files/screen-capture-grant.json，之后可后台复用，
 * 这是内核 ui.screenshot 能工作的前置条件。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var diagText: TextView
    private lateinit var scroll: ScrollView
    private lateinit var webView: WebView
    private lateinit var retryBtn: Button
    private lateinit var captureBtn: Button
    private lateinit var copyBtn: Button
    private val handler = Handler(Looper.getMainLooper())
    private var uiMode = false // false=诊断面板, true=WebView(内核 /__host 宿主帧 + 面板 iframe)
    /** 设备端自检结果（后台算一次，渲染时前缀到诊断面板）。 */
    @Volatile private var selfCheckText: String = ""

    /**
     * 顶部通道状态条：channelLive()==false 时常驻红条，可点重探。
     * 与开屏 [lobos.ui.setup.SetupActivity] 同源 —— 同一把判据
     * （[Evidence.channelLive]）与同一句文案（[ChannelStatusText.DOWN]），不新造第二套。
     */
    private var channelBar: TextView? = null
    /** 滚动页的原始上内边距：红条出现时往下让位，消失时复原（左右下不动）。 */
    private var scrollBaseTopPadding = 0
    /** 红条占位高度（固定值：避免每帧测量后再重排）。 */
    private val channelBarHeightPx: Int by lazy {
        (CHANNEL_BAR_HEIGHT_DP * resources.displayMetrics.density).toInt()
    }
    /** 通道条刷新防重入：探针会阻塞（走常驻通道跑 id），不许并发。 */
    @Volatile private var channelBarRefreshInFlight = false
    /** 通道条刷新节流：500ms 轮询 × N ≈ 与开屏 2s 采集同频（探针自带冷却）。 */
    private var channelBarTick = 0

    /** 面板更新桥协议版本：必须与 console panelUpdateBridge.ts 的 BRIDGE_PROTOCOL_VERSION 一致。 */
    private val programUpdateProtocol = 1

    /**
     * 截屏授权（ui.screenshot 的前置）。
     *
     * MediaProjection 的授权模型：它**不能预置**，必须由用户在系统弹窗
     * 上点一次「开始录制」。所以这里必须有个 Activity 承接 startActivityForResult。
     * 拿到 resultCode + data 后：
     * ① saveGrant() 落盘缓存（同进程复用；跨重启尽力复用，失效时回落重新授权）；
     * ② 拉起 ScreenCaptureController 建 projection。
     */
    private val requestCapture = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data
        if (result.resultCode == RESULT_OK && data != null) {
            ScreenCaptureController.saveGrant(this, result.resultCode, data)
            startCaptureService(result.resultCode, data)
            RuntimeDiagnostics.append(
                this, "screenshot", true, "截屏授权已获取", "已缓存，可后台复用；ui.screenshot 现在可用"
            )
        } else {
            RuntimeDiagnostics.append(
                this, "screenshot", false, "截屏授权被取消",
                "ui.screenshot 将继续返回 -32001；可随时点「授权屏幕捕获」重来"
            )
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        diagText = findViewById(R.id.diagText)
        scroll = findViewById(R.id.scroll)
        webView = findViewById(R.id.webview)
        retryBtn = findViewById(R.id.retryBtn)
        captureBtn = findViewById(R.id.captureBtn)
        copyBtn = findViewById(R.id.copyBtn)

        // 授权发起权只属于开场流程：开屏的 P0 静默冲刺 + 首页的 F4 补齐行（PermissionSprint / OnboardingFlow）。
        // 这里过去自己发过一次通知弹窗与电池豁免跳转，等于把同一步做了两遍，
        // 而且做的是**门后那一遍** —— 全新安装的用户在到达本页之前就需要通知权限（用于
        // S0 输码），门后补发既救不了 S0，又让「谁负责发起授权」变成两处（spec §2.5 同源要求）。
        retryBtn.setOnClickListener { restartRuntime() }
        captureBtn.setOnClickListener { requestScreenCapture() }
        // 一键把自检结果交出去：设备 adb 关闭，剪贴板是唯一可行的导出方式。
        copyBtn.setOnClickListener { copySelfCheck() }

        setupWebView()
        // 通道状态条：工作台与诊断页同帧，红条挂 FrameLayout 顶层，两种模式都看得见。
        installChannelBar()
        // 复用上次授权：若缓存 grant 仍有效直接拉起服务；Android 14+ 跨重启可能失效，届时回落弹窗。
        reuseExistingCaptureGrant()
        startRuntime()
        startPolling()
        runSelfCheckOnce()
    }

    /**
     * 回前台 = 最强的新鲜度事件（用户可能刚在设置页拨了无线调试，端口也轮换过）。
     * 与开屏同一姿势：作废通道缓存并立刻重采 —— 不让过期的 LIVE 继续挂着不报红。
     */
    override fun onResume() {
        super.onResume()
        AdbChannelProbe.invalidate()
        refreshChannelBar()
    }

    /**
     * 设备端自检：**后台**跑一次，结果前缀到诊断面板。
     *
     * 为什么显示在界面上而不是只写文件：目标设备的 **adb 是关闭的**，
     * 用户无法用 adb 把 provisioning.json 拉出来看。把结论直接显示在屏幕上，
     * 是唯一可行的验证方式（见 docs/runbook/system-device-verification.md）。
     */
    private fun runSelfCheckOnce() {
        Thread {
            val text = try {
                ProgramOtaSelfCheck.runAndFormat(this)
            } catch (e: Throwable) {
                "自检异常: " + e::class.java.simpleName + ": " + (e.message ?: "")
            }
            selfCheckText = text
        }.apply { isDaemon = true }.start()
    }

    /**
     * 一键复制自检：**重跑一次**（拿到最新状态）再把报告放进剪贴板。
     *
     * 为什么必须有这个按钮：自检段虽然置顶，但日志很长、自动滚动又会打扰拖动，
     * 用户很难把那段完整取出来；而设备 **adb 关闭**、文件在应用私有目录，
     * 剪贴板是**唯一可行**的导出通道（真机反馈）。
     */
    private fun copySelfCheck() {
        copyBtn.isEnabled = false
        Thread {
            val text = try {
                ProgramOtaSelfCheck.runAndFormat(this)
            } catch (e: Throwable) {
                "自检异常: " + e::class.java.simpleName + ": " + (e.message ?: "")
            }
            selfCheckText = text
            handler.post {
                try {
                    val cm = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
                    cm.setPrimaryClip(android.content.ClipData.newPlainText("Lob OS 自检", text))
                    android.widget.Toast.makeText(
                        this, "已复制到剪贴板 —— 直接粘贴发我即可", android.widget.Toast.LENGTH_LONG,
                    ).show()
                } catch (e: Throwable) {
                    android.widget.Toast.makeText(
                        this, "复制失败: " + e.message, android.widget.Toast.LENGTH_LONG,
                    ).show()
                }
                copyBtn.isEnabled = true
            }
        }.apply { isDaemon = true }.start()
    }

    /** 用户是否已贴到底部（决定要不要自动跟随滚动）。 */
    private fun isAtBottom(): Boolean {
        val child = scroll.getChildAt(0) ?: return true
        return scroll.scrollY + scroll.height >= child.height - 8
    }

    /** 尝试用上次缓存的 MediaProjection 授权直接建 projection（失败则静默，等用户手动授权）。 */
    private fun reuseExistingCaptureGrant() {
        // 「已就绪」只认 PermissionCenter 那一把尺子（它读 ScreenCaptureController.isReady）——
        // 这里再手写一次就会和首页 S2 / 桥令牌的口径漂移（spec §2.5）。
        val captureSpec = PermissionCatalog.byId(PermissionCatalog.MEDIAPROJECTION)
        if (captureSpec != null && PermissionCenter(this).isGranted(captureSpec)) return
        val grant = ScreenCaptureController.loadGrant(this) ?: return
        startCaptureService(grant.first, grant.second)
    }

    /** 拉起截屏前台服务（Android 14+ 必须以前台服务承载 MediaProjection）。 */
    private fun startCaptureService(resultCode: Int, data: Intent) {
        try {
            // 截屏组件由 OsHostService 同进程持有：授权结果经**宿主**转发（宿主会交给 ScreenCaptureController.onHostStart）。
            // 不再 startForegroundService 一个非 Service 类（旧写法必抛异常被吞 → 截屏永远不可用）。
            val svc = Intent(this, OsHostService::class.java)
                .setAction(ScreenCaptureController.ACTION_START)
                .putExtra(ScreenCaptureController.EXTRA_RESULT_CODE, resultCode)
                .putExtra(ScreenCaptureController.EXTRA_RESULT_DATA, data)
            startService(svc)
        } catch (e: Throwable) {
            RuntimeDiagnostics.append(this, "screenshot", false, "启动截屏服务失败",
                "${e::class.java.simpleName}: ${e.message}")
        }
    }

    /** 向系统申请截屏授权（弹窗由系统渲染，用户须手动确认）。 */
    private fun requestScreenCapture() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
            RuntimeDiagnostics.append(this, "screenshot", false, "平台不支持 MediaProjection", "需 API 21+")
            return
        }
        try {
            val mpm = getSystemService(MEDIA_PROJECTION_SERVICE) as android.media.projection.MediaProjectionManager
            requestCapture.launch(mpm.createScreenCaptureIntent())
        } catch (e: Throwable) {
            RuntimeDiagnostics.append(this, "screenshot", false, "发起截屏授权失败",
                "${e::class.java.simpleName}: ${e.message}")
        }
    }

    private fun setupWebView() {
        webView.webViewClient = WebViewClient()
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.addJavascriptInterface(LobosBridge(this), "LobosNative")
    }

    /**
     * 原生侧接收宿主帧发来的 lobos:panel-update-request，处理并回灌结果。
     * 回灌**严格按 console panelUpdateBridge.ts 的契约**：{v,type,requestId,ok,stage,version,restartUncertain,error}。
     * 缺 v / ok 会导致面板侧直接丢弃消息（更新请求超时）。
     */
    fun handleKernelUpdateRequest(json: String) {
        val requestId = try { org.json.JSONObject(json).optString("requestId", "") } catch (_: Throwable) { "" }
        // 网络 + 安装都是**阻塞**操作：必须离开主线程，否则 WebView 与 UI 一起卡死。
        Thread {
            deliverToHost(runKernelUpdate(requestId).toString())
        }.start()
    }

    /**
     * 真正执行一次内核 OTA，并**如实**回报（修复前的实现只做 restartRuntime() 就无条件 ok=true ——
     * 无论有没有新内核、网络通不通都报"成功"，这是假成功）。
     *
     * 语义：
     *   · 未配置 feed / 取 manifest 失败 / 下载失败 / 校验失败 → ok=false + 真实 error（**不重启**）
     *   · 已是最新 → ok=true, stage=up-to-date（**不重启**：无谓重启是有代价的）
     *   · 安装成功 → 重启 runtime 拉起新内核，ok=true, stage=updated, restartUncertain=true
     */
    private fun runKernelUpdate(requestId: String): org.json.JSONObject {
        val km = ProgramManager(this)
        return try {
            if (ProgramOtaUpdater.loadConfig(this) == null) {
                return resultJson(requestId, false, "failed", null, "未配置 program-feed.json：远端内核 OTA 未启用")
            }
            progressToHost(requestId, "checking")
            val outcome = ProgramOtaUpdater.checkAndUpdate(this, km, checkOnly = false)
            when {
                !outcome.checked -> resultJson(requestId, false, "failed", outcome.remote, outcome.detail)
                !outcome.available -> resultJson(requestId, true, "up-to-date", outcome.current, null)
                outcome.updated -> {
                    progressToHost(requestId, "restarting")
                    restartRuntime()
                    resultJson(requestId, true, "updated", outcome.remote, null, restartUncertain = true)
                }
                else -> resultJson(requestId, false, "failed", outcome.remote, outcome.detail)
            }
        } catch (e: Throwable) {
            resultJson(requestId, false, "failed", null, "${e::class.java.simpleName}: ${e.message}")
        }
    }

    private fun resultJson(
        requestId: String,
        ok: Boolean,
        stage: String,
        version: String?,
        error: String?,
        restartUncertain: Boolean = false,
    ): org.json.JSONObject = org.json.JSONObject().apply {
        put("v", programUpdateProtocol)
        put("type", "lobos:panel-update-result")
        put("requestId", requestId)
        put("ok", ok)
        put("stage", stage)
        if (version != null) put("version", version) else put("version", org.json.JSONObject.NULL)
        put("restartUncertain", restartUncertain)
        if (error != null) put("error", error) else put("error", org.json.JSONObject.NULL)
    }

    private fun progressToHost(requestId: String, stage: String) {
        val o = org.json.JSONObject().apply {
            put("v", programUpdateProtocol)
            put("type", "lobos:panel-update-progress")
            put("requestId", requestId)
            put("stage", stage)
        }
        deliverToHost(o.toString())
    }

    /** 宿主帧暴露 lobosDeliverResult(json)；用 JSON 字符串安全注入（避免拼接注入）。 */
    private fun deliverToHost(jsonStr: String) {
        webView.post {
            webView.evaluateJavascript(
                "window.lobosDeliverResult && window.lobosDeliverResult(${org.json.JSONObject.quote(jsonStr)})",
                null
            )
        }
    }

    private fun startRuntime(action: String? = null) {
        // UI 是保活链的又一条边（用户打开界面的时刻补位）。
        // 单进程后没有"启动 runtime 服务"这一步：实例归宿主持有；动作经宿主 intent 转发给 InstanceHost。
        OsHostService.ensureRunning(this)
        if (action != null) {
            try {
                startService(Intent(this, OsHostService::class.java).setAction(action))
            } catch (e: Throwable) {
                RuntimeDiagnostics.append(this, "runtime", false, "发送运行时动作失败",
                    e::class.java.simpleName + ": " + e.message)
            }
        }
    }

    private fun restartRuntime() {
        // 旧实现先 stopService 再重启 —— 监督者引入 binder 边（BIND_AUTO_CREATE）后
        // 该 stop 已**杀不动** runtime（绑定在册），只剩"假装重启"的误导。
        // 正确语义 = ACTION_RESTART：runtime 自己终结当前实例，boot 循环重走全流程。
        uiMode = false
        webView.visibility = View.GONE
        scroll.visibility = View.VISIBLE
        retryBtn.visibility = View.VISIBLE
        RuntimeDiagnostics.clear(this)
        diagText.text = "正在重启运行时..."
        startRuntime(InstanceHost.ACTION_RESTART)
        RuntimeDiagnostics.append(this, "runtime", null, "已请求宿主重读 CURRENT", "单进程模型：经宿主 intent 转发 ACTION_RESTART")
    }

    private fun startPolling() {
        handler.post(object : Runnable {
            override fun run() {
                // 通道条与面板模式无关：诊断帧与 WebView 帧都要常驻（工作台就是后者）。
                // 500ms 轮询 × 4 ≈ 2s 一采，与开屏的 2s 采集同频；探针自带冷却，不会打崩 adbd。
                if (channelBarTick++ % 4 == 0) refreshChannelBar()
                if (!uiMode) {
                    val log = RuntimeDiagnostics.read(this@MainActivity)
                    val body = if (log.isBlank()) "初始化中..." else log
                    // 自检结论**常驻在顶部**：它是"绿没绿"的答案，不该被后续日志冲掉。
                    diagText.text = if (selfCheckText.isBlank()) body else selfCheckText + "\n" + body
                    // ⚠ 只在用户**已经在底部**时才自动跟随。
                    // 无脑 fullScroll(FOCUS_DOWN) 会把置顶的自检段压在屏幕外、用户又拖不上去
                    // —— 真机实测到的可用性问题（自检做了却看不见）。
                    if (isAtBottom()) scroll.post { scroll.fullScroll(ScrollView.FOCUS_DOWN) }
                    if (isPortUp()) enterWebView()
                }
                handler.postDelayed(this, 500)
            }
        })
    }

    private fun enterWebView() {
        // E8 拆分后：控制台承载面归 ConsoleActivity（本 Activity 只留诊断/授权/升级入口）。
        // 这里改为路由过去，不再在本页切换 WebView 模式。
        uiMode = true
        startActivity(Intent(this, lobos.ui.console.ConsoleActivity::class.java))
    }

    private fun isPortUp(): Boolean = try {
        val c = java.net.URL("http://127.0.0.1:${GuestAdapter.CONSOLE_PORT}/status").openConnection() as java.net.HttpURLConnection
        c.connectTimeout = 300
        // 与容器侧 isStatusUp 同理：设备忙时 300ms 读超时会把「活着但忙」误判成死，
        // 表现为面板永远进不去、一直停在诊断页（真机 2026-09-22）。
        c.readTimeout = 1500
        c.requestMethod = "GET"
        c.responseCode == 200
    } catch (_: Throwable) {
        false
    }

    // ---- 通道状态条（与开屏同源）----

    /**
     * 把红条挂到 FrameLayout 顶层并捕获滚动页的原始内边距。
     *
     * 为什么挂在 FrameLayout 而不是诊断滚动页里：工作台是 WebView 帧，诊断是另一个子视图，
     * 二者切换时只有 FrameLayout 顶层常驻 —— 通道断了必须两种帧都看得见。
     */
    private fun installChannelBar() {
        val frame = scroll.parent?.parent as? FrameLayout ?: return
        scrollBaseTopPadding = scroll.paddingTop
        val pad = (8f * resources.displayMetrics.density).toInt()
        val bar = TextView(this).apply {
            text = ChannelStatusText.DOWN
            textSize = 13f
            gravity = Gravity.CENTER_VERTICAL
            setPadding(pad * 2, pad, pad * 2, pad)
            setBackgroundColor(0xFFFFEBEE.toInt())
            setTextColor(0xFFC62828.toInt())
            setOnClickListener { retestChannel() }
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                channelBarHeightPx,
                Gravity.TOP,
            )
        }
        channelBar = bar
        frame.addView(bar)
    }

    /**
     * 刷新红条：后台取通道读数，主线程只切可见性。
     *
     * 判据只有一把尺子：[Evidence.channelLive]（探针 LIVE 且读数未过期）。这里**不**自己判
     * LIVE/DEAD —— 开屏、自动流、工作台三处必须同一口径，否则会在「一条读数是绿、另一条是红」
     * 之间来回翻（v1 假绿事故的同款机制）。
     */
    private fun refreshChannelBar() {
        if (channelBarRefreshInFlight) return
        channelBarRefreshInFlight = true
        Thread {
            val now = System.currentTimeMillis()
            val probe = runCatching { AdbChannelProbe.probe(applicationContext, now) }.getOrNull()
            val live = probe != null && Evidence(nowMs = now, channel = probe).channelLive()
            channelBarRefreshInFlight = false
            handler.post {
                channelBar?.visibility = if (live) View.GONE else View.VISIBLE
                reserveChannelBarSpace(!live)
            }
        }.apply { isDaemon = true }.start()
    }

    /**
     * 红条出现/消失时给下方内容让位：滚动页只加上内边距，WebView 只加顶外边距。
     * 不让位的话红条会盖住诊断首行 / 面板顶栏 —— 「不改其它行为」不等于「盖住别的」。
     */
    private fun reserveChannelBarSpace(visible: Boolean) {
        val offset = if (visible) channelBarHeightPx else 0
        val lp = webView.layoutParams as? FrameLayout.LayoutParams
        if (lp != null && lp.topMargin != offset) {
            lp.topMargin = offset
            webView.layoutParams = lp
        }
        scroll.setPadding(
            scroll.paddingLeft,
            scrollBaseTopPadding + offset,
            scroll.paddingRight,
            scroll.paddingBottom,
        )
    }

    /**
     * 红条点击：作废通道缓存并重探（用户此刻就是想知道「还连不连得上」）。
     *
     * 动作取登记表的取法链首项（[CapabilityCatalog.ADB_CHANNEL] → AUTO「重测通道」），
     * 与开屏的 retestChannel 同源 —— 探针命令不许在 UI 里再拼一份。
     */
    private fun retestChannel() {
        AdbChannelProbe.invalidate()
        android.widget.Toast.makeText(this, "正在重测 ADB 通道…", android.widget.Toast.LENGTH_SHORT).show()
        val ctx = applicationContext
        Thread {
            val acq = CapabilityCatalog.byId(CapabilityCatalog.ADB_CHANNEL)
                ?.acquirer?.invoke(
                    Evidence(nowMs = System.currentTimeMillis(), channel = AdbChannelProbe.cached())
                )
                ?.firstOrNull()
            val result = acq?.let {
                runCatching { CapabilityAcquisitionRunner.dispatch(ctx, CapabilityCatalog.ADB_CHANNEL, it) }.getOrNull()
            }
            handler.post {
                refreshChannelBar()
                android.widget.Toast.makeText(
                    this,
                    if (result?.verified == true) "ADB 通道已恢复"
                    else "ADB 通道仍不可用：" + (result?.detail ?: "未取得结论"),
                    android.widget.Toast.LENGTH_LONG,
                ).show()
            }
        }.apply { isDaemon = true }.start()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    /** 宿主帧 ↔ 原生桥：宿主帧经 window.LobosNative.onRequest 把更新请求交给原生。 */
    private class LobosBridge(private val activity: MainActivity) {
        @JavascriptInterface
        fun onRequest(json: String) {
            activity.runOnUiThread { activity.handleKernelUpdateRequest(json) }
        }
    }
}

/** 通道红条的固定占位高度（dp）：固定值才能确定性地给下方内容让位，不用等测量回调。 */
private const val CHANNEL_BAR_HEIGHT_DP = 36

/**
 * 通道状态条的文案——**唯一出处**：工作台与开屏同读它，避免两处各写一句后漂移。
 *
 * 说明：开屏 [lobos.ui.setup.SetupActivity] 当前仍保留同一句字面量，
 * 本次改动的授权文件清单不含它；后续把它改成引用本处即可（否则改名只改一边 = 两处不一致）。
 */
internal object ChannelStatusText {
    const val DOWN = "ADB 通道已断开 · 点此重连"
}
