package io.github.lobbowen.dshmobile

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import io.github.lobbowen.dshmobile.bridge.ScreenCaptureService
import io.github.lobbowen.dshmobile.kernelota.KernelManager
import io.github.lobbowen.dshmobile.kernelota.KernelOtaUpdater
import io.github.lobbowen.dshmobile.kernelota.KernelSelfCheck
import io.github.lobbowen.dshmobile.lifecycle.ContainerSupervisor
import io.github.lobbowen.dshmobile.permissions.PermissionCatalog
import io.github.lobbowen.dshmobile.permissions.PermissionCenter
import io.github.lobbowen.dshmobile.runtime.GuestAdapter
import io.github.lobbowen.dshmobile.runtime.NodeRuntimeService

/**
 * 入口 Activity，也是“可观测”面板 + 内核 UI 宿主帧：
 * - 内核未就绪时显示“启动诊断”文本（逐阶段、带时间戳的状态，来自 RuntimeDiagnostics）。
 * - 探测到内核控制面（127.0.0.1:KERNEL_CONTROL_PORT）就绪后，切换到 WebView 加载**内核同源托管的宿主帧**
 * （http://127.0.0.1:<port>/__host）。宿主帧内以 iframe 嵌内核面板（同源）—— 这样面板既满足
 * `hasHostBridge()`（window.parent !== window），又满足内核 Origin 闸（同源→写操作不被 403）。
 * - 面板经 postMessage 发 dsh:kernel-update-request → 宿主帧转交本 Activity（DshNative.onRequest）
 * → 经 ACTION_RESTART 重跑 :node 的 boot 流程（重读 CURRENT / 触发 OTA）→ 回灌 dsh:kernel-update-result（**严格按内核契约**）。
 * - 提供“重试”按钮：清空诊断、经 ACTION_RESTART 让运行时重走全流程
 *   （监督者 binder 边在册，stopService 已杀不死 :node —— 旧写法已随之删除）。
 * - 提供“授权屏幕捕获”按钮：MediaProjection 授权**无法预置**（不同于 Device Owner），
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

    /** 内核更新桥协议版本：必须与内核 kernelUpdateBridge.ts 的 BRIDGE_PROTOCOL_VERSION 一致。 */
    private val kernelUpdateProtocol = 1

    /**
     * 截屏授权（ui.screenshot 的前置）。
     *
     * MediaProjection 与 Device Owner 的本质区别：它**不能预置**，必须由用户在系统弹窗
     * 上点一次「开始录制」。所以这里必须有个 Activity 承接 startActivityForResult。
     * 拿到 resultCode + data 后：
     * ① saveGrant() 落盘缓存（同进程复用；跨重启尽力复用，失效时回落重新授权）；
     * ② 拉起 ScreenCaptureService 建 projection。
     */
    private val requestCapture = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data
        if (result.resultCode == RESULT_OK && data != null) {
            ScreenCaptureService.saveGrant(this, result.resultCode, data)
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
        // 复用上次授权：若缓存 grant 仍有效直接拉起服务；Android 14+ 跨重启可能失效，届时回落弹窗。
        reuseExistingCaptureGrant()
        startRuntime()
        startPolling()
        runSelfCheckOnce()
    }

    /**
     * 设备端自检：**后台**跑一次，结果前缀到诊断面板。
     *
     * 为什么显示在界面上而不是只写文件：目标设备的 **adb 是关闭的**，
     * 用户无法用 adb 把 provisioning.json 拉出来看。把结论直接显示在屏幕上，
     * 是唯一可行的验证方式（见 docs/runbook/kernel-device-verification.md）。
     */
    private fun runSelfCheckOnce() {
        Thread {
            val text = try {
                KernelSelfCheck.runAndFormat(this)
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
                KernelSelfCheck.runAndFormat(this)
            } catch (e: Throwable) {
                "自检异常: " + e::class.java.simpleName + ": " + (e.message ?: "")
            }
            selfCheckText = text
            handler.post {
                try {
                    val cm = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
                    cm.setPrimaryClip(android.content.ClipData.newPlainText("DSH 自检", text))
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
        // 「已就绪」只认 PermissionCenter 那一把尺子（它读 ScreenCaptureService.isReady）——
        // 这里再手写一次就会和首页 S2 / 桥令牌的口径漂移（spec §2.5）。
        val captureSpec = PermissionCatalog.byId(PermissionCatalog.MEDIAPROJECTION)
        if (captureSpec != null && PermissionCenter(this).isGranted(captureSpec)) return
        val grant = ScreenCaptureService.loadGrant(this) ?: return
        startCaptureService(grant.first, grant.second)
    }

    /** 拉起截屏前台服务（Android 14+ 必须以前台服务承载 MediaProjection）。 */
    private fun startCaptureService(resultCode: Int, data: Intent) {
        try {
            val svc = Intent(this, ScreenCaptureService::class.java)
                .setAction(ScreenCaptureService.ACTION_START)
                .putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, resultCode)
                .putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, data)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(svc)
            } else {
                startService(svc)
            }
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
        webView.addJavascriptInterface(DshBridge(this), "DshNative")
    }

    /**
     * 原生侧接收内核发来的 dsh:kernel-update-request，处理并回灌结果。
     * 回灌**严格按内核 kernelUpdateBridge.ts 的契约**：{v,type,requestId,ok,stage,version,restartUncertain,error}。
     * 缺 v / ok 会导致内核侧直接丢弃消息（面板超时）。
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
     *   · 安装成功 → 重启 :node 拉起新内核，ok=true, stage=updated, restartUncertain=true
     */
    private fun runKernelUpdate(requestId: String): org.json.JSONObject {
        val km = KernelManager(this)
        return try {
            if (KernelOtaUpdater.loadConfig(this) == null) {
                return resultJson(requestId, false, "failed", null, "未配置 kernel-feed.json：远端内核 OTA 未启用")
            }
            progressToHost(requestId, "checking")
            val outcome = KernelOtaUpdater.checkAndUpdate(this, km, checkOnly = false)
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
        put("v", kernelUpdateProtocol)
        put("type", "dsh:kernel-update-result")
        put("requestId", requestId)
        put("ok", ok)
        put("stage", stage)
        if (version != null) put("version", version) else put("version", org.json.JSONObject.NULL)
        put("restartUncertain", restartUncertain)
        if (error != null) put("error", error) else put("error", org.json.JSONObject.NULL)
    }

    private fun progressToHost(requestId: String, stage: String) {
        val o = org.json.JSONObject().apply {
            put("v", kernelUpdateProtocol)
            put("type", "dsh:kernel-update-progress")
            put("requestId", requestId)
            put("stage", stage)
        }
        deliverToHost(o.toString())
    }

    /** 宿主帧暴露 dshDeliverResult(json)；用 JSON 字符串安全注入（避免拼接注入）。 */
    private fun deliverToHost(jsonStr: String) {
        webView.post {
            webView.evaluateJavascript(
                "window.dshDeliverResult && window.dshDeliverResult(${org.json.JSONObject.quote(jsonStr)})",
                null
            )
        }
    }

    private fun startRuntime(action: String? = null) {
        // UI 是监督链的又一条边（用户打开界面的时刻补位）。
        ContainerSupervisor.ensureRunning(this)
        val svc = Intent(this, NodeRuntimeService::class.java)
        if (action != null) svc.action = action
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(svc)
        } else {
            startService(svc)
        }
    }

    private fun restartRuntime() {
        // 旧实现先 stopService 再重启 —— 监督者引入 binder 边（BIND_AUTO_CREATE）后
        // 该 stop 已**杀不动** :node（绑定在册），只剩"假装重启"的误导。
        // 正确语义 = ACTION_RESTART：:node 自己终结当前实例，boot 循环重走全流程。
        uiMode = false
        webView.visibility = View.GONE
        scroll.visibility = View.VISIBLE
        retryBtn.visibility = View.VISIBLE
        RuntimeDiagnostics.clear(this)
        diagText.text = "正在重启运行时..."
        startRuntime(NodeRuntimeService.ACTION_RESTART)
    }

    private fun startPolling() {
        handler.post(object : Runnable {
            override fun run() {
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
        uiMode = true
        scroll.visibility = View.GONE
        retryBtn.visibility = View.GONE
        webView.visibility = View.VISIBLE
        // 加载**内核同源托管**的宿主帧（非容器 assets）：宿主页与面板同源 → 面板写操作不被内核 403。
        webView.loadUrl("http://127.0.0.1:${GuestAdapter.KERNEL_CONTROL_PORT}/__host")
    }

    private fun isPortUp(): Boolean = try {
        val c = java.net.URL("http://127.0.0.1:${GuestAdapter.KERNEL_CONTROL_PORT}/status").openConnection() as java.net.HttpURLConnection
        c.connectTimeout = 300
        // 与容器侧 isStatusUp 同理：设备忙时 300ms 读超时会把「活着但忙」误判成死，
        // 表现为面板永远进不去、一直停在诊断页（真机 2026-09-22）。
        c.readTimeout = 1500
        c.requestMethod = "GET"
        c.responseCode == 200
    } catch (_: Throwable) {
        false
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    /** 内核 ↔ 原生桥：宿主帧经 window.DshNative.onRequest 把更新请求交给原生。 */
    private class DshBridge(private val activity: MainActivity) {
        @JavascriptInterface
        fun onRequest(json: String) {
            activity.runOnUiThread { activity.handleKernelUpdateRequest(json) }
        }
    }
}
