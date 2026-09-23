# native/posix — app 域缺失/不可用的 POSIX 原语

- 来源：本仓自有代码，BSD-3-Clause。
- 编成 `libdshposix.so` 放进 APK jniLibs，由容器经 `LD_PRELOAD` 注入 DSH 进程。
- `link-interpose.c`：Android 对所有 app 域 neverallow `link(2)`，DSH 的发布会话/附件都依赖它；
  以独占拷贝给出等价语义，从而不必修改 DSH 安装树。
- `open-fallback.c`：Android 的 `/data/user/0`、`/data` 祖先目录对 app 不可读，而 DSH 的
  durable-home 会逐级 fsync 到文件系统根，`open` 目录即 EACCES；这里退到最近可打开的祖先。
- 替代关系：首轮的 `link-publish-shim.js`（逐文件字节补丁）已删除。
