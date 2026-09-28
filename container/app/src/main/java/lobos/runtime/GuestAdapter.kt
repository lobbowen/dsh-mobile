package lobos.runtime

import java.io.File

/**
 * L-C（运行时环境层）与 L-D（生态适配层）的**装配契约** —— 纯逻辑，不依赖 Android。
 *
 * 分层语义（ADR-0006 / ARCHITECTURE §1）：
 *  - L-C 只回答"环境怎么起来"：node 二进制、解释哪个入口、基础环境变量。
 *  - L-D 只回答"guest 缺什么安卓语境"：LOBOS_* 注入、POSIX 垫片（flock/link）、
 *    $PREFIX 可执行名映射、权限模式旋钮。
 *  - **本对象是这两层装配（内核启动计划 + 探针诊断计划，command/cwd/env）的唯一生产点**。此前它们散在
 *    ProcessBuilder 的 `.apply{}` 表达式里（PATH 被写两次、后写覆盖先写、provision
 *    副作用夹在 map 中间），又与 engine 侧旧 boot.js 的孪生装配漂移（TMPDIR/BRIDGE_SOCKET
 *    两边不一致）。漂移的根治不是同步注释，而是生产装配只剩一处、另一处物理迁入
 *    test/boot-fixture.js 降级为测试夹具，并被 golden 向量钉住（GuestAdapterTest + boot-env-contract-test）。
 *    一次性工具进程（ProgramVerifier、AdbClientRunner）不属于启动计划：它们
 *    各设自己的最小 env（HOME/TMPDIR/LD_LIBRARY_PATH），不注入 LOBOS_* 适配面。
 *
 * 新增运行时（Python/Go…）时的规矩：再写一个 `<Guest>Adapter` 并注册进
 * OsHostService 的环境表，**禁止**在 spawn 调用点内联组装环境。
 */
object GuestAdapter {

    // 动本文件（container/app/**）必须同批 bump 根 version.json 的 shell.versionCode
    // （docs/runbook/release.md §2）—— 否则 fast-apk 的发布步骤按「同版本重发」判红。

    /** 两种模式共享的 L-C 输入。nativeLibDir 必须来自 NativePreparer.libSearchPath，
     *  不要在别处再推导一次（linker 搜索路径的唯一正确取值 = applicationInfo.nativeLibraryDir）。 */
    data class BaseInputs(
        val filesDir: File,
        val cacheDir: File,
        val nodeBin: File,
        val nativeLibDir: String,
    )

    /** 内核模式的全量输入（L-C + L-D）。 */
    data class ProgramInputs(
        val base: BaseInputs,
        val programDir: File,
        val programEntry: File,
        /** OTA 包的控制面板目录（<program>/ui/dist，见 program-bundle.js 的保留注）。 */
        val uiDir: File,
        /** 以下均为"声明即可、不要求此刻存在"的 L-D 垫片（缺席 ⇒ guest 侧逐字回退）。 */
        val flockNative: File,
        val posixShim: File,
        val prefixRoot: File,
        val prefixBin: File,
        val bashBin: File?,
        val npmEntry: File?,
        /** D1 安卓语义垫片（os.cpus 等）；null = 不注入 NODE_OPTIONS —— 缺件绝不许让 node 起不来。 */
        val envShim: File? = null,
    )

    /** 最终交给 ProcessBuilder 的完整指令。command/cwd/env 一起进 golden 向量。 */
    data class BootPlan(
        val command: List<String>,
        val cwd: File,
        val env: Map<String, String>,
    )

    /** 内核控制面端口（supervisor API）；与内核 src/platform/config.js 的 apiPort 默认值一致。 */
    const val CONSOLE_PORT = 36360

    /** 内置探针 server.js 端口。**永不参与启动判定**：控制面只有 [CONSOLE_PORT] 这一个。 */
    const val PROBE_PORT = 3080

    /** HostBridge 抽象命名空间 socket 名；与 CapabilityBroker.SOCKET_NAME 一致。 */
    const val BRIDGE_SOCKET = "lobos_hostbridge"

    /**
     * 探针的最小装配（L-C，不含任何 L-D 旋钮）：只跑 server.js，验 node 能否 exec + listen。
     *
     * 调用方只有 `InstanceHost.runNativeProbe`（诊断页显式驱动）。启动链**不许**用它：
     * 探针不承载控制面，点亮 3080 不等于有运行时在服务（真机 2026-09-28 定罪 D15）。
     */
    fun probePlan(base: BaseInputs, script: File, inheritedPath: String?): BootPlan = BootPlan(
        command = listOf(base.nodeBin.absolutePath, script.absolutePath, "--port", PROBE_PORT.toString()),
        cwd = base.filesDir,
        env = baseEnv(base, inheritedPath) + mapOf(
            "NODE_PATH" to File(base.filesDir, "node_modules").absolutePath,
        ),
    )

    /** 内核模式的完整装配（L-C + L-D 全量）。 */
    fun programPlan(i: ProgramInputs, inheritedPath: String?): BootPlan = BootPlan(
        command = listOf(i.base.nodeBin.absolutePath, i.programEntry.absolutePath, "daemon"),
        cwd = i.programDir,
        env = buildMap {
            putAll(baseEnv(i.base, inheritedPath))
            // 内核依赖在 <program>/node_modules；filesDir 下的留给 npm 安装的共享模块。
            put(
                "NODE_PATH",
                listOf(File(i.programDir, "node_modules"), File(i.base.filesDir, "node_modules"))
                    .joinToString(File.pathSeparator) { it.absolutePath }
            )
            // ---- L-D：生态适配层（每一项都是"guest 在安卓上缺的那块"） ----
            put("LOBOS_ANDROID", "1")
            put("LOBOS_PLATFORM", "android")
            put("LOBOS_SUPERVISOR_HOME", i.base.filesDir.absolutePath)
            put("LOBOS_UI_DIR", i.uiDir.absolutePath)
            // socket 名必须显式注入：boot.js 孪生管线曾只在一侧有、另一侧靠内核默认值
            // 兜住 —— 默认值一改就是静默断链。
            put("LOBOS_BRIDGE_SOCKET", BRIDGE_SOCKET)
            // 权限模式：Android untrusted_app 无用户态沙箱原语（bwrap/landlock/seatbelt
            // 全被 SELinux 域拒），默认 workspace-write 会让 bash/PTC 每条命令
            // fail-closed。danger-full-access = 放弃载荷层二次隔离、以外层 SELinux
            // 为 confinement（产品拍板 2026-09-23）。
            put("LOBOS_PERMISSION_MODE", "danger-full-access")
            // flock(2) 原生绑定（fast-apk CI 现编进 jniLibs，见 docs/components/native.md）。
            // 文件缺席时垫片 dlopen 失败 ⇒ 逐字回退 vendor 原始语义，故只是声明、不要求存在。
            put("LOBOS_FLOCK_NATIVE", i.flockNative.absolutePath)
            // link(2) 用户态替代：经 LD_PRELOAD 注入子进程，见 native/d1/。
            put("LD_PRELOAD", i.posixShim.absolutePath)
            // D1：/tmp 语义兑现 —— 安卓根只读，硬编码 /tmp 的脚本必失败；liblobosposix 的
            // open/openat 把 /tmp 前缀重写到 $TMPDIR（见 container/native/d1/open-fallback.c）。
            // 默认生效、无开关：载荷起子进程时会剥掉 `LOBOS_*`（真机定罪），开关到不了干活
            // 的进程；生效与否由 liblobosposix 看 TMPDIR 是否绝对路径决定。
            // $PREFIX：nativeLibraryDir 的原生件在这里以**真名**落地（bash/rg 是复制，
            // node 是指向 libnode.so 的链接 —— 判据见 PrefixProvisioner.linkNode），
            // 供载荷按名字解析，不改载荷内部路径（ADR-0001）。
            // PATH 单点组装：$PREFIX/bin 最前，其次 node 目录 —— 旧实现同一键写两次
            // 互相覆盖，哪侧生效全凭运气。注意：boot-env-contract 门禁会连注释一起按
            // 正则计数本文件的 PATH 装配字面量，注释里不要再写这类字面量。
            put("PATH", joinPath(i.prefixBin.absolutePath, i.base.nodeBin.parentFile!!.absolutePath, inheritedPath))
                // https 的信任根：安卓系统 CA 的落点**随版本变**（API 34+ 起在 conscrypt APEX）。
                // 只传当前存在的那几个目录（OpenSSL 的 SSL_CERT_DIR 接受冒号列表）——
                // 写死单个路径必有一头 TLS 全灭（真机实测 API 37：git https 报 unable to get local issuer）。
                val caDirs = listOf("/apex/com.android.conscrypt/cacerts", "/system/etc/security/cacerts", "/data/misc/keychain/cacerts-added")
                    .filter { java.io.File(it).isDirectory }
                if (caDirs.isNotEmpty()) put("SSL_CERT_DIR", caDirs.joinToString(":"))
                // 信任根随产品走（首选）：$PREFIX/etc/ca-bundle.pem 由 PrefixProvisioner 从 assets 播下。
                //   libcurl 认 CURL_CA_BUNDLE、OpenSSL 认 SSL_CERT_FILE —— 两者都设，谁被先读都不失效；
                //   文件不在时上面那行 SSL_CERT_DIR 仍作兜底（系统 CA 在 app 域多半验不过，真机实证）。
                val caBundle = java.io.File(java.io.File(java.io.File(i.base.filesDir, "usr"), "etc"), "ca-bundle.pem")
                if (caBundle.isFile) {
                    put("SSL_CERT_FILE", caBundle.absolutePath)
                    put("CURL_CA_BUNDLE", caBundle.absolutePath)
                    // git 单独再来一个键：件里的 libcurl 当初编译时带了 --with-ca-path（指向系统信任库），
                    //   而 libcurl 一旦**显式**设了自己的 CA 路径，就不再读 CURL_CA_BUNDLE、也不走 OpenSSL 的
                    //   SSL_CERT_FILE 默认路径。真机实证：只设前两个键仍报 unable to get local issuer；
                    //   GIT_SSL_CAINFO 指到同一份 bundle 立刻通（637ms 拿到 HTTP 层响应）。
                    put("GIT_SSL_CAINFO", caBundle.absolutePath)
                }
            put("SHELL", i.bashBin?.absolutePath ?: "/system/bin/sh")
            i.npmEntry?.let { put("LOBOS_NPM_ENTRY", it.absolutePath) }
            // D1 Linux 语义：安卓取不到 cpu 信息（os.cpus() 空），由预载垫片在**空**时用
            // availableParallelism() 合成。只在垫片真在场时注入 NODE_OPTIONS。
            i.envShim?.let { put("NODE_OPTIONS", "--require " + it.absolutePath) }
        },
    )

    /** 两种模式共享的 L-C 基础环境。 */
    private fun baseEnv(base: BaseInputs, inheritedPath: String?): Map<String, String> = mapOf(
        // Node 在安卓沙箱里需要 HOME/TMPDIR，否则部分模块报错。
        // TMPDIR 单源（cacheDir）：boot.js 曾用 os.tmpdir() —— 两侧必须同一事实，
        // 否则"tmp 写入被 SELinux 拒"这类故障只在一侧复现。
        "HOME" to base.filesDir.absolutePath,
        "TMPDIR" to base.cacheDir.absolutePath,
        // Linux 语义（D1）：安卓/bionic 下 LANG/LC_* 全空，排序与字符类按 C locale 走，
        // 多字节语义与预期不符（环境报告 P3-1）。C.UTF-8 是 bionic 认得的 UTF-8 名字。
        // 只设 LANG、不设 LC_ALL —— 留出逐类覆盖的余地，也不覆盖调用方的显式选择。
        "LANG" to "C.UTF-8",
        // 只服务 $PREFIX 下尚无 RUNPATH 的工具；libnode 的依赖由二进制的
        // DT_RUNPATH=$ORIGIN 负责（见 docs/architecture.md 第 3 节），这些工具按同一判据
        // 重编之后本键即可删除。
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
