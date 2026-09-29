package lobos.os

import android.content.Context
import lobos.RuntimeDiagnostics
import lobos.native.NativeAssetRegistry
import lobos.native.NativePreparer
import lobos.runtime.NodeProvisioner
import lobos.runtime.PrefixProvisioner
import lobos.runtime.SupplyProvisioner
import java.io.File

/**
 * 运行环境是 OS 自己的事实：$PREFIX 的能力件、随包 npm、信任根重播、C 层签名清单供给，
 * 由宿主就位这一条边装配，与「哪颗 Program 装上了」无关（债表 ENV-1）。
 *
 * 先前这些只长在一颗 Program 的启动路径上（`InstanceHost.bootProgramOnce` 内）：没有 Program
 * 或被杀掉时环境不在，第二个住户永远等不到。本件只**搬家**——生产内容的仍是既有供给件，
 * 不新增任何兼容语义（旋钮的组装在 S2 从 GuestAdapter 搬成纯函数，不在这里）。
 */
object RuntimeEnvironment {

    /** 一次装配的读数。为 [complete] 时才进进程缓存：装配失败不许被缓存成常驻态。 */
    data class Snapshot(
        val nodeBin: File,
        val prefixReady: List<String>,
        val prefixMissing: List<String>,
        val npmEntry: File?,
        val npmBin: File?,
        val envShim: File?,
        val npmrc: File?,
    ) {
        /** 环境是否自洽：$PREFIX 无缺件，且 npm 在 `$PREFIX/bin` 有真名（ENV-3）。 */
        val complete: Boolean get() = prefixMissing.isEmpty() && npmBin != null
    }

    @Volatile private var cached: Snapshot? = null
    @Volatile private var supplyKicked = false

    /**
     * 一个进程树根的环境输入 —— 纯数据，语义装配因此能被 JVM 单测钉住而不碰 Android。
     *
     * posixShim/envShim 可空：探针树根**刻意不注入 LD_PRELOAD**，它测的是裸 node 能不能
     * exec+listen，垫片区里的 linker 问题会被这层注入掩盖掉（D15 的教训是探针读数不能冒充运行态）。
     */
    data class TreeRoot(
        val home: File,
        val tmpDir: File,
        val nodeBin: File,
        val nativeLibDir: String,
        val prefixRoot: File,
        val prefixBin: File,
        val bashBin: File?,
        val posixShim: File? = null,
        val envShim: File? = null,
    )

    /**
     * 每个进程树根共享的那套语义（L-C 基础 + D1 兼容面）。
     *
     * 它先前住在 `GuestAdapter.baseEnv`/`programPlan` 里 —— 于是「环境」实际长在 console 这颗
     * Program 的启动装配上，另外几个树根各拼一份最小 env（HOME/TMPDIR/LD_LIBRARY_PATH 抄三遍），
     * 谁都没拿到 LD_PRELOAD 与信任根（债表 ENV-2）。env 沿进程树继承 ⇒ 附着单位是树根，
     * 不是某一次调用。console 特有的 `LOBOS_*` 申报**不在这里**（仍由 GuestAdapter 产）。
     */
    fun treeRootEnv(root: TreeRoot, inheritedPath: String?): Map<String, String> = buildMap {
        // Node 在安卓沙箱里需要 HOME/TMPDIR，否则部分模块报错。
        // TMPDIR 单源（cacheDir）：boot.js 曾用 os.tmpdir() —— 两侧必须同一事实，
        // 否则"tmp 写入被 SELinux 拒"这类故障只在一侧复现。
        put("HOME", root.home.absolutePath)
        put("TMPDIR", root.tmpDir.absolutePath)
        // Linux 语义（D1）：安卓/bionic 下 LANG/LC_* 全空，排序与字符类按 C locale 走，
        // 多字节语义与预期不符（环境报告 P3-1）。C.UTF-8 是 bionic 认得的 UTF-8 名字。
        // 只设 LANG、不设 LC_ALL —— 留出逐类覆盖的余地，也不覆盖调用方的显式选择。
        put("LANG", "C.UTF-8")
        // 只服务 $PREFIX 下尚无 RUNPATH 的工具；libnode 的依赖由二进制的
        // DT_RUNPATH=$ORIGIN 负责（见 docs/architecture.md 第 3 节），这些工具按同一判据
        // 重编之后本键即可删除。
        put("LD_LIBRARY_PATH", root.nativeLibDir)
        put("NODE_BIN", root.nodeBin.absolutePath)
        // PATH 单点组装：$PREFIX/bin 最前，其次 node 目录，再 `npm -g` 的 bin（装完的 CLI
        // 要找得回，ENV-4），最后继承来的那段 —— 旧实现同一键写两次互相覆盖，哪侧生效全凭运气。
        // 注意：boot-env-contract 门禁会连注释一起按正则计数 PATH 的装配字面量，注释里不要再写这类字面量。
        put(
            "PATH",
            joinPath(
                root.prefixBin.absolutePath,
                root.nodeBin.parentFile!!.absolutePath,
                NodeProvisioner.globalBin(root.home).absolutePath,
                inheritedPath,
            )
        )
        // link(2) 用户态替代：经 LD_PRELOAD 注入子进程，见 native/d1/。
        root.posixShim?.let { put("LD_PRELOAD", it.absolutePath) }
        // D1：/tmp 语义兑现 —— 安卓根只读，硬编码 /tmp 的脚本必失败；liblobosposix 的
        // open/openat 把 /tmp 前缀重写到 $TMPDIR（见 container/native/d1/open-fallback.c）。
        // 默认生效、无开关：载荷起子进程时会剥掉 `LOBOS_*`（真机定罪），开关到不了干活的进程；
        // 生效与否由 liblobosposix 看 TMPDIR 是否绝对路径决定。
        // https 的信任根：安卓系统 CA 的落点**随版本变**（API 34+ 起在 conscrypt APEX）。
        // 只传当前存在的那几个目录（OpenSSL 的 SSL_CERT_DIR 接受冒号列表）——
        // 写死单个路径必有一头 TLS 全灭（真机实测 API 37：git https 报 unable to get local issuer）。
        val caDirs = listOf(
            "/apex/com.android.conscrypt/cacerts",
            "/system/etc/security/cacerts",
            "/data/misc/keychain/cacerts-added",
        ).filter { File(it).isDirectory }
        if (caDirs.isNotEmpty()) put("SSL_CERT_DIR", caDirs.joinToString(":"))
        // 信任根随产品走（首选）：$PREFIX/etc/ca-bundle.pem 由 PrefixProvisioner 从 assets 播下。
        //   libcurl 认 CURL_CA_BUNDLE、OpenSSL 认 SSL_CERT_FILE —— 两者都设，谁被先读都不失效；
        //   文件不在时上面那行 SSL_CERT_DIR 仍作兜底（系统 CA 在 app 域多半验不过，真机实证）。
        val caBundle = PrefixProvisioner.caBundleAt(root.prefixRoot)
        if (caBundle.isFile) {
            put("SSL_CERT_FILE", caBundle.absolutePath)
            put("CURL_CA_BUNDLE", caBundle.absolutePath)
            // git 单独再来一个键：件里的 libcurl 当初编译时带了 --with-ca-path（指向系统信任库），
            //   而 libcurl 一旦**显式**设了自己的 CA 路径，就不再读 CURL_CA_BUNDLE、也不走 OpenSSL 的
            //   SSL_CERT_FILE 默认路径。真机实证：只设前两个键仍报 unable to get local issuer；
            //   GIT_SSL_CAINFO 指到同一份 bundle 立刻通（637ms 拿到 HTTP 层响应）。
            put("GIT_SSL_CAINFO", caBundle.absolutePath)
        }
        put("SHELL", root.bashBin?.absolutePath ?: "/system/bin/sh")
        // D1 Linux 语义：安卓取不到 cpu 信息（os.cpus() 空），由预载垫片在**空**时用
        // availableParallelism() 合成。只在垫片真在场时注入 NODE_OPTIONS。
        root.envShim?.let { put("NODE_OPTIONS", "--require " + it.absolutePath) }
    }

    /** 按**路径段**去重（先到先得）：整串 distinct 挡不住"继承 PATH 已含 node 目录"
     *  导致的重复段 —— 旧 PATH 双写的病根就是同一目录经不同拼接路径混进来。 */
    fun joinPath(vararg parts: String?): String =
        parts.filterNotNull()
            .flatMap { it.split(File.pathSeparator) }
            .filter { it.isNotEmpty() }
            .distinct()
            .joinToString(File.pathSeparator)

    /**
     * 从 Context 现算一个树根的输入（TreeRoot 的唯一生产点，启动链与一次性进程共用一条）。
     *
     * 先 ensure 再取件：语义里要有 `$PREFIX/bin`、bash、CA bundle，这些是装配的产物；
     * 一次性进程不该比内核更早就绪不到环境。
     */
    fun treeRootFor(ctx: Context): TreeRoot = treeRootFor(ctx, ensure(ctx))

    /** 已装配过（拿着 [Snapshot]）的调用方走这条，避免为取输入再 ensure 一次、上屏两遍。 */
    fun treeRootFor(ctx: Context, s: Snapshot): TreeRoot = TreeRoot(
        home = ctx.filesDir,
        tmpDir = ctx.cacheDir,
        nodeBin = s.nodeBin,
        // linker 搜索路径的唯一正确取值口径见 NativePreparer.libSearchPath，别在这里另推一遍。
        nativeLibDir = NativePreparer.libSearchPath(ctx),
        prefixRoot = PrefixProvisioner.root(ctx),
        prefixBin = PrefixProvisioner.binDir(ctx),
        bashBin = PrefixProvisioner.bashBin(ctx),
        // 垫片**在场才声明**：LD_PRELOAD 指向不存在的文件只会给 linker 加一行噪声，
        // 而缺件本就该逐字回退裸语义（与 envShim→NODE_OPTIONS 同一口径）。
        posixShim = File(ctx.applicationInfo.nativeLibraryDir, NativeAssetRegistry.libNameOf("posix"))
            .takeIf { it.isFile },
        envShim = s.envShim,
    )

    /** 幂等：完整快照按进程复用；不完整则每次调用重装配（供给线程只 kick 一次）。 */
    fun ensure(ctx: Context): Snapshot {
        cached?.takeIf { it.complete }?.let { s ->
            // 缓存命中也要上屏：诊断日志每次启动会被清，读数不能只剩第一次那一遍。
            RuntimeDiagnostics.append(
                ctx, "prefix", true, "\$PREFIX 能力件全就位（本进程已装配）",
                PrefixProvisioner.root(ctx).absolutePath + " 已有=" + s.prefixReady.joinToString()
            )
            return s
        }
        return synchronized(this) {
            cached?.takeIf { it.complete } ?: assemble(ctx).also { cached = it }
        }
    }

    private fun assemble(ctx: Context): Snapshot {
        val nodeBin = NativeAssetRegistry.resolve(ctx, NativeAssetRegistry.NODE)

        // $PREFIX 是真名的家：bash/rg 复制、node 链接、libc++ 随附、CA 重播、npm 链接。
        val ready = PrefixProvisioner.provision(ctx, nodeBin)
        val missing = PrefixProvisioner.expected - ready.toSet()
        RuntimeDiagnostics.append(
            ctx, "prefix", missing.isEmpty(),
            if (missing.isEmpty()) "\$PREFIX 能力件全就位" else "\$PREFIX 缺件：${missing.joinToString()}",
            PrefixProvisioner.root(ctx).absolutePath + " 已有=" + ready.joinToString()
        )

        val npmCli = NodeProvisioner.ensureNpm(ctx)
        val npmBin = PrefixProvisioner.linkNpm(ctx, npmCli)
        RuntimeDiagnostics.append(
            ctx, "npm", npmBin != null,
            if (npmBin != null) "npm 就位（\$PREFIX/bin/npm 可按名字调用）" else "npm 未就位 —— 仅影响 Agent 安装，内核照常运行",
            (npmBin?.absolutePath ?: "无真名") + " → " + (npmCli?.absolutePath ?: "assets/npm 解包失败，详见 logcat")
        )

        val envShim = NodeProvisioner.ensureEnvShim(ctx)
        RuntimeDiagnostics.append(
            ctx, "env-shim", envShim != null,
            if (envShim != null) "安卓语义垫片就位（os.cpus 等）" else "安卓语义垫片未就位（不阻断；os.cpus() 仍返回 0）",
            envShim?.absolutePath ?: "assets/node/android-env-shim.cjs 落地失败"
        )

        val npmrc = NodeProvisioner.ensureNpmPrefixRc(ctx)
        RuntimeDiagnostics.append(
            ctx, "npmrc", npmrc != null,
            if (npmrc != null) ".npmrc 前缀在册" else ".npmrc 未能写入（guest 侧 npm -g 会失败）",
            npmrc?.absolutePath ?: "写入失败（无路径可报）"
        )

        if (!supplyKicked) {
            supplyKicked = true
            Thread {
                try {
                    SupplyProvisioner.ensure(ctx)
                } catch (e: Throwable) {
                    RuntimeDiagnostics.append(ctx, "supply", false, "C 层供给线程异常", e.message ?: "")
                }
            }.start()
        }

        return Snapshot(nodeBin, ready, missing.toList(), npmCli, npmBin, envShim, npmrc)
    }
}
