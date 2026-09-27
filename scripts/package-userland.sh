#!/usr/bin/env bash
# 打包成内核取用契约的形状：tar.gz 内含 bin/<tool>，并打 sha256（内核 TOOLS 就钉这个值）。
set -euo pipefail
TOOL="${1:?需要工具名}"
VER="$(cat "dist/${TOOL}.version" 2>/dev/null || echo unknown)"
TAR="dist/userland-${TOOL}-${VER}-android-arm64.tar.gz"
tar czf "$TAR" -C dist bin
( cd dist && sha256sum "$(basename "$TAR")" >> SHA256SUMS )
echo "[ok] $TAR ($(stat -c%s "$TAR") 字节)"
sha256sum "$TAR"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo '### userland 产物 sha256（内核 TOOLS 就钉这个值）'; echo '```'; sha256sum "$TAR"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
fi
