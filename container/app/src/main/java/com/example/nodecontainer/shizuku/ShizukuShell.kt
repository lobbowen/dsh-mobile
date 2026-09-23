package com.example.nodecontainer.shizuku

import android.content.ComponentName
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.IBinder
import com.example.nodecontainer.BuildConfig
import rikka.shizuku.Shizuku
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * `shell.exec` 的能力本体。**Shizuku 是必备前提**（ADR-0003）：未安装 / 未启动 / 未授权时，
 * 能力协商为不可用，调用方按契约拿到 -32001 —— **不做应用 uid 兜底**，不搞特判分支。
 */
object ShizukuShell {

    private val remote = AtomicReference<IRemoteShell?>(null)
    private val connected = CountDownLatch(1)

    private val args: Shizuku.UserServiceArgs by lazy {
        Shizuku.UserServiceArgs(
            ComponentName(BuildConfig.APPLICATION_ID, RemoteShellService::class.java.name)
        )
            .daemon(false)          // 调用方进程死亡即回收
            .version(1)             // 代码更新时递增，让 server 重建 user service
            .processNameSuffix("shell")
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            remote.set(IRemoteShell.Stub.asInterface(binder))
            while (connected.count > 0) connected.countDown()
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            remote.set(null)
        }
    }

    fun binderAlive(): Boolean = try {
        Shizuku.pingBinder()
    } catch (_: Throwable) { false }

    fun permissionGranted(): Boolean = try {
        binderAlive() && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
    } catch (_: Throwable) { false }

    fun requestPermission(requestCode: Int) {
        try {
            if (binderAlive()) Shizuku.requestPermission(requestCode)
        } catch (_: Throwable) { }
    }

    /** 确保 user service 已绑定；未授权或绑定失败返回 false。 */
    fun ensureBound(): Boolean {
        if (!permissionGranted()) return false
        if (remote.get() != null) return true
        return try {
            Shizuku.bindUserService(args, connection)
            connected.await(5, TimeUnit.SECONDS) && remote.get() != null
        } catch (_: Throwable) { false }
    }

    data class ExecResult(val exitCode: Int, val output: String, val uid: Int)

    /** null 表示能力不可用（未授权/绑定失败）——由调用方转成 -32001。 */
    fun exec(cmd: String, cmdArgs: List<String>, timeoutMs: Long): ExecResult? {
        if (!ensureBound()) return null
        val svc = remote.get() ?: return null
        return try {
            val b = svc.exec(cmd, cmdArgs.toTypedArray(), timeoutMs)
            ExecResult(b.getInt("exitCode", -1), b.getString("output") ?: "", b.getInt("uid", -1))
        } catch (_: Throwable) { null }
    }
}
