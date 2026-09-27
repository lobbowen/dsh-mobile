#!/usr/bin/env bash
# sqlite3 CLI —— C 层工具供给批次（供给表 env-sqlite3 的兑现）。
#
# 为什么自己编：上游 sqlite.org 只发源码 amalgamation，没有 android/bionic 二进制。
# 为什么动态（不加 -static）：容器 Linux 语义靠 LD_PRELOAD 落地，静态件会绕过整层
# （2026-09-27 对 bash/rg 的真机定罪）。形态由 scripts/verify-userland-artifact.sh 钉住。
#
# 写法纪律：命令替换只出现在**裸赋值**里（不写成 "$(...)"），避免嵌套引号 —— 首轮 CI
# 就栽在这类解析上（syntax error: unexpected EOF）。简单写法在这里不是风格，是可靠性。
set -euo pipefail

HERE=$(dirname "$0")
cd "$HERE/.."

if [ -z "${CC:-}" ]; then
  echo "[error] 需要 CC（aarch64-linux-android21-clang）"
  exit 1
fi

OUT="${OUT:-dist}"
mkdir -p "$OUT/bin" work

# 不写死版本号：从官方下载页取当前 amalgamation，避免钉一个日后 404 的 URL。
curl -fsSL https://www.sqlite.org/download.html -o work/download.html
URL=$(grep -oE 'https://www[.]sqlite[.]org/[0-9]{4}/sqlite-amalgamation-[0-9]{7}[.]zip' work/download.html | head -n 1)
if [ -z "$URL" ]; then
  echo "[error] 下载页里找不到 amalgamation URL（页面结构变了？）"
  exit 1
fi
VER=$(echo "$URL" | sed -E 's#.*amalgamation-([0-9]{7})[.]zip#\1#')
echo "[sqlite3] 版本码 $VER"

curl -fsSL "$URL" -o work/sqlite.zip
rm -rf work/sqlite
mkdir -p work/sqlite
unzip -q work/sqlite.zip -d work/sqlite
SRC=$(find work/sqlite -maxdepth 1 -type d -name 'sqlite-amalgamation-*' | head -n 1)
if [ -z "$SRC" ]; then
  echo "[error] 解包后没有 sqlite-amalgamation-* 目录"
  exit 1
fi

# shell.c = CLI；sqlite3.c = 引擎。开 JSON1/FTS5（agent 常用）。
"$CC" -O2 -DNDEBUG -DSQLITE_THREADSAFE=1 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_JSON1 \
  -o "$OUT/bin/sqlite3" "$SRC/shell.c" "$SRC/sqlite3.c" -lm -ldl

echo "$VER" > "$OUT/sqlite3.version"
SIZE=$(stat -c%s "$OUT/bin/sqlite3")
echo "[sqlite3] 产出 $OUT/bin/sqlite3（$SIZE 字节）"
