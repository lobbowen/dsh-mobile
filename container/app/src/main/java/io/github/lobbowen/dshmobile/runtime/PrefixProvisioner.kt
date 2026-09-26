package io.github.lobbowen.dshmobile.runtime

import android.content.Context
import android.system.Os
import java.io.File

/**
 * 由 nativeLibraryDir 派生 $PREFIX。
 *
 * targetSdk<=28 时 app home 允许 execve（docs/adr/0001-android-execution-domain.md），故把原生件以真实名字放进这里：
 * bin/ 放可执行工具（bash、rg 是复制，node 是链接），lib/ 放须按约定路径加载的原生模块（pty.node）。
 */
object PrefixProvisioner {

    private val BINS = listOf("libbash.so" to "bash", "libdshrg.so" to "rg")
    private val LIBS = listOf("libdshpty.so" to "pty.node")

    /** node 在 $PREFIX/bin 下的名字。报告 2026-09-26 §五：`command -v node` 全 MISSING，
     *  于是 npm 生命周期脚本、`#!/usr/bin/env node` 的 shim、以 node 自起的 MCP server 一律起不来。 */
    const val NODE_BIN_NAME = "node"

    fun root(ctx: Context): File = File(ctx.filesDir, "usr")
    fun binDir(ctx: Context): File = File(root(ctx), "bin")
    fun libDir(ctx: Context): File = File(root(ctx), "lib")

    /** 幂等复制 + 建 node 链，返回已就位条目名；缺件跳过（对应能力降级，由诊断上屏）。
     *  nodeBin 由调用方给（NativeAssetRegistry 是 libnode.so 位置的唯一事实源）。 */
    fun provision(ctx: Context, nodeBin: File): List<String> {
        val ready = mutableListOf<String>()
        val nativeDir = ctx.applicationInfo.nativeLibraryDir
        for ((items, dir) in listOf(BINS to binDir(ctx), LIBS to libDir(ctx))) {
            dir.mkdirs()
            val executable = items === BINS
            for ((libName, name) in items) {
                val src = File(nativeDir, libName)
                val dst = File(dir, name)
                if (!src.isFile) { dst.delete(); continue }
                if (!dst.isFile || dst.length() != src.length()) {
                    try {
                        src.copyTo(dst, overwrite = true)
                        if (executable) dst.setExecutable(true, false)
                    } catch (_: Exception) { dst.delete(); continue }
                }
                ready += name
            }
        }
        if (linkNode(ctx, nodeBin) != null) ready += NODE_BIN_NAME
        return ready
    }

    /** node 以**符号链接**进 $PREFIX/bin，不与 bash/rg 同走复制。
     *  判据：libnode 带 `DT_RUNPATH=$ORIGIN`（scripts/verify-runtime-elf.sh 立的规矩），而 `$ORIGIN`
     *  取的是内核解析后的真实路径 —— 链接让 `$ORIGIN` 仍落在 nativeLibraryDir，`libc++_shared.so`
     *  就在旁边；复制会搬出 116MB 且把 ELF 放进没有依赖的目录，等于把 1.1.3 那次的
     *  `CANNOT LINK EXECUTABLE ... _ZTVNSt6__ndk1...` 重新装回真机。
     *  每次开机按调用方现算出的 nodeBin 复核链接：`/data/app/~~<随机段>` 随重装变号，
     *  写死一次的链接会在升级后变成断链。 */
    private fun linkNode(ctx: Context, nodeBin: File): File? {
        binDir(ctx).mkdirs()
        val link = File(binDir(ctx), NODE_BIN_NAME)
        val target = nodeBin.absolutePath
        val current = try { Os.readlink(link.absolutePath) } catch (_: Exception) { null }
        if (current == target) return link
        try {
            link.delete()
            Os.symlink(target, link.absolutePath)
            return link
        } catch (_: Exception) {
            return null
        }
    }

    fun bashBin(ctx: Context): File? = File(binDir(ctx), "bash").takeIf { it.isFile }

    /** 供诊断比对：$PREFIX 里应当存在的条目（缺哪个 = 哪个能力没落地）。 */
    val expected: List<String> = BINS.map { it.second } + LIBS.map { it.second } + NODE_BIN_NAME
}
