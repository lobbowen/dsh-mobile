# 原生件来源与许可（Native Provenance）

本仓 `container/native/` 下有三组原生源码，由 CI 用 NDK 编成 `.so` 打进 APK 的 `jniLibs/`
（`nativeLibraryDir` 是 W^X 下唯一可 `dlopen`/`execve` 的通道）。本文件是它们**唯一**的来源与许可记录。

## 1. flock/ —— `libdshflock.so`

- **来源**：npm `@deepseek-ai/node-addon-system@0.1.2` 的 `src/flock.c`（该包 `files` 字段随包发布源码），逐字保留，仅添加说明文件，不改一行 C。
- **许可**：BSD-3-Clause。
- **用途**：安卓容器无 android-arm64 预编译件（厂商只发 linux-glibc/musl 与 darwin），而 `flock(2)` 是内核系统调用、无 JS 等价物 → 由 `fast-apk` CI 用 NDK 现编为 `libdshflock.so` 打进 APK jniLibs。
- **内核侧**：dsh 安装树的加载垫片 `kernel/src/guard/native/flock-shim.js` 指向该 `.so`。
- **上游升级**：比对 `npm view @deepseek-ai/node-addon-system` 的 `src/flock.c` 是否变化；有变化则同步此副本并 bump 垫片、重测真机。

## 2. posix/ —— `libdshposix.so`（本仓自有）

- **来源**：本仓自有代码，BSD-3-Clause。
- **形态**：编成 `libdshposix.so` 放进 APK jniLibs，由容器经 `LD_PRELOAD` 注入 DSH 进程。
- `link-interpose.c`：Android 对所有 app 域 `neverallow` `link(2)`，而 DSH 的发布会话/附件依赖它；以独占拷贝给出等价语义，从而不必修改 DSH 安装树。
- `open-fallback.c`：`/data/user/0`、`/data` 祖先目录对 app 不可读，而 DSH 的 durable-home 会逐级 `fsync` 到文件系统根，`open` 目录即 `EACCES`；这里退到最近可打开的祖先。
- **已删除**：首轮的 `link-publish-shim.js`（逐文件字节补丁）。

## 3. ptyprobe/ —— `libdshptyprobe.so`（本仓自有）

- **来源**：本仓自有代码（非 vendored），BSD-3-Clause（与 `native/flock/` 同许可域）。
- **用途**：`fast-apk` CI 用 NDK `$CC -static` 编成 `libdshptyprobe.so` 放进 APK jniLibs；容器 `NodeRuntimeService.runPtyProbe()` 在 spawn 内核前直接 exec 它（静态无动态依赖，W^X 下 nativeLibraryDir 通道可用），stdout 逐行上屏。
- **为什么存在**：终端 5 环链的第 ② 环 —— `node-pty` 无 android-arm64 预编译件，且 untrusted_app 域对 `/dev/ptmx` 的 SELinux 许可因 ROM/版本而异（Termux 历史因此走 pipe 假 PTY）。真 PTY vs 假 PTY 的决策必须有本机实测数据，探针一次 exec 给出全链各步的 OK/errno。
- **为什么静态**：动态链接要 `LD_LIBRARY_PATH` 且会把 libc++ 版本漂移带进来（PTC 子进程崩溃教训）；纯 C + `-static` 彻底隔离。
- **为什么不登记 `native-assets.txt`**：NativeAssetRegistry 刻意把 CAPABILITY（能力件）排除在 ALL 之外 —— 登记它会把"配方软失败"变成硬红，与体积门槛无关；缺件时 Kotlin 侧诚实显示「未随包（跳过）」。
- **升级比对**：无上游对应物；改动只需同步本文件与 `NodeRuntimeService.runPtyProbe` 的输出约定。
