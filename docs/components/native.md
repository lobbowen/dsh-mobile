# 原生件来源与许可（Native Provenance）

本仓 `container/native/` 按**交付层**分两组：`d1/`（D1 Linux 语义兑现）与 `d2/`（D2 Android 平台件）。三组原生源码由 CI 用 NDK 编成 `.so` 打进 APK 的 `jniLibs/`
（`nativeLibraryDir` 是 W^X 下唯一可 `dlopen`/`execve` 的通道）。本文件是它们**唯一**的来源与许可记录。

## 1. d2/flock.c —— `liblobosflock.so`（D2）

- **来源**：npm `@deepseek-ai/node-addon-system@0.1.2` 的 `src/flock.c`（该包 `files` 字段随包发布源码），逐字保留，仅添加说明文件，不改一行 C。
- **许可**：BSD-3-Clause。
- **用途**：安卓容器无 android-arm64 预编译件（厂商只发 linux-glibc/musl 与 darwin），而 `flock(2)` 是内核系统调用、无 JS 等价物 → 用 NDK 编为 `liblobosflock.so` 打进 APK jniLibs。**编一次即固化**：见 `docs/architecture.md` §8「小件能力件」—— 首次固化后 `fast-apk` 只下载校验，不再每次现编。
- **OS 原生侧**：`lobos/native` + `lobos/runtime` 负责把该 `.so` 投放到 libSearchPath（原 `programs/console/src/assembler` 已随后下沉删除）。
- **上游升级**：比对 `npm view @deepseek-ai/node-addon-system` 的 `src/flock.c` 是否变化；有变化则同步此副本并 bump 垫片、重测真机。

## 2. d1/ —— `liblobosposix.so`（D1，本仓自有）

- **来源**：本仓自有代码，BSD-3-Clause。
- **形态**：编成 `liblobosposix.so` 放进 APK jniLibs，由容器经 `LD_PRELOAD` 注入 DSH 进程。
- `link-interpose.c`：Android 对所有 app 域 `neverallow` `link(2)`，而 DSH 的发布会话/附件依赖它；以独占拷贝给出等价语义，从而不必修改 DSH 安装树。
- `exec-path.c`：shebang 与标准路径面兑现（execve 家族在交给内核前，按**调用方 PATH** 解析 shebang 解释器与 `/usr/bin/X`、`/bin/sh` 这类绝对路径）—— 补的是**约定**，为的是让 npm/pip 的原生 shim 与 `#!/usr/bin/env X` 按原样工作，而不是给每个工具手写一层包装。
- `open-fallback.c`：`/data/user/0`、`/data` 祖先目录对 app 不可读，而 DSH 的 durable-home 会逐级 `fsync` 到文件系统根，`open` 目录即 `EACCES`；这里退到最近可打开的祖先。 另有 `tmp-redirect.h`（`/tmp` 前缀重写的唯一实现）与 `tmp-paths.c`（`mkdir/stat/unlink/rename/…` 整张路径 syscall 面）—— 只动 `/tmp` 前缀，默认生效（不依赖会被 DSH 剥掉的 `LOBOS_*` 开关）。
- **已删除**：首轮的 `link-publish-shim.js`（逐文件字节补丁）。

## 3. d2/pty-probe.c —— `liblobosptyprobe.so`（D2，本仓自有）

- **来源**：本仓自有代码（非 vendored），BSD-3-Clause（与 `native/d2/` 同许可域）。
- **用途**：`fast-apk` CI 用 NDK `$CC -static` 编成 `liblobosptyprobe.so` 放进 APK jniLibs；容器 `InstanceHost.runPtyProbe()` 在 spawn 内核前直接 exec 它（静态无动态依赖，W^X 下 nativeLibraryDir 通道可用），stdout 逐行上屏。
- **为什么存在**：终端 5 环链的第 ② 环 —— `node-pty` 无 android-arm64 预编译件，且 untrusted_app 域对 `/dev/ptmx` 的 SELinux 许可因 ROM/版本而异（Termux 历史因此走 pipe 假 PTY）。真 PTY vs 假 PTY 的决策必须有本机实测数据，探针一次 exec 给出全链各步的 OK/errno。
- **为什么静态**：动态链接要 `LD_LIBRARY_PATH` 且会把 libc++ 版本漂移带进来（PTC 子进程崩溃教训）；纯 C + `-static` 彻底隔离。
- **为什么不登记 `native-assets.txt`**：NativeAssetRegistry 刻意把 CAPABILITY（能力件）排除在 ALL 之外 —— 登记它会把"配方软失败"变成硬红，与体积门槛无关；缺件时 Kotlin 侧诚实显示「未随包（跳过）」。
- **升级比对**：无上游对应物；改动只需同步本文件与 `InstanceHost.runPtyProbe` 的输出约定。
