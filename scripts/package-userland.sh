#!/usr/bin/env bash
# 打包成 C 的件形状：tar.gz 内含 bin/<tool>；文件名**内容寻址**（带 sha256 前 12 位）。
#
# 为什么必须内容寻址：件本体在对象存储上是 `--cache-control=31536000`（长缓存，靠「文件名带
# 版本号即不可变」的老约定）。但 tar.gz 不是逐字节可复现的（mtime/gzip 头会变）—— 同一版本号
# 重编就会产出不同字节，而 CDN 仍会按旧缓存给你旧字节（2026-09-27 实证：sqlite3 重编后
# sha 由 83a117… 变 733cfa…）。把内容哈希写进文件名，重编即新名，长缓存才安全。
# 写法纪律：命令替换只在裸赋值里出现，不写 "$(...)"。
set -euo pipefail

TOOL="${1:?需要工具名}"
VER=$(cat "dist/${TOOL}.version" 2>/dev/null || echo unknown)
RAW="dist/.userland-${TOOL}-raw.tar.gz"
tar czf "$RAW" -C dist bin
SHA=$(sha256sum "$RAW" | cut -c1-12)
TAR="dist/userland-${TOOL}-${VER}-${SHA}-android-arm64.tar.gz"
mv "$RAW" "$TAR"
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
