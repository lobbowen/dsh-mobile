package io.github.lobbowen.dshmobile

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * 内核（L1）版本管理 —— 与容器引擎 OTA 引擎共用同一套指针约定。
 *
 * 布局（与 container-engine/src/ota-engine.js、kernel-bundle.js 对齐）：
 * files/kernel/CURRENT -> 当前生效版本号（原子写）
 * files/kernel/<version>/kernel.json -> 内核包清单（含 entry/signature/requires）
 * files/kernel/<version>/bin/dsh-supervisor -> 内核入口（**由 node 解释执行**）
 *
 * 与 Node 运行时版本（NodeVersionManager，files/node/CURRENT）是两套独立指针：
 * - Node 运行时（L0）冻结；
 * - 内核（L1）经签名 OTA 热更新。
 * 二者互不替代。
 *
 * ============================================================================
 * dsh-supervisor 是【脚本】，不是可执行的二进制 —— 不要试图 exec 它
 * ============================================================================
 * 它落在 `filesDir`（label = `app_data_file`），**SELinux W^X 禁止 execve**。
 * 正确用法是把它当**参数**交给 node：
 *
 * ```kotlin
 * ProcessBuilder(nodeBin.absolutePath, entry.absolutePath, "daemon")
 * ```
 * 即「用 node 跑这个脚本」。见 NodeRuntimeService 的启动链。
 *
 * 这与 `libnode.so` 的处理方式**刻意不同** —— 后者是真正要被 exec 的 ELF，
 * 必须放在 `nativeLibraryDir`（label = `exec_type`），即 `jniLibs/<abi>/`。
 *
 * 历史上的类注释误写成「由 :node 进程 exec」，与实现矛盾。这是埋着的雷：
 * 照注释去 `ProcessBuilder(entry.absolutePath)` 必在真机上以
 * `error=13, Permission denied` 失败。本注释即为修正，并加了运行时断言守护。
 * ============================================================================
 */
class KernelManager(private val context: Context) {

    data class KernelVersion(val version: String, val dir: File)

    data class KernelManifest(
        val name: String,
        val version: String,
        val abi: String,
        val engines: JSONObject?,
        val entry: String,
        val requires: List<String>,
        val signature: String?
    )

    private val kernelRoot = File(context.filesDir, "kernel")
    private val currentPointer = File(kernelRoot, "CURRENT")

    fun currentVersion(): String? =
        if (currentPointer.exists()) currentPointer.readText().trim().ifBlank { null } else null

    /** 已安装（落盘）的内核版本目录名。 */
    fun installedVersions(): List<String> {
        if (!kernelRoot.exists()) return emptyList()
        return kernelRoot.list()?.filter {
            it != "CURRENT" && File(kernelRoot, it).isDirectory
        }?.sorted() ?: emptyList()
    }

    fun kernelDir(version: String): File = File(kernelRoot, version)

    /**
     * 内核入口脚本路径 —— **这是一个脚本，不是可执行二进制**。
     *
     * 它位于 `filesDir`（`app_data_file`），SELinux W^X 禁止 execve。
     * 必须交给 node 解释执行：`ProcessBuilder(nodeBin, entryPath(v), "daemon")`。
     *
     * 调用 [assertNotDirectlyExecutable] 可在开发期抓住误用。
     */
    fun entryPath(version: String): File = File(kernelDir(version), "bin/dsh-supervisor")

    /**
     * 断言 [entryPath] 不会被直接 exec —— 该路径在 `app_data_file` 下，W^X 会拒绝。
     *
     * 初衷：类注释曾与实现矛盾（写「由 :node 进程 exec」而实际落 filesDir），
     * 这是典型的「埋雷」型缺陷 —— 后人照注释写代码就必崩。把不变式写成可执行
     * 断言，比注释更难被忽略。
     *
     * 注意断言的是**目录归属**（唯一可靠的静态判据），不是文件权限位：
     * `File.canExecute()` 对 `app_data_file` 也返回 true，在此完全不可信。
     *
     * @throws IllegalStateException 该路径竟然不在 filesDir 子树内（布局被破坏）
     */
    fun assertNotDirectlyExecutable(version: String) {
        val entry = entryPath(version).canonicalFile
        val filesRoot = context.filesDir.canonicalFile
        check(entry.startsWith(filesRoot)) {
            "内核入口应位于 filesDir（app_data_file，W^X 禁 exec）内，但它跑到了 ${entry.parent}。" +
                "此断言失败意味着内核 OTA 的落盘布局被破坏 —— " +
                "若入口需要被 exec，它必须改走 jniLibs/nativeLibraryDir（exec_type）通道。"
        }
    }

    fun kernelJsonPath(version: String): File = File(kernelDir(version), "kernel.json")

    /** 读取内核 manifest；缺失/解析失败返回 null。 */
    fun readKernelJson(version: String): KernelManifest? = readKernelJson(version, kernelRoot)

    /**
     * 从指定根目录读取版本 manifest。
     *
     * 为什么要带 root 参数：安装流程会把包解到 `files/kernel/<v>.tmp-*` 而不是
     * 正式目录，然后**在落位前**核对"解包结果"与"校验阶段读到的"是否一致。
     * 用固定的 `kernelRoot` 读不到临时目录，那个核对就无从做起 —— 而它正是
     * 防住「验的是 A、装的是 B」的唯一手段（见 KernelInstaller 注释）。
     */
    fun readKernelJson(version: String, root: File): KernelManifest? {
        val p = File(root, "$version/kernel.json")
        if (!p.exists()) return null
        return try {
            val json = JSONObject(p.readText())
            KernelManifest(
                name = json.optString("name", "dsh-kernel"),
                version = json.optString("version", version),
                abi = json.optString("abi", ""),
                engines = json.optJSONObject("engines"),
                entry = json.optString("entry", "bin/dsh-supervisor"),
                requires = json.optJSONArray("requires")?.let { a ->
                    (0 until a.length()).map { a.getString(it) }
                } ?: emptyList(),
                signature = json.optString("signature", "").ifBlank { null }
            )
        } catch (_: Throwable) {
            null
        }
    }

    /**
     * 把 zip 解到指定目录（公开给 [KernelInstaller] 用）。
     *
     * 保留 private 的 [unzip] 作为实现 —— 这里只做"解包成功与否"的语义化封装，
     * 让调用方不必 catch Throwable 也能区分"包结构不合法"（可归因）与
     * "IO 出错"（需排查环境）。
     */
    fun unzipInto(zip: File, dest: File) {
        unzip(zip, dest)
    }

    /**
     * 设置当前版本（原子写：先写临时再 rename）。
     * 调用方需保证目标版本已落盘（唯一来源是 OTA 安装器，见 ADR-0005）。
     */
    fun setCurrentVersion(version: String) {
        kernelRoot.mkdirs()
        val tmp = File(kernelRoot, "CURRENT.tmp")
        tmp.writeText(version)
        tmp.renameTo(currentPointer)
    }

    /** 内核版本比较：数字段按数值、其余按字符串逐 token 比较（0.1.0-android.10 > 0.1.0-android.2）。 */
    internal fun compareKernelVersions(a: String, b: String): Int {
        val ta = Regex("\\d+|\\D+").findAll(a).map { it.value }.toList()
        val tb = Regex("\\d+|\\D+").findAll(b).map { it.value }.toList()
        for (i in 0 until maxOf(ta.size, tb.size)) {
            val x = ta.getOrNull(i) ?: return -1
            val y = tb.getOrNull(i) ?: return 1
            val nx = x.toLongOrNull()
            val ny = y.toLongOrNull()
            val c = when {
                nx != null && ny != null -> nx.compareTo(ny)
                nx != null -> 1
                ny != null -> -1
                else -> x.compareTo(y)
            }
            if (c != 0) return c
        }
        return 0
    }

    /** 结构性内核健康检查：CURRENT 指针与目录、entry 是否自洽。 */
    fun integrityChecks(): List<String> {
        val out = mutableListOf<String>()
        val cur = currentVersion()
        if (cur == null) {
            out += "CURRENT 指针缺失"
        } else {
            if (!File(kernelRoot, cur).isDirectory) out += "CURRENT=$cur 但目录不存在"
            if (!entryPath(cur).exists()) out += "CURRENT=$cur 但入口 bin/dsh-supervisor 缺失"
            if (readKernelJson(cur) == null) out += "CURRENT=$cur 但 kernel.json 缺失/不可解析"
        }
        return out
    }

    private fun errText(e: Throwable) = e::class.java.simpleName + ": " + (e.message ?: "(无消息)")

    /**
     * 从 zip 里取出 kernel.json 全文（不解整包）。
     *
     * 注意 `name.endsWith("kernel.json")` 是**刻意的宽松匹配**：包内路径恒为
     * `kernel/<version>/kernel.json`，而 version 事先未知 —— 这正是我们要读它的原因。
     * 但也因此可能命中 `foo-kernel.json` 这类条目，所以下面还要校验解析出的
     * version 非空，把它当作可信性门槛。
     *
     * 返回 null 表示"取不到或不可解析"，调用方据此归为 BrokenBaseline。
     */
    private fun readKernelJsonFromZip(zip: File): String? {
        return try {
            java.util.zip.ZipInputStream(zip.inputStream()).use { zis ->
                var entry = zis.nextEntry
                while (entry != null) {
                    if (!entry.isDirectory && entry.name.endsWith("kernel.json")) {
                        val text = zis.bufferedReader().readText()
                        if (text.isNotBlank()) return text
                    }
                    zis.closeEntry()
                    entry = zis.nextEntry
                }
                null
            }
        } catch (_: Throwable) {
            null
        }
    }

    private fun readVersionFromZip(zip: File): String? {
        val text = readKernelJsonFromZip(zip) ?: return null
        return try {
            // 用 optString(name) 后判空，而不是 optString(name, null)：
            // 后者在 Kotlin 里会推断成 Nothing? 并触发 Java 类型不匹配警告，
            // 且语义上"缺失"与"空串"本就该一起归一为 null。
            JSONObject(text).optString("version", "").ifBlank { null }
        } catch (_: Throwable) {
            null
        }
    }

    /**
     * 解压 zip 到 dest（自动建目录）。
     *
     * 用 `java.util.zip.ZipInputStream`：它按**局部头**的 method 字段自动分派
     * Stored / Deflate，无需调用方关心压缩方式 —— 这正是我们要的（对照
     * container-engine/src/zip.js，那边因为是纯 JS 手写 zip，曾漏掉 Deflate 支持）。
     *
     * 安全：内核包可能来自本地 feed（用户放的 zip），属不可信输入，
     * 因此逐条做**目录穿越**检查。历史实现直接 `File(dest, entry.name)`，
     * 一个名为 `../../shared_prefs/x.xml` 的条目就能写出沙箱之外。
     */
    private fun unzip(zip: File, dest: File) {
        val destRoot = dest.canonicalFile
        java.util.zip.ZipInputStream(zip.inputStream()).use { zis ->
            var entry = zis.nextEntry
            var count = 0
            while (entry != null) {
                val name = entry.name
                val out = File(dest, name).canonicalFile
                if (!out.path.startsWith(destRoot.path + File.separator) && out.path != destRoot.path) {
                    throw IllegalStateException("内核包条目路径越界（疑似目录穿越）: $name")
                }
                if (entry.isDirectory) {
                    out.mkdirs()
                } else {
                    out.parentFile?.mkdirs()
                    out.outputStream().use { os -> zis.copyTo(os) }
                    count += 1
                }
                zis.closeEntry()
                entry = zis.nextEntry
            }
            if (count == 0) throw IllegalStateException("内核包内没有任何文件条目")
        }
    }

    companion object {
        const val TAG = "KernelManager"
        fun sha256(file: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { fis ->
                val buf = ByteArray(8192)
                var n: Int
                while (fis.read(buf).also { n = it } != -1) md.update(buf, 0, n)
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
