# native/ptyprobe — 真机 PTY 能力探针

- **来源**：本仓自有代码（非 vendored），BSD-3-Clause（与 native/flock/ 同许可域）。
- **用途**：fast-apk CI 用 NDK `$CC -static` 编成 `libdshptyprobe.so` 放进 APK jniLibs；
  容器 `NodeRuntimeService.runPtyProbe()` 在 spawn 内核前直接 exec 它（静态无动态
  依赖，W^X 下 nativeLibraryDir 通道可用），stdout 逐行上屏「研发面板 → ptyprobe」。
- **为什么存在**：终端 5 环链的第 ② 环 —— node-pty 无 android-arm64 预编译件，
  且 untrusted_app 域对 /dev/ptmx 的 SELinux 许可因 ROM/版本而异（Termux 历史
  因此走 pipe 假 PTY）。真 PTY 移植 vs 假 PTY 回退的决策**必须有本机实测数据**，
  探针一次 exec 给出全链各步的 OK/errno，部分许可也是决策信息。
- **为什么静态**：动态链接要 LD_LIBRARY_PATH 且会把 libc++ 版本漂移面带进来
  （PTC 子进程崩溃教训）；纯 C + `-static` 彻底隔离。
- **为什么不登记 native-assets.txt**：那份清单的 ≥1MB 门槛会误杀小体积件
  （同 libdshflock/libdshpublish 先例）；缺件时 Kotlin 侧诚实显示「未随包（跳过）」。
- **升级比对**：无上游对应物；改动只需同步本文件与 NodeRuntimeService.runPtyProbe 的输出约定。
