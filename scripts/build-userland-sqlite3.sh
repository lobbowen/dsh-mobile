#!/usr/bin/env bash
# sqlite3 CLI —— C 层工具供给批次（供给表 env-sqlite3 的兑现）。
#
# 为什么自己编：上游 sqlite.org 只发源码 amalgamation，没有 android/bionic 二进制。
# 为什么动态（不加 -static）：容器 Linux 语义靠 LD_PRELOAD 落地，静态件会绕过整层
# （2026-09-27 对 bash/rg 的真机定罪）。形态由 scripts/verify-userland-artifact.sh 钉住。
#
# 写法纪律（首轮 CI 两连栽的教训）：
#   ① 命令替换只出现在裸赋值里（不写双引号包起来的命令替换），避免嵌套引号解析风险；
#   ② 可能「没命中」的管道一律带 `|| true` —— `set -euo pipefail` 下 grep 未命中会让整条
#      管道非零，脚本会在我的空值检查**之前**静默退出（首轮就是这样，日志里一个字都没有）；
#   ③ 每步都要有声音，失败要能一眼看出是哪一步。
set -euo pipefail

HERE=$(dirname "$0")
cd "$HERE/.."

if [ -z "${CC:-}" ]; then
  echo "::error title=缺 CC::需要 CC（aarch64-linux-android21-clang）"
  exit 1
fi

OUT="${OUT:-dist}"
mkdir -p "$OUT/bin" work

PAGE=https://www.sqlite.org/download.html
echo "[sqlite3] 取下载页 $PAGE"
if ! curl -fsSL "$PAGE" -o work/download.html; then
  echo "::error title=下载页取不到::$PAGE（网络/DNS/证书）"
  exit 1
fi
BYTES=$(stat -c%s work/download.html)
echo "[sqlite3] 下载页 $BYTES 字节"

# 页面里是相对链接（2024/sqlite-amalgamation-XXXXXXX.zip），只匹配尾巴，两种写法都吃得下。
REL=$(grep -oE '[0-9]{4}/sqlite-amalgamation-[0-9]{7}[.]zip' work/download.html | head -n 1 || true)
if [ -z "$REL" ]; then
  echo "::error title=找不到 amalgamation 链接::下载页里没有 [0-9]{4}/sqlite-amalgamation-[0-9]{7}.zip（页面结构变了？前 3 条 zip 链接如下）"
  grep -oE '[A-Za-z0-9._/-]+[.]zip' work/download.html | head -n 3 || true
  exit 1
fi
URL="https://www.sqlite.org/$REL"
VER=$(echo "$REL" | sed -E 's#.*-([0-9]{7})[.]zip#\1#')
echo "[sqlite3] 版本码 $VER <- $URL"

if ! curl -fsSL "$URL" -o work/sqlite.zip; then
  echo "::error title=amalgamation 取不到::$URL"
  exit 1
fi
echo "[sqlite3] 源码包 $(stat -c%s work/sqlite.zip) 字节"
rm -rf work/sqlite
mkdir -p work/sqlite
unzip -q work/sqlite.zip -d work/sqlite
SRC=$(find work/sqlite -maxdepth 1 -type d -name 'sqlite-amalgamation-*' | head -n 1 || true)
if [ -z "$SRC" ]; then
  echo "::error title=解包异常::解包后没有 sqlite-amalgamation-* 目录"
  find work/sqlite -maxdepth 2 | head -n 10 || true
  exit 1
fi
echo "[sqlite3] 源码树 $SRC"

# shell.c = CLI；sqlite3.c = 引擎。开 JSON1/FTS5（agent 常用）。
"$CC" -O2 -DNDEBUG -DSQLITE_THREADSAFE=1 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_JSON1 \
  -o "$OUT/bin/sqlite3" "$SRC/shell.c" "$SRC/sqlite3.c" -lm -ldl

echo "$VER" > "$OUT/sqlite3.version"
SIZE=$(stat -c%s "$OUT/bin/sqlite3")
echo "[sqlite3] 产出 $OUT/bin/sqlite3（$SIZE 字节）"
