package lobos.runtime

import java.io.File
import lobos.os.RuntimeEnvironment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * console 启动计划（GuestAdapter）+ 共享树根语义（RuntimeEnvironment.treeRootEnv）的 golden 向量。
 *
 * 钉住的历史缺陷（架构收敛 C，真机侧只在此处可复现）：
 *   · 环境组装曾散在 ProcessBuilder 内联块里，PATH 被写两次、后写覆盖先写
 *     —— $PREFIX/bin 是否生效全凭运气；
 *   · TMPDIR / LOBOS_BRIDGE_SOCKET 与 engine 侧孪生管线各写各的，漂移成
 *     "只在真机复现"的静默断链；
 *   · NODE_PATH 两侧各只有一段，且第二段与 `npm -g` 的前缀指向不同目录
 *     —— 全局安装的共享模块永远 import 不到（债表 ENV-5）。
 *
 * 生产权威判定见 engine/test/boot-env-contract-test.js（跨语言解析这两个文件）；
 * 本测试负责另一半：装配**结果**逐键逐值正确。
 */
class GuestAdapterTest {

    private val filesDir = File("/data/user/0/lobos/files")
    private val cacheDir = File("/data/user/0/lobos/cache")
    private val nodeBin = File("/data/app/~~xx/pkg/lib/arm64-v8a/libnode.so")
    private val nodeBinDir = nodeBin.absoluteFile.parent
    private val nativeLibDir = "/data/app/~~xx/pkg/lib/arm64-v8a"
    private val programDir = File(filesDir, "programs/console/1.2.3")
    private val programEntry = File(programDir, "bin/panel")
    private val prefixRoot = File("/prefix")
    private val prefixBin = File("/prefix/bin")
    private val globalBin = NodeProvisioner.globalBin(filesDir)

    /** 启动链树根：带 LD_PRELOAD 垫片、不带 NODE_OPTIONS 垫片（后者按用例单独给）。 */
    private val root = RuntimeEnvironment.TreeRoot(
        home = filesDir, tmpDir = cacheDir, nodeBin = nodeBin, nativeLibDir = nativeLibDir,
        prefixRoot = prefixRoot, prefixBin = prefixBin, bashBin = File("/prefix/bin/bash"),
        posixShim = File(nativeLibDir, "liblobosposix.so"),
    )

    /** 探针树根：生产同款 —— 两片垫片都剥掉。 */
    private val bareRoot = root.copy(posixShim = null)

    private fun programInputs(
        bashBin: File? = File("/prefix/bin/bash"),
        npmEntry: File? = null,
        envShim: File? = null,
    ) = GuestAdapter.ProgramInputs(
        root = root.copy(bashBin = bashBin, envShim = envShim),
        programDir = programDir,
        programEntry = programEntry,
        uiDir = File(programDir, "ui/dist"),
        flockNative = File(nativeLibDir, "liblobosflock.so"),
        npmEntry = npmEntry,
    )

    // ── 命令形态 ──

    @Test fun 内核模式命令是_nodeBin_入口_daemon_且cwd是内核目录() {
        val plan = GuestAdapter.programPlan(programInputs(), "inherit")
        assertEquals(
            listOf(nodeBin.absolutePath, programEntry.absolutePath, "daemon"),
            plan.command,
        )
        assertEquals(programDir.absolutePath, plan.cwd.absolutePath)
    }

    @Test fun 探针模式命令带_3080_端口且cwd是filesDir() {
        val script = File("/data/local/tmp/server.js")
        val plan = GuestAdapter.probePlan(bareRoot, script, "inherit")
        assertEquals(
            listOf(nodeBin.absolutePath, script.absolutePath, "--port", "3080"),
            plan.command,
        )
        assertEquals(filesDir.absolutePath, plan.cwd.absolutePath)
    }

    // ── PATH 单点组装（旧缺陷：写两次互相覆盖）──

    @Test fun PATH以PREFIX_bin最前且nodeBinDir只出现一次() {
        // 故意把 nodeBinDir 也塞进继承路径：distinct 必须去重，否则就是老 bug 复发。
        val inherited = "/system/bin:$nodeBinDir"
        val plan = GuestAdapter.programPlan(programInputs(), inherited)
        val parts = plan.env.getValue("PATH").split(File.pathSeparator)
        assertEquals(prefixBin.absolutePath, parts.first())
        assertEquals("nodeBinDir 在 PATH 中出现次数", 1, parts.count { it == nodeBinDir })
        assertEquals("/system/bin", parts.last())
    }

    @Test fun PATH含npm全局bin且按此序排在继承段之前() {
        val parts = GuestAdapter.programPlan(programInputs(), "/system/bin").env.getValue("PATH")
            .split(File.pathSeparator)
        // ENV-4：`npm -g` 装完的 CLI 要在 PATH 里找得回 —— 缺这段装上了也用不了。
        assertEquals(
            listOf(prefixBin.absolutePath, nodeBinDir, globalBin.absolutePath, "/system/bin"),
            parts,
        )
    }

    @Test fun 探针模式的PATH与内核模式同源() {
        val plan = GuestAdapter.probePlan(bareRoot, File("/s.js"), "/system/bin")
        assertEquals(
            GuestAdapter.programPlan(programInputs(), "/system/bin").env.getValue("PATH"),
            plan.env.getValue("PATH"),
        )
    }

    // ── 树根共享环境（内核/探针/一次性进程同一份语义）──

    @Test fun HOME_TMPDIR_LD_LIBRARY_PATH_NODE_BIN_单源正确() {
        for (plan in listOf(
            GuestAdapter.programPlan(programInputs(), null),
            GuestAdapter.probePlan(bareRoot, File("/s.js"), null),
        )) {
            assertEquals(filesDir.absolutePath, plan.env.getValue("HOME"))
            // TMPDIR 必须 = cacheDir：boot.js 曾用 os.tmpdir() 独走过。
            assertEquals(cacheDir.absolutePath, plan.env.getValue("TMPDIR"))
            assertEquals(nativeLibDir, plan.env.getValue("LD_LIBRARY_PATH"))
            assertEquals(nodeBin.absolutePath, plan.env.getValue("NODE_BIN"))
        }
    }

    // ── console 专属申报 ──

    @Test fun LOBOS键全量注入且socket名与默认值逐字钉住() {
        val env = GuestAdapter.programPlan(programInputs(), null).env
        assertEquals("1", env.getValue("LOBOS_ANDROID"))
        assertEquals("android", env.getValue("LOBOS_PLATFORM"))
        assertEquals(filesDir.absolutePath, env.getValue("LOBOS_SUPERVISOR_HOME"))
        assertEquals(File(programDir, "ui/dist").absolutePath, env.getValue("LOBOS_UI_DIR"))
        // socket 名两侧（内核 client.js ⇄ CapabilityBroker）唯一事实源：
        // 改这个字面量必须同时改两处 —— 钉死它，防"默认值兜住"式静默断链复发。
        assertEquals("lobos_hostbridge", env.getValue("LOBOS_BRIDGE_SOCKET"))
        assertEquals("danger-full-access", env.getValue("LOBOS_PERMISSION_MODE"))
        assertEquals(File(nativeLibDir, "liblobosflock.so").absolutePath, env.getValue("LOBOS_FLOCK_NATIVE"))
        assertEquals(File(nativeLibDir, "liblobosposix.so").absolutePath, env.getValue("LD_PRELOAD"))
    }

    @Test fun NODE_PATH双段且第二段是npm全局前缀的node_modules() {
        val env = GuestAdapter.programPlan(programInputs(), null).env
        assertEquals(
            listOf(
                File(programDir, "node_modules"),
                NodeProvisioner.globalNodeModules(filesDir),
            ).joinToString(File.pathSeparator) { it.absolutePath },
            env.getValue("NODE_PATH"),
        )
    }

    @Test fun SHELL回落到_system_sh_仅在无bash时() {
        assertEquals("/system/bin/sh", GuestAdapter.programPlan(programInputs(bashBin = null), null).env.getValue("SHELL"))
        assertEquals(
            File("/prefix/bin/bash").absolutePath,
            GuestAdapter.programPlan(programInputs(bashBin = File("/prefix/bin/bash")), null).env.getValue("SHELL"),
        )
    }

    @Test fun LOBOS_NPM_ENTRY只在提供npmEntry时出现() {
        assertFalse(GuestAdapter.programPlan(programInputs(npmEntry = null), null).env.containsKey("LOBOS_NPM_ENTRY"))
        val npm = File("/prefix/lib/node_modules/npm/bin/npm-cli.js")
        assertEquals(
            npm.absolutePath,
            GuestAdapter.programPlan(programInputs(npmEntry = npm), null).env.getValue("LOBOS_NPM_ENTRY"),
        )
    }

    @Test fun NODE_OPTIONS只在提供envShim时出现() {
        assertFalse(GuestAdapter.programPlan(programInputs(envShim = null), null).env.containsKey("NODE_OPTIONS"))
        val shim = File("/prefix/lib/android-env-shim.cjs")
        assertEquals(
            "--require " + shim.absolutePath,
            GuestAdapter.programPlan(programInputs(envShim = shim), null).env.getValue("NODE_OPTIONS"),
        )
    }

    @Test fun 探针模式绝不注入LOBOS键与垫片() {
        // 探针先于内核存在：它若带上 LOBOS_* 或垫片，就分不清是环境层还是适配层在起作用。
        val env = GuestAdapter.probePlan(bareRoot, File("/s.js"), null).env
        assertTrue("探针 env 出现了 LOBOS_*: " + env.keys.filter { it.startsWith("LOBOS_") },
            env.keys.none { it.startsWith("LOBOS_") })
        assertFalse(env.containsKey("LD_PRELOAD"))
        assertFalse(env.containsKey("NODE_OPTIONS"))
        // 夹具机器上 CA 目录/bundle 不在场 ⇒ 信任根三键不入集合（真机读数在 V-0c）。
        assertEquals(
            setOf("HOME", "TMPDIR", "LANG", "LD_LIBRARY_PATH", "NODE_BIN", "PATH", "SHELL", "NODE_PATH"),
            env.keys,
        )
    }

    @Test fun 继承路径为空时PATH不发散() {
        val env = GuestAdapter.programPlan(programInputs(), null).env
        assertEquals(
            listOf(prefixBin.absolutePath, nodeBinDir, globalBin.absolutePath),
            env.getValue("PATH").split(File.pathSeparator),
        )
        // 空串也算"无继承"：joinPath 过滤空段，不能留下 "::" 尾巴。
        val env2 = GuestAdapter.programPlan(programInputs(), "").env
        assertEquals(env.getValue("PATH"), env2.getValue("PATH"))
    }
}
