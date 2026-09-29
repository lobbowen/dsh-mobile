package lobos.runtime

import lobos.os.RuntimeEnvironment
import java.io.File

/**
 * console（内核 Program）的**启动计划**：command/cwd + 这颗 Program 特有的申报。
 *
 * 分层语义（ADR-0006 / ARCHITECTURE §1）：
 *  - 「环境怎么起来」（node 二进制、HOME/TMPDIR/PATH/信任根/垫片）是**每个进程树根共享**的
 *    OS 事实，唯一生产点在 [RuntimeEnvironment.treeRootEnv]，此处只调用、不再拼一遍。
 *  - 「guest 缺什么安卓语境」里只有 `LOBOS_*` 申报是 console 专属，留在本对象。
 *  - 此前两个角色长在同一份 `baseEnv`+`programPlan` 里 ⇒ 环境实际依附于 console 这颗 Program，
 *    其它树根（校验器、ADB 客户端、探针）各抄一份最小 env，谁都没拿到 LD_PRELOAD 与信任根
 *    （债表 ENV-2）。搬家由 `boot-env-contract` 门禁钉住。
 *
 * 装配产出的 env 会被 spawn 侧**整体替换**继承环境（`InstanceHost`：先 clear 再 putAll），
 * 所以这里是全部环境事实，不存在"第二处 apply 悄悄覆盖"的暗通道。
 */
object GuestAdapter {

    // 动本文件（container/app/**）必须同批 bump 根 version.json 的 shell.versionCode
    // （docs/runbook/release.md §2）—— 否则 fast-apk 的发布步骤按「同版本重发」判红。

    /** 内核模式的全部输入。root 由 `InstanceHost` 现算（启动链上的树根要带垫片）。 */
    data class ProgramInputs(
        val root: RuntimeEnvironment.TreeRoot,
        val programDir: File,
        val programEntry: File,
        /** OTA 包的控制面板目录（<program>/ui/dist，见 program-bundle.js 的保留注）。 */
        val uiDir: File,
        /** "声明即可、不要求此刻存在"的 L-D 垫片（缺席 ⇒ guest 侧逐字回退）。 */
        val flockNative: File,
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
     * 探针的最小装配：只跑 server.js，验 node 能否 exec + listen。
     *
     * 调用方只有 `InstanceHost.runNativeProbe`（诊断页显式驱动）。启动链**不许**用它：
     * 探针不承载控制面，点亮 3080 不等于有运行时在服务（真机 2026-09-28 定罪 D15）。
     * 树根刻意不带 posixShim/envShim —— 垫片区里的 linker 问题会被注入掩盖掉，
     * 探针要读的是裸 node（D15 的教训：探针读数不能冒充运行态）。
     */
    fun probePlan(root: RuntimeEnvironment.TreeRoot, script: File, inheritedPath: String?): BootPlan = BootPlan(
        command = listOf(root.nodeBin.absolutePath, script.absolutePath, "--port", PROBE_PORT.toString()),
        cwd = root.home,
        // 探针只要 [root] 的共享语义，**不追加 NODE_PATH**：先前这里补了一段 `filesDir/node_modules`，
        // 而全仓没有任何代码创建那个目录 —— 与 ENV-5 定罪的旧第二段同一形状（指向不存在处的路径）。
        // server.js 只 require 内置模块，模块解析路径对它不构成输入。
        env = RuntimeEnvironment.treeRootEnv(root, inheritedPath),
    )

    /** 内核模式：共享树根语义 + console 的 `LOBOS_*` 申报。 */
    fun programPlan(i: ProgramInputs, inheritedPath: String?): BootPlan = BootPlan(
        command = listOf(i.root.nodeBin.absolutePath, i.programEntry.absolutePath, "daemon"),
        cwd = i.programDir,
        env = buildMap {
            putAll(RuntimeEnvironment.treeRootEnv(i.root, inheritedPath))
            // 内核依赖在 <program>/node_modules；第二段必须是 `npm -g` 真的往里装的那个目录
            // （同一事实源 NodeProvisioner.globalNodeModules），旧实现指 filesDir/node_modules
            // ⇒ 全局安装的共享模块永远 import 不到（债表 ENV-5）。
            put(
                "NODE_PATH",
                listOf(
                    File(i.programDir, "node_modules"),
                    NodeProvisioner.globalNodeModules(i.root.home),
                ).joinToString(File.pathSeparator) { it.absolutePath }
            )
            // ---- console 专属申报（每一项都是"guest 在安卓上缺的那块语境"） ----
            put("LOBOS_ANDROID", "1")
            put("LOBOS_PLATFORM", "android")
            put("LOBOS_SUPERVISOR_HOME", i.root.home.absolutePath)
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
        },
    )
}
