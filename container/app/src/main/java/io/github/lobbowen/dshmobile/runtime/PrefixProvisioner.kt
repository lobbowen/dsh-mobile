package io.github.lobbowen.dshmobile.runtime

import android.content.Context
import java.io.File

/**
 * 由 nativeLibraryDir 派生 $PREFIX。
 *
 * targetSdk<=28 时 app home 允许 execve（docs/adr/0001-android-execution-domain.md），故把 lib*.so 复制为真实文件名：
 * bin/ 放可执行工具（bash、rg），lib/ 放须按约定路径加载的原生模块（pty.node）。
 */
object PrefixProvisioner {

    private val BINS = listOf("libbash.so" to "bash", "libdshrg.so" to "rg")
    private val LIBS = listOf("libdshpty.so" to "pty.node")

    fun root(ctx: Context): File = File(ctx.filesDir, "usr")
    fun binDir(ctx: Context): File = File(root(ctx), "bin")
    fun libDir(ctx: Context): File = File(root(ctx), "lib")

    /** 幂等复制，返回已就位条目名；缺件跳过（对应能力降级，由诊断上屏）。 */
    fun provision(ctx: Context): List<String> {
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
        return ready
    }

    fun bashBin(ctx: Context): File? = File(binDir(ctx), "bash").takeIf { it.isFile }
}
