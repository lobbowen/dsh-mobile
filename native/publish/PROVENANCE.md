# native/publish — renameat2(RENAME_NOREPLACE) NAPI 桥

- **来源**：本仓自有代码（非 vendored），BSD-3-Clause（与 native/flock/ 同许可域）。
  async-work 生命周期骨架沿用 vendor `flock.c` 的既有模式（cleanup hook + closing 标志），
  因为该模式已被 0.1.7-alpha.2 真机路径验证。
- **用途**：fast-apk CI 用 NDK 编成 `libdshpublish.so` 放进 APK jniLibs；
  容器经 `DSH_PUBLISH_NATIVE` 递路径；守卫投放的 link 垫片
  （`dsh-android-kernel/src/guard/native/link-publish-shim.js`）经它把 dsh 安装树
  里 5 处 `link(2)` 独占发布桥到 `renameat2(RENAME_NOREPLACE)`。
- **为什么不是 link(2)**：Android 7+ SELinux 禁 untrusted_app 在 app 私有目录创建
  硬链接（真机实证 2026-09-23：`EACCES: permission denied, link '...jsonl.zstd.*.tmp'`）。
  `rename(2)` 允许但会覆盖既有目标，破坏 dsh「目标存在→EEXIST→定胜方判定」的并发语义；
  `RENAME_NOREPLACE` 恢复原子 + 独占 + 不覆盖，与 link 发布语义等价。
- **导出面**：`renameNoReplace(src, dst, cb)`，cb(0 | 正 errno)（与 libdshflock 的
  tryLock 同一约定）。EINVAL（fs 不支持 NOREPLACE）原样回传，回退策略在 JS 侧。
- **升级比对**：无上游对应物；改动只需同步 link-publish-shim-test.js 的错误面断言。
