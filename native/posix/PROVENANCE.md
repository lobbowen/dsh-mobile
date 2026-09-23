# native/posix — app 域缺失的 POSIX 原语

- 来源：本仓自有代码，BSD-3-Clause。
- 用途：编成 `libdshposix.so` 放进 APK jniLibs，由容器经 `LD_PRELOAD` 注入 DSH 进程。
- 为什么：Android 对所有 app 域 `neverallow ... file_type:file link`，DSH 的会话落盘与
  附件发布都用 link(2)。本库以独占拷贝给出等价语义，从而**不必修改 DSH 安装树**。
- 替代关系：首轮实现的 `link-publish-shim.js`（逐文件字节补丁）已删除。
