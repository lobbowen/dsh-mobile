package lobos.runtime

import android.content.Context
import android.system.Os
import lobos.native.NativeAssetRegistry
import java.io.File

/**
 * 由 nativeLibraryDir 派生 $PREFIX。
 *
 * targetSdk<=28 时 app home 允许 execve（docs/adr/0001-android-execution-domain.md），故把原生件以真实名字放进这里：
 * bin/ 放可执行工具（bash、rg 是复制，node 是链接），lib/ 放须按约定路径加载的原生模块（pty.node）。
 */
object PrefixProvisioner {

    // 文件名从**注册表派生**（唯一事实源）：改 libName 只需改 NativeAssetRegistry。
    private val BINS = listOf(
        NativeAssetRegistry.libNameOf("bash") to "bash",
        NativeAssetRegistry.libNameOf("ripgrep") to "rg",
    )
    // bash/rg 是**动态**可执行文件（见 scripts/build-native-capabilities.sh 的判据），
    // 其中 rg 的 DT_NEEDED 含 libc++_shared.so；它按 `DT_RUNPATH=$ORIGIN` 找**同目录**的
    // 依赖，所以必须把 libc++ 也放到 $PREFIX/bin，而不是只留在 nativeLibraryDir。
    private val DEPS = listOf(
        NativeAssetRegistry.LIBCXX.libName to NativeAssetRegistry.LIBCXX.libName,
    )
    // liblobospty.so 来自 node-pty 配方，**不登记**在注册表里（它是软失败依赖件，
    // 登记就会把它纳入 NativePreparer 的探针与 native-assets 投影），故此处仍为字面量。
    private val LIBS = listOf("liblobospty.so" to "pty.node")

    /** node 在 $PREFIX/bin 下的名字。报告 2026-09-26 §五：`command -v node` 全 MISSING，
     *  于是 npm 生命周期脚本、`#!/usr/bin/env node` 的 shim、以 node 自起的 MCP server 一律起不来。 */
    const val NODE_BIN_NAME = "node"

    /** npm 在 $PREFIX/bin 下的真名（债表 ENV-3）：环境里按名字调 npm 的载体。 */
    const val NPM_BIN_NAME = "npm"

    /** CA bundle 的文件名与 assets 名（信任根随产品走，见 provision 里的说明）。 */
    const val CA_BUNDLE_NAME = "ca-bundle.pem"
    private const val CA_BUNDLE_ASSET = "ca-bundle.pem"

    fun root(ctx: Context): File = File(ctx.filesDir, "usr")
    fun binDir(ctx: Context): File = File(root(ctx), "bin")
    fun libDir(ctx: Context): File = File(root(ctx), "lib")
    fun etcDir(ctx: Context): File = File(root(ctx), "etc")
    /** CA bundle 的落点**只由 $PREFIX 根派生**：装配方与取用方（树根语义）共用这一条，
     *  否则「播在哪」与「去哪找」会各写一份字面量而漂移。 */
    fun caBundleAt(prefixRoot: File): File = File(File(prefixRoot, "etc"), CA_BUNDLE_NAME)
    fun caBundle(ctx: Context): File = caBundleAt(root(ctx))

    /** 幂等复制 + 建 node 链，返回已就位条目名；缺件跳过（对应能力降级，由诊断上屏）。
     *  nodeBin 由调用方给（NativeAssetRegistry 是 libnode.so 位置的唯一事实源）。 */
    fun provision(ctx: Context, nodeBin: File): List<String> {
        val ready = mutableListOf<String>()
        val nativeDir = ctx.applicationInfo.nativeLibraryDir
        for ((items, dir) in listOf(BINS to binDir(ctx), DEPS to binDir(ctx), LIBS to libDir(ctx))) {
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
        // 信任根随产品走：app 域里系统 CA 存储用不了（真机实测 API 37：OpenSSL 走默认路径验不过、
        //   GIT_SSL_CAPATH 指到 conscrypt APEX 也验不过），所以把官方 CA bundle 像 ota-public.pem 一样
        //   焊进 APK，开机播到 $PREFIX/etc/；环境侧由 GuestAdapter 指 SSL_CERT_FILE / CURL_CA_BUNDLE。
        //   每次开机重播（188KB，代价可忽略）：APK 升级后 bundle 一定是新的，不会留旧信任根。
        val caDst = caBundle(ctx)
        try {
            caDst.parentFile?.mkdirs()
            ctx.assets.open(CA_BUNDLE_ASSET).use { input -> caDst.outputStream().use { out -> input.copyTo(out) } }
            ready += CA_BUNDLE_NAME
        } catch (_: Exception) { caDst.delete() }
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

    /** npm 以**符号链接**进 $PREFIX/bin（npm 是纯 JS，可执行性来自解释器，不需要也不许再包一层
     *  入口脚本 —— 逐件包装是 `d1/exec-path.c:8-9` 定罪过的「中间多了一层」）。目标目录名带版本号，
     *  故每次装配按调用方现算出的路径复核链接。shebang `#!/usr/bin/env node` 由 D1 按 PATH 兑现。 */
    fun linkNpm(ctx: Context, npmCli: File?): File? {
        if (npmCli == null || !npmCli.isFile) return null
        binDir(ctx).mkdirs()
        val link = File(binDir(ctx), NPM_BIN_NAME)
        val target = npmCli.absolutePath
        val current = try { Os.readlink(link.absolutePath) } catch (_: Exception) { null }
        if (current == target) return link
        return try {
            link.delete()
            Os.symlink(target, link.absolutePath)
            link
        } catch (_: Exception) {
            null
        }
    }

    fun bashBin(ctx: Context): File? = File(binDir(ctx), "bash").takeIf { it.isFile }

    /** 供诊断比对：$PREFIX 里应当存在的条目（缺哪个 = 哪个能力没落地）。
     *  npm 不在这里：它的来源是 assets 解包后的 npm-cli.js，不是 nativeLibraryDir 的复制/链接，
     *  混进同一张表会让「复制类缺件」与「解包类缺件」两种成因共用一个读数。npm 的读数单列
     *  （linkNpm 的返回值，由 `lobos/os/RuntimeEnvironment` 上屏）。 */
    val expected: List<String> = BINS.map { it.second } + DEPS.map { it.second } + LIBS.map { it.second } + NODE_BIN_NAME + CA_BUNDLE_NAME
}
