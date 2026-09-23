package io.github.lobbowen.dshmobile.shizuku

import android.content.Context
import android.os.Bundle
import androidx.annotation.Keep
import java.util.concurrent.TimeUnit

/**
 * Shizuku UserService：运行在 Shizuku server 的**自己的进程**里，身份是 shell（adb, uid 2000）。
 *
 * 为什么不是 `Shizuku.newProcess`：自 Shizuku v13 起该方法已 **private 且标记废弃**
 * （计划 API 14 移除）。官方受支持的路径就是自定义 AIDL + UserService（本类）。
 */
class RemoteShellService : IRemoteShell.Stub {

    /** 无参构造是 Shizuku 反射实例化的硬要求。 */
    @Keep
    constructor() : super()

    /** v13 起支持带 Context 的构造（可选）。 */
    @Keep
    constructor(context: Context) : super()

    /** 保留事务：调用方死亡后由 server 调用来回收本 user service。 */
    override fun destroy() {
        android.os.Process.killProcess(android.os.Process.myPid())
    }

    override fun exec(cmd: String, args: Array<out String>?, timeoutMs: Long): Bundle {
        val argv = ArrayList<String>(1 + (args?.size ?: 0))
        argv.add(cmd)
        args?.let { argv.addAll(it) }

        val out = Bundle()
        var proc: java.lang.Process? = null
        try {
            val p = ProcessBuilder(argv).redirectErrorStream(true).start()
            proc = p
            val sb = StringBuilder()
            val reader = p.inputStream.bufferedReader()
            // 读线程与 waitFor 并行：避免管道写满导致子进程阻塞（经典死锁）。
            val pump = Thread {
                reader.forEachLine { if (sb.length < MAX_OUTPUT) sb.append(it).append('\n') }
            }
            pump.start()
            val finished = p.waitFor(timeoutMs.coerceIn(1L, 60_000L), TimeUnit.MILLISECONDS)
            if (!finished) {
                p.destroyForcibly()
                out.putInt("exitCode", -1)
                out.putString("output", sb.toString() + "\n…(超时 ${timeoutMs}ms，已强杀)")
            } else {
                pump.join(500)
                out.putInt("exitCode", p.exitValue())
                out.putString("output", sb.toString())
            }
        } catch (e: Throwable) {
            out.putInt("exitCode", -1)
            out.putString("output", "exec 失败：${e.message}")
        } finally {
            try { proc?.destroy() } catch (_: Throwable) { }
        }
        out.putInt("uid", android.os.Process.myUid())
        return out
    }

    private companion object {
        const val MAX_OUTPUT = 256 * 1024
    }
}
