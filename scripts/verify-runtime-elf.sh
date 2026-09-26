#!/usr/bin/env bash
#
# 随包原生 ELF 的「能否自己把自己链接起来」校验 —— 判据的唯一实现。
# 调用点（少一个就留一个放行口子）：构建 build-node-android.sh；打包 fast-apk.yml
# 与 build-apk.yml 的 pre-gradle Gate；固化 release-admin.yml 的 pin；
# 重打包 release-admin.yml 的 repack。
#
# 判据只有一条：一个 ELF 若 DT_NEEDED 了同目录里我们随包投放的库
# （当前就是 libc++_shared.so），它就必须自带 DT_RUNPATH 且值里有 $ORIGIN。
# 只有 DT_RPATH 单独判红 —— bionic 忽略它，所以链接必须带 -Wl,--enable-new-dtags；
# 这一档不拦住，三小时 CI 与一轮真机都白跑。
#
# 为什么这是硬门槛而不是「建议」：dsh 的 run_code 从空环境起子进程，继承不到
# 主进程设的 LD_LIBRARY_PATH。完整论证与 2026-09-26 真机实测见 ARCHITECTURE.md 第 3 节。
#
# 用法: bash scripts/verify-runtime-elf.sh <含随包 .so 的目录>
# 退出: 0 全部合格 / 1 有不合格产物 / 2 环境或用法问题（无法校验就不放行）
set -euo pipefail

DIR="${1:-}"
if [ -z "$DIR" ] || [ ! -d "$DIR" ]; then
  echo "[error] 用法: bash $0 <随包 ELF 目录>"
  exit 2
fi

READELF="${READELF:-}"
if [ -z "$READELF" ]; then
  READELF="$(command -v readelf 2>/dev/null || true)"
fi
if [ -z "$READELF" ]; then
  READELF="$(ls "${ANDROID_NDK:-/nonexistent}"/toolchains/llvm/prebuilt/*/bin/llvm-readelf 2>/dev/null | head -1 || true)"
fi
if [ -z "$READELF" ]; then
  echo "[error] 找不到 readelf / llvm-readelf —— 无法校验就不得放行产物。"
  exit 2
fi
echo "== 校验器: $READELF  目录: $DIR =="

# `|| true` 是必需的：pipefail 之下，目录里没有 .so 时 ls 的非零退出会让赋值语句
# 直接终止脚本（set -e），根本走不到下面那条「没有可校验的东西」的明确报错。
SO_LIST="$(cd "$DIR" && ls *.so 2>/dev/null || true)"
if [ -z "$SO_LIST" ]; then
  echo "[error] $DIR 下没有任何 .so，没有可校验的东西（多半是下载/拷贝没落到位）。"
  exit 2
fi
BUNDLED=" $(printf '%s\n' "$SO_LIST" | tr '\n' ' ') "

fail=0
for f in "$DIR"/*.so; do
  base="$(basename "$f")"
  dyn="$("$READELF" -W -d "$f" 2>/dev/null || true)"
  if [ -z "$dyn" ]; then
    echo "  [FAIL] $base —— readelf 读不出动态段，不是合法 ELF？"
    fail=1
    continue
  fi
  needed="$(printf '%s\n' "$dyn" | awk '/NEEDED/ {gsub(/[\[\]]/,"",$NF); print $NF}')"
  runpath="$(printf '%s\n' "$dyn" | sed -n 's/.*(RUNPATH).*\[\(.*\)\].*/\1/p' | head -1)"
  rpath="$(printf '%s\n' "$dyn" | sed -n 's/.*(RPATH).*\[\(.*\)\].*/\1/p' | head -1)"

  local_deps=""
  for lib in $needed; do
    if [ "$lib" = "$base" ]; then continue; fi
    case "$BUNDLED" in
      *" $lib "*) local_deps="$local_deps $lib" ;;
    esac
  done

  if [ -z "$local_deps" ]; then
    echo "  [skip] $base —— 不依赖同目录随包库（NEEDED: $(printf '%s' "$needed" | tr '\n' ' ')）"
    continue
  fi

  case "$runpath" in
    *'$ORIGIN'*)
      echo "  [ok]   $base —— DT_RUNPATH=[$runpath]，可自解析同目录依赖:$local_deps"
      ;;
    *)
      if [ -n "$rpath" ]; then
        echo "  [FAIL] $base —— 只有 DT_RPATH=[$rpath]，bionic 忽略它。"
        echo "         链接须加 -Wl,--enable-new-dtags 才能产出 DT_RUNPATH。"
      else
        echo "  [FAIL] $base —— 无 DT_RUNPATH，却依赖同目录随包库:$local_deps"
        echo "         空环境（dsh run_code 起子进程）下必然 CANNOT LINK。"
      fi
      printf '%s\n' "$dyn" | { grep -E "RPATH|RUNPATH|NEEDED" || true; } | sed 's/^/         /'
      fail=1
      ;;
  esac
done

if [ "$fail" -ne 0 ]; then
  echo "==> [error] 有原生产物不能满足「空环境下自解析依赖」，拒绝。"
  exit 1
fi
echo "==> [ok] 全部原生产物可自解析同目录依赖"
