package io.github.lobbowen.dshmobile.kernel

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * 内核包解包 —— **安全关键**。
 *
 * 内核包属不可信输入（历史实现还允许用户放本地 zip）。
 * 历史实现直接 File(dest, entry.name)，一个名为 ../../shared_prefs/x.xml 的条目
 * 就能把文件写到沙箱之外。这里把该防护钉成测试。
 */
class KernelArchiveTest {

    private lateinit var dir: File

    @Before fun setUp() { dir = Files.createTempDirectory("karch").toFile() }
    @After fun tearDown() { dir.deleteRecursively() }

    private fun makeZip(name: String, entries: Map<String, String>): File {
        val f = File(dir, name)
        ZipOutputStream(f.outputStream()).use { zos ->
            for ((n, content) in entries) {
                zos.putNextEntry(ZipEntry(n))
                zos.write(content.toByteArray(Charsets.UTF_8))
                zos.closeEntry()
            }
        }
        return f
    }

    @Test fun 正常解包() {
        val z = makeZip("ok.zip", mapOf(
            "kernel/0.1.0/kernel.json" to "{\"version\":\"0.1.0\"}",
            "kernel/0.1.0/bin/dsh-supervisor" to "// script",
        ))
        val out = File(dir, "out")
        KernelArchive.unzip(z, out)
        assertTrue(File(out, "kernel/0.1.0/kernel.json").isFile)
        assertTrue(File(out, "kernel/0.1.0/bin/dsh-supervisor").isFile)
        assertEquals("// script", File(out, "kernel/0.1.0/bin/dsh-supervisor").readText())
    }

    @Test fun 目录穿越被拒且不写出任何文件() {
        val z = makeZip("evil.zip", mapOf("../evil.txt" to "pwned"))
        try {
            KernelArchive.unzip(z, File(dir, "out"))
            fail("应当拒绝目录穿越条目")
        } catch (e: IllegalStateException) {
            assertTrue("错误消息应指明越界: " + e.message, (e.message ?: "").contains("越界"))
        }
        assertFalse("绝不能写到目标目录之外", File(dir, "evil.txt").exists())
    }

    @Test fun 绝对路径条目被中性化_不会写到dest之外() {
        // 注意：这里**不会**触发越界检查，而这是正确的。
        // Java 的 File(parent, child) 把绝对 child 当**相对**处理：
        //   File(<dest>, "/tmp/evil.txt") -> <dest>/tmp/evil.txt
        // 所以条目被"中性化"在目标目录内，不会写到真正的 /tmp。
        // 断言真实行为（而不是我原先臆想的"抛异常"）—— 原先那条是**夹具的假设错了**，
        // 不是被测代码有问题（CI 实测报错后修正）。
        val z = makeZip("abs.zip", mapOf("/tmp/dsh-evil.txt" to "pwned"))
        val out = File(dir, "out")
        KernelArchive.unzip(z, out)
        assertTrue("绝对条目应被中性化进 dest", File(out, "tmp/dsh-evil.txt").isFile)
        assertFalse("绝不能逃出 dest", File(dir, "tmp/dsh-evil.txt").exists())
    }

    @Test fun 空包被拒() {
        val f = File(dir, "empty.zip")
        ZipOutputStream(f.outputStream()).use { /* 不写任何条目 */ }
        try {
            KernelArchive.unzip(f, File(dir, "out"))
            fail("空包应当被拒（否则会静默产出一个空内核）")
        } catch (e: IllegalStateException) {
            assertTrue((e.message ?: "").contains("没有任何文件条目"))
        }
    }

    @Test fun 读出包内kernelJson() {
        val z = makeZip("m.zip", mapOf(
            "kernel/0.2.0/bin/x" to "x",
            "kernel/0.2.0/kernel.json" to "{\"version\":\"0.2.0\"}",
        ))
        val text = KernelArchive.readKernelJsonFromZip(z)
        assertNotNull(text)
        assertTrue("应读到 kernel.json 的内容", (text ?: "").contains("0.2.0"))
    }

    @Test fun 没有kernelJson时返回null() {
        val z = makeZip("nojson.zip", mapOf("kernel/0.1.0/bin/x" to "x"))
        assertNull(KernelArchive.readKernelJsonFromZip(z))
    }

    @Test fun sha256与已知值一致() {
        val f = File(dir, "abc.txt")
        f.writeText("abc")
        // echo -n abc | sha256sum
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", KernelArchive.sha256(f))
    }
}
