package lobos.bridge

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.os.Build
import android.os.Environment
import android.os.IBinder
import android.provider.Settings
import android.util.Log
import lobos.MainActivity
import lobos.OsApplication
import lobos.R
import lobos.RuntimeDiagnostics
import lobos.capability.BridgeTokens
import lobos.capability.CapabilityCatalog
import lobos.capability.CapabilityCriteria
import lobos.capability.CapabilityEvidenceCollector
import lobos.ota.ProgramInstaller
import lobos.ota.ProgramManager
import lobos.ota.ProgramOtaUpdater
import lobos.lifecycle.OsHostService
import lobos.lifecycle.OsAccessibilityService
import lobos.lifecycle.PackageInstallReceiver
import lobos.native.AssetStatus
import lobos.native.NativeAssetRegistry
import lobos.native.NativePreparer
import lobos.native.PrepareReport
import lobos.os.AppRegistry
import lobos.os.Journal
import lobos.os.KillAudit
import lobos.os.OsInit
import lobos.os.OsPhase
import lobos.os.PortBroker
import lobos.os.ProgramAuthorizer
import lobos.os.ProgramSettings
import lobos.os.RegistryStore
import lobos.os.TaskRegistry
import lobos.runtime.InstanceHost
import lobos.runtime.NodeVersionManager
import lobos.runtime.GuestAdapter
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/**
 * HostBridge —— 安卓能力桥（L3，随 APK 冻结）。
 *
 * 传输：Unix 域套接字（抽象命名空间，`LocalServerSocket(SOCKET_NAME)`）。Program（同进程内）
 * 主动 connect；本服务监听。严禁 TCP 暴露控制面（见 BASE_SPEC §8）。
 * 协议：JSON-RPC 2.0，换行分隔的 JSON 帧（与 container/engine/src/bridge/uds-transport.js 对齐）。
 * 握手：Program 先发 `bridge.handshake`（protocol + requires 能力分组），本服务回 `capabilities`
 * + `groups`（设备实际已预置能力的分组交集）。
 * 鉴权：每方法声明所需能力（caps）；调用方 requires 超出设备 capabilities → 返回
 * ERR_CAPABILITY_MISSING(-32001)；未知方法 → METHOD_NOT_FOUND(-32601)。
 * 审计：所有特权操作落 files/bridge-audit.log（持久，不随内核包切换丢失）。
 *
 * 注：抽象命名空间套接字在 Android 上等价于 `LocalServerSocket(name)`；内核侧 Node 客户端
 * 用 `net.connect('\0' + SOCKET_NAME)`（**前导 NUL 字节** = Linux 抽象命名空间；Node 22 原生支持）连接。
 * 不是空格前缀——那会连到文件系统里名为 " name" 的路径，永远连不通。
 *
 * 分层纪律（ADR-0006）：本服务是**纯能力桥**。监督运行时曾寄住在 onCreate（"第二职责"），
 * 那是把 L-A 生命周期职责焊死在 L-B 组件上的胶水 —— 桥被杀则监督陪葬、桥的重拉与内核
 * boot 互相踩。现已整体迁入 [OsHostService]；本服务被创建时只回戳一句
 * "监督者请就位"（互保闭环的一条边），不承担监督本身。
 */
class CapabilityBroker(private val host: Service) : ContextWrapper(host) {

    private var server: LocalServerSocket? = null
    private var running = false
    private val executor = Executors.newCachedThreadPool()
    private lateinit var notifManager: NotificationManager

    /**
     * 由 [OsHostService] 调用（幂等）：初始化 + 起 UDS 监听。
     *
     * 它**不再**是 Android Service：单生命周期收敛后唯一前台服务是 OsHostService，
     * 桥只是宿主进程里的一个组件，不再自转前台、不再持有第二/第三条常驻通知。
     */
    fun start() {
        notifManager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        startBridge()
        // 互保闭环：桥活着就确保宿主在（宿主启动时也会 ensureComponents）。
        OsHostService.ensureRunning(this)
    }

    /** OsHost 转发系统投递（幂等）。 */
    fun onHostStart(intent: Intent?) {
        if (!running) startBridge()
    }

    private fun startBridge() {
        if (running) return
        running = true
        executor.execute {
            try {
                server = LocalServerSocket(SOCKET_NAME)
                RuntimeDiagnostics.append(this, "bridge", true, "HostBridge 监听 UDS", "name=$SOCKET_NAME")
                while (running) {
                    val sock = try { server?.accept() } catch (_: Throwable) { null } ?: break
                    executor.execute { handleConnection(sock) }
                }
            } catch (e: Throwable) {
                RuntimeDiagnostics.append(this, "bridge", false, "HostBridge 启服失败", "${e::class.java.simpleName}: ${e.message}")
                Log.e(TAG, "HostBridge 启动失败", e)
            }
        }
    }

    private fun handleConnection(sock: LocalSocket) {
        try {
            val reader = BufferedReader(InputStreamReader(sock.inputStream))
            val out = sock.outputStream
            while (running) {
                val text = reader.readLine() ?: break
                if (text.isBlank()) continue
                try {
                    val msg = JSONObject(text)
                    val resp = dispatch(msg)
                    if (resp != null) writeFrame(out, resp)
                } catch (e: Throwable) {
                    Log.w(TAG, "帧解析失败: $text", e)
                }
            }
        } catch (_: Throwable) {
        } finally {
            try { sock.close() } catch (_: Throwable) {}
        }
    }

    private fun writeFrame(out: OutputStream, obj: JSONObject) {
        out.write((obj.toString() + "\n").toByteArray(Charsets.UTF_8))
        out.flush()
    }

    /** 本连接对端声明的 Program（握手时确定；未握手/未声明 → null）。 */
    @Volatile
    private var peerProgram: String? = null

    /** 本连接被授权的方法组（由 ProgramAuthorizer 依据包清单 requires 判定）。 */
    @Volatile
    private var peerGroups: Set<String> = emptySet()

    /**
     * 方法 → 桥组。os.* / capability.* / bridge.* 不受组约束：
     * 它们的能力由方法自身的 caps 判（契约 §0.1 的 OS 面不按 Program 分组）。
     */
    private fun groupOfMethod(method: String): String? = when {
        method.startsWith("app.") -> "app_control"
        method.startsWith("ui.") -> "ui_automation"
        method.startsWith("shell.") -> "shell"
        method.startsWith("fs.") -> "storage"
        method.startsWith("build.") -> "build"
        method.startsWith("notif.") || method.startsWith("notify.") -> "notification"
        method.startsWith("sys.") -> "system"
        else -> null
    }

    /** 分发一帧；通知类（无 id）返回 null（不回包）。 */
    private fun dispatch(msg: JSONObject): JSONObject? {
        val id = msg.opt("id")
        val method = msg.optString("method", null)
        if (method == null) return null // 通知：不回包

        if (method == "bridge.handshake") {
            return handshake(id, msg.optJSONObject("params") ?: JSONObject())
        }

        val params = msg.optJSONObject("params") ?: JSONObject()
        // 契约别名：console 按 docs/components/console-system-api.md 发 notify.post，桥内规范名为 notif.post。
        val canonical = if (method == "notify.post") "notif.post" else method
        val def = METHODS[canonical] ?: OS_METHODS[canonical]
        if (def == null) {
            return error(id, CODE_METHOD_NOT_FOUND, "未知方法: $method")
        }
        if (!capsSatisfied(def.caps)) {
            return error(id, CODE_CAPABILITY_MISSING, "缺少能力: ${def.caps.joinToString()}")
        }
        // Program 授权（契约 §0 / 复检 AUD-G35）：组令牌之外，还要看本连接声明的 Program 是否被授权该组。
        val group = groupOfMethod(canonical)
        if (group != null && !peerGroups.contains(group)) {
            return error(id, CODE_CAPABILITY_MISSING, "Program ${peerProgram ?: "(未握手)"} 未获授权组: $group")
        }
        try {
            val result = def.handle(params)
            if (def.audit) audit(method, params, true, null)
            return ok(id, result)
        } catch (e: BridgeError) {
            if (def.audit) audit(method, params, false, e.message)
            return error(id, e.code, e.message ?: "error")
        } catch (e: Throwable) {
            if (def.audit) audit(method, params, false, e.message)
            Log.e(TAG, "方法执行异常: $method", e)
            return error(id, CODE_INTERNAL, "${e::class.java.simpleName}: ${e.message}")
        }
    }

    private fun handshake(id: Any?, params: JSONObject): JSONObject {
        val protocol = params.optInt("protocol", 1)
        val requires = params.optJSONArray("requires")?.toList() ?: emptyList()
        // Program 授权表（AUD-G35）：未声明 program（或与包清单 name 不符）→ 只有 base。
        val program = params.optString("program", "").takeIf { it.isNotBlank() }
        val authorized = ProgramAuthorizer.groupsFor(this, program)
        peerProgram = program
        peerGroups = authorized
        val granted = requires.filter { groupCapsSatisfied(it) && authorized.contains(it.removePrefix("bridge:")) }
        val caps = deviceCapabilities()
        // 握手永远算成功返回（能力不足体现在 granted 列表里，不是错误），审计必须记 ok=true；
        // 曾写死 false，导致 bridge-audit.log 里每次健康握手都是失败行。
        audit("bridge.handshake", params, true, null)
        return ok(id, JSONObject().apply {
            put("protocol", protocol)
            put("capabilities", JSONArray(caps))
            put("groups", JSONArray(granted))
            put("program", program ?: JSONObject.NULL)
            put("authorizedGroups", JSONArray(authorized.toList()))
        })
    }

    // ---- 设备能力推断 ----

    /**
     * 桥能力令牌 = 能力登记表的一次投影（[BridgeTokens]），这里**不写任何判据表达式**：
     * 判据若在此复写一遍，就会出现「首页与桥各说各话」（spec §2.5 反向门禁负责让它变红）。
     *
     * 令牌语义提醒：`adb_shell` 表示「配对凭据在册、shell 通道具备」，**不保证此刻连得上** ——
     * adbd 的端口随无线调试重启轮换，真正执行时由 [AdbClientRunner.shell] 现问 mDNS 端点，
     * 连不上按运行时错误（-32603）返回，而不是冒充「能力缺失」（-32001 只表达前提未就绪）。
     */
    private fun deviceCapabilities(): Set<String> =
        BridgeTokens.from(CapabilityEvidenceCollector.systemReads(this))

    /** 一个能力分组是否“满足”：分组映射到其代表能力，设备具备该能力即满足。 */
    private fun groupCapsSatisfied(group: String): Boolean {
        val rep = GROUP_REQUIRED[group] ?: return false
        return deviceCapabilities().contains(rep)
    }

    private fun capsSatisfied(required: List<String>): Boolean {
        val caps = deviceCapabilities()
        return required.all { caps.contains(it) }
    }

    // ---- 审计 ----

    private fun audit(method: String, params: JSONObject, ok: Boolean, err: String?) {
        try {
            val ts = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date())
            val summary = params.toString().let { if (it.length > 200) it.take(200) + "…" else it }
            val line = "$ts method=$method ok=$ok params=$summary${if (err != null) " err=$err" else ""}\n"
            File(filesDir, "bridge-audit.log").appendText(line)
        } catch (_: Throwable) {}
    }

    // ---- 响应构造 ----

    private fun ok(id: Any?, result: JSONObject): JSONObject =
        JSONObject().apply { put("jsonrpc", "2.0"); put("id", id); put("result", result) }

    private fun error(id: Any?, code: Int, message: String): JSONObject =
        JSONObject().apply {
            put("jsonrpc", "2.0"); put("id", id)
            put("error", JSONObject().apply { put("code", code); put("message", message) })
        }

    // ---- 方法实现 ----

    /**
     * 取无障碍服务实例；未连接则抛 -32001。
     * 能力门禁已在 dispatch 前置（caps 含 "accessibility"），此处是**二次确认**，
     * 覆盖「门禁通过后服务恰好被系统回收」的竞态窗口。
     */
    private fun requireA11y(): OsAccessibilityService =
        OsAccessibilityService.instance
            ?: throw BridgeError(CODE_CAPABILITY_MISSING, "无障碍服务未连接（请在系统设置中开启 Lob OS 无障碍服务）")

    private fun entryJson(e: AppRegistry.Entry): JSONObject = JSONObject().apply {
        put("id", e.id)
        put("version", e.version ?: JSONObject.NULL)
        put("role", e.role)
        put("desired", e.desired.name.lowercase(Locale.US))
        put("port", e.port ?: JSONObject.NULL)
    }

    // ── os.* 方法面（契约：docs/components/console-system-api.md）────────────────────
    // 形状对齐：字段按契约 §2 给出（消费方 programs/console/src/api/*.js 按这些字段取值）。
    // 未落地的方法显式 not-implemented（-32002）；已落地给真实读数，绝不伪造。
    private fun notImplemented(method: String): Nothing =
        throw BridgeError(CODE_NOT_IMPLEMENTED, "未实现: " + method + "（见 lobos/os/METHOD-GAPS.md）")

    private fun programJson(e: AppRegistry.Entry): JSONObject = JSONObject().apply {
        put("id", e.id)
        put("name", e.id)
        put("version", e.version ?: JSONObject.NULL)
        put("role", e.role)
        put("phase", e.desired.name.lowercase(Locale.US))
    }

    private fun programsJson(): JSONArray = JSONArray().apply {
        AppRegistry.all(this@CapabilityBroker).forEach { put(programJson(it)) }
    }

    private fun journalJson(e: Journal.Event): JSONObject = JSONObject().apply {
        put("seq", e.seq)
        put("ts", e.atMs)
        put("type", e.category)
        put("source", "os")
        put("data", e.detail)
        put("internal", false)
    }

    /** 转投宿主 intent（本进程内的唯一命令通道，见 OsHostService.ensureComponents）。 */
    private fun toHost(action: String) {
        val i = Intent(this, OsHostService::class.java).setAction(action)
        startService(i)
    }

    private fun instanceJson(e: AppRegistry.Entry): JSONObject = JSONObject().apply {
        put("id", e.id)
        put("kind", "program")
        put("name", e.id)
        put("desired", e.desired.name.lowercase(Locale.US))
        put("phase", e.desired.name.lowercase(Locale.US))
    }

    private fun taskJson(x: TaskRegistry.Task): JSONObject = JSONObject().apply {
        put("id", x.id)
        put("kind", x.kind)
        put("state", x.state)
        put("progress", x.progress)
        put("startedAt", x.startedAt)
        put("detail", x.detail)
        if (x.endedAt != null) put("endedAt", x.endedAt)
    }

    /** Program 包任务：受理即返回 taskId，体力活在原生线程里跑（进度进 TaskRegistry）。 */
    private fun startProgramJob(kind: String): JSONObject {
        val id = TaskRegistry.start(this@CapabilityBroker, kind)
        Thread {
            try {
                TaskRegistry.update(this@CapabilityBroker, id, "running", 10, "检查远端 program-manifest.json")
                val out = ProgramOtaUpdater.checkAndUpdate(
                    this@CapabilityBroker,
                    ProgramManager(this@CapabilityBroker),
                    checkOnly = false,
                )
                val ok = out.updated || !out.available
                TaskRegistry.finish(this@CapabilityBroker, id, ok, out.detail)
                Journal.append(this@CapabilityBroker, "appmgr", null, kind + "：" + out.detail)
            } catch (e: Throwable) {
                TaskRegistry.finish(this@CapabilityBroker, id, false, e::class.java.simpleName + ": " + e.message)
            }
        }.start()
        return JSONObject().apply { put("ok", true); put("accepted", true); put("taskId", id) }
    }

    /** 卸载：清掉所有 Program 版本与指针（"没有 Program"是合法状态，OTA 可再装）。 */
    private fun startUninstallJob(): JSONObject {
        val id = TaskRegistry.start(this@CapabilityBroker, "uninstall")
        Thread {
            try {
                val km = ProgramManager(this@CapabilityBroker)
                val versions = km.installedVersions()
                TaskRegistry.update(this@CapabilityBroker, id, "running", 30, "清理 " + versions.size + " 个版本")
                var removed = 0
                versions.forEach { v -> if (runCatching { km.programDir(v).deleteRecursively() }.getOrDefault(false)) removed++ }
                km.clearCurrentVersion()
                val stale = km.sweepStaleStaging().first
                AppRegistry.upsert(
                    this@CapabilityBroker,
                    AppRegistry.Entry(
                        id = AppRegistry.consoleId(),
                        version = null,
                        role = "system",
                        desired = AppRegistry.Desired.STOPPED,
                        port = null,
                    ),
                )
                TaskRegistry.finish(this@CapabilityBroker, id, true, "已卸载 " + removed + " 个版本，清扫暂存 " + stale.size + " 个")
                Journal.append(this@CapabilityBroker, "appmgr", null, "uninstall：移除 " + removed + " 个版本")
            } catch (e: Throwable) {
                TaskRegistry.finish(this@CapabilityBroker, id, false, e::class.java.simpleName + ": " + e.message)
            }
        }.start()
        return JSONObject().apply { put("ok", true); put("accepted", true); put("taskId", id) }
    }

    private val OS_METHODS: Map<String, MethodDef> = mapOf(
        "os.state.get" to MethodDef(listOf("base"), false) { _ ->
            // 三处同源的第三处：控制台读 **state.json 那一份**，不现场重算结论。
            // 以前这里拿「此刻」的 controlPlaneUp 现判 degraded，而通知与磁贴渲染的是上一拍
            // 实测落盘的相位 —— 同一台设备可以同时对面板和通知说两种话（真机 2026-09-28 定罪）。
            val s = OsInit.snapshot(this@CapabilityBroker)
            val since = s.atMs
            JSONObject().apply {
                put("phase", s.phase.name.lowercase(Locale.US))
                put("label", s.phase.label)
                put("since", since)
                put("uptimeMs", if (since > 0) System.currentTimeMillis() - since else 0L)
                put("degraded", s.phase == OsPhase.DEGRADED)
                put("statusLine", OsInit.statusLine(this@CapabilityBroker))
                put("facts", JSONObject().apply {
                    put("readingsCollected", s.facts.readingsCollected)
                    put("controlPlaneUp", s.facts.controlPlaneUp)
                    put("channel", s.facts.channel.name.lowercase(Locale.US))
                    put("anchor", s.facts.anchor.name.lowercase(Locale.US))
                })
                put("programs", programsJson())
            }
        },
        "os.journal.read" to MethodDef(listOf("base"), false) { p ->
            val after = p.optLong("after", 0L)
            val limit = p.optInt("limit", 50).coerceIn(1, 1000)
            val evs = Journal.events(this@CapabilityBroker, limit).filter { it.seq > after }
            JSONObject().apply {
                put("seq", Journal.latestSeq(this@CapabilityBroker))
                put("events", JSONArray().apply { evs.forEach { put(journalJson(it)) } })
            }
        },
        "os.journal.logTail" to MethodDef(listOf("base"), false) { p ->
            val stream = p.optString("stream", "os")
            val n = p.optInt("n", 8).coerceIn(1, 200)
            val src = if (stream == "programs" || stream == "error") {
                RuntimeDiagnostics.readNodeStderr(this@CapabilityBroker)
            } else {
                Journal.tail(this@CapabilityBroker, n)
            }
            JSONObject().apply {
                put("stream", stream)
                put("lines", JSONArray().apply { src.split("\n").takeLast(n).forEach { put(it) } })
            }
        },
        "os.journal.export" to MethodDef(listOf("base"), false) { p ->
            val after = p.optLong("after", 0L)
            val limit = p.optInt("limit", 1000).coerceIn(1, 5000)
            val evs = Journal.events(this@CapabilityBroker, limit).filter { it.seq > after }
            JSONObject().apply {
                put("seq", Journal.latestSeq(this@CapabilityBroker))
                put("exported", evs.size)
                put("lines", JSONArray().apply { evs.forEach { put(it.toJson().toString()) } })
            }
        },
        "os.journal.metrics" to MethodDef(listOf("base"), false) { _ ->
            val evs = Journal.events(this@CapabilityBroker, 1000)
            val bySource = JSONObject()
            val byType = JSONObject()
            var last = 0L
            evs.forEach { e ->
                bySource.put("os", bySource.optInt("os", 0) + 1)
                byType.put(e.category, byType.optInt(e.category, 0) + 1)
                if (e.atMs > last) last = e.atMs
            }
            val topTypes = JSONArray()
            byType.keys().asSequence().sortedByDescending { byType.optInt(it, 0) }.take(5)
                .forEach { k -> topTypes.put(JSONObject().apply { put("type", k); put("count", byType.optInt(k, 0)) }) }
            JSONObject().apply {
                put("gseq", Journal.latestSeq(this@CapabilityBroker))
                put("events", evs.size)
                put("bySource", bySource)
                put("topTypes", topTypes)
                put("sinceLastMs", if (last > 0) System.currentTimeMillis() - last else 0L)
            }
        },
        "os.journal.tasks" to MethodDef(listOf("base"), false) { p ->
            val kind = p.optString("kind", "").takeIf { it.isNotBlank() }
            val running = p.optBoolean("running", false)
            JSONObject().apply {
                put("tasks", JSONArray().apply {
                    TaskRegistry.list(this@CapabilityBroker, kind, running).forEach { put(taskJson(it)) }
                })
                put("current", TaskRegistry.current(this@CapabilityBroker, kind)?.let { taskJson(it) } ?: JSONObject.NULL)
            }
        },
        "os.journal.task" to MethodDef(listOf("base"), false) { p ->
            val id = p.optString("id", "")
            val task = TaskRegistry.get(this@CapabilityBroker, id)
                ?: throw BridgeError(CODE_METHOD_NOT_FOUND, "无此任务: " + id)
            JSONObject().apply { put("task", taskJson(task)) }
        },
        "os.instances.list" to MethodDef(listOf("base"), false) { _ ->
            val mods = JSONArray()
            AppRegistry.all(this@CapabilityBroker).forEach { e ->
                val ph = e.desired.name.lowercase(Locale.US)
                mods.put(JSONObject().apply {
                    put("id", e.id); put("kind", "program"); put("name", e.id)
                    put("desired", ph); put("phase", ph)
                })
            }
            JSONObject().apply { put("modules", mods) }
        },
        "os.instances.get" to MethodDef(listOf("base"), false) { p ->
            val id = p.optString("id", AppRegistry.consoleId())
            val e = AppRegistry.all(this@CapabilityBroker).firstOrNull { it.id == id }
                ?: throw BridgeError(CODE_METHOD_NOT_FOUND, "无此实例: " + id)
            instanceJson(e)
        },
        "os.instances.action" to MethodDef(listOf("base"), true) { p ->
            val id = p.optString("id", AppRegistry.consoleId())
            if (id != AppRegistry.consoleId()) throw BridgeError(CODE_METHOD_NOT_FOUND, "无此实例: " + id)
            val action = p.optString("action", "")
            val running = when (action) {
                "start" -> { toHost(InstanceHost.ACTION_START_RUNTIME); true }
                "restart" -> { toHost(InstanceHost.ACTION_RESTART); true }
                "stop" -> { toHost(InstanceHost.ACTION_STOP_RUNTIME); false }
                else -> throw BridgeError(CODE_INVALID_PARAM, "action 必须是 start|stop|restart")
            }
            val desired = if (running) AppRegistry.Desired.RUNNING else AppRegistry.Desired.STOPPED
            AppRegistry.upsert(
                this@CapabilityBroker,
                AppRegistry.Entry(AppRegistry.consoleId(), ProgramManager(this@CapabilityBroker).currentVersion(), "system", desired, null),
            )
            Journal.append(this@CapabilityBroker, "instance", null, "os.instances.action=" + action + "（console）")
            JSONObject().apply {
                put("ok", true)
                put("desired", desired.name.lowercase(Locale.US))
                put("phase", desired.name.lowercase(Locale.US))
            }
        },
        "os.session.get" to MethodDef(listOf("base"), false) { _ ->
            JSONObject().apply { put("sessionState", OsInit.current(this@CapabilityBroker).name.lowercase(Locale.US)) }
        },
        "os.session.stop" to MethodDef(listOf("base"), true) { _ ->
            // 停全部被管对象；**OS 不停自己**（由容器/系统决定）。
            toHost(InstanceHost.ACTION_STOP_RUNTIME)
            Journal.append(this@CapabilityBroker, "session", null, "os.session.stop：被管对象已停，OS 自身不动")
            JSONObject().apply { put("ok", true) }
        },
        "os.programs.overview" to MethodDef(listOf("base"), false) { _ ->
            JSONObject().apply {
                put("installed", AppRegistry.all(this@CapabilityBroker).size)
                put("programs", programsJson())
                put("versionInfo", JSONObject().apply { put("current", ProgramManager(this@CapabilityBroker).currentVersion() ?: "") })
                put("upgrade", JSONObject().apply { put("updateAvailable", false) })
            }
        },
        "os.programs.list" to MethodDef(listOf("base"), false) { _ ->
            JSONObject().apply { put("programs", programsJson()) }
        },
        "os.programs.settings" to MethodDef(listOf("base"), true) { p ->
            val id = p.optString("id", AppRegistry.consoleId())
            val patch = JSONObject(p.toString())
            patch.remove("id")
            if (patch.length() == 0) throw BridgeError(CODE_INVALID_PARAM, "空补丁：至少给一个要写的键")
            val merged = ProgramSettings.patch(this@CapabilityBroker, id, patch)
            Journal.append(this@CapabilityBroker, "programs", null, "settings 更新: " + id)
            JSONObject().apply { put("ok", true); put("settings", merged) }
        },


        "os.appmgr.install" to MethodDef(listOf("base"), true) { _ -> startProgramJob("install") },
        "os.appmgr.upgrade" to MethodDef(listOf("base"), true) { _ -> startProgramJob("upgrade") },
        "os.appmgr.uninstall" to MethodDef(listOf("base"), true) { _ -> startUninstallJob() },
        "os.appmgr.checkUpdate" to MethodDef(listOf("base"), false) { _ ->
            val out = ProgramOtaUpdater.checkAndUpdate(this@CapabilityBroker, ProgramManager(this@CapabilityBroker), checkOnly = true)
            JSONObject().apply {
                put("updateAvailable", out.available)
                put("latest", out.remote ?: JSONObject.NULL)
                put("current", out.current ?: JSONObject.NULL)
                put("checkedAt", System.currentTimeMillis())
                put("detail", out.detail)
            }
        },



        "os.registry.info" to MethodDef(listOf("base"), false) { _ -> RegistryStore.info(this@CapabilityBroker) },
        "os.registry.apps" to MethodDef(listOf("base"), false) { _ ->
            JSONObject().apply { put("programs", programsJson()) }
        },
        "os.registry.set" to MethodDef(listOf("base"), true) { p ->
            val origin = p.optString("origin", "").trim()
            if (origin.isBlank() || !origin.startsWith("https://")) {
                throw BridgeError(CODE_INVALID_PARAM, "origin 必须是非空 https:// URL（镜像源只走 TLS）")
            }
            RegistryStore.setOrigin(this@CapabilityBroker, origin, null)
        },
        "os.registry.refresh" to MethodDef(listOf("base"), true) { _ ->
            val cur = RegistryStore.info(this@CapabilityBroker).optString("origin", "")
            if (cur.isBlank()) throw BridgeError(CODE_INVALID_PARAM, "尚未设置镜像源（先 os.registry.set）")
            RegistryStore.setOrigin(this@CapabilityBroker, cur, RegistryStore.probe(cur))
        },
        "os.registry.probe" to MethodDef(listOf("base"), false) { p ->
            val origin = p.optString("origin", "").trim().ifBlank {
                RegistryStore.info(this@CapabilityBroker).optString("origin", "")
            }
            if (origin.isBlank()) throw BridgeError(CODE_INVALID_PARAM, "未提供 origin 且尚未设置镜像源")
            RegistryStore.probe(origin)
        },
        "os.ports.list" to MethodDef(listOf("base"), false) { _ ->
            val leases = PortBroker.list(this@CapabilityBroker)
            val arr = JSONArray()
            leases.forEach { l -> arr.put(JSONObject().apply { put("port", l.port); put("owner", l.owner) }) }
            JSONObject().apply {
                put("fixed", JSONArray()); put("user", arr)
                put("allocated", leases.size)
                put("capacity", PortBroker.RANGE_END - PortBroker.RANGE_START + 1)
            }
        },
        "os.ports.claim" to MethodDef(listOf("base"), true) { p ->
            val owner = p.optString("owner", "console")
            val pref = if (p.has("preferred")) p.optInt("preferred") else null
            JSONObject().apply { put("port", PortBroker.claim(this@CapabilityBroker, owner, pref)); put("mode", "claimed") }
        },
        "os.ports.release" to MethodDef(listOf("base"), true) { p ->
            PortBroker.release(this@CapabilityBroker, p.optString("owner", "console"))
            JSONObject().apply { put("ok", true) }
        },
        "os.runtime.status" to MethodDef(listOf("base"), false) { _ ->
            val node = NativeAssetRegistry.resolve(this@CapabilityBroker, NativeAssetRegistry.NODE)
            JSONObject().apply {
                put("name", "node")
                put("version", NodeVersionManager(this@CapabilityBroker).currentVersion())
                put("path", node.absolutePath)
                put("ok", node.exists())
            }
        },

        "os.runtime.nodeLts" to MethodDef(listOf("base"), false) { _ ->
            val cur = NodeVersionManager(this@CapabilityBroker).currentVersion()
            JSONObject().apply { put("current", cur); put("latest", cur); put("updateAvailable", false) }
        },
        "os.env.status" to MethodDef(listOf("base"), false) { _ ->
            val ev = CapabilityEvidenceCollector.systemReads(this@CapabilityBroker)
            val caps = BridgeTokens.from(ev)
            val verdicts = CapabilityCatalog.evaluate(ev)
            JSONObject().apply {
                put("platform", "android")
                put("apiLevel", Build.VERSION.SDK_INT)
                put("capabilities", JSONArray().apply { caps.sorted().forEach { put(it) } })
                put("catalog", JSONArray().apply {
                    verdicts.keys.sorted().forEach { k ->
                        put(JSONObject().apply {
                            put("id", k)
                            put("status", verdicts[k]?.status?.name?.lowercase(Locale.US) ?: "unknown")
                        })
                    }
                })
            }
        },
        "os.env.programs" to MethodDef(listOf("base"), false) { _ ->
            JSONObject().apply { put("programs", programsJson()) }
        },
        "capability.invoke" to MethodDef(listOf("base"), true) { _ -> notImplemented("capability.invoke") },
    )

    private val METHODS: Map<String, MethodDef> = mapOf(
        // 3.8 system
        "sys.info" to MethodDef(listOf("base"), false) { _ ->
            JSONObject().apply {
                put("manufacturer", Build.MANUFACTURER)
                put("model", Build.MODEL)
                put("androidApi", Build.VERSION.SDK_INT)
                put("platform", "android")
                put("bridge", SOCKET_NAME)
            }
        },
        // 原生资产自检（只读，无权限要求）。
        //
        // 为什么把它暴露给内核：W^X/exec 这条链的失败**几乎全部发生在真机上**，
        // 而容器侧的诊断层（diagnostics.txt）需要用户手动去翻。把它经桥暴露后，
        // 内核可以直接在 UI 里回答「node 到底能不能跑、为什么不能」，
        // 且给出的是**结构化归因**（缺依赖 / 未解压 / SELinux 拒 exec / 探针失败），
        // 而不是一句 "启动失败"。
        //
        // 注意：本方法是**只读探测**，每次调用会真跑一次 exec-probe（默认 walkProbes=true）。
        // 传 {"walkProbes": false} 可只做存在性+依赖检查，避免频繁 spawn 进程。
        // 探针默认走 NativePreparer.prepare()，与容器启动链**完全同一实现**，不会漂移。
        "sys.nativeAssets" to MethodDef(listOf("base"), false) { p ->
            val walkProbes = p.optBoolean("walkProbes", true)
            val report = if (walkProbes) {
                NativePreparer.prepare(this)
            } else {
                // 跳过 exec-probe：verify 与 prepare 同一实现（存在性 + 依赖检查），
                // 不再内联伪造 —— 曾硬编码 inApk=false，把"APK 里有但没解出来"误报成"包里没有"。
                PrepareReport(NativeAssetRegistry.ALL.map { exe -> exe to NativePreparer.verify(this, exe) })
            }
            report.toJson().apply {
                put("nativeLibraryDir", applicationInfo.nativeLibraryDir)
                put("libSearchPath", NativePreparer.libSearchPath(this@CapabilityBroker))
            }
        },
        // 3.7 notification
        "notif.post" to MethodDef(listOf("base"), true) { p ->
            val ch = "hostbridge_notif"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                notifManager.createNotificationChannel(
                    NotificationChannel(ch, "HostBridge", NotificationManager.IMPORTANCE_LOW)
                )
            }
            val n = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                android.app.Notification.Builder(this, ch)
            else android.app.Notification.Builder(this)
            n.setContentTitle(p.optString("title", "Lob OS")).setContentText(p.optString("text", ""))
                .setSmallIcon(android.R.drawable.ic_dialog_info)
            // 通知 agent 投递的通知与前台服务通知（1001-1003）错开：落在 10000+ 专属区间。
            notifManager.notify((10000 + (System.currentTimeMillis() % 55000)).toInt(), n.build())
            JSONObject().apply { put("posted", true) }
        },
        "notif.read" to MethodDef(listOf("notification_access"), true) { p ->
            // 真实实现：由 OsNotificationListenerService 在通知发布时收集到 NotificationStore。
            // 未连接（用户没在系统设置里开启）→ 能力缺失，按契约 -32001，不返回伪造空集。
            if (!NotificationStore.connected) {
                throw BridgeError(
                    CODE_CAPABILITY_MISSING,
                    "通知监听未连接：请在 设置 → 通知 → 通知使用权 中启用本应用后重试。"
                )
            }
            val limit = p.optInt("limit", 50).coerceIn(1, 200)
            val arr = NotificationStore.snapshot(limit)
            JSONObject().apply {
                put("notifications", arr)
                put("count", arr.length())
            }
        },
        // 3.1 app_control
        "app.listInstalled" to MethodDef(listOf("base"), false) { _ ->
            val apps = packageManager.getInstalledApplications(PackageManager.GET_META_DATA)
            val arr = JSONArray()
            for (ai in apps) arr.put(ai.packageName)
            JSONObject().apply { put("packages", arr); put("count", arr.length()) }
        },
        "app.launch" to MethodDef(listOf("base"), false) { p ->
            val pkg = p.optString("pkg", "")
            val ai = packageManager.getLaunchIntentForPackage(pkg)
            if (ai == null) throw BridgeError(CODE_INVALID_PARAM, "无启动入口: $pkg")
            ai.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(ai)
            JSONObject().apply { put("launched", pkg) }
        },
        "app.openUrl" to MethodDef(listOf("base"), false) { p ->
            // 内核 browser.open 的承接方：安卓上「打开外部浏览器」= ACTION_VIEW Intent。
            // 无浏览器/无 Activity 可处理 → 抛 INVALID_PARAM（调用方走「无可用浏览器」分支）。
            val url = p.optString("url", "")
            if (url.isEmpty()) throw BridgeError(CODE_INVALID_PARAM, "url 为空")
            val ai = Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))
            ai.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (ai.resolveActivity(packageManager) == null) throw BridgeError(CODE_INVALID_PARAM, "无可用浏览器: $url")
            startActivity(ai)
            JSONObject().apply { put("opened", true); put("url", url) }
        },
        "app.stop" to MethodDef(listOf("base"), false) { p ->
            val pkg = p.optString("pkg", "")
            (getSystemService(ACTIVITY_SERVICE) as ActivityManager).killBackgroundProcesses(pkg)
            JSONObject().apply { put("stopped", pkg) }
        },
        "app.install" to MethodDef(listOf("base"), true) { p ->
            // 安装路径只保留「用户手动同意」：走 PackageInstaller 的 createSession/write/commit，
            // 由系统弹确认框，用户点确认才安装（Manifest 声明 REQUEST_INSTALL_PACKAGES）。
            val apk = p.optString("apkPath", "")
            val f = File(apk)
            if (!f.exists()) throw BridgeError(CODE_INVALID_PARAM, "APK 不存在: $apk")
            val installer = packageManager.packageInstaller
            val params = android.content.pm.PackageInstaller.SessionParams(
                android.content.pm.PackageInstaller.SessionParams.MODE_FULL_INSTALL
            )
            // 保持最小权限集：不申请任何静默/替换特权。
            val sessionId = installer.createSession(params)
            installer.openSession(sessionId).use { session ->
                f.inputStream().use { input ->
                    session.openWrite("lobos", 0, f.length()).use { input.copyTo(it) }
                }
                val intent = Intent(this, PackageInstallReceiver::class.java)
                    .putExtra(EXTRA_PKG, apk)
                val pi = android.app.PendingIntent.getBroadcast(
                    this, sessionId, intent,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
                )
                session.commit(pi.intentSender)
            }
            JSONObject().apply {
                put("installing", apk)
                put("sessionId", sessionId)
                put("note", "已提交 PackageInstaller 会话；结果经广播回传，可轮询 app.listInstalled 确认")
            }
        },
        "app.uninstall" to MethodDef(listOf("base"), true) { p ->
            // 卸载同样只走「用户手动同意」：PackageInstaller.uninstall 由系统弹确认框。
            val pkg = p.optString("pkg", "")
            if (pkg.isEmpty()) throw BridgeError(CODE_INVALID_PARAM, "pkg 为空")
            val intent = Intent(this, PackageInstallReceiver::class.java)
                .setAction(PackageInstallReceiver.ACTION_UNINSTALLED)
                .putExtra(EXTRA_PKG, pkg)
            val pi = android.app.PendingIntent.getBroadcast(
                this, pkg.hashCode(), intent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
            )
            packageManager.packageInstaller.uninstall(pkg, pi.intentSender)
            JSONObject().apply { put("uninstalling", pkg) }
        },
        // 3.2 ui_automation —— 真实实现（OsAccessibilityService，P2 落地）。
        // 服务未连接时 requireA11y() 抛 -32001；方法级 caps 已由 dispatch 前置门禁。
        "ui.tap" to MethodDef(listOf("accessibility"), true) { p ->
            val a11y = requireA11y()
            val ok = a11y.performTap(
                p.optDouble("x", 0.0).toFloat(),
                p.optDouble("y", 0.0).toFloat(),
                p.optLong("durationMs", 60L)
            )
            JSONObject().apply { put("ok", ok) }
        },
        "ui.swipe" to MethodDef(listOf("accessibility"), true) { p ->
            val a11y = requireA11y()
            val ok = a11y.performSwipe(
                p.optDouble("x1", 0.0).toFloat(), p.optDouble("y1", 0.0).toFloat(),
                p.optDouble("x2", 0.0).toFloat(), p.optDouble("y2", 0.0).toFloat(),
                p.optLong("durationMs", 300L)
            )
            JSONObject().apply { put("ok", ok) }
        },
        "ui.inputText" to MethodDef(listOf("accessibility"), true) { p ->
            val a11y = requireA11y()
            val text = p.optString("text", "")
            if (p.has("selector") && p.optJSONObject("selector")?.length() == 0) {
                throw BridgeError(CODE_INVALID_PARAM, "selector 不能为空对象")
            }
            val ok = a11y.inputText(text, p.optJSONObject("selector"))
            JSONObject().apply { put("ok", ok) }
        },
        "ui.getUiTree" to MethodDef(listOf("accessibility"), false) { p ->
            val a11y = requireA11y()
            // getUiTree 是只读观测，不写审计（与 methods.js 一致，crosslang 门禁钉住）。
            a11y.dumpUiTree(
                maxNodes = p.optInt("maxNodes", 3000),
                maxDepth = p.optInt("maxDepth", 40)
            )
        },
        "ui.screenshot" to MethodDef(listOf("mediaprojection"), true) { p ->
            // P5：真实实现。授权是**每次会话**的（用户须点系统弹窗），故首次调用前
            // 必须先经 MainActivity 授权；授权结果缓存在 files/screen-capture-grant.json。
            val svc = ScreenCaptureController.instance
                ?: throw BridgeError(
                    CODE_CAPABILITY_MISSING,
                    "截屏服务未启动。需先在 App 内完成一次截屏授权（系统弹窗），此后可后台复用"
                )
            val metrics = resources.displayMetrics
            val w = p.optInt("width", metrics.widthPixels)
            val h = p.optInt("height", metrics.heightPixels)
            val bmp = svc.capture(w, h, metrics.densityDpi)
                ?: throw BridgeError(CODE_INTERNAL, "截屏失败（8s 内未取到帧；可能屏幕处于锁屏/息屏）")

            val dir = File(filesDir, "screenshots").apply { mkdirs() }
            val file = File(dir, "shot-${System.currentTimeMillis()}.png")
            file.outputStream().use { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
            val outW = bmp.width
            val outH = bmp.height
            bmp.recycle()

            if (p.optBoolean("inline", false)) {
                // 内联 base64：方便小图/低分辨率直取，但大图会显著撑大 JSON-RPC 帧。
                val bytes = file.readBytes()
                JSONObject().apply {
                    put("encoding", "base64")
                    put("content", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
                    put("width", outW); put("height", outH); put("bytes", bytes.size)
                    put("path", file.absolutePath)
                }
            } else {
                JSONObject().apply {
                    put("path", file.absolutePath)
                    put("width", outW)
                    put("height", outH)
                    put("bytes", file.length())
                }
            }
        },
        "ui.waitFor" to MethodDef(listOf("accessibility"), false) { p ->
            val a11y = requireA11y()
            val selector = p.optJSONObject("selector")
                ?: throw BridgeError(CODE_INVALID_PARAM, "waitFor 需要 selector")
            a11y.waitForNode(
                selector,
                timeoutMs = p.optLong("timeoutMs", 10_000L),
                intervalMs = p.optLong("intervalMs", 250L)
            )
        },
        // 3.3 shell —— 内置 ADB 客户端（无线调试）通道（ADR-0003 勘误 2026-09-24）。
        //
        // 为什么下沉在壳而不是内核：ADB 客户端是权限通道（L0），身份密钥落 files/adb/；
        // 若放内核（L1 热更层），OTA 下来的代码就能读写/替换 ADB 身份 —— 双信任根失效。
        // 实现形态：一次性 Node 进程跑 assets/node/adb-client/（minSdk 24 的 Kotlin 没有
        // TLS exporter / SPAKE2 原语），与内核校验器同构，见 AdbClientRunner。
        //
        // 门禁设计：pair/status/forget 只要 base（否则未配对设备永远配不上对）；
        // exec 要 adb_shell（= 已配对）。连接失败等运行时错误按 -32603 原样带回，
        // 不冒充「能力缺失」—— -32001 只表达「前提未就绪」。
        "shell.status" to MethodDef(listOf("base"), false) { _ ->
            val res = AdbClientRunner.status(this)
            if (!res.ok) throw BridgeError(CODE_INTERNAL, "ADB status 失败: ${res.error ?: res.raw.take(300)}")
            res.json ?: JSONObject()
        },
        "shell.pair" to MethodDef(listOf("base"), true) { p ->
            val host = p.optString("host", "")
            val pairPort = p.optInt("pairPort", 0)
            val code = p.optString("code", "")
            if (host.isBlank() || pairPort <= 0 || code.isBlank()) {
                throw BridgeError(CODE_INVALID_PARAM, "pair 需要 host / pairPort / code")
            }
            val connectPort = if (p.has("connectPort")) p.optInt("connectPort", 0).takeIf { it > 0 } else null
            val timeoutMs = p.optLong("timeoutMs", 30_000L).coerceIn(1_000L, 120_000L)
            val res = AdbClientRunner.pair(this, host, pairPort, code, connectPort, timeoutMs)
            if (!res.ok) throw BridgeError(CODE_INTERNAL, "配对失败: ${res.error ?: res.raw.take(300)}")
            res.json ?: JSONObject()
        },
        "shell.forget" to MethodDef(listOf("base"), true) { _ ->
            val res = AdbClientRunner.forget(this)
            if (!res.ok) throw BridgeError(CODE_INTERNAL, "forget 失败: ${res.error ?: res.raw.take(300)}")
            JSONObject().apply { put("ok", true) }
        },
        // shell.exec：**以 shell uid(2000) 经内置 ADB 客户端执行**（无线调试连接）。
        // 不做应用 uid 兜底（兜底会让「能力有没有」这件事变得不可判定）。
        // ADB shell 通道不回传命令退出码（v2 协议才有），故结果不含 exitCode 字段 ——
        // 调用方判成功与否看 ok，取输出看 stdout。
        "shell.exec" to MethodDef(listOf("adb_shell"), true) { p ->
            val cmd = p.optString("cmd", "")
            if (cmd.isBlank()) throw BridgeError(CODE_INVALID_PARAM, "cmd 为空")
            val arr = p.optJSONArray("args")?.let { a -> (0 until a.length()).map { a.optString(it) } }
                ?: emptyList()
            val timeoutMs = p.optLong("timeoutMs", 10_000L).coerceIn(1L, 60_000L)
            val full = if (arr.isEmpty()) cmd
                       else cmd + " " + arr.joinToString(" ") { shellQuote(it) }
            val res = AdbClientRunner.shell(this, full, null, null, timeoutMs)
            if (!res.ok) throw BridgeError(CODE_INTERNAL, "ADB shell 失败: ${res.error ?: res.raw.take(300)}")
            val outStr = res.json?.optString("out", "") ?: ""
            JSONObject().apply {
                put("ok", true)
                put(
                    "stdout",
                    if (outStr.length > MAX_SHELL_OUTPUT) outStr.take(MAX_SHELL_OUTPUT) + "\n…(截断)"
                    else outStr
                )
                put("uid", 2000)
                put("privileged", true)
                put("note", "以 shell uid(2000) 经内置 ADB 客户端（无线调试）执行。")
            }
        },
        // ---- 3.5 storage：fs.* 真实实现（P5，2026-09）----
        // 访问范围：全放开（有 MANAGE_EXTERNAL_STORAGE 即通行），不做白名单限制。
        // 但保留**审计留痕**与**危险路径提示**（不拦截）——见 auditPathHint()。
        "fs.read" to MethodDef(listOf("manage_external_storage"), false) { p ->
            val f = requireReadableFile(p.optString("path", ""))
            val maxBytes = p.optLong("maxBytes", DEFAULT_FS_MAX_BYTES).coerceIn(1L, MAX_FS_BYTES)
            if (f.length() > maxBytes) {
                throw BridgeError(
                    CODE_INVALID_PARAM,
                    "文件 ${f.length()} 字节超过上限 $maxBytes；用 maxBytes 显式放大（硬顶 ${MAX_FS_BYTES}）"
                )
            }
            val bytes = f.readBytes()
            val encoding = p.optString("encoding", "auto")
            if (encoding == "base64") {
                JSONObject().apply {
                    put("path", f.absolutePath)
                    put("bytes", bytes.size)
                    put("encoding", "base64")
                    put("content", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
                }
            } else {
                // auto：能按 UTF-8 无损还原就当文本，否则退 base64（避免二进制被静默损坏）。
                val text = String(bytes, Charsets.UTF_8)
                val lossless = text.toByteArray(Charsets.UTF_8).contentEquals(bytes)
                JSONObject().apply {
                    put("path", f.absolutePath)
                    put("bytes", bytes.size)
                    if (lossless) {
                        put("encoding", "utf8")
                        put("content", text)
                    } else {
                        put("encoding", "base64")
                        put("content", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
                        put("note", "内容非合法 UTF-8，已自动以 base64 返回（避免损坏二进制）")
                    }
                }
            }
        },
        "fs.write" to MethodDef(listOf("manage_external_storage"), true) { p ->
            val f = requireWritableFile(p.optString("path", ""))
            val encoding = p.optString("encoding", "utf8")
            val content = p.optString("content", "")
            val bytes = if (encoding == "base64") {
                android.util.Base64.decode(content, android.util.Base64.DEFAULT)
            } else {
                content.toByteArray(Charsets.UTF_8)
            }
            val append = p.optBoolean("append", false)
            f.parentFile?.mkdirs()
            if (append) f.appendBytes(bytes) else f.writeBytes(bytes)
            JSONObject().apply {
                put("path", f.absolutePath)
                put("bytes", bytes.size)
                put("appended", append)
                auditPathHint(f.absolutePath)?.let { put("hint", it) }
            }
        },
        "fs.list" to MethodDef(listOf("manage_external_storage"), false) { p ->
            val path = p.optString("path", "")
            val f = when {
                path.isBlank() -> File(Environment.getExternalStorageDirectory().absolutePath)
                else -> File(path)
            }
            if (!f.exists()) throw BridgeError(CODE_INVALID_PARAM, "路径不存在: ${f.absolutePath}")
            val recursive = p.optBoolean("recursive", false)
            val maxEntries = p.optInt("maxEntries", 1000).coerceIn(1, 10000)
            val arr = JSONArray()
            var truncated = false
            if (f.isDirectory) {
                if (recursive) f.walkTopDown().forEach { c ->
                    if (arr.length() >= maxEntries) { truncated = true; return@forEach }
                    if (c.absolutePath != f.absolutePath) arr.put(fileToJson(c))
                } else {
                    val kids = f.listFiles() ?: emptyArray()
                    for (c in kids) {
                        if (arr.length() >= maxEntries) { truncated = true; break }
                        arr.put(fileToJson(c))
                    }
                }
            }
            JSONObject().apply {
                put("path", f.absolutePath)
                put("isDirectory", f.isDirectory)
                put("entries", arr)
                put("count", arr.length())
                put("truncated", truncated)
            }
        },
        "fs.mkdir" to MethodDef(listOf("manage_external_storage"), true) { p ->
            val f = requireWritableFile(p.optString("path", ""))
            val ok = if (f.exists()) f.isDirectory else f.mkdirs()
            if (!ok) throw BridgeError(CODE_INTERNAL, "创建目录失败: ${f.absolutePath}")
            JSONObject().apply {
                put("path", f.absolutePath)
                put("existed", f.exists())
            }
        },
        // ---- 3.6 build：内核安装（A'' 自举）----
        //
        // 语义澄清：本组**不是**「内置编译工具链」（那个方案已实测证伪，见
        // docs/architecture.md（仓库根）§2.3：Google Maven 无 aarch64 版
        // aapt2，exec 四道关的后三关装机后无法补救）。
        //
        // 它是「设备从本地 feed 安装**已签名**内核」—— 职责是安装而非生产。
        // 因此所需能力为 program_update（任意设备都具备），而非 build_chain。
        //
        // 为什么保留 build_chain 令牌：它是「设备上有构建工具链」的能力声明，
        // 未来若真有了 arm64 工具链再置位即可，不需要改这里的代码路径。
        // 现在它**不会被** deviceCapabilities() 置位，所以依赖它的调用方
        // 仍会拿到 -32001 —— 这是正确的降级，因为我们确实没有那套工具链。
        // 内核**安装/升级的唯一入口**，且**只从 OTA 源**（ADR-0005）。
        //
        // 为什么只留一条：来源若有多条（本地 feed / 内置基线 / 远端），就会出现多份
        // "安装语义"，它们迟早不一致；更糟的是其中任何一条都能**绕过版本下限**。
        // 收敛成一条，安全性也一并收敛。
        //
        // 参数：{ checkOnly?: bool } —— true 只检查（不下载不安装），供"检查更新"用。
        // 返回值里 `available`（有新版本）与 `updated`（真装了）**必须分开**：
        //   "发现新版本但没装"和"装了"是两件事，调用方要能区分。
        //
        // **不自己重启**：重启会让调用方（面板/内核）半途消失、收不到回执。
        "build.programInstall" to MethodDef(listOf("program_update"), true) { p ->
            val checkOnly = p.optBoolean("checkOnly", false)
            val ota = ProgramOtaUpdater.checkAndUpdate(this, ProgramManager(this), checkOnly)
            JSONObject().apply {
                put("ok", if (checkOnly) ota.checked else ota.updated)
                put("checked", ota.checked)
                put("available", ota.available)
                put("updated", ota.updated)
                put("current", ota.current ?: JSONObject.NULL)
                put("version", ota.remote ?: JSONObject.NULL)
                put("source", ProgramInstaller.Source.OTA.label)
                put("detail", ota.detail)
                put("restartRequired", ota.updated)
            }
        },
        "build.programStatus" to MethodDef(listOf("program_update"), false) { _ ->
            val km = ProgramManager(this)
            val cur = km.currentVersion()
            JSONObject().apply {
                put("current", cur ?: JSONObject.NULL)
                put("installed", JSONArray(km.installedVersions()))
                put("integrity", JSONArray(km.integrityChecks()))
            }
        },
        // 保留旧名以兼容存量调用方，但指向内核安装（语义已修正）。
        "build.apk" to MethodDef(listOf("program_update"), true) { p ->
            throw BridgeError(
                CODE_INVALID_PARAM,
                "build.apk 已废弃：内置构建链经实测不可行（Google Maven 无 aarch64 版 aapt2，" +
                    "interp/架构/libc 三关装机后无法补救）。请改用 build.programInstall —— " +
                    "设备安装已签名内核，无需编译。详见 docs/architecture.md（仓库根）§2.2"
            )
        },
        "build.status" to MethodDef(listOf("program_update"), false) { _ ->
            val km = ProgramManager(this)
            JSONObject().apply {
                put("current", km.currentVersion() ?: JSONObject.NULL)
                put("installed", JSONArray(km.installedVersions()))
            }
        }
    )

    // ---- fs.* 辅助 ----

    private fun fileToJson(f: File): JSONObject = JSONObject().apply {
        put("name", f.name)
        put("path", f.absolutePath)
        put("directory", f.isDirectory)
        put("size", if (f.isDirectory) 0L else f.length())
        put("modified", f.lastModified())
        put("readable", f.canRead())
        put("writable", f.canWrite())
    }

    private fun requireReadableFile(path: String): File {
        if (path.isBlank()) throw BridgeError(CODE_INVALID_PARAM, "path 为空")
        val f = File(path)
        if (!f.exists()) throw BridgeError(CODE_INVALID_PARAM, "文件不存在: $path")
        if (f.isDirectory) throw BridgeError(CODE_INVALID_PARAM, "是目录而非文件: $path")
        if (!f.canRead()) throw BridgeError(CODE_INVALID_PARAM, "无读权限: $path")
        return f
    }

    private fun requireWritableFile(path: String): File {
        if (path.isBlank()) throw BridgeError(CODE_INVALID_PARAM, "path 为空")
        val f = File(path)
        if (f.exists() && f.isDirectory) throw BridgeError(CODE_INVALID_PARAM, "是目录而非文件: $path")
        val parent = f.parentFile
        if (parent != null && !parent.exists()) {
            // 允许自动建父目录（fs.write/fs.mkdir 的常见用法），但父目录必须可创建。
            if (!parent.mkdirs() && !parent.exists()) {
                throw BridgeError(CODE_INVALID_PARAM, "无法创建父目录: ${parent.absolutePath}")
            }
        }
        if (parent != null && !parent.canWrite()) {
            throw BridgeError(CODE_INVALID_PARAM, "父目录不可写: ${parent.absolutePath}")
        }
        return f
    }

    /**
     * 危险路径提示（**不拦截**，仅回传给调用方 + 审计）。
     *
     * 用户明确选择了「全放开」策略，故不设白名单。但这些路径写入的后果不可逆
     * （设备变砖 / 内核崩溃 / 系统不可启动），调用方至少应当在日志里看见风险。
     */
    private fun auditPathHint(path: String): String? {
        val p = path.trim()
        return when {
            p.startsWith("/dev/") || p == "/dev" ->
                "⚠ 写入 /dev 下的块设备/字符设备可能立即损坏设备数据"
            p.startsWith("/proc/") || p.startsWith("/sys/") ->
                "⚠ /proc 与 /sys 是内核接口，写入可能使系统立即不稳定或崩溃"
            p.startsWith("/system") || p.startsWith("/vendor") || p.startsWith("/boot") ->
                "⚠ 系统分区受 verified boot 保护，写入通常失败；强行修改可能导致设备无法启动"
            p == "/" -> "⚠ 根目录写入：请确认目标路径"
            else -> null
        }
    }

    /** POSIX 单引号包裹（args 拼进 shell 命令串时用，防参数注入）。 */
    private fun shellQuote(s: String): String = "'" + s.replace("'", "'\\''") + "'"

    /** 由 [OsHostService] 调用：停监听（不再是 Service 生命周期）。 */
    fun shutdown() {
        running = false
        try { server?.close() } catch (_: Throwable) {}
    }

    companion object {
        const val TAG = "CapabilityBroker"
        /** socket 名唯一事实源在 L-C/L-D 装配契约（GuestAdapter）：内核侧经
         *  LOBOS_BRIDGE_SOCKET 注入同一常量，两侧不许各自写字面量。 */
        const val SOCKET_NAME = GuestAdapter.BRIDGE_SOCKET
        const val CODE_CAPABILITY_MISSING = -32001
        const val CODE_INVALID_PARAM = -32602
        const val CODE_METHOD_NOT_FOUND = -32601
        /** 已声明但原生尚未落地的方法（诚实回答，绝不冒充成功）。 */
        const val CODE_NOT_IMPLEMENTED = -32002
        const val CODE_INTERNAL = -32603

        /** PackageInstaller 回传广播里携带的目标（apk 路径或包名），见 PackageInstallReceiver。 */
        const val EXTRA_PKG = "lobos_target"

        /** shell.exec 单次输出上限（防止超大输出撑爆 JSON-RPC 帧）。 */
        const val MAX_SHELL_OUTPUT = 256 * 1024

        /** fs.read 默认读取上限（64MB 硬顶）—— 与 JSON-RPC 帧模型匹配。 */
        const val DEFAULT_FS_MAX_BYTES = 8L * 1024 * 1024
        const val MAX_FS_BYTES = 64L * 1024 * 1024

        // 能力分组 -> 代表能力（用于握手时的 groups 交集）
        val GROUP_REQUIRED = mapOf(
            "bridge:app_control" to "base",
            "bridge:notification" to "base",
            "bridge:system" to "base",
            "bridge:ui_automation" to "accessibility",
            "bridge:shell" to "adb_shell",
            "bridge:storage" to "manage_external_storage",
            // build 组的代表能力改为 program_update（不再是 build_chain）。
            // 理由：该组现在的语义是「安装已签名内核」，而 build_chain 描述的
            // 「有编译工具链」已被实测证伪。若仍绑 build_chain，整组会因
            // 那个永不具备的能力而永远不可用 —— 这正是「代价极高的沉默失败」。
            "bridge:build" to "program_update"
        )
    }
}

data class MethodDef(
    val caps: List<String>,
    val audit: Boolean,
    val handle: (JSONObject) -> JSONObject
)

class BridgeError(val code: Int, message: String) : Exception(message)

private fun JSONArray.toList(): List<String> {
    val out = mutableListOf<String>()
    for (i in 0 until length()) out.add(getString(i))
    return out
}
