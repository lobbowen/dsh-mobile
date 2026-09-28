package lobos.bridge

import android.app.Activity
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import lobos.MainActivity
import lobos.OsApplication
import lobos.R
import lobos.RuntimeDiagnostics
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * 截屏服务（ui.screenshot 的执行体，P5）。
 *
 * 为什么必须是前台服务（而不是普通 Service / 甚至直接在桥里做）
 * Android 14 (API 34) 起，持有 MediaProjection 的进程**必须**运行一个
 * foregroundServiceType="mediaProjection" 的前台服务，否则系统直接抛
 * SecurityException。这是硬性要求，不是优化建议。
 *
 * 授权模型（与无障碍类系统绑定服务的本质区别）
 * MediaProjection 的授权是 **每次会话** 的：必须由用户在系统弹窗里点「开始录制」，
 * 拿回一个 resultCode + Intent，用它 createScreenCaptureIntent 才能建出 VirtualDisplay。
 *
 * 这意味着：
 * · **无法预置**（系统不允许后台静默授予）；
 * · 无法在后台静默发起（必须有 Activity 承载 startActivityForResult）；
 * · 授权结果**尽力复用**：缓存在 files/screen-capture-grant.json，同进程内的
 * 后续截图直接重建 MediaProjection。注意 Android 14+ 对 token 复用收紧，
 * 跨进程重启的缓存可能失效 —— 失效路径必须 catch 住并回落重新授权
 * （见 startCapture 的 SecurityException/null 归因），不能当成功宣称。
 *
 * 所以本服务的契约是：**「授权一次，同进程长期复用；失效即明确报未授权」**。
 * 首次 ui.screenshot 若未授权，返回 -32001 并附带 "需要用户授权" 的明确指引；
 * 用户在 App 里点一次授权后，后续截图即可后台完成。
 */
class ScreenCaptureController(private val host: Service) : ContextWrapper(host) {

    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var handlerThread: HandlerThread? = null
    private var handler: Handler? = null

    /**
     * 由 [OsHostService] 调用：纳管本组件。
     * 本控制器**不直接转前台**：截屏会话的 FGS 由 [ScreenCaptureService] 承担（A5 已接线）——
     * 授权结果先交给它转前台，再由它回调 [startProjectionFromService] 创建投影。
     */
    fun start() {
        instance = this
    }

    /** 授权结果由 Console 界面经此 Intent 传入（host 转发）。 */
    fun onHostStart(intent: Intent?) {
        if (intent?.action == ACTION_START && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            val code = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
            @Suppress("DEPRECATION")
            val data = intent.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
            if (code == Activity.RESULT_OK && data != null) {
                // 委托给截屏前台服务（A5）：API 34+ 要求「先有 mediaProjection 类型的 FGS，
                // 再创建 MediaProjection」，否则 getMediaProjection 抛 SecurityException。
                ScreenCaptureService.start(this, code, data)
            } else {
                RuntimeDiagnostics.append(this, "screenshot", false, "截屏授权被取消", "resultCode=$code")
            }
        }
    }

    private fun startProjection(resultCode: Int, data: Intent) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return
        try {
            val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val p = mpm.getMediaProjection(resultCode, data) ?: run {
                RuntimeDiagnostics.append(this, "screenshot", false, "getMediaProjection 返回 null", "授权数据可能已失效")
                return
            }
            // 必须注册 callback：否则部分 ROM 上 projection 会在短暂空闲后被系统回收，
            // 表现为「第一次能截、第二次 startVirtualDisplay 抛 IllegalStateException」。
            p.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    Log.i(TAG, "MediaProjection 被系统停止")
                    teardown()
                }
            }, Handler(android.os.Looper.getMainLooper()))

            projection = p
            instance = this
            RuntimeDiagnostics.append(this, "screenshot", true, "MediaProjection 已就绪", "截屏授权生效")
        } catch (e: Throwable) {
            RuntimeDiagnostics.append(this, "screenshot", false, "启动 MediaProjection 失败", errText(e))
        }
    }

    /**
     * 截一帧。**同步**返回，最多等 8 秒。
     *
     * 实现要点：ImageReader 取最新帧 → 转 Bitmap。
     * 用 `acquireLatestImage()` 而不是 `acquireNextImage()`：后者拿到的是队列里最旧的帧，
     * 在高刷新率设备上可能已经过期好几帧。
     */
    fun capture(width: Int, height: Int, densityDpi: Int): Bitmap? {
        val p = projection ?: return null
        val latch = CountDownLatch(1)
        val holder = AtomicReference<Bitmap?>(null)

        try {
            setupDisplay(p, width, height, densityDpi)
            val reader = imageReader ?: return null
            reader.setOnImageAvailableListener({ r ->
                var image: Image? = null
                try {
                    image = r.acquireLatestImage()
                    if (image != null) {
                        holder.set(imageToBitmap(image))
                    }
                } catch (e: Throwable) {
                    Log.w(TAG, "取帧失败", e)
                } finally {
                    try { image?.close() } catch (_: Throwable) {}
                    latch.countDown()
                }
            }, handler)

            // 部分设备首次建 VirtualDisplay 后需要一两帧才出图；超时即放弃。
            if (!latch.await(8, TimeUnit.SECONDS)) {
                Log.w(TAG, "截屏超时（8s 内未收到帧）")
            }
        } catch (e: Throwable) {
            RuntimeDiagnostics.append(this, "screenshot", false, "截屏失败", errText(e))
        }
        return holder.get()
    }

    private fun setupDisplay(p: MediaProjection, width: Int, height: Int, densityDpi: Int) {
        if (imageReader != null) return // 复用已建好的显示
        if (handler == null) {
            val t = HandlerThread("lobos-screen-capture")
            t.start()
            handlerThread = t
            handler = Handler(t.looper)
        }
        val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        imageReader = reader
        virtualDisplay = p.createVirtualDisplay(
            "lobos-capture",
            width, height, densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface, null, handler
        )
    }

    private fun imageToBitmap(image: Image): Bitmap {
        val plane = image.planes[0]
        val buffer = plane.buffer
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * image.width

        // ImageReader 的行跨度通常大于 width*4（对齐填充），直接 createBitmap 会花屏。
        val bmp = Bitmap.createBitmap(
            image.width + rowPadding / pixelStride,
            image.height,
            Bitmap.Config.ARGB_8888
        )
        bmp.copyPixelsFromBuffer(buffer)
        return Bitmap.createBitmap(bmp, 0, 0, image.width, image.height)
    }

    private fun teardown() {
        try { virtualDisplay?.release() } catch (_: Throwable) {}
        try { imageReader?.close() } catch (_: Throwable) {}
        try { projection?.stop() } catch (_: Throwable) {}
        virtualDisplay = null
        imageReader = null
        projection = null
        if (instance === this) instance = null
        // 投影没了，临时 FGS 也该消失（稳态回到唯一的宿主 FGS）。
        ScreenCaptureService.stop(this)
    }

    /** 由 [OsHostService] 调用：释放投影与显示（不再是 Service 生命周期）。 */
    fun shutdown() {
        teardown()
        handlerThread?.quitSafely()
        handlerThread = null
        handler = null
    }

    private fun errText(e: Throwable): String =
        "${e::class.java.simpleName}: ${e.message}"

    companion object {
        const val TAG = "ScreenCaptureController"
        const val ACTION_START = "lobos.SCREEN_CAPTURE_START"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"

        /** 截图授权缓存文件（同进程复用；跨重启仅尽力复用，Android 14+ 可能失效需重新授权）。 */
        const val GRANT_FILE = "screen-capture-grant.json"

        @Volatile
        var instance: ScreenCaptureController? = null
            private set

        fun isReady(): Boolean = instance?.projection != null

        /** 由 [ScreenCaptureService] 在转前台之后调用：此刻创建投影才符合 API 34 的次序。 */
        fun startProjectionFromService(ctx: Context, resultCode: Int, data: Intent) {
            instance?.startProjection(resultCode, data)
        }

        /**
         * 保存授权结果。 Intent 无法直接序列化为 JSON，故用 Intent 的
         * toUri(FLAG_GRANT_READ_URI_PERMISSION) 仅能拿到数据 URI —— 对 MediaProjection
         * 的授权 Intent 不适用。稳妥做法是把整个 Intent 以 Parcel 字节流存盘。
         */
        fun saveGrant(ctx: Context, resultCode: Int, data: Intent) {
            try {
                val parcel = android.os.Parcel.obtain()
                data.writeToParcel(parcel, 0)
                val bytes = parcel.marshall()
                parcel.recycle()
                val obj = org.json.JSONObject().apply {
                    put("resultCode", resultCode)
                    put("intentBase64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
                    put("savedAt", System.currentTimeMillis())
                }
                File(ctx.filesDir, GRANT_FILE).writeText(obj.toString())
            } catch (e: Throwable) {
                Log.w(TAG, "保存截屏授权失败", e)
            }
        }

        fun loadGrant(ctx: Context): Pair<Int, Intent>? {
            return try {
                val f = File(ctx.filesDir, GRANT_FILE)
                if (!f.exists()) return null
                val obj = org.json.JSONObject(f.readText())
                val bytes = android.util.Base64.decode(obj.getString("intentBase64"), android.util.Base64.DEFAULT)
                val parcel = android.os.Parcel.obtain()
                parcel.unmarshall(bytes, 0, bytes.size)
                parcel.setDataPosition(0)
                @Suppress("DEPRECATION")
                val intent = Intent.CREATOR.createFromParcel(parcel)
                parcel.recycle()
                obj.getInt("resultCode") to intent
            } catch (e: Throwable) {
                Log.w(TAG, "读取截屏授权失败", e)
                null
            }
        }
    }
}
