package io.github.lobbowen.dshmobile.runtime

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * L-C/L-D 装配契约（GuestAdapter）的 golden 向量。
 *
 * 钉住的历史缺陷（架构收敛 C，真机侧只在此处可复现）：
 *   · 环境组装曾散在 ProcessBuilder 内联块里，PATH 被写两次、后写覆盖先写
 *     —— $PREFIX/bin 是否生效全凭运气；
 *   · TMPDIR / DSH_BRIDGE_SOCKET 与 engine 侧孪生管线各写各的，漂移成
 *     "只在真机复现"的静默断链；
 *   · NODE_PATH 两侧各只有一段，内核自带模块与 npm 共享模块永远缺一侧。
 *
 * 生产权威判定见 engine/test/boot-env-contract-test.js（跨语言解析本文件）；
 * 本测试负责另一半：装配**结果**逐键逐值正确。
 */
class GuestAdapterTest {

    private val filesDir = File("/data/user/0/io.github.lobbowen.dshmobile/files")
    private val cacheDir = File("/data/user/0/io.github.lobbowen.dshmobile/cache")
    private val nodeBin = File("/data/app/~~xx/pkg/lib/arm64-v8a/libnode.so")
    private val nodeBinDir = nodeBin.absoluteFile.parent
    private val nativeLibDir = "/data/app/~~xx/pkg/lib/arm64-v8a"
    private val kernelDir = File(filesDir, "kernel/1.2.3")
    private val kernelEntry = File(kernelDir, "bin/dsh-supervisor")

    private val base = GuestAdapter.BaseInputs(
        filesDir = filesDir, cacheDir = cacheDir, nodeBin = nodeBin, nativeLibDir = nativeLibDir,
    )

    private fun kernelInputs(
        bashBin: File? = File("/prefix/bin/bash"),
        npmEntry: File? = null,
    ) = GuestAdapter.KernelInputs(
        base = base,
        kernelDir = kernelDir,
        kernelEntry = kernelEntry,
        uiDir = File(kernelDir, "ui/dist"),
        flockNative = File(nativeLibDir, "libdshflock.so"),
        posixShim = File(nativeLibDir, "libdshposix.so"),
        prefixRoot = File("/prefix"),
        prefixBin = File("/prefix/bin"),
        bashBin = bashBin,
        npmEntry = npmEntry,
    )

    // ── 命令形态 ──

    @Test fun 内核模式命令是_nodeBin_入口_daemon_且cwd是内核目录() {
        val plan = GuestAdapter.kernelPlan(kernelInputs(), "inherit")
        assertEquals(
            listOf(nodeBin.absolutePath, kernelEntry.absolutePath, "daemon"),
            plan.command,
        )
        assertEquals(kernelDir.absolutePath, plan.cwd.absolutePath)
    }

    @Test fun 探针模式命令带_3080_端口且cwd是filesDir() {
        val script = File("/data/local/tmp/server.js")
        val plan = GuestAdapter.probePlan(base, script, "inherit")
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
        val plan = GuestAdapter.kernelPlan(kernelInputs(), inherited)
        val parts = plan.env.getValue("PATH").split(File.pathSeparator)
        assertEquals("/prefix/bin", parts.first())
        assertEquals("nodeBinDir 在 PATH 中出现次数", 1, parts.count { it == nodeBinDir })
        assertEquals("/system/bin", parts.last())
    }

    @Test fun PATH在探针模式下以nodeBinDir开头() {
        val plan = GuestAdapter.probePlan(base, File("/s.js"), "/system/bin")
        val parts = plan.env.getValue("PATH").split(File.pathSeparator)
        assertEquals(nodeBinDir, parts.first())
        assertEquals(listOf(nodeBinDir, "/system/bin"), parts)
    }

    // ── L-C 基础环境（两种模式共享）──

    @Test fun HOME_TMPDIR_LD_LIBRARY_PATH_NODE_BIN_单源正确() {
        for (plan in listOf(
            GuestAdapter.kernelPlan(kernelInputs(), null),
            GuestAdapter.probePlan(base, File("/s.js"), null),
        )) {
            assertEquals(filesDir.absolutePath, plan.env.getValue("HOME"))
            // TMPDIR 必须 = cacheDir：boot.js 曾用 os.tmpdir() 独走过。
            assertEquals(cacheDir.absolutePath, plan.env.getValue("TMPDIR"))
            assertEquals(nativeLibDir, plan.env.getValue("LD_LIBRARY_PATH"))
            assertEquals(nodeBin.absolutePath, plan.env.getValue("NODE_BIN"))
        }
    }

    // ── L-D 生态适配（仅内核模式）──

    @Test fun DSH键全量注入且socket名与默认值逐字钉住() {
        val env = GuestAdapter.kernelPlan(kernelInputs(), null).env
        assertEquals("1", env.getValue("DSH_ANDROID"))
        assertEquals("android", env.getValue("DSH_PLATFORM"))
        assertEquals(filesDir.absolutePath, env.getValue("DSH_SUPERVISOR_HOME"))
        assertEquals(File(kernelDir, "ui/dist").absolutePath, env.getValue("DSH_UI_DIR"))
        // socket 名两侧（内核 client.js ⇄ HostBridgeService）唯一事实源：
        // 改这个字面量必须同时改两处 —— 钉死它，防"默认值兜住"式静默断链复发。
        assertEquals("dsh_hostbridge", env.getValue("DSH_BRIDGE_SOCKET"))
        assertEquals("danger-full-access", env.getValue("DSH_PERMISSION_MODE"))
        assertEquals(File(nativeLibDir, "libdshflock.so").absolutePath, env.getValue("DSH_FLOCK_NATIVE"))
        assertEquals(File(nativeLibDir, "libdshposix.so").absolutePath, env.getValue("LD_PRELOAD"))
    }

    @Test fun NODE_PATH双段且内核自带在前() {
        val env = GuestAdapter.kernelPlan(kernelInputs(), null).env
        assertEquals(
            listOf(File(kernelDir, "node_modules"), File(filesDir, "node_modules"))
                .joinToString(File.pathSeparator) { it.absolutePath },
            env.getValue("NODE_PATH"),
        )
    }

    @Test fun SHELL回落到_system_sh_仅在无bash时() {
        assertEquals("/system/bin/sh", GuestAdapter.kernelPlan(kernelInputs(bashBin = null), null).env.getValue("SHELL"))
        assertEquals(
            File("/prefix/bin/bash").absolutePath,
            GuestAdapter.kernelPlan(kernelInputs(bashBin = File("/prefix/bin/bash")), null).env.getValue("SHELL"),
        )
    }

    @Test fun DSH_NPM_ENTRY只在提供npmEntry时出现() {
        assertFalse(GuestAdapter.kernelPlan(kernelInputs(npmEntry = null), null).env.containsKey("DSH_NPM_ENTRY"))
        val npm = File("/prefix/lib/node_modules/npm/bin/npm-cli.js")
        assertEquals(
            npm.absolutePath,
            GuestAdapter.kernelPlan(kernelInputs(npmEntry = npm), null).env.getValue("DSH_NPM_ENTRY"),
        )
    }

    @Test fun 探针模式绝不注入DSH键() {
        // 探针先于内核存在：它若带上 DSH_*，就分不清是环境层还是适配层在起作用。
        val env = GuestAdapter.probePlan(base, File("/s.js"), null).env
        assertTrue("探针 env 出现了 DSH_*: " + env.keys.filter { it.startsWith("DSH_") },
            env.keys.none { it.startsWith("DSH_") })
        assertEquals(setOf("HOME", "TMPDIR", "LD_LIBRARY_PATH", "NODE_BIN", "PATH", "NODE_PATH"), env.keys)
    }

    @Test fun 继承路径为空时PATH不发散() {
        val env = GuestAdapter.kernelPlan(kernelInputs(), null).env
        assertEquals(listOf("/prefix/bin", nodeBinDir), env.getValue("PATH").split(File.pathSeparator))
        // 空串也算"无继承"：joinPath 过滤空段，不能留下 "::" 尾巴。
        val env2 = GuestAdapter.kernelPlan(kernelInputs(), "").env
        assertEquals(env.getValue("PATH"), env2.getValue("PATH"))
    }
}
