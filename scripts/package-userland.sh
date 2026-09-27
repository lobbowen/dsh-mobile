#!/usr/bin/env bash
# 打包成 C 的件形状：**zip** 内含 dist 下的整棵树；文件名**内容寻址**（sha256 前 12 位）。
#
# 为什么是 zip 而不是 tar.gz：消费方是**安卓原生**（容器 Kotlin 用 ZipInputStream 解包）——
#   已放到 APK 层的东西不该再借运行时的解包能力（用户 2026-09-29 复核）。
# 为什么是整棵树：git 这类件运行期要 libexec/git-core 与 share/git-core/templates（只打 bin/ 会「装上了但 clone 跑不起来」）。
# 为什么内容寻址：件在对象存储上是长缓存，而压缩包不是逐字节可复现的 —— 重编即新名，长缓存才安全。
set -euo pipefail

HERE=$(dirname "$0")
cd "$HERE/.."
ROOT_DIR=$(pwd)

TOOL="${1:?需要工具名}"
VER=$(cat "dist/${TOOL}.version" 2>/dev/null || echo unknown)
RAW="work/.userland-${TOOL}-raw.zip"
[ -f "dist/bin/${TOOL}" ] || { echo "::error title=缺件::dist/bin/${TOOL} 不在，先构建"; exit 1; }
STAGE=$(mktemp -d)
cp -a dist/. "$STAGE/"
rm -f "$STAGE"/*.version "$STAGE"/SHA256SUMS $(find "$STAGE" -maxdepth 1 -name '*.zip') 2>/dev/null || true
echo "[package] 打包（zip）：bin + 其它 prefix 目录"
( cd "$STAGE" && zip -q -r -X "$ROOT_DIR/$RAW" . )
rm -rf "$STAGE"
SHA=$(sha256sum "$RAW" | cut -c1-12)
ZIP="dist/userland-${TOOL}-${VER}-${SHA}-android-arm64.zip"
mv "$RAW" "$ZIP"
NAME=$(basename "$ZIP")
cd dist
sha256sum "$NAME" >> SHA256SUMS
cd ..
echo "[ok] $ZIP"
sha256sum "$ZIP"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  SUM=$(sha256sum "$ZIP")
  { echo '### userland 产物 sha256（C 的清单就钉这个值）'; echo '```'; echo "$SUM"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
fi
