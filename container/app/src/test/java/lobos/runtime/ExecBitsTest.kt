package lobos.runtime

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 落盘件的执行位**只由内容形状决定**（债表 ENV-25）。
 *
 * 对照组是双向的，因为旧写法两个方向都错：`if (name.startsWith("bin/")) setExecutable(...)`
 * 会让 `libexec/git-core/` 里的真 ELF 拿不到位（git clone 按路径 exec 子命令即 EACCES），
 * 同时给 `bin/` 下的清单文本发位。所以这里既验「目录名不管用」，也验「数据件不给位」。
 */
class ExecBitsTest {

    private lateinit var dir: File

    @Before fun setUp() { dir = Files.createTempDirectory("execbits").toFile() }
    @After fun tearDown() { dir.deleteRecursively() }

    // 0x7f 'E' 'L' 'F' + 一点后续字节，够判定魔数即可
    private val elf = byteArrayOf(0x7f, 69, 76, 70, 2, 1, 0, 0)
    private val shebang = "#!/usr/bin/env node\nconsole.log('x')\n".toByteArray()
    private val data = "libexec/git-core/git\t../../bin/git\n".toByteArray()

    private fun put(rel: String, bytes: ByteArray): File {
        val f = File(dir, rel)
        f.parentFile?.mkdirs()
        f.writeBytes(bytes)
        f.setExecutable(false, false)
        return f
    }

    @Test fun ELF件放在任何目录下都该拿到执行位() {
        val helper = put("libexec/git-core/git-remote-http", elf)
        assertFalse(helper.canExecute())
        ExecBits.apply(helper)
        assertTrue(helper.canExecute())
    }

    @Test fun shebang脚本该拿到执行位() {
        val entry = put("lib/node_modules/npm/bin/npm-cli.js", shebang)
        ExecBits.apply(entry)
        assertTrue(entry.canExecute())
    }

    @Test fun 数据件即使在bin下也不发位() {
        // 反向对照组：旧写法正是按这个目录名发位的。
        val list = put("bin/link-farm.txt", data)
        ExecBits.apply(list)
        assertFalse(list.canExecute())
    }

    @Test fun repair补齐整棵树并且不沿链接成环() {
        val deep = put("libexec/git-core/git-upload-pack", elf)
        val text = put("share/git-core/README", data)
        val entry = put("bin/git", elf)
        // 件内农场满是相对链（`libexec/git-core/git → ../../bin/git`），历史上还有指向父目录的写法：
        //   跟随目录链会让这个递归自旋到 StackOverflow，所以判据必须跳过链接本身。
        Files.createSymbolicLink(File(dir, "up").toPath(), dir.toPath())
        ExecBits.repair(dir)
        assertTrue(deep.canExecute())
        assertTrue(entry.canExecute())
        assertFalse(text.canExecute())
    }
}
