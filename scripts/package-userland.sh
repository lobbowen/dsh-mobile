#!/usr/bin/env bash
# 打包成 C 的件形状：tar.gz 内含 dist 下的**整棵树**；文件名**内容寻址**（带 sha256 前 12 位）。
#
# 为什么是整棵树而不是只有 bin/：有些件运行期需要完整 prefix 布局 —— git 就是典型
#   （libexec/git-core/ 的子命令与 git-remote-https、share/git-core/templates）。
#   只打 bin/ 会让「git 装上了，但 clone 跑不起来」这种失败悄悄发生。
#
# 为什么必须内容寻址：件本体在对象存储上是长缓存（靠「文件名带版本号即不可变」的老约定），
#   而 tar.gz 不是逐字节可复现的（mtime/gzip 头会变）—— 同版本号重编就会产出不同字节，
#   而 CDN 仍按旧缓存给旧字节（2026-09-27 实证）。把内容哈希写进文件名，重编即新名。
#
# 写法纪律：命令替换只在裸赋值里出现；**不写 $'…'**（本仓踩过：尾部被解析层吃掉，
#   表现为脚本里少半行，CI 报的却是别的错）。
set -euo pipefail

TOOL="${1:?需要工具名}"
VER=$(cat "dist/${TOOL}.version" 2>/dev/null || echo unknown)
# 中间 tar 写在 work/ 而不是 dist/：写在被 tar 的目录里会让 tar 报
#   「.: file changed as we read it」并以非零退出（CI 实证，三件一起红）。
RAW="work/.userland-${TOOL}-raw.tar.gz"
mkdir -p work
echo "[package] 打包整棵 dist 树（.version / SHA256SUMS / 中间 tar 已排除）"
tar czf "$RAW" -C dist --exclude='*.version' --exclude='.userland-*' --exclude='SHA256SUMS' --exclude='*.tar.gz' .
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
  { echo '### userland 产物 sha256（C 的清单就钉这个值）'; echo '```'; echo "$SUM"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
fi
