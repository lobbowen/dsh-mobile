package io.github.lobbowen.dshmobile.native

/**
 * 一个随包分发的原生资产及其可执行性声明。
 *
 * 这些事实曾硬编码在 8 处（构建脚本/CI/gradle/Kotlin 各一份），现收敛到
 * [NativeAssetRegistry] 一条声明，其余由其派生。
 *
 * nativeLibraryDir（exec_type）恒可 exec；app home 需 targetSdk<=28，见 docs/adr/0001-android-execution-domain.md。
 * 另需 PT_INTERP=/system/bin/linker64、aarch64、DT_NEEDED 仅 bionic 或随包库，
 * 且依赖随包库时本体须带含 $ORIGIN 的 DT_RUNPATH；
 * 这些约束装机后无法补救，须在打包期校验。exec-probe 是唯一可信的运行期判定。
 */
data class NativeExecutable(
    /** 稳定标识，用于诊断、审计、一致性测试。仅 ASCII 小写/下划线。 */
    val id: String,

    /**
     * `nativeLibraryDir` 内文件名。
     *
     * **必须以 `lib` 开头、`.so` 结尾** —— PackageManager 只把符合该模式的文件
     * 解压到 `nativeLibraryDir`；否则它会留在 APK 内被 mmap，`nativeLibraryDir` 里根本没有。
     */
    val libName: String,

    /** 给人看的名字（诊断输出用）。 */
    val humanName: String,

    /**
     * exec-probe 参数。空列表 = 只验证「能不能启动」。
     *
     * 注意：探针是**真跑进程**，不是读文件头。这是唯一能同时覆盖四道关的验证手段。
     */
    val probeArgs: List<String>,

    /**
     * 期望 stdout 包含的片段；`null` = 只看退出码。
     *
     * 只判退出码不够：有些 ELF 会在缺依赖时退 0 后立刻挂。
     */
    val probeExpect: String?,

    /**
     * 必须**同目录**存在的依赖 `.so`。
     *
     * 两件事缺一不可：这些库真在同目录，**且本体自带含 `$ORIGIN` 的 `DT_RUNPATH`**
     * 指向该目录（链接期注入，`scripts/verify-runtime-elf.sh` 在构建/固化/打包三处校验）。
     * 不能靠调用方补 `LD_LIBRARY_PATH` —— `dsh` 的 `run_code` 清空环境。
     * 完整论证见 docs/architecture.md 第 3 节。
     *
     * 依赖缺失时 linker 报 `error=13` —— 与「SELinux 拒绝 exec」的 errno 完全相同，
     * 极易误导排查。本字段的存在就是为了让 [NativePreparer] 能**先查依赖再归因**。
     */
    val requiredDeps: List<String>,

    /**
     * `false` = 可选资产，缺失不阻断启动。
     *
     * 用于「有了更好、没有也能降级」的东西（例如未来的 shell 工具）。
     */
    val required: Boolean,

    /** 该资产的已知约束（给人看的自由文本）。 */
    val note: String = "",

    /**
     * 供给档位 —— 它**怎么来的**，以及缺件时该判红还是降级。
     *
     * 取值（闭集，消费方按此分档，见 `scripts/verify-apk-native.sh`）：
     *  · `"self-c"`   自有 C，NDK 现编。**必产**：编不出来就是环境问题 ⇒ 硬红。
     *  · `"upstream"` 上游源码配方（bash / ripgrep）。`$PREFIX` 依赖它们且**无回退** ⇒ 硬红。
     *  · `"soft"`     上游预编译/配方有不确定性（node-pty、PTY 探针）。缺件只**降级**，不陪葬其它能力。
     *
     * 为什么要有它：这三档原先只以"注释 + 三段 for 循环"的形式住在 `verify-apk-native.sh` 里，
     * 于是"包里有哪些小件、各自什么失败语义"又多了一份手抄。现在它是注册表的一个字段，
     * 由 `scripts/gen-native-assets.js` 投影成 `.github/native-capabilities.txt` 供 shell/测试读取。
     */
    val buildTier: String = "self-c",
)
