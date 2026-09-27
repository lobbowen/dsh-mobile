#!/usr/bin/env bash
# 打包成内核取用契约的形状：tar.gz 内含 bin/<tool>，并打 sha256（内核 TOOLS 就钉这个值）。
# 写法纪律：命令替换只在裸赋值里出现，不写 "$(...)"。
set -euo pipefail

TOOL="${1:?需要工具名}"
VER=$(cat "dist/${TOOL}.version" 2>/dev/null || echo unknown)
TAR="dist/userland-${TOOL}-${VER}-android-arm64.tar.gz"
tar czf "$TAR" -C dist bin
NAME=$(basename "$TAR")
cd dist
sha256sum "$NAME" >> SHA256SUMS
cd ..
echo "[ok] $TAR"
sha256sum "$TAR"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  SUM=$(sha256sum "$TAR")
  { echo '### userland 产物 sha256（内核 TOOLS 就钉这个值）'; echo '```'; echo "$SUM"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
fi
