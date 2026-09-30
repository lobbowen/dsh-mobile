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
ROOT_DIR=$(pwd)   # 绝对仓根：下面 fetch-pinned 与 version 格都按它拼路径（本脚本会 cd，相对路径不可用）

if [ -z "${CC:-}" ]; then
  echo "::error title=缺 CC::需要 CC（aarch64-linux-android21-clang）"
  exit 1
fi

OUT="${OUT:-dist}"
mkdir -p "$OUT/bin" work

# 版本与源码都只从钉值表取（scripts/userland-sources.json 的 sqlite3 那一格）。
# 旧写法是**从 sqlite.org 的下载页现刮**第一个 amalgamation 链接：那等于「仓内声明的是哪一版」
#   由网络决定 —— 线上清单写着 3530400，而这一轮刮到哪一版是另一回事，drift 对账就会在
#   「没有一个人改过代码」的轮次里红在 version 格上。升级 = 主动改表里那一格（与 npm/pnpm 同一条纪律）。
echo "[sqlite3] 取源码（钉值表的 sqlite3 那一格）"
bash "$ROOT_DIR/scripts/fetch-pinned.sh" --pin sqlite3 "$ROOT_DIR/work/sqlite.zip" \
  --version-file "$ROOT_DIR/$OUT/sqlite3.version"
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

SIZE=$(stat -c%s "$OUT/bin/sqlite3")
echo "[sqlite3] 产出 $OUT/bin/sqlite3（$SIZE 字节）"
