package io.github.lobbowen.dshmobile

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import io.github.lobbowen.dshmobile.native.AssetStatus
import io.github.lobbowen.dshmobile.native.NativeAssetRegistry
import io.github.lobbowen.dshmobile.native.PrefixProvisioner
import io.github.lobbowen.dshmobile.native.NativePreparer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * 内核运行时前台服务（独立进程 :node）。容器（L0）把“可热更新的内核（L1）”真正拉起来的最后一环。
 *
 * 职责：把内置 Node 拉起来跑内核（内核控制面默认 127.0.0.1:36360），
 * 并把启动过程的每一步写进诊断文件，供 UI 进程逐行展示。
 *
 * "每一步都可观测"是本服务的硬性设计目标：真机环境千差万别（SELinux 策略、
 * ROM 定制、页大小），一旦启动失败，必须能从屏幕上直接看出失败在哪一环、
 * node 自己报了什么，而不是只能翻 logcat 猜。
 *
 * Node 是直接 exec 的应用私有二进制（bionic 链接）——这是真正的"原生安卓
 * 环境"，与 Termux 无关、不需要 root。可执行性的全部约束（W^X / linker / 架构 /
 * libc 四道关）与验证手段收敛在 `native/` 包，见 [NativePreparer]。
 *
 * 流程（对齐 container-engine/src/boot.js 与 docs/BASE_SPEC.md §9）：
 * 0. 预置体检（ProvisioningProbe，PROVISIONING.md §4）—— 控制面能力可见。
 * 1. 启动 HostBridge（UDS 能力桥，独立服务）。
 * 2. 原生资产统一准备：存在性 → 依赖前置 → exec-probe（`NativePreparer.prepare`）。
 * 全过程**任一必需项失败即中止**，且给出精确到修复动作的归因。
 * 3. server.js 探针就位。
 * 4. 写 runtime.json（schema 2，容器写内核读）。
 * 5. spawn 内核进程（注入 DSH_ANDROID 环境）。
 * 6. 轮询控制面端口；失败/进程退出 → 退避重启（START_STICKY 保活）。
 *
 * 关键点：一次包升级 = 重启 :node 进程（用户侧“热”的，无 APK 重编）。
 */
class NodeRuntimeService : Service() {

    private var nodeProcess: Process? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val scope = CoroutineScope(Dispatchers.IO)
    private var loopJob: Job? = null
    private var portUp = false
    private var healthUp = false
    private var keepRunning = true
    private var restartCount = 0

    /**
     * 让 linker 找到随包 `.so` 的搜索路径。
     *
     * 唯一正确取值 = `nativeLibraryDir`，由 [NativePreparer.libSearchPath] 从
     * [NativeAssetRegistry] 派生 —— 不要再各写一份。完整论证（为什么这个变量必需、
     * 为什么不能省、为什么不用 `$ORIGIN` rpath）见 `NativePreparer.probe()` 的注释。
     */
    private val libSearchPath: String get() = NativePreparer.libSearchPath(this)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIF_ID, buildNotification())
        // partial wakelock：前台服务只保证「进程不被优先级回收」，Doze 仍会冻结
        // 网络与 alarm；息屏常驻必须显式持锁（ROM 白名单引导在 MainActivity）。
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dsh:runtime").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 幂等闸门：重复 startService（重试按钮 / Activity 重建 / START_STICKY 重投递 /
        // BootReceiver 撞车）**不得**再叠一个 supervisorLoop。真机 2026-09-22 实锤：
        // 双循环共享 nodeProcess/healthUp，把活内核误判成死 → 反复 spawn 必死进程
        // （guard.lock 被占 → 内核 exit(1)）→ 1s 紧循环重启 → 闪屏。
        if (loopJob?.isActive == true) return START_STICKY
        RuntimeDiagnostics.clear(this)
        keepRunning = true
        // 先把预置体检结果写进诊断（PROVISIONING §4），再拉起 HostBridge 与内核 ——
        // 这样即使内核起不来，屏幕上也能看到「设备到底具备哪些控制面能力」。
        try {
            ProvisioningProbe.run(this)
        } catch (e: Throwable) {
            RuntimeDiagnostics.append(this, "probe", false, "预置体检异常", "${e::class.java.simpleName}: ${e.message}")
        }
        // 写路径实证（真机报告「全盘不可写 EACCES」的定位探针）：syscall 层能否写
        // files/cache/external/tmp 与 dsh 会话目录同进程同 uid —— 若这里全 OK，
        // 则写失败发生在 dsh 策略层而非文件系统层；若这里就 EACCES，责任在容器/ROM。
        probeFilesystemWrites()
        // PTY/shell 取证（终端真假的判定实验，见 native/ptyprobe/PROVENANCE.md）：
        // 结果上屏，决定 node-pty 移植走真 PTY 还是管道假 PTY。
        runPtyProbe()
        // 先拉起 HostBridge（UDS 能力桥），再启动内核
        startHostBridge()
        loopJob = scope.launch { supervisorLoop() }
        return START_STICKY
    }

    private fun startHostBridge() {
        val svc = Intent(this, HostBridgeService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svc) else startService(svc)
    }

    /** 执行随包 PTY 探针（静态 C，无 libc++ 依赖，直接 exec），stdout 逐行上屏。
     * 缺件（旧 APK/dev）静默跳过——该二进制刻意不登记进 native-assets.txt（同小体积绑定先例）。 */
    private fun runPtyProbe() {
        val bin = File(NativePreparer.libSearchPath(this).substringBefore(File.pathSeparatorChar), "libdshptyprobe.so")
        if (!bin.isFile) {
            RuntimeDiagnostics.append(this, "ptyprobe", null, "PTY 探针未随包（跳过）", bin.absolutePath)
            return
        }
        val r = try {
            val p = ProcessBuilder(bin.absolutePath).redirectErrorStream(true).start()
            val out = p.inputStream.bufferedReader().readText()
            if (!p.waitFor(10, java.util.concurrent.TimeUnit.SECONDS)) { p.destroy(); "timeout" } else out.trim()
        } catch (e: Throwable) {
            "${e::class.java.simpleName}: ${e.message}"
        }
        RuntimeDiagnostics.append(this, "ptyprobe", null, "PTY 探针结果", r.toString())
    }

    private fun probeFilesystemWrites() {
        val targets = linkedMapOf(
            "files" to File(filesDir, ".dsh-write-probe"),
            "cache" to File(cacheDir, ".dsh-write-probe"),
            "external" to (getExternalFilesDir(null)?.let { File(it, ".dsh-write-probe") } ?: File("<null>")),
            "/tmp" to File("/tmp/.dsh-write-probe"),
            "dsh-home" to File(File(filesDir, ".dsh"), ".write-probe")
        )
        for ((label, f) in targets) {
            if (!f.absolutePath.startsWith("/")) {
                RuntimeDiagnostics.append(this, "probe", false, "写探针 $label", "路径不可用")
                continue
            }
            val r = try {
                f.parentFile?.mkdirs()
                f.writeText("probe")
                val okRead = f.readText() == "probe"
                f.delete()
                if (okRead) null else "写成功但读回不符"
            } catch (e: Throwable) {
                "${e::class.java.simpleName}: ${e.message}"
            }
            if (r == null) {
                RuntimeDiagnostics.append(this, "probe", true, "写探针 $label", "写读删 OK ${f.absolutePath}")
            } else {
                RuntimeDiagnostics.append(this, "probe", false, "写探针 $label 失败", "$r ${f.absolutePath}")
            }
        }
    }

    /** 监督循环：持续拉起内核，进程退出/健康失败则退避重启，避免无限紧循环。 */
    private suspend fun supervisorLoop() {
        while (keepRunning) {
            val backoff = minOf(BACKOFF_BASE_MS shl restartCount.coerceAtMost(5), BACKOFF_MAX_MS)
            val ok = bootKernelOnce()
            var bornAt = 0L
            if (ok) {
                // 内核在跑；等待其退出或被外部停止
                bornAt = SystemClock.elapsedRealtime()
                while (keepRunning && nodeProcess?.isAlive == true && (healthUp || portUp)) {
                    delay(1000)
                }
            }
            // 退避清零以**存活时长**为准，不以「health 探到 200」为准：残留守卫占着
            // 36360 时新进程秒死，但探测照样秒回 200（假成功）——若据此清零，
            // 退避永远停在 1s，形成紧循环风暴（真机 2026-09-22 实锤）。
            if (ok && SystemClock.elapsedRealtime() - bornAt >= STABLE_MS) {
                restartCount = 0
            } else {
                restartCount += 1
            }
            if (!keepRunning) break
            RuntimeDiagnostics.append(this, "supervisor", null, "退避 ${backoff}ms 后重启", "attempt=$restartCount")
            delay(backoff)
        }
    }

    /**
     * 单次拉起内核；成功返回 true（进程已起 + 控制面就绪），失败返回 false。
     *
     * 可执行性验证由 [NativePreparer.prepare] 完成 —— 它**真跑一次**进程。
     * `canExecute()` 只查 stat 权限位，对 SELinux W^X 无感（假阳性），
     * 这是上游真机排查得出的结论，务必保留。
     */
    private fun bootKernelOnce(): Boolean {
        try {
            RuntimeDiagnostics.append(
                this, "init", null, "NodeRuntimeService 启动内核 (进程 :node)",
                "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}), filesDir=${filesDir.absolutePath}"
            )

            // ---- 0) 内核版本指针 ----
            //
            // 顺序是刻意设计的，每一步解决不同的失败模式：
            // 0a) 已有内核 → 直接用（最常见路径，零额外开销）
            // 0b) 无内核 → 尝试本地 feed（A'' 自举：用户把新包放到 /sdcard）
            // 0c) 仍无内核 → 落到 APK 内置基线（无网首启的兜底）
            // 0d) 都没有 → 回落探针模式，并把「缺基线」记为构建缺陷
            //
            // 为什么本地 feed 优先于内置基线：本地 feed 意味着"有人明确要装这个版本"，
            // 意图比"用出厂版本"更强；而基线只是"什么都没有时的兜底"。反过来的话，
            // 用户放的新包会被出厂版本一直压着，表现为"放了包没反应"。
            val km = KernelManager(this)

            // 0b) 本地 feed：设备上（/sdcard 等）若有 kernel-<ver>.zip + manifest，就地升级。
            // 这是 A'' 自举的落点 —— 全程离线、不依赖网络与 PC。
            // 不再限定 CURRENT 缺失：feed 的语义就是「有人明确要装这个版本」（见类注释
            // 「放了包没反应」），旧门禁把它退化成只有首启兜底才生效。
            val feed = LocalKernelFeed.scan(this)
            if (feed != null) {
                RuntimeDiagnostics.append(
                    this, "kernel-feed", true, "发现本地内核 feed",
                    "zip=${feed.zip.absolutePath}（${feed.zip.length()} 字节）, manifest=${feed.manifest?.absolutePath ?: "(无)"}"
                )
                val feedResult = KernelInstaller.install(
                    context = this,
                    zip = feed.zip,
                    manifest = feed.manifestJson,
                    source = KernelInstaller.Source.LOCAL_FILE,
                )
                // 类契约：装成功即消费（删除 feed 包），避免每次开机重复安装同一包；
                // 失败保留，下次开机照常重试。
                if (feedResult.ok) LocalKernelFeed.consume(feed)
                RuntimeDiagnostics.append(
                    this, "kernel-feed",
                    feedResult.ok,
                    if (feedResult.ok) "本地 feed 内核已安装" else "本地 feed 内核未生效",
                    "${feedResult.toDiagnosticLine()}\n校验器输出:\n${feedResult.nodeVerifyOutput.take(1200)}"
                )
            }

            // 0b.5) 远端内核 OTA：查一次 feed，有更新就自动升级。
            //
            // 为什么必须在 spawn **之前**：升级完成后 CURRENT 已指向新内核，
            // 本次启动就直接跑新版，**不需要额外重启**。
            // 失败只落诊断 —— 离线/服务端故障时开机流程必须照常走完。
            // 默认**手动**触发（由内核经桥方法 build.kernelUpdate 调起）；
            // 只有 kernel-feed.json 里 autoCheck=true 时才在启动链主动检查 ——
            // 稳定态不该有意外动作。
            val otaCfg = KernelOtaUpdater.loadConfig(this)
            if (otaCfg != null && otaCfg.autoCheck) {
                try {
                    val ota = KernelOtaUpdater.checkAndUpdate(this, km)
                    if (ota.checked) {
                        RuntimeDiagnostics.append(
                            this, "kernel-ota", ota.updated,
                            if (ota.updated) "启动自动升级内核到 ${ota.remote}" else "启动内核检查完成（无更新）",
                            ota.detail
                        )
                    }
                } catch (e: Throwable) {
                    RuntimeDiagnostics.append(
                        this, "kernel-ota", false, "启动内核检查异常",
                        "${e::class.java.simpleName}: ${e.message}"
                    )
                }
            }

            // 0c) 内置基线兜底（含完整验签，见 KernelManager.ensureBaseline 注释）
            val baseline = km.ensureBaseline()
            if (baseline.isDefect) {
                RuntimeDiagnostics.append(
                    this, "kernel-baseline", false, "无可用内置基线内核",
                    baseline.toString()
                )
            }
            val kVersion = baseline.versionOrNull
            val kernelDir = if (!kVersion.isNullOrBlank()) km.kernelDir(kVersion) else null
            val entry = if (!kVersion.isNullOrBlank()) km.entryPath(kVersion) else null
            val hasKernel = entry != null && entry.exists()
            // 不变式守护：内核入口是【脚本】，必须交给 node 解释执行。
            // 它落在 filesDir（app_data_file），W^X 禁止 execve —— 直接 ProcessBuilder
            // 它在真机上必然 error=13。这个断言把「注释与实现矛盾」的雷变成可执行检查。
            if (hasKernel && kVersion != null) {
                try {
                    km.assertNotDirectlyExecutable(kVersion)
                } catch (e: IllegalStateException) {
                    RuntimeDiagnostics.append(this, "kernel", false, "内核入口布局异常", err(e))
                    return false
                }
            }
            // 结构自检：CURRENT 与目录/入口/manifest 是否自洽。发现问题**不阻断**
            // （可能只是 OTA 落地了一半，重试可恢复），但必须留下可查的痕迹。
            val integrity = km.integrityChecks()
            if (integrity.isNotEmpty()) {
                RuntimeDiagnostics.append(
                    this, "kernel-integrity", false, "内核布局不自洽", integrity.joinToString("; ")
                )
            }
            RuntimeDiagnostics.append(
                this, "kernel", hasKernel,
                if (hasKernel) "内核版本=$kVersion" else "尚无内核包（无本地 feed、且无内置基线，先跑内置探针）",
                if (hasKernel) "入口=${entry!!.absolutePath}"
                else "files/kernel/CURRENT 缺失，且 assets/kernel/baseline.zip 不可用；本次将回落到 assets/node/server.js 探针模式"
            )

            // ---- 1) 原生资产统一准备（存在性 → 依赖前置 → exec-probe） ----
            //
            // 这一步取代了历史上的三处分散逻辑：
            // · NodeProvisioner.ensureBundledNode （只知道 libnode.so 存在与否）
            // · diagnoseNativeLibs() （只打日志，从不阻断 → 缺陷 1）
            // · runExecProbe(nodeBin) （归因只按 errno 罗列可能 → 缺陷 2）
            //
            // 三者叠加出的真实故障：libc++_shared.so 缺失 → exec-probe 以 linker 错误失败
            // → errno=13 → 归因到「SELinux 禁止 exec」→ 真因（依赖缺失）永远浮不出来。
            // 现在依赖检查前置且独立归因，见 native/NativePreparer.kt 顶部说明。
            val version = NodeVersionManager(this).currentVersion()
            RuntimeDiagnostics.append(
                this, "version", true, "内置 Node 版本=$version",
                "（以清单为准；实际二进制版本见下方 exec-probe 的输出）"
            )

            val assets = NativePreparer.prepare(this)
            if (!assets.allRequiredReady) {
                val what = assets.failedRequired.joinToString("; ") { (e, st) ->
                    "${e.libName}（${describeStatus(st)}）"
                }
                RuntimeDiagnostics.append(
                    this, "provision", false, "原生资产校验未通过，中止启动", what
                )
                return false
            }
            val nodeAsset = NativeAssetRegistry.NODE
            val nodeBin = NativeAssetRegistry.resolve(this, nodeAsset)

            // ---- 2) server.js 探针就位 ----
            val script = NodeProvisioner.ensureServerScript(this)
            RuntimeDiagnostics.append(this, "script", true, "server.js 探针就位", script.absolutePath)

            // ---- 2b) npm 基础环境就位（纯 JS，由 libnode.so 代跑；失败不阻断启动）----
            val npmCli = NodeProvisioner.ensureNpm(this)
            RuntimeDiagnostics.append(
                this, "npm", npmCli != null,
                if (npmCli != null) "npm 就位（面板可安装 Agent）" else "npm 未就位 —— 仅影响 Agent 安装，内核照常运行",
                npmCli?.absolutePath ?: "assets/npm 解包失败，详见 logcat"
            )

            // ---- 5) 写 runtime.json（schema 2，容器写内核读） ----
            writeRuntimeJson(
                home = filesDir.absolutePath,
                nodePath = nodeBin.absolutePath,
                nodeBinDir = nodeBin.parentFile!!.absolutePath,
                npmPath = nodeBin.absolutePath,
                npmEntry = npmCli?.absolutePath,
                minNode = "v24.12.0"
            )
            RuntimeDiagnostics.append(this, "runtime", true, "runtime.json 已写入（schema 2）", "home=${filesDir.absolutePath}")

            // ---- 6) 启动内核 ----
            // 有内核包：跑内核入口（控制面 36360）；无内核包：回落内置探针 server.js（便于首启验证 Node 原生链路）。
            //
            // spawn 前必须回收残留守卫：内核单实例锁（supervisor/guard.lock）持锁者
            // 存活时，新进程 acquireLock 失败即 exit(1) —— 不回收就是必死重启循环。
            reapOrphanKernel()

            //
            // 注意第一个参数是 nodeBin（nativeLibraryDir 下的 libnode.so，唯一可 exec 的东西），
            // entry 是**脚本参数**、不是被 exec 的目标 —— 它落在 filesDir（app_data_file），
            // W^X 禁止 execve。把两者顺序写反必在真机上 error=13。
            // 不变式由 km.assertNotDirectlyExecutable() 守护。
            val pb = if (hasKernel && kernelDir != null && entry != null) {
                val uiDir = File(kernelDir, "manager/dist").absolutePath
                ProcessBuilder(nodeBin.absolutePath, entry.absolutePath, "daemon")
                    .directory(kernelDir)
                    .apply {
                        environment().apply {
                            put("DSH_ANDROID", "1")
                            put("DSH_PLATFORM", "android")
                            put("DSH_SUPERVISOR_HOME", filesDir.absolutePath)
                            put("DSH_UI_DIR", uiDir)
                            put("HOME", filesDir.absolutePath)
                            put("TMPDIR", cacheDir.absolutePath)
                            put("NODE_PATH", File(kernelDir, "node_modules").absolutePath)
                            put("PATH", nodeBin.parentFile!!.absolutePath + File.pathSeparator + (getenv("PATH") ?: ""))
                            put("LD_LIBRARY_PATH", libSearchPath)
                            // flock(2) 原生绑定（fast-apk CI 用 NDK 现编进 jniLibs，见
                            // native/flock/PROVENANCE.md）。nodeBin 就在 nativeLibraryDir，
                            // 同目录即唯一事实源；守卫据此在 dsh 安装树投放 flock 垫片。
                            // 文件缺席时垫片 dlopen 失败 ⇒ 逐字回退 vendor 原始语义，
                            // 故此路径只是声明，不要求此刻存在。
                            put("DSH_FLOCK_NATIVE", File(nodeBin.parentFile, "libdshflock.so").absolutePath)
                            // link(2) 用户态替代：经 LD_PRELOAD 注入 DSH 进程，见 native/posix/。
                            put("LD_PRELOAD", File(nodeBin.parentFile, "libdshposix.so").absolutePath)
                            // ── 权限模式旋钮（配套 cordis.patch.yml）──
                            // 权限模式：Android untrusted_app 无任何用户态沙箱原语
                            //（bwrap/landlock/seatbelt 全被 SELinux 域拒），dsh 默认
                            // workspace-write 会让 bash/PTC 每条命令 fail-closed。
                            // danger-full-access = 放弃 dsh 层二次隔离、以外层 SELinux
                            // 为 confinement（产品拍板 2026-09-23）。
                            put("DSH_PERMISSION_MODE", "danger-full-access")
                            // $PREFIX：把 nativeLibraryDir 的 lib*.so 以真名复制为可执行文件，
                            // 供 DSH 按名字解析（bash/rg），不再改 DSH 内部路径。见 docs/ADR-001。
                            val prefixRoot = PrefixProvisioner.root(this@NodeRuntimeService)
                            val prefixBin = PrefixProvisioner.binDir(this@NodeRuntimeService)
                            PrefixProvisioner.provision(this@NodeRuntimeService)
                            put("PREFIX", prefixRoot.absolutePath)
                            put("PATH", prefixBin.absolutePath + File.pathSeparator + (getenv("PATH") ?: ""))
                            put("SHELL", PrefixProvisioner.bashBin(this@NodeRuntimeService)?.absolutePath ?: "/system/bin/sh")
                        }
                    }
            } else {
                ProcessBuilder(nodeBin.absolutePath, script.absolutePath, "--port", PORT.toString())
                    .directory(filesDir)
            }
            pb.environment().apply {
                // Node 在安卓沙箱里需要 HOME / TMPDIR，否则部分模块报错
                put("HOME", filesDir.absolutePath)
                put("TMPDIR", cacheDir.absolutePath)
                put("NODE_PATH", File(filesDir, "node_modules").absolutePath)
                // 必需项，理由见 NativePreparer.probe() 的注释。漏了 node 会在动态链接期直接失败。
                put("LD_LIBRARY_PATH", libSearchPath)
            }
            nodeProcess = pb.start()
            portUp = false
            healthUp = false
            RuntimeDiagnostics.append(
                this, "exec", true, "内核进程已启动",
                "pid=${currentPid(nodeProcess)}, 控制面 127.0.0.1:$KERNEL_CONTROL_PORT（探针端口 $PORT）"
            )

            forward(nodeProcess!!.inputStream, "stdout")
            forward(nodeProcess!!.errorStream, "stderr")
            watchExit()
            pollControlPlane()
            return healthUp || portUp
        } catch (e: Throwable) {
            RuntimeDiagnostics.append(this, "fatal", false, "启动流程异常", err(e))
            Log.e(TAG, "启动 Node/内核失败", e)
            return false
        }
    }

    /**
     * 把资产失败状态压成一句可读结论（供启动中止时的诊断行）。
     *
     * 每种状态对应**互不相同**的修复动作 —— 这正是把归因结构化的意义：
     * 不再是「可能原因有 1/2/3」，而是「就是这一条」。
     */
    private fun describeStatus(st: AssetStatus): String = when (st) {
        is AssetStatus.Ready -> "就位"
        is AssetStatus.MissingFromLib ->
            if (st.inApk) "APK 内有但未解压到 nativeLibraryDir（查 extractNativeLibs / useLegacyPackaging）"
            else "APK 内就没有（打包期丢失：查构建脚本产物与 keepDebugSymbols）"
        is AssetStatus.MissingDependency ->
            "缺少依赖 ${st.dep}（linker 不查 nativeLibraryDir，须随包放同目录）"
        is AssetStatus.NotExecutable ->
            "无法 exec（依赖已确认完好 → SELinux W^X 拒 exec，查该文件是否真在 nativeLibraryDir）"
        is AssetStatus.ProbeFailed ->
            "探针失败 exit=${st.exit}，输出=${st.output.ifBlank { "(空)" }}"
    }

    /**
     * 取子进程的 PID，仅用于诊断展示（拿不到返回 "n/a"，绝不影响主流程）。
     *
     * 为什么不用 Process.pid()：**Android 上根本没这个方法**。它是 Java 9
     * 加入 java.lang.Process 的，Android 的 java.lang.Process 一直没跟进
     * （android-29/30/35 的 android.jar 均无此方法），写了会在编译期报
     * "Unresolved reference 'pid'"。注意 SDK_INT 这种【运行时】判断救不了
     * 【编译期】的方法缺失。
     *
     * 也不能用 android.os.Process.myPid()：那是本应用自己的 pid，
     * 不是 node 子进程的 pid，含义完全不同，用了会误导诊断。
     *
     * 可行做法：Android 的 Process 实现把 pid 编进了 toString()，形如
     * "Process[pid=12345, exitValue=\"not exited\"]"
     * 这里用正则提取，解析失败一律降级为 "n/a"。
     */
    private fun currentPid(p: Process?): String {
        if (p == null) return "n/a"
        return runCatching {
            Regex("""pid=(\d+)""").find(p.toString())?.groupValues?.get(1)
        }.getOrNull() ?: "n/a"
    }

    /**
     * spawn 前回收上一轮的残留内核进程。
     *
     * 内核（bin/dsh-supervisor daemon）用 guard.lock 做单实例锁：持锁进程存活时
     * 新进程直接 exit(1)。容器是唯一合法拉起者，一旦上一轮守卫因服务重启竞态、
     * START_STICKY 重投递等成为**无人跟踪的孤儿**，此后每次 spawn 都必死 ——
     * 而它占着 36360，健康探测秒回 200，把失败循环伪装成"启动成功"（真机 2026-09-22 实锤）。
     *
     * 守卫与容器同 uid，killProcess 有权限；lock 内容就是持锁 pid（内核侧写入）。
     * 路径与内核 state-root.js 对齐：DSH_SUPERVISOR_HOME(=filesDir)/supervisor/guard.lock。
     */
    private fun reapOrphanKernel() {
        try { nodeProcess?.takeIf { it.isAlive }?.destroy() } catch (_: Throwable) {}
        // 本轮 stderr 从零计（recordNodeStderr 是累积追加，不清空会把上一轮的死因顶给本轮）。
        RuntimeDiagnostics.clearNodeStderr(this)
        try {
            val lock = File(File(filesDir, "supervisor"), "guard.lock")
            if (!lock.exists()) return
            val pid = lock.readText().trim().toIntOrNull()
            if (pid != null && pid > 0 && File("/proc/$pid").exists()) {
                // PID 可能已被系统复用：cmdline 不含 libnode 就不是本应用的守卫，只清锁不杀进程。
                val cmdline = try { File("/proc/$pid/cmdline").readText() } catch (_: Throwable) { "" }
                if (cmdline.contains("libnode")) {
                    RuntimeDiagnostics.append(this, "reap", null, "回收残留内核进程", "pid=$pid（guard.lock 持锁者）")
                    android.os.Process.killProcess(pid)
                    Thread.sleep(200)
                }
            }
            lock.delete()
        } catch (_: Throwable) {}
    }

    /** 转发子进程 stdout/stderr：都进 logcat；stderr 落盘**并限量上屏**。 */
    private fun forward(stream: InputStream, tag: String) {
        Thread {
            var shown = 0
            var childShown = 0
            stream.bufferedReader().use { r ->
                r.forEachLine { line ->
                    Log.i("Kernel:$tag", line)
                    if (tag == "stderr") {
                        RuntimeDiagnostics.recordNodeStderr(this, line + "\n")
                        // stderr 必须上屏：dsh/守卫的启动崩溃**只往 stderr 抛栈**，此前只有
                        // stdout 上屏 → 屏幕上一片安静、面板却打不开，无从排查（真机 2026-09-22）。
                        // 限量防 npm 海噪刷爆诊断页；全文仍在 node-stderr.log。
                        // 守卫镜像的子进程崩溃行（"[stderr] " 前缀）单独计数：真机秒退的
                        // 死因恰恰排在守卫自身日志之后，与 INFO 共用限量会被挡在屏幕外。
                        val isChildLine = line.startsWith("[stderr] ")
                        if (isChildLine) {
                            if (childShown < CHILD_STDERR_SCREEN_LINES) {
                                RuntimeDiagnostics.append(this, "kernel-stderr", null, line)
                                childShown++
                                if (childShown == CHILD_STDERR_SCREEN_LINES) {
                                    RuntimeDiagnostics.append(this, "kernel-stderr", null, "……(子进程 stderr 上屏截断，完整见 node-stderr.log)")
                                }
                            }
                        } else if (shown < STDERR_SCREEN_LINES) {
                            RuntimeDiagnostics.append(this, "kernel-stderr", null, line)
                            shown++
                            if (shown == STDERR_SCREEN_LINES) {
                                RuntimeDiagnostics.append(this, "kernel-stderr", null, "……(stderr 上屏截断，完整见 node-stderr.log)")
                            }
                        }
                    } else {
                        RuntimeDiagnostics.append(this, "kernel-$tag", null, line)
                    }
                }
            }
        }.start()
    }

    /**
     * 等待 node/内核进程结束；若控制面始终没起来，说明启动失败，把 stderr 完整回写诊断。
     *
     * ----------------------------------------------------------------------
     * 读 stderr 前为什么必须轮询等待
     * ----------------------------------------------------------------------
     * forward() 在【另一个线程】里逐行读并写文件，而本方法在 waitFor() 返回后
     * 立刻去读同一个文件 —— 两者之间没有任何同步。当 node 死得很快时（例如
     * 参数错误导致 listen() 抛 RangeError 后瞬间退出），读取线程很可能还没被
     * 调度到，文件自然是空的，诊断就会显示"node 无 stderr 输出"，而实际上
     * node 明明打印了错误。这曾把排查引向"是不是二进制有问题"的错误方向。
     *
     * 所以这里轮询等文件出现内容（最多 1.5 秒）。正常情况下第一轮就命中。
     * 用 while 而非 repeat{}：repeat 是内联 lambda，return@repeat 只相当于
     * continue，跳不出整个循环。
     * ----------------------------------------------------------------------
     */
    private fun watchExit() {
        val p = nodeProcess ?: return
        Thread {
            val code = runCatching { p.waitFor() }.getOrDefault(-1)
            // 主动停机不算故障；但**任何非主动退出都必须记录** —— 旧实现在
            // portUp/healthUp=true 时直接 return，「起来过又秒死」这一失败形态
            // 的 exitCode/stderr 永远进不了诊断（真机 2026-09-22 排查实锤的盲区）。
            if (!keepRunning) return@Thread
            val readyNote = if (healthUp || portUp) "（曾就绪后退出 —— 排查方向：启动后崩溃/单实例锁冲突，而非拉不起）" else ""
            RuntimeDiagnostics.append(this, "process", false, "内核/node 进程已退出", "exitCode=$code$readyNote")

            var err = RuntimeDiagnostics.readNodeStderr(this)
            var waited = 0
            while (err.isBlank() && waited < 1500) {
                Thread.sleep(100)
                waited += 100
                err = RuntimeDiagnostics.readNodeStderr(this)
            }

            RuntimeDiagnostics.append(
                this, "node-stderr", err.isNotBlank(), "node 标准错误(完整)",
                if (err.isNotBlank()) err
                else "(node 确实没有 stderr 输出；已等待 ${waited}ms 让转发线程收敛。\n" +
                    " stdout 已逐行写入 logcat，可用 adb logcat -s NodeRuntime:*)"
            )
        }.start()
    }

    /**
     * 轮询控制面是否就绪（最多 30s）。
     *
     * 双判定：内核真跑起来时看 /status（36360）；无内核包、仅跑内置探针 server.js 时
     * 看探针端口（3080）。任一就绪即认定启动成功。
     */
    private fun pollControlPlane() {
        repeat(100) {
            if (isStatusUp()) {
                healthUp = true
                RuntimeDiagnostics.append(
                    this, "health", true,
                    "内核控制面就绪 (127.0.0.1:$KERNEL_CONTROL_PORT/status)",
                    "内核原生运行成功 ✓"
                )
                return
            }
            if (isPortUp()) {
                portUp = true
                RuntimeDiagnostics.append(
                    this, "port", true, "127.0.0.1:$PORT 已就绪（探针模式）",
                    "Node 原生运行成功 ✓（尚未下发内核包，当前为内置 server.js 探针）"
                )
                return
            }
            Thread.sleep(300)
        }
        RuntimeDiagnostics.append(
            this, "health", false, "控制面在 30s 内未就绪",
            "可能原因：node/内核崩溃 / 端口被占用 / 二进制不兼容当前 ROM（如非 16KB 页对齐）。\n" +
                "查看上方 [FAIL] process 与 node-stderr。"
        )
    }

    private fun isStatusUp(): Boolean = try {
        val c = URL("http://127.0.0.1:$KERNEL_CONTROL_PORT/status").openConnection() as HttpURLConnection
        c.connectTimeout = 300
        // 读超时 1.5s：dsh 启动/安装期设备 CPU 饱和，守卫事件循环排不出 300ms；
        // 太紧会把「活着但忙」误判成「死了」（真机 2026-09-22 面板打不开的直接观感）。
        c.readTimeout = 1500
        c.requestMethod = "GET"
        c.responseCode == 200
    } catch (_: Throwable) {
        false
    }

    /** 内置探针 server.js 的端口（首启验证 Node 原生链路用；内核就绪后走 36360）。 */
    private fun isPortUp(): Boolean = try {
        val c = URL("http://127.0.0.1:$PORT/").openConnection() as HttpURLConnection
        c.connectTimeout = 300
        c.readTimeout = 300
        c.requestMethod = "GET"
        c.responseCode in 200..499
    } catch (_: Throwable) {
        false
    }

    private fun getenv(k: String): String? = System.getenv(k)

    private fun writeRuntimeJson(home: String, nodePath: String, nodeBinDir: String, npmPath: String, npmEntry: String?, minNode: String) {
        val dir = File(filesDir, "supervisor")
        dir.mkdirs()
        val obj = JSONObject().apply {
            put("schema", 2)
            put("nodePath", nodePath)
            put("nodeBinDir", nodeBinDir)
            put("npmPath", npmPath)
            // npmEntry：npm-cli.js 的绝对路径，内核以 [nodePath, npmEntry, ...args] 形态代跑。
            // 保持 schema=2 是刻意的：OTA 下来的旧内核读到未知字段会忽略，
            // 而 bump schema 会让它们直接拒读契约（新 APK + 旧内核是常态）。
            if (npmEntry != null) put("npmEntry", npmEntry)
            put("minNode", minNode)
            put("writtenBy", "android-node-container")
        }
        File(dir, "runtime.json").writeText(obj.toString(2))
    }

    private fun err(e: Throwable): String =
        "${e::class.java.simpleName}: ${e.message}\n" +
            e.stackTraceToString().lines().take(10).joinToString("\n")

    override fun onDestroy() {
        keepRunning = false
        nodeProcess?.destroy()
        nodeProcess = null
        loopJob?.cancel()
        loopJob = null
        try { wakeLock?.release() } catch (_: Throwable) { }
        wakeLock = null
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val pi = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, NodeContainerApp.NOTIFICATION_CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_text))
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
    }

    companion object {
        const val TAG = "NodeRuntimeService"
        const val NOTIF_ID = 1001
        // 内核**控制面**（supervisor API）端口：与内核 src/platform/config.js 的 apiPort 默认值(36360)一致。
        // 不是 3080 —— 3080 是内核 healthUrl（被管控的 DSH 应用端口），不是 supervisor 控制面。
        const val KERNEL_CONTROL_PORT = 36360
        /** 内置探针 server.js 端口（无内核包时的首启验证）。 */
        const val PORT = 3080
        const val BACKOFF_BASE_MS = 1000L
        const val BACKOFF_MAX_MS = 30000L
        /** 内核连续存活超过该时长才算真实成功，退避计数才允许清零。 */
        const val STABLE_MS = 15000L
        /** stderr 上屏的行数上限（全文始终落 node-stderr.log）。 */
        const val STDERR_SCREEN_LINES = 60
        /** 子进程崩溃镜像（守卫给 dsh stderr 行加 "[stderr] " 前缀）单独放宽：
         * 真机 2026-09-22 的秒退死因恰恰排在守卫自身几十行日志之后，统一限量把它挡在了屏幕外。 */
        const val CHILD_STDERR_SCREEN_LINES = 400
    }
}
