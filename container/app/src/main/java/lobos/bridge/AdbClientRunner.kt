package lobos.bridge

import android.content.Context
import lobos.os.Backoff
import lobos.native.NativeAssetRegistry
import lobos.native.NativePreparer
import lobos.runtime.NodeProvisioner
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.io.OutputStreamWriter
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject

/**
 * 调用内置 ADB 客户端（assets/node/adb-client/）。
 *
 * 形态与 [ProgramVerifier] 同构（Node 侧有 minSdk 24 缺的 TLS exporter / SPAKE2
 * 原语），协议细节见 cli.js 头注释与 ADR-0003（勘误 2026-09-24）。
 *
 * 凭据目录固定在 files/adb/（0700，密钥 0600），由 LOBOS_ADB_DIR 注入子进程 ——
 * 不再放内核目录：OTA 下来的 L1 不应能读写权限通道的身份密钥。
 * 首次运行通过 --migrate-from 认领旧内核路径（files/supervisor/adb/）的密钥，
 * 保住已在设备上授权过的 ADB 身份，避免升级后要求用户重新配对。
 *
 * ── 为什么改成"常驻 serve + 帧"（2026-09-27 真机定罪"无限连接断开"）──────────────
 * 旧实现每次 status/shell 都新起一个 Node 子进程（约 100MB libnode 映射），进程内的
 * transport 做得再好也无法跨调用复用 TLS 会话，adbd 侧于是每次都重走
 * TlsConnection 初始化 → Handshake → timeout 清 socket。
 * 现在只 **惰性启动一个** cli.js serve：stdin 发 JSON-RPC 帧、stdout 收结果帧，
 * 进程内 transport 维护常驻多路复用会话。进程死了才按指数退避重启（上限封顶）。
 *
 * pair **仍走一次性子进程**：配对是 SPAKE2 一次性握手，与常驻 shell 通道无关，
 * 也避免把配对的失败态带进常驻进程。
 */
object AdbClientRunner {

    /** 子进程结果。ok=false 时 error 给出归因；raw 保留一手输出供诊断。 */
    data class AdbOutcome(
        val ok: Boolean,
        val json: JSONObject?,
        val error: String?,
        val raw: String,
        val exitCode: Int,
    )

    fun status(context: Context): AdbOutcome =
        serve(context, "status", JSONObject(), DEFAULT_TIMEOUT_MS)

    fun forget(context: Context): AdbOutcome =
        serve(context, "forget", JSONObject(), DEFAULT_TIMEOUT_MS)

    /**
     * 常驻通道读数：只回答"当前是否已有一条就绪的 TLS 会话"，不发新连接、不跑命令。
     * [AdbChannelProbe] 靠它在两次重验之间续读，避免为了"活着"反复 dial。
     */
    fun channel(context: Context, timeoutMs: Long = CHANNEL_TIMEOUT_MS): AdbOutcome =
        serve(context, "channel", JSONObject(), timeoutMs)

    fun pair(
        context: Context,
        host: String,
        pairPort: Int,
        code: String,
        connectPort: Int?,
        timeoutMs: Long,
    ): AdbOutcome {
        val args = mutableListOf("pair", "--host", host, "--pair-port", pairPort.toString(),
            "--code", code, "--timeout-ms", timeoutMs.toString())
        if (connectPort != null) args += listOf("--connect-port", connectPort.toString())
        return runOnce(context, args, timeoutMs + SPAWN_SLACK_MS)
    }

    /**
     * 经已配对的通道跑一条 shell。端点来源优先级：调用方显式指定 > 常驻通道现有端点 >
     * 现场 mDNS 记录 > （皆无）Node 侧 state.json 的历史值。
     *
     * 第二档是根治点：通道已就绪就**直接复用它的 host:port**，既不再现问 mDNS，也不
     * 新建 TCP/TLS。只有通道未就绪时才现问一次 mDNS（ConnectEndpointResolver 的
     * watcher 已常驻，resolve 不再每次新起 NsdManager browse）。
     */
    fun shell(
        context: Context,
        cmd: String,
        host: String?,
        connectPort: Int?,
        timeoutMs: Long,
    ): AdbOutcome {
        val params = JSONObject().apply {
            put("cmd", cmd)
            put("timeoutMs", timeoutMs)
        }
        var epHost = host
        var epPort = connectPort
        if (epHost == null || epPort == null) {
            val ch = channel(context, CHANNEL_TIMEOUT_MS)
            val ready = ch.json?.takeIf { it.optBoolean("ready", false) }
            if (ready != null) {
                epHost = epHost ?: ready.optString("host", "").takeIf { it.isNotBlank() }
                epPort = epPort ?: ready.optInt("port", 0).takeIf { it > 0 }
            }
            if (epHost == null || epPort == null) {
                val live = ConnectEndpointResolver.resolve(context)
                epHost = epHost ?: live?.host
                epPort = epPort ?: live?.port
            }
        }
        epHost?.takeIf { it.isNotBlank() }?.let { params.put("host", it) }
        epPort?.takeIf { it > 0 }?.let { params.put("connectPort", it) }
        return serve(context, "shell", params, timeoutMs + SPAWN_SLACK_MS)
    }

    // ── 常驻 serve 子进程 ─────────────────────────────────────────────────────

    private sealed class CallResult {
        data class Frame(val obj: JSONObject) : CallResult()
        data class Failure(val error: String, val dead: Boolean) : CallResult()
    }

    private val lock = Any()

    @Volatile
    private var proc: ServeProcess? = null

    @Volatile
    private var consecutiveFailures = 0

    @Volatile
    private var nextStartAtMs = 0L

    @Volatile
    private var lastStartError: String? = null

    /** 发一帧并等结果帧；进程中途死掉会在预算内退避重启后重试。 */
    private fun serve(context: Context, method: String, params: JSONObject, timeoutMs: Long): AdbOutcome {
        val deadline = System.currentTimeMillis() + timeoutMs
        var lastErr: String? = null
        while (true) {
            val remaining = deadline - System.currentTimeMillis()
            if (remaining <= 0) {
                return AdbOutcome(false, null, lastErr ?: ("adb-timeout " + timeoutMs + "ms"), drainLogs(), -1)
            }
            val p = ensureProcess(context, remaining)
                ?: return AdbOutcome(false, null, lastStartError ?: "adb serve 进程不可用", drainLogs(), -1)
            when (val r = p.call(method, params, deadline - System.currentTimeMillis())) {
                is CallResult.Frame -> {
                    markHealthy()
                    return toOutcome(r.obj, p)
                }
                is CallResult.Failure -> {
                    if (!r.dead) return AdbOutcome(false, null, r.error, p.logsText(), -1)
                    // 进程死了：ensureProcess 会按退避重启；预算耗尽即收口。
                    lastErr = r.error
                    if (System.currentTimeMillis() >= deadline) {
                        return AdbOutcome(false, null, lastErr, p.logsText(), -1)
                    }
                }
            }
        }
    }

    /** 惰性启动；死了/没有才建；连不上按指数退避，退避中且预算不够就直接失败。 */
    private fun ensureProcess(context: Context, budgetMs: Long): ServeProcess? {
        synchronized(lock) {
            val existing = proc
            if (existing != null && existing.alive) return existing
            if (existing != null) {
                // 进程已死：先记一次失败并把下一次启动推到退避窗口之后。
                existing.destroyQuietly()
                proc = null
                consecutiveFailures += 1
                nextStartAtMs = System.currentTimeMillis() + backoffMs(consecutiveFailures)
            }
            val waitMs = nextStartAtMs - System.currentTimeMillis()
            if (waitMs > 0) {
                if (waitMs >= budgetMs) {
                    lastStartError = "adb serve 处于重启退避中（" + waitMs + "ms 后重试）"
                    return null
                }
                try {
                    Thread.sleep(waitMs)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return null
                }
            }
            return try {
                val started = startProcess(context)
                proc = started
                lastStartError = null
                started
            } catch (e: Throwable) {
                consecutiveFailures += 1
                nextStartAtMs = System.currentTimeMillis() + backoffMs(consecutiveFailures)
                lastStartError = "adb-spawn-failed " + e::class.java.simpleName + ": " + (e.message ?: "")
                null
            }
        }
    }

    /** 真回了一帧才算健康：只在"启动成功"时清零会让启动即崩的进程永远 500ms 重试。 */
    private fun markHealthy() {
        consecutiveFailures = 0
        nextStartAtMs = 0L
    }

    /** 指数退避：与 SupervisorPolicy 共用 [lobos.os.Backoff]（复检 C5 去重）。 */
    private fun backoffMs(failures: Int): Long =
        Backoff.exponential(failures - 1, RESTART_BASE_MS, RESTART_MAX_MS)

    /** 子进程环境注入：HOME/TMPDIR/LOBOS_ADB_DIR/LD_LIBRARY_PATH 一样都不能少。 */
    private fun baseEnv(context: Context, adbDir: File): List<Pair<String, String>> {
        return listOf(
            "HOME" to context.filesDir.absolutePath,
            "TMPDIR" to context.cacheDir.absolutePath,
            "LOBOS_ADB_DIR" to adbDir.absolutePath,
            // 本进程派生的后续子进程（$PREFIX 里的工具）无 RUNPATH，靠继承这个变量找库。
            // NativePreparer.probe 刻意不设 —— 那才是 run_code 的真实形态。
            "LD_LIBRARY_PATH" to NativePreparer.libSearchPath(context),
        )
    }

    private fun startProcess(context: Context): ServeProcess {
        val scriptDir = NodeProvisioner.ensureAdbClientScripts(context)
        val nodeBin = NativeAssetRegistry.resolve(context, NativeAssetRegistry.NODE)
        val adbDir = File(context.filesDir, "adb").apply { if (!exists()) mkdirs() }
        val args = mutableListOf(nodeBin.absolutePath, File(scriptDir, "cli.js").absolutePath, "serve")
        args += listOf("--migrate-from", File(context.filesDir, "supervisor/adb").absolutePath)
        val pb = ProcessBuilder(args)
            .directory(context.filesDir)
            .redirectErrorStream(false) // stdout 是帧通道，stderr 另收，绝不混流
        for ((k, v) in baseEnv(context, adbDir)) pb.environment().put(k, v)
        return ServeProcess(pb.start())
    }

    private fun toOutcome(obj: JSONObject, p: ServeProcess): AdbOutcome {
        val raw = p.logsText()
        val err = obj.optJSONObject("error")
        if (err != null) {
            return AdbOutcome(false, null, err.optString("message", "unknown").ifBlank { "unknown" }, raw, 0)
        }
        val result = obj.optJSONObject("result")
            ?: return AdbOutcome(false, null, "serve 结果帧缺 result: " + obj.toString().take(200), raw, 0)
        val ok = result.optBoolean("ok", true)
        return AdbOutcome(
            ok = ok,
            json = result,
            error = if (ok) null else result.optString("error", "unknown").ifBlank { "unknown" },
            raw = raw,
            exitCode = 0,
        )
    }

    private fun drainLogs(): String = proc?.logsText() ?: ""

    /** pair 的一次性子进程：spawn → 干活 → LOBOS_ADB_RESULT 行 → 退出。 */
    private fun runOnce(context: Context, subArgs: List<String>, procTimeoutMs: Long): AdbOutcome {
        val scriptDir = try {
            NodeProvisioner.ensureAdbClientScripts(context)
        } catch (e: Throwable) {
            return AdbOutcome(false, null, "adb-client-script-missing: " + e.message, "", -1)
        }
        val nodeBin = NativeAssetRegistry.resolve(context, NativeAssetRegistry.NODE)
        val adbDir = File(context.filesDir, "adb").apply { if (!exists()) mkdirs() }

        val args = mutableListOf(nodeBin.absolutePath, File(scriptDir, "cli.js").absolutePath)
        args += subArgs
        args += listOf("--migrate-from", File(context.filesDir, "supervisor/adb").absolutePath)

        return try {
            val pb = ProcessBuilder(args).directory(context.filesDir).redirectErrorStream(false)
            for ((k, v) in baseEnv(context, adbDir)) pb.environment().put(k, v)
            val p = pb.start()
            val out = StringBuilder()
            val err = StringBuilder()
            // 读线程与 waitFor 并行：单线程先 waitFor 会在管道写满时死锁。
            val outPump = Thread {
                p.inputStream.bufferedReader().forEachLine { line ->
                    synchronized(out) { if (out.length < MAX_OUTPUT) out.append(line).append('\n') }
                }
            }
            val errPump = Thread {
                p.errorStream.bufferedReader().forEachLine { line ->
                    synchronized(err) { if (err.length < MAX_OUTPUT) err.append(line).append('\n') }
                }
            }
            outPump.start()
            errPump.start()
            val finished = p.waitFor(procTimeoutMs, TimeUnit.MILLISECONDS)
            if (!finished) {
                p.destroyForcibly()
                return AdbOutcome(false, null, "adb-timeout " + procTimeoutMs + "ms", out.toString() + err.toString(), -1)
            }
            outPump.join(1000)
            errPump.join(1000)
            val outText = synchronized(out) { out.toString() }
            val raw = outText + err.toString()
            val exit = p.exitValue()

            val line = outText.lineSequence().lastOrNull { it.startsWith(RESULT_PREFIX) }
                ?: return AdbOutcome(false, null,
                    "adb 进程未输出结果行（exit=" + exit + "）", raw, exit)
            val json = try {
                JSONObject(line.substring(RESULT_PREFIX.length).trim())
            } catch (e: Throwable) {
                return AdbOutcome(false, null, "结果行不是合法 JSON: " + line.take(200), raw, exit)
            }
            AdbOutcome(
                ok = json.optBoolean("ok", false) && exit == 0,
                json = json,
                error = if (json.optBoolean("ok", false)) null
                        else json.optString("error", "unknown").ifBlank { "unknown" },
                raw = raw,
                exitCode = exit,
            )
        } catch (e: Throwable) {
            AdbOutcome(false, null,
                "adb-spawn-failed " + e::class.java.simpleName + ": " + (e.message ?: ""), "", -1)
        }
    }

    /**
     * 一个常驻 Node 子进程。stdout 逐行 JSON 帧；id → CompletableFuture 路由。
     * 进程退出时在途帧全部 completeExceptionally，调用方据此走"死了→退避重启"。
     */
    private class ServeProcess(private val process: Process) {
        private val nextId = AtomicLong(0)
        private val pending = ConcurrentHashMap<Long, CompletableFuture<JSONObject>>()
        private val logs = StringBuilder()
        private val writeLock = Any()
        private val stdout: BufferedReader = process.inputStream.bufferedReader(Charsets.UTF_8)
        private val stdin: BufferedWriter = BufferedWriter(OutputStreamWriter(process.outputStream, Charsets.UTF_8))

        @Volatile
        var alive: Boolean = true
            private set

        @Volatile
        private var deathError: String? = null

        init {
            val out = Thread { readLoop() }
            out.name = "adb-serve-out"
            out.isDaemon = true
            out.start()
            val err = Thread { drainStderr() }
            err.name = "adb-serve-err"
            err.isDaemon = true
            err.start()
        }

        fun call(method: String, params: JSONObject, timeoutMs: Long): CallResult {
            if (!alive) return CallResult.Failure(deathError ?: "adb serve 进程已退出", true)
            val id = nextId.incrementAndGet()
            val future = CompletableFuture<JSONObject>()
            pending[id] = future
            val frame = JSONObject().apply {
                put("jsonrpc", "2.0")
                put("id", id)
                put("method", method)
                put("params", params)
            }
            try {
                synchronized(writeLock) {
                    stdin.write(frame.toString())
                    stdin.write("\n")
                    stdin.flush()
                }
            } catch (e: Throwable) {
                pending.remove(id)
                onExit("adb serve 写入失败: " + (e.message ?: e::class.java.simpleName))
                return CallResult.Failure(deathError ?: "adb serve 写入失败", true)
            }
            return try {
                CallResult.Frame(future.get(timeoutMs.coerceAtLeast(1L), TimeUnit.MILLISECONDS))
            } catch (e: TimeoutException) {
                pending.remove(id)
                CallResult.Failure("adb-timeout " + timeoutMs + "ms（serve 未回帧）", false)
            } catch (e: ExecutionException) {
                pending.remove(id)
                CallResult.Failure(deathError ?: ("adb serve 中断: " + (e.cause?.message ?: "")), true)
            } catch (e: InterruptedException) {
                pending.remove(id)
                Thread.currentThread().interrupt()
                CallResult.Failure("adb serve 调用被中断", false)
            }
        }

        fun logsText(): String = synchronized(logs) { logs.toString() }

        private fun readLoop() {
            try {
                while (true) {
                    val line = stdout.readLine() ?: break
                    if (line.isBlank()) continue
                    val obj = try {
                        JSONObject(line)
                    } catch (e: Throwable) {
                        appendLog("stdout非帧: " + line.take(200))
                        continue
                    }
                    val id = obj.optLong("id", -1L)
                    if (id > 0) pending.remove(id)?.complete(obj)
                    else appendLog("stdout无id帧: " + line.take(200))
                }
            } catch (e: Throwable) {
                appendLog("stdout读取结束: " + (e.message ?: e::class.java.simpleName))
            } finally {
                onExit("adb serve stdout 关闭")
            }
        }

        private fun drainStderr() {
            try {
                process.errorStream.bufferedReader(Charsets.UTF_8).forEachLine { appendLog(it) }
            } catch (e: Throwable) {
                // stderr 只是诊断，读不到不影响主链
            }
        }

        private fun onExit(reason: String) {
            if (!alive) return
            alive = false
            deathError = reason
            for ((_, f) in pending) f.completeExceptionally(IllegalStateException(reason))
            pending.clear()
        }

        fun destroyQuietly() {
            onExit("adb serve 进程被替换")
            try { stdin.close() } catch (e: Throwable) { /* ignore */ }
            try { process.destroy() } catch (e: Throwable) { /* ignore */ }
        }

        private fun appendLog(message: String) {
            synchronized(logs) {
                logs.append(message).append('\n')
                if (logs.length > MAX_LOG_CHARS) logs.delete(0, logs.length - MAX_LOG_CHARS)
            }
        }
    }

    private const val RESULT_PREFIX = "LOBOS_ADB_RESULT "
    private const val DEFAULT_TIMEOUT_MS = 15_000L
    private const val CHANNEL_TIMEOUT_MS = 2_000L
    // 进程级超时 = 工作超时 + spawn 余量（Node 冷启动 ~100ms 级，留 10s 富余防抖）
    private const val SPAWN_SLACK_MS = 10_000L
    // 重启退避：起点 500ms，逐次翻倍，上限 30s（"退避 + 上限"）。
    private const val RESTART_BASE_MS = 500L
    private const val RESTART_MAX_MS = 30_000L
    private const val MAX_OUTPUT = 64 * 1024
    private const val MAX_LOG_CHARS = 8 * 1024
}
