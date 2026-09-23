package io.github.lobbowen.dshmobile.kernel

import java.io.File
import java.security.MessageDigest
import java.util.zip.ZipInputStream

/**
 * 内核包的**解包与完整性原语** —— 纯 JVM（刻意不碰 org.json，保持可单测）。
 *
 * 安全要点：内核包属**不可信输入**（历史上还支持过用户放置的本地 zip），
 * 因此逐条做**目录穿越**检查。历史实现直接 File(dest, entry.name)，
 * 一个名为 ../../shared_prefs/x.xml 的条目就能写出沙箱之外。
 *
 * 为什么用 ZipInputStream 而不是自己解析：它按局部头的 method 自动分派 Stored/Deflate，
 * 无需调用方关心压缩方式（对照 container-engine/src/zip.js：那份纯 JS 手写实现曾漏掉 Deflate）。
 */
object KernelArchive {

    /**
     * 解压到 dest（自动建目录）。
     * @throws IllegalStateException 条目路径越界 / 包内没有任何文件条目
     */
    fun unzip(zip: File, dest: File) {
        val destRoot = dest.canonicalFile
        ZipInputStream(zip.inputStream()).use { zis ->
            var entry = zis.nextEntry
            var count = 0
            while (entry != null) {
                val name = entry.name
                val out = File(dest, name).canonicalFile
                // 前缀比较必须带分隔符，否则 /data/x-evil 会被误判为 /data/x 的子路径。
                if (!out.path.startsWith(destRoot.path + File.separator) && out.path != destRoot.path) {
                    throw IllegalStateException("内核包条目路径越界（疑似目录穿越）: " + name)
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

    /**
     * 从 zip 里读出 kernel.json 原文。
     *
     * name.endsWith("kernel.json") 是**刻意的宽松匹配**：包内路径恒为 kernel/<version>/kernel.json，
     * 而 version 事先未知 —— 这正是要读它的原因。但也因此可能命中 foo-kernel.json，
     * 所以调用方还要校验解析出的 version 非空，把它当作可信性门槛。
     *
     * @return null 表示取不到或内容为空
     */
    fun readKernelJsonFromZip(zip: File): String? = try {
        ZipInputStream(zip.inputStream()).use { zis ->
            var entry = zis.nextEntry
            var found: String? = null
            while (entry != null && found == null) {
                if (!entry.isDirectory && entry.name.endsWith("kernel.json")) {
                    val text = zis.bufferedReader().readText()
                    if (text.isNotBlank()) found = text
                }
                zis.closeEntry()
                entry = zis.nextEntry
            }
            found
        }
    } catch (_: Throwable) { null }

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
