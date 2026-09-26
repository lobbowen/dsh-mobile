package io.github.lobbowen.dshmobile.runtime

import android.content.Context
import java.io.File

/**
 * 把 asset 侧数据文件（探针脚本 / adb-client / npm）复制到 filesDir 的入口。
 *
 * 约定见 docs/adr/0001-android-execution-domain.md：libnode.so 经 jniLibs 解压到
 * nativeLibraryDir 执行；原生资产的登记与验证在 NativeAssetRegistry / NativePreparer，
 * 本对象**不碰 node 二进制本身**（曾有 ensureBundledNode 薄壳，因"只查存在性不知依赖"
 * 会把缺库误归因为 SELinux 拒 exec，已删 —— 归因链只留 NativePreparer.verify 一条）。
 */
object NodeProvisioner {

    /**
     * 把 server.js 探针复制到 filesDir。
     *
     * 它是交给 node 的**参数**、不是被 exec 的目标，放 filesDir 没有可执行性问题。
     * 每个启动都覆盖写 —— 这样换了 APK 里的 server.js 就能立即生效，
     * 不会因为残留旧文件而出现"改了没反应"。
     */
    fun ensureServerScript(context: Context): File {
        val script = File(context.filesDir, "server.js")
        context.assets.open("node/server.js").use { input ->
            script.outputStream().use { out -> input.copyTo(out) }
        }
        return script
    }

    /** npm 全局前缀的目录名（guest 里唯一可写的 `npm -g` 目标）。
     *  同一事实内核也写一次（runtime-contract.js 的 npmEnv → npm_config_prefix），
     *  两边由 kernel/test/npm-contract-chain-test.js 逐字对账 —— 改名必须同批改。 */
    const val NPM_GLOBAL_DIR_NAME = ".npm-global"

    /** 建 `$HOME/.npmrc` 并钉住 prefix；文件已在则原样交回，绝不覆盖。
     *  npm 的默认 prefix 指向 node 安装目录（这里 = 只读的 /data/app/…/lib），
     *  guest 里 dsh 自己起的 npm 没有内核那份 npm_config_prefix，只有 .npmrc 管得住。
     *  用户改过 .npmrc（换 registry/代理）就是这台机器的既定事实，开机抹平它不可接受。 */
    fun ensureNpmPrefixRc(context: Context): File? {
        val rc = File(context.filesDir, ".npmrc")
        if (rc.isFile) return rc
        return try {
            rc.writeText("prefix=" + File(context.filesDir, NPM_GLOBAL_DIR_NAME).absolutePath + "\n")
            rc
        } catch (_: Throwable) {
            null
        }
    }

    /**
     * 让内置 ADB 客户端（`assets/node/adb-client/`）就位于 `files/adb-client/`。
     *
     * 为什么在 APK 侧而不是内核侧（ADR-0003 勘误 2026-09-24）：ADB 客户端是
     * **权限通道**，属于壳（L0）的职责；内核是 L1 热更层，若自带客户端，
     * OTA 就能替换信任根之外的身份密钥产生路径。凭据也因此落在壳私有的
     * `files/adb/`，与内核目录物理隔离。
     *
     * 整目录逐文件复制（同款 [ensureAssetCopied] 内容比对），CLI 入口是 cli.js，
     * 由 AdbClientRunner 以一次性 Node 进程调用。
     */
    fun ensureAdbClientScripts(context: Context): File {
        val names = listOf(
            "cli.js", "index.js", "pairing.js", "transport.js",
            "spake2.js", "ed25519.js", "x509.js", "adbkey.js",
        )
        val dir = File(context.filesDir, "adb-client")
        dir.mkdirs()
        for (name in names) {
            ensureAssetCopied(context, "node/adb-client/$name", File(dir, name))
        }
        return dir
    }

    /**
     * 把内置 npm 解到 `files/npm/<version>/`，返回 `bin/npm-cli.js` 的绝对路径；
     * 失败返回 null（**不阻断启动**：没有 npm 内核照常跑，只是"面板装 Agent"不可用）。
     *
     * 为什么 npm 放 assets 而不是 jniLibs：npm 是纯 JS，**调用形态永远是 node 代跑**
     * （`libnode.so <npm-cli.js 绝对路径> install ...`），不存在"把它当二进制 exec"的
     * 通路，所以放哪都无所谓；jniLibs 只留给真需要被 exec 的 ELF。
     *
     * 为什么"版本目录 + .ready 标记"：npm 解包后约 1900 个文件，覆盖安装 APK 时
     * 版本没变就不该重解；版本变了自然落到新目录，无需处理半旧半新的混叠。
     */
    fun ensureNpm(context: Context): File? {
        return try {
            val version = context.assets.open("npm/version.txt").bufferedReader().use { it.readText().trim() }
            require(version.isNotEmpty()) { "npm/version.txt 为空" }
            val dest = File(context.filesDir, "npm/$version")
            val npmCli = File(dest, "bin/npm-cli.js")
            if (npmCli.isFile && File(dest, ".ready").exists()) return npmCli

            dest.parentFile?.mkdirs()
            dest.deleteRecursively()   // 重来：宁可全量重解，不留半包
            dest.mkdirs()
            context.assets.open("npm/npm.zip").use { input ->
                java.util.zip.ZipInputStream(input).use { zis ->
                    val root = dest.canonicalFile
                    var entry = zis.nextEntry
                    while (entry != null) {
                        val out = File(dest, entry.name).canonicalFile
                        if (!out.path.startsWith(root.path + File.separator) && out.path != root.path) {
                            throw IllegalStateException("npm 包条目路径越界: ${entry.name}")
                        }
                        if (entry.isDirectory) out.mkdirs()
                        else {
                            out.parentFile?.mkdirs()
                            out.outputStream().use { os -> zis.copyTo(os) }
                        }
                        zis.closeEntry()
                        entry = zis.nextEntry
                    }
                }
            }
            if (!npmCli.isFile) throw IllegalStateException("解包后仍缺 bin/npm-cli.js: ${npmCli.absolutePath}")
            File(dest, ".ready").writeText(version)
            npmCli
        } catch (e: Throwable) {
            android.util.Log.w("NodeProvisioner", "npm 解包失败（不阻断启动）", e)
            null
        }
    }

    /**
     * 让内核包校验器（`assets/node/kernel-verify.js`）就位。
     *
     * 为什么由 Kotlin 复制而不是直接从 assets 读：Node **读不了 APK 内的
     * assets** —— `process.env` 里没有任何指向它的路径，而且 assets 在 APK
     * 里是压缩存储的，需要 AssetManager 才能访问。所以必须落到普通文件。
     *
     * 与 [ensureServerScript] 的区别：这里用**内容比对**决定是否重写。
     * 原因：校验器会在每次内核安装时被调用，而"每次都写盘"会让它自己成为
     * 一个潜在的失败点（磁盘满/IO 抖动）。内容一致就跳过，减少无谓写。
     *
     * 它是**校验器**，与被校验的内核包解耦。绝不能改从内核目录加载 ——
     * 那会让"签名无效的内核"有机会提供自己的校验器（自证循环）。
     */
    fun ensureKernelVerifyScript(context: Context): File {
        return ensureAssetCopied(context, "node/kernel-verify.js", File(context.filesDir, "kernel-verify.js"))
    }

    /**
     * 让 ed25519 公钥锚点就位（`assets/ota-public.pem` → `files/ota-public.pem`）。
     *
     * 这把公钥是**设备端唯一信任源**：内核包只有用它验签通过才能生效。
     * 它随 APK 冻结、只能随 APK 升级而变 —— 所以任何"运行时可替换公钥"的
     * 设计都会让双信任根失效。本方法只做 APK assets → filesDir 的复制，
     * 不提供任何写入/覆盖该文件的桥方法。
     */
    fun ensureOtaPublicKey(context: Context): File {
        return ensureAssetCopied(context, "ota-public.pem", File(context.filesDir, "ota-public.pem"))
    }

    /**
     * 把 assets 里的文件复制到 filesDir，**内容一致则跳过**。
     *
     * 用字节比对而非 mtime/size：mtime 在 APK 更新后会变（即使内容没变），
     * 而 size 相同不代表内容相同。字节比对是这个场景下唯一可靠的判据，
     * 且这些文件都很小（KB 级），开销可忽略。
     */
    private fun ensureAssetCopied(context: Context, assetPath: String, dest: File): File {
        val assetBytes = context.assets.open(assetPath).use { it.readBytes() }
        if (dest.exists() && dest.length() == assetBytes.size.toLong()) {
            val same = try {
                dest.readBytes().contentEquals(assetBytes)
            } catch (_: Throwable) {
                false
            }
            if (same) return dest
        }
        dest.parentFile?.mkdirs()
        // 先写临时再 rename：避免"写到一半被杀"导致下次读到半截文件。
        // 这个文件是安全关键件（公钥/校验器），半截内容比不存在更危险 ——
        // 它会被当成"存在但无效"，故障表现会非常难查。
        val tmp = File(dest.parentFile, dest.name + ".tmp")
        tmp.writeBytes(assetBytes)
        if (!tmp.renameTo(dest)) {
            tmp.delete()
            throw IllegalStateException("无法把 $assetPath 落地到 ${dest.absolutePath}")
        }
        return dest
    }
}
