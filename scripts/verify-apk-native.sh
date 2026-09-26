#!/usr/bin/env bash
#
# APK 内原生件清单审计 —— 「包里到底有没有运行期要的东西」的唯一实现。
# 调用点（少一个就留一个放行口子）：打包 fast-apk.yml 与 build-apk.yml 的
# Audit APK contents；诊断 release-admin.yml 的 diag 模式（--report，只出事实）。
#
# 为什么要这一步（真实教训）：真机报 cannot locate symbol
# "_ZTVNSt6__ndk119basic_ostringstream..."，那是运行期动态链接找不到
# libc++_shared.so 的表现；当时的门禁只查 jniLibs 目录，没查真正打进 APK 的
# 条目，于是「编译成功」和「真机可跑」之间有一道没人守的门。
# 与其让它在真机上失败，不如在这里失败 —— 反馈快得多。
#
# 判据（gate 模式，逐条硬红）：
#   1) APK 可读且 lib/ 下有条目            —— 零条目 = 审计无对象，不放行
#   2) 不含 assets/kernel/                 —— ADR-0005：内核只从 OTA 源安装
#   3) 自有小件必产（libdshflock/libdshposix/libdshptyprobe）
#   4) $PREFIX 依赖件必产（libbash/libdshrg，无回退路径）
#   5) libdshpty.so 软失败 —— 缺席只是终端 PTY 降级，::warning::
#   6) assets/npm/npm.zip 与 version.txt   —— 缺了面板装不了任何 Agent
#   7) .github/native-assets.txt 逐资产（名字即判据数据，加资产不改这里）
#   8) adb-client 逐个 JS + 件数与源码目录一致 —— ADR-0003 权限通道的字节
#
# 处置口径：report 模式【永不判红】（退 0），把同样的条目逐条打成
# [ok]/[MISSING] 事实 —— 报告通道的读者是操作者，判红会中止后续取证步骤。
#
# 用法: bash scripts/verify-apk-native.sh <apk 路径> [abi] [--report]
# 退出: 0 通过（或 report 模式）/ 1 审计不通过 / 2 用法或环境不成立（无法审计不放行）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APK="${1:-}"
ABI="${2:-${ABI:-}}"
MODE="${3:-}"
if [ "$MODE" = "--abi" ]; then MODE="${3:-}"; fi
if [ -z "$APK" ] || [ ! -f "$APK" ]; then
  echo "[error] 用法: bash $0 <apk> [abi] [--report]（apk 必须存在 —— 审计不许空跑）"
  exit 2
fi
case "$MODE" in
  --report) REPORT=1 ;;
  "") REPORT=0 ;;
  *) echo "[error] 未知模式 '$MODE'"; exit 2 ;;
esac
# gate 模式没有 ABI 就无法拼出 lib/<abi>/... 的条目名；静默用错默认值
# 会把「装错了 ABI 的包」判成通过，所以缺它直接拒绝开工。
if [ "$REPORT" = "0" ] && [ -z "$ABI" ]; then
  echo "[error] 未给 ABI（第二个参数或 \$ABI）—— 条目名无从拼出，审计无法进行。"
  exit 2
fi
[ -n "$ABI" ] || ABI="arm64-v8a"   # report 模式允许缺省（diag 一直这么干）

command -v unzip >/dev/null 2>&1 || { echo "[error] 找不到 unzip —— 无法审计就不得放行。"; exit 2; }
LIST="$(unzip -l "$APK" 2>/dev/null || true)"
[ -n "$LIST" ] || {
  if [ "$REPORT" = "1" ]; then echo "  [FAIL] unzip 读不出条目清单"; exit 0; fi
  echo "[error] unzip 读不出 $APK 的条目清单（不是合法 zip？）"; exit 1
}

has() { printf '%s\n' "$LIST" | grep -q -- "$1"; }
# grep -c 在无命中时退 1（pipefail 下会让赋值直接中止脚本），且必须保证拿到的是数字：
# 读不出数字时返回 -1，让后面的件数比对必然红，而不是「空值 == 空值」静默相等放行。
count() {
  local n
  n="$(printf '%s\n' "$LIST" | { grep -c -- "$1" || true; })"
  case "$n" in ('') n=-1 ;; esac
  printf '%s' "$n"
}

MISSING=""
note_missing() { # $1=条目 $2=人话原因
  if [ "$REPORT" = "1" ]; then
    echo "  [MISSING] $1 —— $2"
  else
    echo "[error] APK 里缺少 $1"
    echo "        $2"
  fi
  MISSING="$MISSING $1"
}

echo "== APK: $APK ($(stat -c%s "$APK") 字节, ABI=$ABI) =="
echo "--- lib/ 下的条目 ---"
if [ "$REPORT" = "1" ]; then
  # 本节刻意【不以空行收尾】：调用方常用 sed -n '/节名/,/^$/p' 截段，
  # 段尾空行会把本节内容截成只剩标题。
  printf '%s\n' "$LIST" | grep 'lib/' | sed 's/^/  /' || echo "  (无 lib/ 条目 —— 严重异常)"
elif ! printf '%s\n' "$LIST" | grep -q 'lib/'; then
  echo "[error] 没有 lib/ 条目 —— 原生件一个都不在，审计无对象，不放行。"
  exit 1
fi

# --- 内核资产（必须为空，ADR-0005）---
echo
echo "--- 内核资产（必须为空）---"
if has 'assets/kernel/'; then
  if [ "$REPORT" = "1" ]; then
    # 「不该有却有」不是「缺项」—— 单记 FAIL，不混进缺项清单。
    echo "  [FAIL] 含 assets/kernel/ —— ADR-0005 规定内核不随 APK 分发"
    printf '%s\n' "$LIST" | grep -E 'assets/kernel/' | sed 's/^/    /' || true
  else
    echo "::error title=APK 含内核资产::ADR-0005 规定内核不随 APK 分发（内核只从 OTA 源安装）。"
    printf '%s\n' "$LIST" | grep -E 'assets/kernel/' || true
    exit 1
  fi
else
  echo "[ok] APK 不含内核资产（内核经 OTA 安装）"
fi

# --- 小体积原生件（刻意不登记 native-assets.txt 的那批）---
# 自有 C 编译失败即环境问题 ⇒ 硬红；bash/rg 来自上游源码配方但 $PREFIX 无回退 ⇒ 硬红；
# node-pty 配方缺席只降级：缺件时垫片逐字回退原语义，不该让其它能力陪葬。
echo
echo "--- 小体积原生件 ---"
for b in libdshflock.so libdshposix.so libdshptyprobe.so; do
  has "lib/${ABI}/$b" && echo "[ok] lib/${ABI}/$b" \
    || note_missing "lib/${ABI}/$b" "自有 C，必产（编译失败即环境问题）"
done
for b in libbash.so libdshrg.so; do
  has "lib/${ABI}/$b" && echo "[ok] lib/${ABI}/$b" \
    || note_missing "lib/${ABI}/$b" "\$PREFIX 依赖它，无回退路径"
done
if has "lib/${ABI}/libdshpty.so"; then
  echo "[ok] lib/${ABI}/libdshpty.so"
else
  MISSING="$MISSING lib/${ABI}/libdshpty.so"
  if [ "$REPORT" = "1" ]; then
    echo "  [soft-absent] lib/${ABI}/libdshpty.so —— 终端 PTY 降级"
  else
    echo "::warning title=能力降级::lib/${ABI}/libdshpty.so 不在 APK —— 终端 PTY 不可用"
  fi
fi

# --- npm 基础环境（缺了面板装不了任何 Agent，核心能力不是可选增强）---
echo
echo "--- npm 基础环境 ---"
if has 'assets/npm/npm.zip'; then
  SIZE="$(printf '%s\n' "$LIST" | awk '/assets\/npm\/npm\.zip/{print $1}' | head -1)"
  echo "[ok] 含 assets/npm/npm.zip（${SIZE:-?} 字节）"
  if has 'assets/npm/version.txt'; then
    echo "[ok] 含 assets/npm/version.txt"
  else
    note_missing "assets/npm/version.txt" "npm.zip 在但版本戳缺失（解包版本无从确定）"
  fi
else
  note_missing "assets/npm/npm.zip" "面板无法安装任何 Agent。常见原因：Stage pinned npm 步骤（scripts/stage-npm-assets.sh）被删/改名。"
fi

# --- 原生资产清单：名字住在 .github/native-assets.txt，这里不硬编码 ---
echo
echo "--- native-assets.txt 逐资产 ---"
ASSETS="$(grep -v '^[[:space:]]*#' "$ROOT/.github/native-assets.txt" | grep -v '^[[:space:]]*$' | tr -d '\r' || true)"
if [ -z "$ASSETS" ]; then
  if [ "$REPORT" = "1" ]; then
    echo "  [FAIL] 清单为空 —— 本节一条都不会检查"
  else
    echo "[error] .github/native-assets.txt 里没有任何资产 —— 审计无意义，中止。"
    exit 1
  fi
fi
for a in $ASSETS; do
  has "lib/${ABI}/$a" && echo "[ok] lib/${ABI}/$a" \
    || note_missing "lib/${ABI}/$a" "清单来源: .github/native-assets.txt（NativeAssetRegistry 的投影）"
done

# --- adb-client 资产（ADR-0003：ADB 配对/shell 的唯一实现，运行时由
#     NodeProvisioner.ensureAdbClientScripts 整目录复制到 files/adb-client）---
# 文件集合以 src/main/assets 目录为事实源：加文件忘了打包、或误删，都会在这里红。
echo
echo "--- adb-client 资产 ---"
SRC_DIR="$ROOT/container/app/src/main/assets/node/adb-client"
SRC_N=0
for f in "$SRC_DIR"/*.js; do
  [ -e "$f" ] || continue
  SRC_N=$((SRC_N + 1))
  n="assets/node/adb-client/$(basename "$f")"
  has "$n" && echo "[ok] $n" || note_missing "$n" "adb-client 权限通道字节"
done
if [ "$SRC_N" = "0" ]; then
  if [ "$REPORT" = "1" ]; then echo "  [FAIL] 源码目录无 adb-client JS"; else
    echo "[error] $SRC_DIR 下没有 .js —— 审计无对象，不放行。"; exit 1
  fi
fi
APK_N="$(count 'assets/node/adb-client/[^/]*\.js$')"
if [ "$SRC_N" != "$APK_N" ]; then
  if [ "$REPORT" = "1" ]; then
    echo "  [MISSING] adb-client 件数不一致：源码 $SRC_N vs APK $APK_N"
  else
    echo "[error] adb-client 件数不一致：源码 $SRC_N vs APK $APK_N"; exit 1
  fi
  MISSING="$MISSING adb-client-count"
fi

echo
echo "--- 压缩方式（Stored=未压缩 / Defl=压缩）---"
unzip -v "$APK" | awk '$NF ~ /lib\// {print "  " $NF "  " $2 "  " $3 "  " $4}' || true

if [ "$REPORT" = "1" ]; then
  if [ -n "$MISSING" ]; then
    echo
    echo "  结果: ✗ 缺项:$MISSING（report 模式不判红，只列事实）"
  else
    echo
    echo "  结果: ✓ 全部条目在位"
  fi
  exit 0
fi

if [ -n "$MISSING" ]; then
  echo "==> [error] 审计不通过，缺项:$MISSING"
  echo "    这正是真机 'cannot locate symbol _ZTVNSt6__ndk119basic_ostringstream'"
  echo "    一类故障的直接原因。请检查 scripts/build-node-android.sh 的打包段、"
  echo "    app/build.gradle.kts 的 jniLibs 配置与各 Stage 步骤。"
  exit 1
fi
echo "==> [ok] APK 原生件审计通过（资产/小件/npm/adb-client 全在包里）"
