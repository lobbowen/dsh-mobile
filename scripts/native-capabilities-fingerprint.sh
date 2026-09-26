#!/usr/bin/env bash
# 小件能力件的**源指纹** —— 构建输入变了，指纹就变。
#
# 用途：判断「能不能直接用已固化的产物」而不再重编。
#   · pin 工作流：以本指纹命名不可变 Release（native-cap-<指纹>-<abi>）；
#   · fast-apk：先算本指纹，命中固化记录就下载校验，未命中才回退现场编译。
#
# 覆盖范围（构建输入）：
#   · container/native/**            —— 自有 C 源（flock / posix / ptyprobe）
#   · scripts/build-native-capabilities.sh —— 全部配方（含 bash / ripgrep / node-pty 的版本常量）
#
# 已知缺口（**诚实记下**）：NDK 版本不在指纹里 —— 它由 runner 预装
# （ANDROID_NDK_LATEST_HOME），本仓未钉。若 runner 的 NDK 大版本变更，产物可能变而指纹不变。
# 要彻底确定，需要把 NDK 版本钉进仓库并纳入指纹（后续工作）。
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

{
  find container/native -type f | sort
  echo scripts/build-native-capabilities.sh
} | while read -r f; do
  [ -f "$f" ] && sha256sum "$f"
done | sha256sum | cut -d' ' -f1
