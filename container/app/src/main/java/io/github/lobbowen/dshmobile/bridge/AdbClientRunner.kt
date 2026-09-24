package io.github.lobbowen.dshmobile.bridge

import android.content.Context
import io.github.lobbowen.dshmobile.native.NativeAssetRegistry
import io.github.lobbowen.dshmobile.native.NativePreparer
import io.github.lobbowen.dshmobile.runtime.NodeProvisioner
import java.io.File
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * 以一次性 Node 进程调用内置 ADB 客户端（`assets/node/adb-client/`）。
 *
 * 形态与 [NodeKernelVerifier] 同构（spawn → 干活 → `DSH_ADB_RESULT {json}` 结果行
 * → 退出），原因也一样：minSdk 24 的 Kotlin 没有 TLS exporter / SPAKE2 所需的
 * 密码学原语，而 Node 里有。协议细节见 cli.js 头注释与 ADR-0003（勘误 2026-09-24）。
 *
 * 凭据目录固定在 `files/adb/`（0700，密钥 0600），由 DSH_ADB_DIR 注入子进程 ——
 * 不再放内核目录：OTA 下来的 L1 不应能读写权限通道的身份密钥。
 * 首次运行通过 `--migrate-from` 认领旧内核路径（`files/supervisor/adb/`）的密钥，
 * 保住已在设备上授权过的 ADB 身份，避免升级后要求用户重新配对。
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
        run(context, listOf("status"), DEFAULT_TIMEOUT_MS)

    fun forget(context: Context): AdbOutcome =
        run(context, listOf("forget"), DEFAULT_TIMEOUT_MS)

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
        return run(context, args, timeoutMs + SPAWN_SLACK_MS)
    }

    fun shell(
        context: Context,
        cmd: String,
        host: String?,
        connectPort: Int?,
        timeoutMs: Long,
    ): AdbOutcome {
        val args = mutableListOf("shell", "--cmd", cmd, "--timeout-ms", timeoutMs.toString())
        if (host != null) args += listOf("--host", host)
        if (connectPort != null) args += listOf("--connect-port", connectPort.toString())
        return run(context, args, timeoutMs + SPAWN_SLACK_MS)
    }

    private fun run(context: Context, subArgs: List<String>, procTimeoutMs: Long): AdbOutcome {
        val scriptDir = try {
            NodeProvisioner.ensureAdbClientScripts(context)
        } catch (e: Throwable) {
            return AdbOutcome(false, null, "adb-client-script-missing: ${e.message}", "", -1)
        }
        val nodeBin = NativeAssetRegistry.resolve(context, NativeAssetRegistry.NODE)
        val adbDir = File(context.filesDir, "adb")
        if (!adbDir.exists()) adbDir.mkdirs()

        // 参数全部走 argv，不经 shell —— cmd 里的空格/引号/分号不会变成注入。
        val args = mutableListOf(nodeBin.absolutePath, File(scriptDir, "cli.js").absolutePath)
        args += subArgs
        args += listOf("--migrate-from", File(context.filesDir, "supervisor/adb").absolutePath)

        return try {
            val pb = ProcessBuilder(args)
                .directory(context.filesDir)
                .redirectErrorStream(true)
            pb.environment().apply {
                put("HOME", context.filesDir.absolutePath)
                put("TMPDIR", context.cacheDir.absolutePath)
                put("DSH_ADB_DIR", adbDir.absolutePath)
                // linker 只查 LD_LIBRARY_PATH，与启动链/校验器同款（NativePreparer.probe）
                put("LD_LIBRARY_PATH", NativePreparer.libSearchPath(context))
            }
            val proc = pb.start()
            val out = StringBuilder()
            // 读线程与 waitFor 并行：单线程先 waitFor 会在管道写满时死锁。
            val pump = Thread {
                proc.inputStream.bufferedReader().forEachLine { line ->
                    if (out.length < MAX_OUTPUT) out.append(line).append('\n')
                }
            }
            pump.start()
            val finished = proc.waitFor(procTimeoutMs, TimeUnit.MILLISECONDS)
            if (!finished) {
                proc.destroyForcibly()
                return AdbOutcome(false, null, "adb-timeout ${procTimeoutMs}ms", out.toString(), -1)
            }
            pump.join(1000)
            val raw = out.toString()
            val exit = proc.exitValue()

            val line = raw.lineSequence().lastOrNull { it.startsWith(RESULT_PREFIX) }
                ?: return AdbOutcome(false, null,
                    "adb 进程未输出结果行（exit=$exit）", raw, exit)
            val json = try {
                JSONObject(line.substring(RESULT_PREFIX.length).trim())
            } catch (e: Throwable) {
                return AdbOutcome(false, null, "结果行不是合法 JSON: ${line.take(200)}", raw, exit)
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
                "adb-spawn-failed ${e::class.java.simpleName}: ${e.message ?: ""}", "", -1)
        }
    }

    private const val RESULT_PREFIX = "DSH_ADB_RESULT "
    private const val DEFAULT_TIMEOUT_MS = 15_000L
    // 进程级超时 = 工作超时 + spawn 余量（Node 冷启动 ~100ms 级，留 10s 富余防抖）
    private const val SPAWN_SLACK_MS = 10_000L
    private const val MAX_OUTPUT = 64 * 1024
}
