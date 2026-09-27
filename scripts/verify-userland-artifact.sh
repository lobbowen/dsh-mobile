#!/usr/bin/env bash
# userland 产物形态门禁：必须是 aarch64 ELF **且动态链接**。
# 动态是硬要求 —— 静态件会绕过 LD_PRELOAD 语义层（2026-09-27 对 bash/rg 的真机定罪）。
# 写法纪律：命令替换只在裸赋值里出现，不写 "$(...)"。
set -euo pipefail

TOOL="${1:?需要工具名}"
BIN="dist/bin/$TOOL"
if [ ! -f "$BIN" ]; then
  echo "::error title=缺产物::dist/bin/$TOOL 没产出"
  exit 1
fi
INFO=$(file -b "$BIN")
echo "[$TOOL] $INFO"

case "$INFO" in
  *"ARM aarch64"*) : ;;
  *) echo "::error title=产物不是 aarch64::$INFO"; exit 1 ;;
esac
case "$INFO" in
  *"dynamically linked"*|*"shared object"*) : ;;
  *) echo "::error title=产物是静态件::$INFO —— 容器 Linux 语义层（LD_PRELOAD）对静态件失效"; exit 1 ;;
esac

SIZE=$(stat -c%s "$BIN")
echo "[ok] $TOOL $SIZE 字节"
