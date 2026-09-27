#!/usr/bin/env bash
# userland 产物形态门禁：必须是 aarch64 ELF **且动态链接**。
# 动态是硬要求 —— 静态件会绕过 LD_PRELOAD 语义层（2026-09-27 对 bash/rg 的真机定罪）。
set -euo pipefail
TOOL="${1:?需要工具名}"
BIN="dist/bin/$TOOL"
[ -f "$BIN" ] || { echo "::error title=缺产物::dist/bin/$TOOL 没产出"; exit 1; }
INFO="$(file -b "$BIN")"
case "$INFO" in *"ARM aarch64"*) : ;; *) echo "::error title=产物不是 aarch64::$(printf '%s' "$INFO")"; exit 1 ;; esac
case "$INFO" in
  *"dynamically linked"*|*"shared object"*) : ;;
  *) echo "::error title=产物是静态件::$(printf '%s' "$INFO") —— 容器 Linux 语义层（LD_PRELOAD）对静态件失效"; exit 1 ;;
esac
echo "[ok] $TOOL $(stat -c%s "$BIN") 字节；$INFO"
