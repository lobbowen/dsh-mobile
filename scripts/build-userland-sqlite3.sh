#!/usr/bin/env bash
# sqlite3 CLI —— C 层工具供给批次（供给表 env-sqlite3 的兑现）。
#
# 为什么自己编：上游 sqlite.org 只发源码 amalgamation，没有 android/bionic 二进制。
# 为什么动态（不加 -static）：容器 Linux 语义靠 LD_PRELOAD 落地，静态件会绕过整层
# （2026-09-27 对 bash/rg 的真机定罪）。形态由 scripts/verify-userland-artifact.sh 钉住。
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-dist}"
mkdir -p "$OUT/bin" work
: "${CC:?需要 CC（aarch64-linux-android21-clang）"}

# 不写死版本号：从官方下载页取当前 amalgamation，避免钉一个日后 404 的 URL。
URL="$(curl -fsSL https://www.sqlite.org/download.html | grep -o 'https://www.sqlite.org/[0-9]\{4\}/sqlite-amalgamation-[0-9]\{7\}\.zip' | head -1)"
[ -n "$URL" ] || { echo "[error] 没从 sqlite.org/download.html 找到 amalgamation URL（页面结构变了？）"; exit 1; }
VER="$(echo "$URL" | grep -o '[0-9]\{7\}' | head -1)"
echo "[sqlite3] 版本码 $VER <- $URL"
curl -fsSL "$URL" -o work/sqlite.zip
rm -rf work/sqlite && mkdir -p work/sqlite
unzip -q work/sqlite.zip -d work/sqlite
SRC="$(find work/sqlite -maxdepth 1 -type d -name 'sqlite-amalgamation-*' | head -1)"
[ -n "$SRC" ] || { echo "[error] 解包后没找到 sqlite-amalgamation-*"; exit 1; }

# shell.c = CLI；sqlite3.c = 引擎。开 JSON1/FTS5（agent 常用）。
"$CC" -O2 -DNDEBUG -DSQLITE_THREADSAFE=1 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_JSON1 \
  -o "$OUT/bin/sqlite3" "$SRC/shell.c" "$SRC/sqlite3.c" -lm -ldl
echo "$VER" > "$OUT/sqlite3.version"
echo "[sqlite3] 产出 $OUT/bin/sqlite3（$(stat -c%s "$OUT/bin/sqlite3") 字节）"
