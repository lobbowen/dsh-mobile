package io.github.lobbowen.dshmobile.runtime

import java.io.File

/**
 * L-C（运行时环境层）与 L-D（生态适配层）的**装配契约** —— 纯逻辑，不依赖 Android。
 *
 * 分层语义（ADR-0006 / ARCHITECTURE §1）：
 *  - L-C 只回答"环境怎么起来"：node 二进制、解释哪个入口、基础环境变量。
 *  - L-D 只回答"guest 缺什么安卓语境"：DSH_* 注入、POSIX 垫片（flock/link）、
 *    $PREFIX 可执行名映射、权限模式旋钮。
 *  - **本对象是这两层启动计划（探针/内核，command/cwd/env）的唯一装配点**。此前它们散在
 *    ProcessBuilder 的 `.apply{}` 表达式里（PATH 被写两次、后写覆盖先写、provision
 *    副作用夹在 map 中间），又与 engine 侧旧 boot.js 的孪生装配漂移（TMPDIR/BRIDGE_SOCKET
 *    两边不一致）。漂移的根治不是同步注释，而是生产装配只剩一处、另一处物理迁入
 *    test/boot-fixture.js 降级为测试夹具，并被 golden 向量钉住（GuestAdapterTest + boot-env-contract-test）。
 *    一次性工具进程（NodeKernelVerifier、AdbClientRunner）不属于启动计划：它们
 *    各设自己的最小 env（HOME/TMPDIR/LD_LIBRARY_PATH），不注入 DSH_* 适配面。
 *
 * 新增运行时（Python/Go…）时的规矩：再写一个 `<Guest>Adapter` 并注册进
 * ContainerSupervisor 的环境表，**禁止**在 spawn 调用点内联组装环境。
 */
object GuestAdapter {

    /** 两种模式共享的 L-C 输入。nativeLibDir 必须来自 NativePreparer.libSearchPath，
     *  不要在别处再推导一次（linker 搜索路径的唯一正确取值 = applicationInfo.nativeLibraryDir）。 */
    data class BaseInputs(
        val filesDir: File,
        val cacheDir: File,
        val nodeBin: File,
        val nativeLibDir: String,
    )

    /** 内核模式的全量输入（L-C + L-D）。 */
    data class KernelInputs(
        val base: BaseInputs,
        val kernelDir: File,
        val kernelEntry: File,
        /** OTA 包的控制面板目录（<kernel>/ui/dist，见 kernel-bundle.js 的保留注）。 */
        val uiDir: File,
        /** 以下均为"声明即可、不要求此刻存在"的 L-D 垫片（缺席 ⇒ guest 侧逐字回退）。 */
        val flockNative: File,
        val posixShim: File,
        val prefixRoot: File,
        val prefixBin: File,
        val bashBin: File?,
        val npmEntry: File?,
    )

    /** 最终交给 ProcessBuilder 的完整指令。command/cwd/env 一起进 golden 向量。 */
    data class BootPlan(
        val command: List<String>,
        val cwd: File,
        val env: Map<String, String>,
    )

    /** 内核控制面端口（supervisor API）；与内核 src/platform/config.js 的 apiPort 默认值一致。 */
    const val KERNEL_CONTROL_PORT = 36360

    /** 内置探针 server.js 端口（首启验证 Node 原生链路；不是控制面）。 */
    const val PROBE_PORT = 3080

    /** HostBridge 抽象命名空间 socket 名；与 HostBridgeService.SOCKET_NAME 一致。 */
    const val BRIDGE_SOCKET = "dsh_hostbridge"

    /** 探针模式（无内核包）的最小装配：只跑 server.js，验证原生 exec 链路。 */
    fun probePlan(base: BaseInputs, script: File, inheritedPath: String?): BootPlan = BootPlan(
        command = listOf(base.nodeBin.absolutePath, script.absolutePath, "--port", PROBE_PORT.toString()),
        cwd = base.filesDir,
        env = baseEnv(base, inheritedPath) + mapOf(
            "NODE_PATH" to File(base.filesDir, "node_modules").absolutePath,
        ),
    )

    /** 内核模式的完整装配（L-C + L-D 全量）。 */
    fun kernelPlan(i: KernelInputs, inheritedPath: String?): BootPlan = BootPlan(
        command = listOf(i.base.nodeBin.absolutePath, i.kernelEntry.absolutePath, "daemon"),
        cwd = i.kernelDir,
        env = buildMap {
            putAll(baseEnv(i.base, inheritedPath))
            // 内核依赖在 <kernel>/node_modules；filesDir 下的留给 npm 安装的共享模块。
            put(
                "NODE_PATH",
                listOf(File(i.kernelDir, "node_modules"), File(i.base.filesDir, "node_modules"))
                    .joinToString(File.pathSeparator) { it.absolutePath }
            )
            // ---- L-D：生态适配层（每一项都是"guest 在安卓上缺的那块"） ----
            put("DSH_ANDROID", "1")
            put("DSH_PLATFORM", "android")
            put("DSH_SUPERVISOR_HOME", i.base.filesDir.absolutePath)
            put("DSH_UI_DIR", i.uiDir.absolutePath)
            // socket 名必须显式注入：boot.js 孪生管线曾只在一侧有、另一侧靠内核默认值
            // 兜住 —— 默认值一改就是静默断链。
            put("DSH_BRIDGE_SOCKET", BRIDGE_SOCKET)
            // 权限模式：Android untrusted_app 无用户态沙箱原语（bwrap/landlock/seatbelt
            // 全被 SELinux 域拒），dsh 默认 workspace-write 会让 bash/PTC 每条命令
            // fail-closed。danger-full-access = 放弃 dsh 层二次隔离、以外层 SELinux
            // 为 confinement（产品拍板 2026-09-23）。
            put("DSH_PERMISSION_MODE", "danger-full-access")
            // flock(2) 原生绑定（fast-apk CI 现编进 jniLibs，见 native/flock/PROVENANCE.md）。
            // 文件缺席时垫片 dlopen 失败 ⇒ 逐字回退 vendor 原始语义，故只是声明、不要求存在。
            put("DSH_FLOCK_NATIVE", i.flockNative.absolutePath)
            // link(2) 用户态替代：经 LD_PRELOAD 注入 DSH 进程，见 native/posix/。
            put("LD_PRELOAD", i.posixShim.absolutePath)
            // $PREFIX：把 nativeLibraryDir 的 lib*.so 以真名复制为可执行文件，
            // 供 DSH 按名字解析（bash/rg），不改 DSH 内部路径（ADR-0001）。
            // PATH 单点组装：$PREFIX/bin 最前，其次 node 目录 —— 旧实现同一键写两次
            // 互相覆盖，哪侧生效全凭运气。注意：boot-env-contract 门禁会连注释一起按
            // 正则计数本文件的 PATH 装配字面量，注释里不要再写这类字面量。
            put("PATH", joinPath(i.prefixBin.absolutePath, i.base.nodeBin.parentFile!!.absolutePath, inheritedPath))
            put("SHELL", i.bashBin?.absolutePath ?: "/system/bin/sh")
            i.npmEntry?.let { put("DSH_NPM_ENTRY", it.absolutePath) }
        },
    )

    /** 两种模式共享的 L-C 基础环境。 */
    private fun baseEnv(base: BaseInputs, inheritedPath: String?): Map<String, String> = mapOf(
        // Node 在安卓沙箱里需要 HOME/TMPDIR，否则部分模块报错。
        // TMPDIR 单源（cacheDir）：boot.js 曾用 os.tmpdir() —— 两侧必须同一事实，
        // 否则"tmp 写入被 SELinux 拒"这类故障只在一侧复现。
        "HOME" to base.filesDir.absolutePath,
        "TMPDIR" to base.cacheDir.absolutePath,
        // 必需项，理由见 NativePreparer.probe() 注释；漏了 node 在动态链接期直接失败。
        "LD_LIBRARY_PATH" to base.nativeLibDir,
        "NODE_BIN" to base.nodeBin.absolutePath,
        "PATH" to joinPath(base.nodeBin.parentFile!!.absolutePath, inheritedPath),
    )

    /** 按**路径段**去重（先到先得）：整串 distinct 挡不住"继承 PATH 已含 node 目录"
     *  导致的重复段 —— 旧 PATH 双写的病根就是同一目录经不同拼接路径混进来。 */
    private fun joinPath(vararg parts: String?): String =
        parts.filterNotNull()
            .flatMap { it.split(File.pathSeparator) }
            .filter { it.isNotEmpty() }
            .distinct()
            .joinToString(File.pathSeparator)
}
