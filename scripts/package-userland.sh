#!/usr/bin/env bash
# 打包成 C 的件形状：**zip** 内含 dist 下的整棵树；文件名**内容寻址**（sha256 前 12 位）。
#
# 为什么是 zip 而不是 tar.gz：消费方是**安卓原生**（容器 Kotlin 用 ZipInputStream 解包）——
#   已放到 APK 层的东西不该再借运行时的解包能力（用户 2026-09-29 复核）。
# 为什么是整棵树：git 这类件运行期要 libexec/git-core 与 share/git-core/templates（只打 bin/ 会「装上了但 clone 跑不起来」）。
# 为什么内容寻址：件在对象存储上是长缓存，按内容命名才能安全长缓存。
#   名字钉的是 sha，所以**同名必须逐字节同物**：mtime 归一（下面那步）之后，同一棵树重打两颗包
#   字节一致；不归一时装脚本的时间进入 zip 条目头 ⇒ 同名版本重建 6 颗 sha 全变、设备全体重下、
#   对象存储旧键越堆越多（2026-09-30 真机对账定罪）。
set -euo pipefail

HERE=$(dirname "$0")
cd "$HERE/.."
ROOT_DIR=$(pwd)

TOOL="${1:?需要工具名}"
VER=$(cat "dist/${TOOL}.version" 2>/dev/null || echo unknown)
RAW="work/.userland-${TOOL}-raw.zip"
ENTRY=$(bash "$ROOT_DIR/scripts/read-userland-entry.sh" "$TOOL")
[ -f "dist/$ENTRY" ] || { echo "::error title=缺件::dist/$ENTRY 不在（清单入口声明=$ENTRY），先构建"; exit 1; }
STAGE=$(mktemp -d)
cp -a dist/. "$STAGE/"
rm -f "$STAGE"/*.version "$STAGE"/SHA256SUMS $(find "$STAGE" -maxdepth 1 -name '*.zip') 2>/dev/null || true
# zip 把每个条目的 mtime 写进本地头 ⇒ 不归一就是「同一棵树、两颗 sha」。DOS 时间戳的下界是
# 1980-01-01，取它作固定基准（取 1970 会被 zip 夹紧，夹法不保证跨版本一致）。
# -h 是必须的：链接农场里的符号链接也各自带 mtime，不跟着归一，git 那颗仍然是逐字节不可复现。
find "$STAGE" -exec touch -h -t 198001010000.00 {} +
echo "[package] 打包（zip）：bin + 其它 prefix 目录"
# ⚠ 必须 -y（存链接，不跟随）：zip 默认**跟随符号链接**，而 git 的链接农场有上百个指向同一
#   多兆字节二进制的链接 ⇒ 包体会暴涨（tar 默认只存链接，所以从前 23 MB 传得动）。
#   设备侧由 link-farm.txt 重建真实符号链接（原生 Os.symlink），所以包里只要有那份清单即可。
( cd "$STAGE" && zip -q -r -X -y "$ROOT_DIR/$RAW" . )
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
