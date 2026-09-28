package lobos.runtime

import android.app.Service
import android.content.ContextWrapper
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import lobos.MainActivity
import lobos.OsApplication
import lobos.ProvisioningProbe
import lobos.R
import lobos.RuntimeDiagnostics
import lobos.ota.ProgramManager
import lobos.ota.ProgramOtaUpdater
import lobos.ota.ProgramOtaResolution
import lobos.lifecycle.OsHostService
import lobos.native.AssetStatus
import lobos.native.NativeAssetRegistry
import lobos.native.NativePreparer
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * 运行时**实例宿主**（L-C 环境层）—— 由 [OsHostService] 在同进程内持有。
 *
 * 分层职责（ADR-0006 / ARCHITECTURE §1）：
 *  - 只做两件事：**装配并拉起运行时实例**（经 [GuestAdapter]，环境变量的唯一
 *    装配点在 L-D 侧），以及**守护自己的子进程**（退避重启，见 bootLoop）。
 *  - 它**不是** Android Service：单一生命周期收敛后，唯一前台服务是 [OsHostService]。
 *    进程级存活归 OsHost，本组件只负责"把运行时跑起来并看住子进程"。
 *  - 出生归自己：由 OsHost 调 [start] 时自发起 boot 循环（幂等闸门）。
 *
 * "每一步都可观测"是本服务的硬性设计目标：真机环境千差万别（SELinux 策略、
 * ROM 定制、页大小），一旦启动失败，必须能从屏幕上直接看出失败在哪一环、
 * node 自己报了什么，而不是只能翻 logcat 猜。
 *
 * Node 是直接 exec 的应用私有二进制（bionic 链接）——这是真正的"原生安卓
 * 环境"，与 Termux 无关、不需要 root。可执行性的全部约束（W^X / linker / 架构 /
 * libc 四道关）与验证手段收敛在 `native/` 包，见 [NativePreparer]。
 *
 * 启动链路（每次 boot 的固定顺序，对齐 docs/contracts/base-spec.md §9）：
 * 1. 内核版本指针 + OTA 检查（ADR-0005：内核只来自 OTA）
 * 2. 原生资产统一准备（存在性 → 依赖前置 → exec-probe）
 * 3. 探针脚本 / npm 就位
 * 4. runtime.json 契约落盘（容器写、内核读，schema 2）
 * 5. GuestAdapter 装配 + spawn（有内核跑内核，无内核回落探针）
 * 6. 控制面轮询（就绪=成功；失败交 bootLoop 退避重试）
 *
 * 关键点：一次包升级 = 重启 runtime 进程（用户侧"热"的，无 APK 重编）。
 */
class InstanceHost(private val host: Service) : ContextWrapper(host) {

    private var nodeProcess: Process? = null
    private var wakeLock: PowerManager.WakeLock? = null
    /** 串行 boot 执行器：任何时刻至多一条 boot 循环（幂等闸门的载体）。 */
    private val bootExec = Executors.newSingleThreadExecutor()
    @Volatile private var bootLoopActive = false
    @Volatile private var keepRunning = true
    /** 设备事实类探针（预置体检/写路径/PTY）每进程只跑一次。 */
    @Volatile private var probesDone = false
    @Volatile private var supplyStarted = false

    /** 暂存清扫的每进程一次闸门：boot 可以重试，重复扫只会把同一件事写进诊断好几遍。 */
    @Volatile private var stagingSwept = false
    private var portUp = false
    private var healthUp = false

    /**
     * 随包 `.so` 所在目录（= `nativeLibraryDir`）。
     *
     * 唯一正确取值由 [NativePreparer.libSearchPath] 从 [NativeAssetRegistry] 派生 ——
     * 不要再各写一份。它现在只服务 `$PREFIX` 下尚未带 RUNPATH 的能力件；
     * 依赖解析本身应当由二进制自己的 `DT_RUNPATH=$ORIGIN` 负责，
     * 完整论证见 docs/architecture.md 第 3 节。
     */
    private val libSearchPath: String get() = NativePreparer.libSearchPath(this)

    /**
     * 由 [OsHostService] 调用（幂等）：清日志 + 自发起 boot 循环。
     * 不再 self-promote 前台、不再写进程记录 / 出生标记 —— 那条 binder 监督链已整体删除。
     */
    fun start() {
        RuntimeDiagnostics.clear(this)
        scheduleBootLoop()
    }

    /** OsHost 转发 UI/系统/桥投递的命令（幂等）。 */
    fun onHostStart(intent: Intent?) {
        when (intent?.action) {
            ACTION_RESTART -> requestRestart()
            ACTION_STOP_RUNTIME -> requestStop()
            ACTION_START_RUNTIME -> requestStart()
        }
        scheduleBootLoop()
    }

    /** 停被管对象（os.instances.action=stop / os.session.stop）：循环退出 + 终结子进程；OS 自身不动。 */
    fun requestStop() {
        keepRunning = false
        try { nodeProcess?.destroy() } catch (_: Throwable) { }
    }

    /** 允许运行（start）：置位后让循环重走（循环已退出时 bootLoopActive 已复位）。 */
    fun requestStart() {
        keepRunning = true
        scheduleBootLoop()
    }

    /** 重启：终结当前子进程，循环随即重拉全流程（幂等）。 */
    fun requestRestart() {
        keepRunning = true
        try { nodeProcess?.destroy() } catch (_: Throwable) { }
        scheduleBootLoop()
    }

    // ---- 按需短持唤醒锁（纪律：干活才持、空闲立即释放；不再永久裸持）----
    private fun acquireBriefWakeLock(timeoutMs: Long) {
        try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lobos:runtime").apply {
                setReferenceCounted(false)
                acquire(timeoutMs)
            }
        } catch (_: Throwable) {
        }
    }

    private fun releaseWakeLock() {
        try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: Throwable) { }
        wakeLock = null
    }

    /** 幂等闸门：onCreate（自出生）/ BootReceiver / START_STICKY 重投 / UI 按钮可能反复
     *  触发本方法，但 boot 循环**至多一条** —— 真机 2026-09-22 实锤双循环共享
     *  nodeProcess/healthUp，把活内核误判成死 → 反复 spawn 必死进程 → 紧循环闪屏。 */
    @Synchronized
    private fun scheduleBootLoop() {
        if (bootLoopActive) return
        bootLoopActive = true
        bootExec.execute {
            try {
                bootLoop()
            } finally {
                // 异常出口也必须复位，否则幂等闸门永远关闭（此后任何 start 都拉不起循环）。
                bootLoopActive = false
            }
        }
    }

    /**
     * 子进程守护循环（父监子，runtime 的分内事；进程级复活归 :main 监督者）。
     * 退避判据全部收敛在 [SupervisorPolicy]，CI 钉死。
     *
     * 唤醒纪律：只在"真干活"（探测/OTA/装配/spawn）期间按需短持 PARTIAL_WAKE_LOCK，
     * 空闲等待与退避期一律不持锁（永久裸锁已按债 E4 删除）。
     */
    private fun bootLoop() {
        var restartCount = 0
        while (keepRunning) {
            // 干活期间短持（预算 60s；bootProgramOnce 内部含网络 OTA 与 spawn）。
            acquireBriefWakeLock(60_000L)
            val ok = try { bootProgramOnce() } finally { releaseWakeLock() }
            var bornAt = 0L
            if (ok) {
                // 内核在跑；等待其退出或被外部停止（1s 轮询；ACTION_RESTART 的
                // destroy 会在此被感知为 isAlive=false，1s 内进入重拉）。
                bornAt = SystemClock.elapsedRealtime()
                while (keepRunning && nodeProcess?.isAlive == true && (healthUp || portUp)) {
                    try { Thread.sleep(1000) } catch (_: InterruptedException) { }
                }
            }
            if (!keepRunning) break
            // 退避清零的判据见 SupervisorPolicy.nextRestartCount（以**存活时长**为准，
            // 不以「health 探到 200」为准 —— 真机 2026-09-22 的紧循环风暴实锤）。
            restartCount = SupervisorPolicy.nextRestartCount(
                restartCount, ok, SystemClock.elapsedRealtime() - bornAt,
            )
            val backoff = SupervisorPolicy.backoffMs(restartCount)
            RuntimeDiagnostics.append(this, "supervisor", null, "退避 ${backoff}ms 后重启", "attempt=$restartCount")
            try { Thread.sleep(backoff) } catch (_: InterruptedException) { }
        }
    }

    /**
     * 单次拉起内核；成功返回 true（进程已起 + 控制面就绪），失败返回 false。
     *
     * 可执行性验证由 [NativePreparer.prepare] 完成 —— 它**真跑一次**进程。
     * `canExecute()` 只查 stat 权限位，对 SELinux W^X 无感（假阳性），
     * 这是上游真机排查得出的结论，务必保留。
     */
    private fun bootProgramOnce(): Boolean {
        try {
            RuntimeDiagnostics.append(
                this, "init", null, "InstanceHost 启动内核 (进程 runtime)",
                "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}), filesDir=${filesDir.absolutePath}"
            )
            // 预置体检 + 写路径/PTY 取证：每进程只做一次（设备事实不随 boot 重试改变），
            // 但必须**先于**任何 spawn 上屏 —— 内核起不来时屏幕要能回答"设备缺哪环"。
            // （docs/runbook/provisioning.md §4；真机报告「全盘不可写 EACCES」的定位探针；
            //   PTY 判定实验见 docs/components/native.md。）
            // C 层共享供给：**容器执行、Android 原生**（机制随 APK 走；内核只检测/触发）。
            //   异步、不阻塞启动：供给要下载几十 MB；探针照旧先跑，下一拍看到已就位的真相。
            if (!supplyStarted) {
                supplyStarted = true
                Thread {
                    try { SupplyProvisioner.ensure(this) } catch (e: Throwable) {
                        RuntimeDiagnostics.append(this, "supply", false, "C 层供给线程异常", e.message ?: "")
                    }
                }.start()
            }

            if (!probesDone) {
                probesDone = true
                try {
                    ProvisioningProbe.run(this)
                } catch (e: Throwable) {
                    RuntimeDiagnostics.append(this, "probe", false, "预置体检异常", "${e::class.java.simpleName}: ${e.message}")
                }
                probeFilesystemWrites()
                runPtyProbe()
            }
            // 每次 boot 尝试都戳一下监督者（幂等）：若 runtime 是被绕过监督链拉起的
            // （UI 直启 / sticky 重投），这里补回互保边 —— 监督者同时负责确保 L-B 桥在册。
            OsHostService.ensureRunning(this)

            // ---- 1) 内核版本指针 + OTA ----
            //
            // 顺序是刻意设计的（ADR-0005：内核**只**来自 OTA）：
            // 1a) 已有内核 → 直接用（最常见路径，零额外开销）
            // 1b) OTA      → CURRENT 缺失则**首次安装**；存在则按需**升级**
            // 1c) 仍无内核 → 回落探针模式（把"未安装"如实记为状态，不伪造内核）
            val km = ProgramManager(this)

            // 1a′) 开机清扫安装暂存（每进程一次，且必须在任何安装动作之前）：
            // 上次安装被杀留下的 `<ver>.tmp-*` 在这一刻不可能是活的（安装只由本进程在
            // OTA 之后发起）。真机 2026-09-26 实测到 `0.1.0-android.12.tmp-*` 长期驻留：
            // 既占空间，又被 installedVersions() 当成候选版本（现按暂存命名排除）。
            // 删了什么一律上屏，不做静默清理。
            if (!stagingSwept) {
                stagingSwept = true
                val sweep = try { km.sweepStaleStaging() } catch (e: Throwable) {
                    RuntimeDiagnostics.append(this, "program-tmp", false, "暂存清扫异常", "${e::class.java.simpleName}: ${e.message}")
                    null
                }
                if (sweep != null) {
                    val (gone, stuck) = sweep
                    val head = when {
                        stuck.isNotEmpty() -> "安装暂存残留删不掉 ${stuck.size} 个（已清 ${gone.size} 个）"
                        gone.isNotEmpty() -> "清掉上次被杀安装的残留 ${gone.size} 个"
                        else -> "无安装暂存残留"
                    }
                    RuntimeDiagnostics.append(
                        this, "program-tmp", stuck.isEmpty(), head,
                        (gone.map { "已清 $it" } + stuck.map { "删不掉 $it" }).joinToString()
                    )
                }
            }

            // 1b) 远端内核 OTA：查一次 feed，有更新就自动升级。
            //
            // 为什么必须在 spawn **之前**：升级完成后 CURRENT 已指向新内核，
            // 本次启动就直接跑新版，**不需要额外重启**。
            // 失败只落诊断 —— 离线/服务端故障时开机流程必须照常走完。
            // 有**启动预算**兜底：离线/慢网时超时即放弃（下次启动或手动再试），绝不拖住开机。
            // 手动入口：面板按钮（lobos:panel-update-request）/ 桥方法 build.programInstall。
            val otaCfg = ProgramOtaUpdater.loadConfig(this)
            if (otaCfg != null && otaCfg.autoCheck) {
                try {
                    val ota = ProgramOtaUpdater.checkAndUpdate(this, km, budgetMs = otaCfg.startupBudgetMs)
                    if (ota.checked) {
                        RuntimeDiagnostics.append(
                            this, "program-ota", ota.updated,
                            if (ota.updated) "启动自动升级内核到 ${ota.remote}" else "启动内核检查完成（无更新）",
                            ota.detail
                        )
                    }
                } catch (e: Throwable) {
                    RuntimeDiagnostics.append(
                        this, "program-ota", false, "启动内核检查异常",
                        "${e::class.java.simpleName}: ${e.message}"
                    )
                }
            }

            // 1c) 取当前内核 —— ADR-0005：APK **不含**内核，来源只有 OTA。
            //
            // 不再有"内置基线兜底"：内核要么已被 OTA 装好（CURRENT 指向它），
            // 要么就是没有。后者是**合法状态**（首装尚未成功），照实记录即可 ——
            // 靠"APK 里塞一个"来掩盖它，正是过去"内核一改就要重出 APK"的根因。
            val kVersion = km.currentVersion()
            val programDir = if (!kVersion.isNullOrBlank()) km.programDir(kVersion) else null
            val entry = if (!kVersion.isNullOrBlank()) km.entryPath(kVersion) else null
            // 归因**三态**（纯逻辑 + 单测，见 ProgramOtaResolution）：
            //   从未安装 / CURRENT 在但入口缺失（只落地一半）/ 就位。
            // 旧实现只有两态，把"只落地一半"也说成"尚未安装成功"，排查方向被带偏。
            val res = ProgramOtaResolution.resolve(kVersion, entry?.absolutePath, entry != null && entry.exists())
            val hasKernel = res.state == ProgramOtaResolution.State.READY
            // 不变式守护：内核入口是【脚本】，必须交给 node 解释执行，且必须落在 filesDir
            // 子树内（内核 OTA 的落盘布局）。旧注释把这条说成「W^X 禁止 execve 所以不能直接跑」——
            // 与 ADR-0001 (b)/D1 冲突（我们钉 targetSdk=28 正是为了 app home 可 exec），
            // 域内自证归供给表 exec-domain 格；断言本身不依赖那个解释，照旧成立。
            if (hasKernel && kVersion != null) {
                try {
                    km.assertNotDirectlyExecutable(kVersion)
                } catch (e: IllegalStateException) {
                    RuntimeDiagnostics.append(this, "program", false, "内核入口布局异常", err(e))
                    return false
                }
            }
            // 结构自检：CURRENT 与目录/入口/manifest 是否自洽。发现问题**不阻断**
            // （可能只是 OTA 落地了一半，重试可恢复），但必须留下可查的痕迹。
            val integrity = km.integrityChecks()
            if (integrity.isNotEmpty()) {
                RuntimeDiagnostics.append(
                    this, "program-integrity", false, "内核布局不自洽", integrity.joinToString("; ")
                )
            }
            RuntimeDiagnostics.append(this, "program", res.ok, res.title, res.detail)

            // ---- 2) 原生资产统一准备（存在性 → 依赖前置 → exec-probe） ----
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

            // ---- 3) 探针脚本 + npm 就位 ----
            val script = NodeProvisioner.ensureServerScript(this)
            RuntimeDiagnostics.append(this, "script", true, "server.js 探针就位", script.absolutePath)
            // npm 基础环境（纯 JS，由 libnode.so 代跑；失败不阻断启动 ——
            // 只影响内核侧 Agent 安装能力，LOBOS_NPM_ENTRY 不注入即可）。
            val npmCli = NodeProvisioner.ensureNpm(this)
            RuntimeDiagnostics.append(
                this, "npm", npmCli != null,
                if (npmCli != null) "npm 就位（面板可安装 Agent）" else "npm 未就位 —— 仅影响 Agent 安装，内核照常运行",
                npmCli?.absolutePath ?: "assets/npm 解包失败，详见 logcat"
            )
            // D1 安卓语义垫片（os.cpus 等）：全局预载。缺件不阻断 —— 只是那项语义仍缺。
            val envShim = NodeProvisioner.ensureEnvShim(this)
            RuntimeDiagnostics.append(
                this, "env-shim", envShim != null,
                if (envShim != null) "安卓语义垫片就位（os.cpus 等）" else "安卓语义垫片未就位（不阻断；os.cpus() 仍返回 0）",
                envShim?.absolutePath ?: "assets/node/android-env-shim.cjs 落地失败"
            )

            // ---- 4) 写 runtime.json（schema 2，容器写内核读） ----
            // minNode 单源：就是随包清单里的 Node 版本（上方 version），不再手写字面量。
            writeRuntimeJson(
                nodePath = nodeBin.absolutePath,
                nodeBinDir = nodeBin.parentFile!!.absolutePath,
                npmPath = nodeBin.absolutePath,
                npmEntry = npmCli?.absolutePath,
                prefix = PrefixProvisioner.root(this).absolutePath,
                minNode = version
            )
            RuntimeDiagnostics.append(this, "runtime", true, "runtime.json 已写入（schema 2）", "home=${filesDir.absolutePath}")
            // npm 的可写全局前缀：npm 的默认 prefix 指向 node 安装目录
            // （这里是只读的 /data/app/…/lib），guest 里载荷自己跑 `npm install -g` 必
            // EACCES/EROFS。宿主 spawn 的 npm 靠 npm_config_prefix 撑着，载荷自起的没有
            // 那份 env —— 只有 $HOME/.npmrc 能覆盖它（HOME=filesDir 由 GuestAdapter 定）。
            // 已存在则**不动**：用户改过 .npmrc（换 registry/代理）不该每次开机被抹平。
            val npmrc = NodeProvisioner.ensureNpmPrefixRc(this)
            RuntimeDiagnostics.append(
                this, "npmrc", npmrc != null,
                if (npmrc != null) ".npmrc 前缀在册" else ".npmrc 未能写入（guest 侧 npm -g 会失败）",
                npmrc?.absolutePath ?: "写入失败（无路径可报）"
            )

            // ---- 5) 装配并 spawn（L-C/L-D 的唯一装配点 = GuestAdapter） ----
            //
            // 有内核包：跑内核入口（控制面 36360）；无内核包：回落内置探针 server.js
            // （便于首启验证 Node 原生链路）。环境变量**一项都不许在这外面组装** ——
            // 旧实现把 L-D 旋钮夹在 ProcessBuilder 的 .apply{} 表达式里，PATH 被写
            // 两次互相覆盖、provision 副作用藏在 map 中间，与 boot.js 孪生管线漂移。
            //
            // spawn 前必须回收残留守卫：内核单实例锁（supervisor/guard.lock）持锁者
            // 存活时，新进程 acquireLock 失败即 exit(1) —— 不回收就是必死重启循环。
            reapOrphanKernel()

            val base = GuestAdapter.BaseInputs(
                filesDir = filesDir, cacheDir = cacheDir, nodeBin = nodeBin, nativeLibDir = libSearchPath
            )
            val plan = if (hasKernel && programDir != null && entry != null) {
                // $PREFIX 复制是**副作用**：必须先于装配执行（plan 只声明、不生产）。
                // 缺件必须上屏 —— 真机 2026-09-26 报告 §五 就是「$PREFIX 里到底有没有
                // node/rg/bash」无人可查，guest 侧只会得到「command not found」。
                val prefixReady = PrefixProvisioner.provision(this, nodeBin)
                val prefixMissing = PrefixProvisioner.expected - prefixReady.toSet()
                RuntimeDiagnostics.append(
                    this, "prefix", prefixMissing.isEmpty(),
                    if (prefixMissing.isEmpty()) "\$PREFIX 能力件全就位" else "\$PREFIX 缺件：${prefixMissing.joinToString()}",
                    PrefixProvisioner.root(this).absolutePath + " 已有=" + prefixReady.joinToString()
                )
                val nativeDir = nodeBin.parentFile!!
                GuestAdapter.programPlan(
                    GuestAdapter.ProgramInputs(
                        base = base,
                        programDir = programDir,
                        programEntry = entry,
                        uiDir = File(programDir, "ui/dist"),
                        flockNative = File(nativeDir, NativeAssetRegistry.libNameOf("flock")),
                        posixShim = File(nativeDir, NativeAssetRegistry.libNameOf("posix")),
                        prefixRoot = PrefixProvisioner.root(this),
                        prefixBin = PrefixProvisioner.binDir(this),
                        bashBin = PrefixProvisioner.bashBin(this),
                        npmEntry = npmCli,
                        envShim = envShim,
                    ),
                    getenv("PATH"),
                )
            } else {
                GuestAdapter.probePlan(base, script, getenv("PATH"))
            }
            //
            // command[0] 恒为 nodeBin，entry 是**脚本参数**、不是被 exec 的目标。
            // 本行旧版把这条理由写成「filesDir 被 W^X 禁止 execve」——那是 targetSdk≥29 的规矩，
            // 而本产品刻意钉 targetSdk=28 换的就是 app home 可 exec（ADR-0001 (b)/D1），
            // 上一条 $PREFIX 放的 bash/rg/node 全依赖这条能力。两句不能同时为真：域内自证
            // 归供给表 exec-domain 格（真机读数未采），在它出读数前不许拿 W^X 当结论用。
            // 不变式由 km.assertNotDirectlyExecutable() 守护。
            val pb = ProcessBuilder(plan.command).directory(plan.cwd)
            // 环境以 plan 为**完整事实**：先清空继承环境，两侧（内核/探针）同一契约，
            // 不再有"第二处 apply 悄悄覆盖 NODE_PATH/PATH"的暗通道。
            pb.environment().clear()
            pb.environment().putAll(plan.env)
            nodeProcess = pb.start()
            portUp = false
            healthUp = false
            RuntimeDiagnostics.append(
                this, "exec", true, "内核进程已启动",
                "pid=${currentPid(nodeProcess)}, 控制面 127.0.0.1:${GuestAdapter.CONSOLE_PORT}（探针端口 ${GuestAdapter.PROBE_PORT}）"
            )

            forward(nodeProcess!!.inputStream, "stdout")
            forward(nodeProcess!!.errorStream, "stderr")
            watchExit()
            // ---- 6) 控制面轮询 ----
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
            "无法 exec（依赖已确认完好 → SELinux 拒 exec，查该文件是否真在 nativeLibraryDir）"
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
     * 内核（programs/console 的运行时入口）用 guard.lock 做单实例锁：持锁进程存活时
     * 新进程直接 exit(1)。容器是唯一合法拉起者，一旦上一轮守卫因服务重启竞态、
     * START_STICKY 重投递等成为**无人跟踪的孤儿**，此后每次 spawn 都必死 ——
     * 而它占着 36360，健康探测秒回 200，把失败循环伪装成"启动成功"（真机 2026-09-22 实锤）。
     *
     * 守卫与容器同 uid，killProcess 有权限；lock 内容就是持锁 pid（内核侧写入）。
     * 路径与内核 state-root.js 对齐：LOBOS_SUPERVISOR_HOME(=filesDir)/supervisor/guard.lock。
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

    /** 执行随包 PTY 探针（静态 C，无 libc++ 依赖，直接 exec），stdout 逐行上屏。
     *  缺件（旧 APK/dev）静默跳过——该二进制刻意不登记进 native-assets.txt（同小体积绑定先例）。 */
    private fun runPtyProbe() {
        val bin = File(libSearchPath.substringBefore(File.pathSeparatorChar), NativeAssetRegistry.libNameOf("ptyprobe"))
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

    /**
     * 写探针：只测**我们自己真正会写的位置**。
     *
     * 判据必须区分「坏」与「本就不该写/测不到」：Android 应用进程写 /tmp 必然 EACCES，
     * 探它等于制造一次固定假红。外部私有目录在部分机型拿不到（返回 null），那是**未知**，
     * 也不能伪造一个路径去探 —— 未知不算通过，但必须如实是未知。
     */
    private fun probeFilesystemWrites() {
        fun probe(label: String, f: File) {
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
        val targets = linkedMapOf(
            "files" to File(filesDir, ".lobos-write-probe"),
            "cache" to File(cacheDir, ".lobos-write-probe"),
            "lobos-home" to File(File(filesDir, ".lobos"), ".write-probe")
        )
        for ((label, f) in targets) probe(label, f)
        val ext = try { getExternalFilesDir(null) } catch (_: Throwable) { null }
        if (ext == null) {
            RuntimeDiagnostics.append(this, "probe", null, "写探针 external", "本机未提供外部私有目录，无法判定")
        } else {
            probe("external", File(ext, ".lobos-write-probe"))
        }
    }

    /** 转发子进程 stdout/stderr：都进 logcat；stderr 落盘**并限量上屏**。 */
    private fun forward(stream: InputStream, tag: String) {
        // 转发线程不许带走 runtime：拆管时另一线程 close() 会让在读的 read() 抛
        // InterruptedIOException（libcore 的「管道被关」正常信号，不是故障），沿默认
        // UncaughtExceptionHandler 上抛就是整进程 FATAL —— 真机 crash buffer 里
        // forEachLine→forward$lambda$11 五连发、三个 pid（D10）。
        val t = Thread {
            try {
                var shown = 0
                var childShown = 0
                stream.bufferedReader().use { r ->
                    r.forEachLine { line ->
                        Log.i("Kernel:$tag", line)
                        if (tag == "stderr") {
                            RuntimeDiagnostics.recordNodeStderr(this, line + "\n")
                            // stderr 必须上屏：实例/守卫的启动崩溃**只往 stderr 抛栈**，此前只有
                            // stdout 上屏 → 屏幕上一片安静、面板却打不开，无从排查（真机 2026-09-22）。
                            // 限量防 npm 海噪刷爆诊断页；全文仍在 node-stderr.log。
                            // 守卫镜像的子进程崩溃行（"[stderr] " 前缀）单独计数：真机秒退的
                            // 死因恰恰排在守卫自身日志之后，与 INFO 共用限量会被挡在屏幕外。
                            val isChildLine = line.startsWith("[stderr] ")
                            if (isChildLine) {
                                if (childShown < CHILD_STDERR_SCREEN_LINES) {
                                    RuntimeDiagnostics.append(this, "program-stderr", null, line)
                                    childShown++
                                    if (childShown == CHILD_STDERR_SCREEN_LINES) {
                                        RuntimeDiagnostics.append(this, "program-stderr", null, "……(子进程 stderr 上屏截断，完整见 node-stderr.log)")
                                    }
                                }
                            } else if (shown < STDERR_SCREEN_LINES) {
                                RuntimeDiagnostics.append(this, "program-stderr", null, line)
                                shown++
                                if (shown == STDERR_SCREEN_LINES) {
                                    RuntimeDiagnostics.append(this, "program-stderr", null, "……(stderr 上屏截断，完整见 node-stderr.log)")
                                }
                            }
                        } else {
                            RuntimeDiagnostics.append(this, "program-$tag", null, line)
                        }
                    }
                }
            } catch (e: Throwable) {
                Log.w("Kernel:$tag", "转发线程结束（不影响运行时存活）", e)
                RuntimeDiagnostics.append(
                    this, "program-$tag", null,
                    "转发线程结束：${e::class.java.simpleName}: ${e.message}",
                    "tag=$tag —— 这条线程死掉只该丢掉日志转发，绝不许拖垮 runtime（真机 D10）"
                )
            }
        }
        // 线程名进 logcat：本缺陷此前在崩溃栈里只叫 Thread-2/Thread-3，无从归因。
        t.name = "program-$tag-forward"
        t.start()
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
            // 主动停机（onDestroy）与人为重启（ACTION_RESTART 的 destroy）不算故障；
            // 但**其余任何退出都必须记录** —— 旧实现在 portUp/healthUp=true 时直接
            // return，「起来过又秒死」这一失败形态的 exitCode/stderr 永远进不了
            // 诊断（真机 2026-09-22 排查实锤的盲区）。
            if (!keepRunning) return@Thread
            val readyNote = SupervisorPolicy.exitNote(healthUp || portUp)
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
     * 子进程已死则**提前收轮**：端口不可能再被它点亮，30s 干等只会拖死退避节奏
     * （假成功防线见 poll 前 reapOrphanKernel 的注释）。
     */
    private fun pollControlPlane() {
        var waitedMs = 0
        var procDiedEarly = false
        while (waitedMs < HEALTH_POLL_BUDGET_MS) {
            if (nodeProcess?.isAlive != true) { procDiedEarly = true; break }
            if (isStatusUp()) {
                healthUp = true
                // 提交（ADR-0005 C2）：**首次健康检查通过**才把"已安装"提升为"已提交"。
                commitPendingKernel()
                RuntimeDiagnostics.append(
                    this, "health", true,
                    "内核控制面就绪 (127.0.0.1:${GuestAdapter.CONSOLE_PORT}/status)",
                    "内核原生运行成功 ✓"
                )
                return
            }
            if (isPortUp()) {
                portUp = true
                RuntimeDiagnostics.append(
                    this, "port", true, "127.0.0.1:${GuestAdapter.PROBE_PORT} 已就绪（探针模式）",
                    "Node 原生运行成功 ✓（尚未下发内核包，当前为内置 server.js 探针）"
                )
                return
            }
            try { Thread.sleep(300) } catch (_: InterruptedException) { }
            waitedMs += 300
        }
        // 回滚（ADR-0005 C2）：新内核待命却始终没通过健康检查 → 它跑不了。
        // 进程早死同样走这里：秒退的内核没有资格保持"已安装"。
        rollbackIfPendingFailed()
        RuntimeDiagnostics.append(
            this, "health", false,
            if (procDiedEarly) "内核进程已退出，控制面不会就绪（等待 ${waitedMs}ms 提前收轮）"
            else "控制面在 ${HEALTH_POLL_BUDGET_MS}ms 内未就绪",
            "可能原因：node/内核崩溃 / 端口被占用 / 二进制不兼容当前 ROM（如非 16KB 页对齐）。\n" +
                "查看上方 [FAIL] process 与 node-stderr。"
        )
    }

    /**
     * 内核**提交**（ADR-0005 C2）：首次健康检查通过 = 这个内核真的能跑。
     * 提升版本下限（只增不减）并清除待命标记。
     */
    private fun commitPendingKernel() {
        try {
            val km = ProgramManager(this)
            val pend = km.pending() ?: return
            if (pend.version != km.currentVersion()) return
            km.setFloor(pend.version)
            km.clearPending()
            RuntimeDiagnostics.append(
                this, "program-commit", true,
                "内核 " + pend.version + " 已提交（版本下限提升）",
                "from=" + (pend.from ?: "(无)") + "；floor=" + (km.floorVersion() ?: "(未设)")
            )
        } catch (e: Throwable) {
            RuntimeDiagnostics.append(this, "program-commit", false, "Program 提交失败", err(e))
        }
    }

    /**
     * 内核**回滚**（ADR-0005 C2）：有新内核待命却始终未通过健康检查 → 退回 from。
     * **下限不降** —— 否则"回滚"就成了降级的后门。
     */
    private fun rollbackIfPendingFailed() {
        try {
            val km = ProgramManager(this)
            val pend = km.pending() ?: return
            val from = pend.from ?: return
            if (km.rollbackTo(from)) {
                RuntimeDiagnostics.append(
                    this, "program-rollback", false,
                    "内核 " + pend.version + " 未通过健康检查，已回滚到 " + from,
                    "版本下限保持 " + (km.floorVersion() ?: "(未设)") + " 不变（防止回退后再被更旧的包覆盖）"
                )
            }
            km.clearPending()
        } catch (_: Throwable) { }
    }

    private fun isStatusUp(): Boolean = try {
        val c = URL("http://127.0.0.1:${GuestAdapter.CONSOLE_PORT}/status").openConnection() as HttpURLConnection
        c.connectTimeout = 300
        // 读超时 1.5s：实例启动/安装期设备 CPU 饱和，守卫事件循环排不出 300ms；
        // 太紧会把「活着但忙」误判成「死了」（真机 2026-09-22 面板打不开的直接观感）。
        c.readTimeout = 1500
        c.requestMethod = "GET"
        c.responseCode == 200
    } catch (_: Throwable) {
        false
    }

    /** 内置探针 server.js 的端口（首启验证 Node 原生链路用；内核就绪后走 36360）。 */
    private fun isPortUp(): Boolean = try {
        val c = URL("http://127.0.0.1:${GuestAdapter.PROBE_PORT}/").openConnection() as HttpURLConnection
        c.connectTimeout = 300
        c.readTimeout = 300
        c.requestMethod = "GET"
        c.responseCode in 200..499
    } catch (_: Throwable) {
        false
    }

    private fun getenv(k: String): String? = System.getenv(k)

    private fun writeRuntimeJson(nodePath: String, nodeBinDir: String, npmPath: String, npmEntry: String?, prefix: String, minNode: String) {
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
            // prefix：$PREFIX 根（能力件的家，bin/{bash,rg,node} · lib/pty.node）。恒为
            // PrefixProvisioner.root 的路径，只**声明位置**、不保证此刻已 provision。
            // 内核投放单元曾以容器环境变量找它 —— 本服务从未导出过那个键，rg/pty 因此
            // 静默停摆一整代（真机 2026-09-26）。环境里不加同名键：一份事实只留一处。
            put("prefix", prefix)
            put("minNode", minNode)
            put("writtenBy", "lobos-os")
        }
        File(dir, "runtime.json").writeText(obj.toString(2))
    }

    private fun err(e: Throwable): String =
        "${e::class.java.simpleName}: ${e.message}\n" +
            e.stackTraceToString().lines().take(10).joinToString("\n")

    /** 由 [OsHostService] 调用：停止实例并回收子进程（不再有 Service 生命周期）。 */
    fun shutdown() {
        keepRunning = false
        nodeProcess?.destroy()
        nodeProcess = null
        bootExec.shutdownNow()
        releaseWakeLock()
    }

    companion object {
        const val TAG = "InstanceHost"
        /** UI 重启入口（面板"重试" / 内核更新后重拉）：杀当前实例、boot 循环重走全流程。 */
        const val ACTION_RESTART = "lobos.action.RESTART_RUNTIME"

        /** 停/启被管运行时（桥的 os.instances.action / os.session.stop 走这两条）。 */
        const val ACTION_STOP_RUNTIME = "lobos.action.STOP_RUNTIME"
        const val ACTION_START_RUNTIME = "lobos.action.START_RUNTIME"
        /** 控制面就绪轮询预算（原硬编码 100×300ms；提出常量供早退日志引用）。 */
        const val HEALTH_POLL_BUDGET_MS = 30_000
        /** stderr 上屏的行数上限（全文始终落 node-stderr.log）。 */
        const val STDERR_SCREEN_LINES = 60
        /** 子进程崩溃镜像（守卫给实例 stderr 行加 "[stderr] " 前缀）单独放宽：
         * 真机 2026-09-22 的秒退死因恰恰排在守卫自身几十行日志之后，统一限量把它挡在了屏幕外。 */
        const val CHILD_STDERR_SCREEN_LINES = 400
    }
}
