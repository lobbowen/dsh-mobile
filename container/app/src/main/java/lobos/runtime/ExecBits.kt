package lobos.runtime

import java.io.File
import java.nio.file.Files

/**
 * 落盘件的**可执行位只由自身内容决定**，不由它在包里的目录名决定。
 *
 * 为什么不是「`bin/` 前缀就给 x」：那条判据把「能不能 execve」交给打包者把件放在哪个目录，于是
 * git 件里 `libexec/git-core/` 的真独立二进制、旧版从 assets 解包的 `npm-cli.js`（该形态已随
 * npm 归口 C 清单删除）全落在判据之外 ——
 * `$PREFIX/bin` 的真名链接建好了，链接目标却不可执行，guest 侧只得到一句 `command not found`
 * （债表 ENV-25）。反向同样要紧：清单、`.pem`、`link-farm.txt` 这类数据件无论在哪个目录都不该拿到 x。
 */
internal object ExecBits {

    /** ELF（`\u007fELF`）或 shebang（`#!`）⇒ 给执行位；读不到、太短、其它内容一律不碰。 */
    fun apply(file: File) {
        val head = ByteArray(4)
        val read = try {
            file.inputStream().use { it.read(head) }
        } catch (_: Throwable) {
            return
        }
        if (read < 2) return
        val magic = String(head, 0, read, Charsets.ISO_8859_1)
        val elf = magic.length == 4 && magic[0] == '\u007f' && magic.substring(1) == "ELF"
        if (elf || magic.startsWith("#!")) file.setExecutable(true, false)
    }

    /**
     * 已就位件的补位通道：解包只在第一次落位时跑，所以「修好了给位的规则」对旧件永不起效 ——
     * 与 DS-7 给链接农场立的规矩同一条：marker 命中不等于件还能用，必须在命中那一支里复验并重放。
     */
    fun repair(dir: File) {
        val kids = dir.listFiles() ?: return
        for (f in kids) {
            // 链接自己不带语义，能不能执行由目标决定；跟随目录链会让这个递归走偏（件内农场满是相对链）。
            if (Files.isSymbolicLink(f.toPath())) continue
            if (f.isDirectory) repair(f) else apply(f)
        }
    }
}
