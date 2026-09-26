#!/usr/bin/env bash
# ensure-tool.sh <命令> <apt 包...>
# 「校验工具没装」与「产物不合格」是两回事：缺工具先装上，让后续判据如实报产物结论，
# 而不是红在一个与产物无关的地方。同一逻辑此前在 fast-apk / build-apk / release-admin
# （repack 与 pin 各一份）里复制了 5 份，收口为唯一宿主。
set -euo pipefail
cmd="${1:?usage: ensure-tool.sh <command> <packages...>}"
shift
if command -v "$cmd" >/dev/null 2>&1; then
  exit 0
fi
echo "[info] 缺少 $cmd，安装: $* …"
sudo apt-get update -qq
sudo apt-get install -y -qq "$@"
command -v "$cmd" >/dev/null 2>&1 || { echo "::error::$cmd 安装后仍找不到"; exit 1; }
