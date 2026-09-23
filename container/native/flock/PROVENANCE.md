# flock.c — 上游源码的构建副本

- 来源：npm `@deepseek-ai/node-addon-system@0.1.2` 的 `src/flock.c`（该包 `files` 字段
  随包发布源码），逐字保留，仅添加本说明文件，不改一行 C。
- 许可：BSD-3-Clause（随上游包发布，见上游仓库 deepseek-harness/deepseek-harness
  的 native/system/packages/entry）。
- 用途：安卓容器无 android-arm64 预编译件（厂商只发 linux-glibc/musl 与 darwin），
  而 flock(2) 是内核系统调用、无 JS 等价物 → 由 fast-apk CI 用 NDK 现编为
  `libdshflock.so` 打进 APK jniLibs（nativeLibraryDir 是唯一可 dlopen 的通道），
  内核在 dsh 安装树投放加载垫片（src/guard/native/flock-shim.js）指向该 .so。
- 上游升级 node-addon-system 时：比对 `npm view @deepseek-ai/node-addon-system` 的
  src/flock.c 是否变化；有变化则同步此副本并 bump 垫片/重测真机。
