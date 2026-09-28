package lobos.ui.console

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import lobos.RuntimeDiagnostics
import lobos.lifecycle.OsHostService
import lobos.ota.ProgramManager
import lobos.ota.ProgramOtaUpdater
import lobos.runtime.GuestAdapter
import java.net.HttpURLConnection
import java.net.URL

/**
 * 控制台承载面（E8 拆分后）：只做一件事 —— 把 console Program 的宿主帧装进 WebView。
 *
 * 与 [lobos.ui.setup.SetupActivity] 的分工：Setup 负责首启引导/配对/授权；本 Activity 负责"工作台"。
 * 不 spawn 任何进程、不占前台服务：console 由 OsHostService/InstanceHost 拉起，本页只等控制面就绪。
 *
 * 面板契约（lobos:panel-update-*）与 console/ui/panelUpdateBridge.ts 逐字对齐；
 * 无法确定的事（重启结果）如实回 restartUncertain=true。
 */
class ConsoleActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val handler = Handler(Looper.getMainLooper())
    private var tries = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // UI 是保活链的又一条边：用户打开界面即补位拉起宿主（幂等）。
        OsHostService.ensureRunning(this)
        webView = WebView(this)
        setContentView(webView)
        webView.webViewClient = WebViewClient()
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.addJavascriptInterface(LobosBridge(this), "LobosNative")
        awaitConsole()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    /** 控制面未就绪就退避重试（最多 30s），如实记账，不伪造。 */
    private fun awaitConsole() {
        if (isControlPlaneUp()) {
            webView.loadUrl("http://127.0.0.1:" + GuestAdapter.CONSOLE_PORT + "/__host")
            return
        }
        if (tries++ > 60) {
            RuntimeDiagnostics.append(this, "console", false, "控制面 30s 未就绪", "等待 InstanceHost 拉起 console Program")
            return
        }
        handler.postDelayed({ awaitConsole() }, 500)
    }

    private fun isControlPlaneUp(): Boolean = try {
        val c = URL("http://127.0.0.1:" + GuestAdapter.CONSOLE_PORT + "/status").openConnection() as HttpURLConnection
        c.connectTimeout = 300
        c.readTimeout = 300
        c.responseCode in 200..499
    } catch (_: Throwable) { false }

    /** 宿主帧经 window.LobosNative.onRequest 交付更新请求。 */
    fun handleUpdateRequest(json: String) {
        val requestId = try { org.json.JSONObject(json).optString("requestId", "") } catch (_: Throwable) { "" }
        Thread { deliver(runUpdate(requestId).toString()) }.start()
    }

    private fun runUpdate(requestId: String): org.json.JSONObject {
        val km = ProgramManager(this)
        return try {
            if (ProgramOtaUpdater.loadConfig(this) == null) {
                return result(requestId, false, "failed", null, "未配置 program-feed.json：Program OTA 未启用")
            }
            progress(requestId, "checking")
            val outcome = ProgramOtaUpdater.checkAndUpdate(this, km, checkOnly = false)
            when {
                !outcome.checked -> result(requestId, false, "failed", outcome.remote, outcome.detail)
                !outcome.available -> result(requestId, true, "up-to-date", outcome.current, null)
                outcome.updated -> {
                    progress(requestId, "restarting")
                    // 单进程后没有"重启独立进程"这一步：把 ACTION_RESTART 交给宿主，由它转给 InstanceHost（幂等）。
                    OsHostService.ensureRunning(this)
                    try { startService(android.content.Intent(this, OsHostService::class.java).setAction(lobos.runtime.InstanceHost.ACTION_RESTART)) } catch (_: Throwable) {}
                    result(requestId, true, "updated", outcome.remote, null, restartUncertain = true)
                }
                else -> result(requestId, false, "failed", outcome.remote, outcome.detail)
            }
        } catch (e: Throwable) {
            result(requestId, false, "failed", null, e::class.java.simpleName + ": " + e.message)
        }
    }

    private fun result(requestId: String, ok: Boolean, stage: String, version: String?, error: String?, restartUncertain: Boolean = false): org.json.JSONObject =
        org.json.JSONObject().apply {
            put("v", 1)
            put("type", "lobos:panel-update-result")
            put("requestId", requestId)
            put("ok", ok)
            put("stage", stage)
            put("version", version ?: org.json.JSONObject.NULL)
            put("restartUncertain", restartUncertain)
            put("error", error ?: org.json.JSONObject.NULL)
        }

    private fun progress(requestId: String, stage: String) {
        deliver(org.json.JSONObject().apply {
            put("v", 1)
            put("type", "lobos:panel-update-progress")
            put("requestId", requestId)
            put("stage", stage)
        }.toString())
    }

    private fun deliver(jsonStr: String) {
        webView.post {
            webView.evaluateJavascript(
                "window.lobosDeliverResult && window.lobosDeliverResult(" + org.json.JSONObject.quote(jsonStr) + ")",
                null,
            )
        }
    }

    private class LobosBridge(private val activity: ConsoleActivity) {
        @JavascriptInterface
        fun onRequest(json: String) { activity.runOnUiThread { activity.handleUpdateRequest(json) } }
    }
}
