#!/usr/bin/env bash
# 判据：openssl 生成的构建信息头里那句构建时间，必须等于仓内钉住的时间基准。
#
# 为什么单独判这一格（债表 ENV-32）：件的 sha256 决定它在对象存储上的键，也决定设备要不要重下。
#   上游 mkbuildinf.pl 在没有 SOURCE_DATE_EPOCH 时写的是**当时**的墙钟，而构建口「设过环境变量」
#   并不等于生效（键名/形状错了一句都不响），所以判据只看生成出来的那一行。
# 头文件名不写死在这里：整个源码树里 grep 那句 built on:，抓到哪份判哪份 —— 抓不到就是判据空转，红。
# 用法: bash scripts/verify-userland-build-date.sh <openssl 源码目录>
set -euo pipefail

HERE=$(dirname "$0")
ROOT_DIR=$(cd "$HERE/.." && pwd)
SRC="${1:?用法: $0 <openssl 源码目录>}"

EPOCH=$(bash "$ROOT_DIR/scripts/fetch-pinned.sh" --time-base)
# 期望串按上游写法拼：perl 标量 gmtime 的形状是 "%a %b %e %H:%M:%S %Y"，mkbuildinf.pl 再缀 " UTC"。
# LC_ALL=C 不是装饰：perl 的 ctime 永远是英文月份/星期，而本机 date 会跟着 locale 吐出「四 1月」，
# 那样拼出来的期望串和自己比自己绿、跟件里的真串却永远不合（2026-10-01 本机实测踩到）。
EXPECT="built on: $(LC_ALL=C date -u -d "@$EPOCH" '+%a %b %e %H:%M:%S %Y') UTC"

# 文件名取自上游 crypto/build.info:118 的 GENERATE[buildinf.h]（生成的头就叫这个名），
# 但**路径不写死**：3.x 把它挪过目录，写死一个 include/... 就是猜。找不到即红 —— 那是判据空转，不是清白。
HEAD=$(find "$SRC" -name buildinf.h 2>/dev/null | head -n1 || true)
[ -n "$HEAD" ] || { echo "::error title=找不到构建信息头::$SRC 下没有生成出的 buildinf.h —— 上游换了机制，本判据成了空尺子，必须重新定位而不是放过"; exit 1; }

LINE=$(grep -m1 'built on:' "$HEAD" || true)
[ -n "$LINE" ] || { echo "::error title=构建信息头里没有日期行::$HEAD 抓到了却 grep 不到 built on:，夹具假设失效，不许放过"; exit 1; }
echo "[build-date] 头文件=$HEAD"
echo "[build-date] 实际=$LINE"
echo "[build-date] 期望=$EXPECT"
printf '%s' "$LINE" | grep -qF "$EXPECT" || {
  echo "::error title=件字节随墙钟动::构建时间没钉住（buildTimeEpoch=$EPOCH）。这一轮的 curl/git 会与上一轮同名不同 sha。"
  exit 1
}
echo "[ok] 构建时间钉在 $EXPECT"
