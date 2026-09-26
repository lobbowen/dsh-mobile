#!/usr/bin/env bash
#
# 随包原生 ELF 的形态判据 —— 「这份东西装到真机上能不能被跑起来」的唯一实现。
# 调用点（少一个就留一个放行口子）：构建 build-node-android.sh；打包 fast-apk.yml
# 与 build-apk.yml 的 pre-gradle Gate；固化 release-admin.yml 的 pin；重打包同文件的 repack。
#
# 五条判据。同一条事实此前有五处出口、三份实现、两种严格度（pin 判红，构建脚本只打
# [info]/[warn]，build-apk 只判架构），2026-09-27 收口成一份实现、一种结论。
#
#  1) 架构：e_machine 必须是 AArch64。装错架构上机就是 exec format error。
#  2) 16KB 页对齐：**每一个** PT_LOAD 的 p_align 都要是 0x4000 的整数倍。
#     旧实现判的是「输出里存在字符串 0x4000」，两个方向都错：aarch64 链接器默认给
#     0x10000（同样满足 16KB 页）会被判红；而多段里只有一段是 0x4000、另一段退回
#     0x1000 时又被放行 —— 那种产物在 16KB 页设备上就是 ELIBBAD。逐段取模才是这件事的判据。
#  3) 解释器：只要声明了 PT_INTERP，值必须是 /system/bin/linker64 —— 值是 glibc 的
#     ld 就说明这份产物是拿主机工具链链出来的，bionic 上无法 exec。
#     「可执行资产必须有 PT_INTERP」由清单声明（--manifest，即 NativeAssetRegistry 的
#     投影）：共享库（libc++_shared.so、NDK 现编的 libdshflock.so）天生没有 PT_INTERP，
#     拿它当硬条件会把好产物判红 —— 这正是构建脚本原来打 [info] 的那件事，两条都对，
#     区别只在「这个文件是不是要被 exec」，而那件事注册表知道，不必靠猜。
#  4) 依赖闭环：DT_NEEDED 里的每个库，要么系统提供（白名单只住 scripts/native-deps.txt
#     一处），要么就在本目录里随包投放。
#  5) 自解析：判到同目录随包依赖（当前就是 libc++_shared.so）时，必须自带 DT_RUNPATH
#     且值里有 $ORIGIN。只有 DT_RPATH 单独判红 —— bionic 忽略它，所以链接必须带
#     -Wl,--enable-new-dtags；这一档不拦住，三小时 CI 与一轮真机都白跑。
#
# 为什么 5 是硬门槛而不是「建议」：dsh 的 run_code 从空环境起子进程，继承不到主进程
# 设的 LD_LIBRARY_PATH。完整论证与 2026-09-26 真机实测见 ARCHITECTURE.md 第 3 节。
#
# 取数一律 LC_ALL=C：readelf 的字段名会随 locale 本地化（zh_CN 下 "Machine:" 变成
# 「机器:」），届时下面每一条 awk/sed 都不命中 —— 判据会静默空转成全绿。本机就是
# zh_CN.UTF-8，CI runner 恰好是 C.UTF-8，所以这个坑只在本地暴露。
#
# 全文不用 `| head`：pipefail 之下 sed/grep 可能在 head 关闭管道后拿到 SIGPIPE，
# 把「命中」翻成「未命中」。本仓已有前科（scripts/verify-apk-native.sh 头部记录）。
#
# 用法: bash scripts/verify-runtime-elf.sh [选项] <含随包 .so 的目录>
#   --deps <文件>      系统库白名单，默认与本脚本同级的 native-deps.txt
#   --manifest <文件>  可执行资产清单（.github/native-assets.txt，注册表的投影）
# 退出: 0 全部合格 / 1 有不合格产物 / 2 环境或用法问题（无法校验就不放行）
set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPS_FILE="$SCRIPT_DIR/native-deps.txt"
MANIFEST_FILE="$SCRIPT_DIR/../.github/native-assets.txt"

DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --deps)     [ $# -ge 2 ] || { echo "[error] --deps 缺值"; exit 2; }; DEPS_FILE="$2"; shift 2 ;;
    --manifest) [ $# -ge 2 ] || { echo "[error] --manifest 缺值"; exit 2; }; MANIFEST_FILE="$2"; shift 2 ;;
    -*)         echo "[error] 不认识的选项：$1"; echo "[error] 用法: bash $0 [--deps F] [--manifest F] <随包 ELF 目录>"; exit 2 ;;
    *)          [ -z "$DIR" ] || { echo "[error] 只接受一个目录参数（已给过 $DIR，又多一个 $1）"; exit 2; }
                DIR="$1"; shift ;;
  esac
done
if [ -z "$DIR" ] || [ ! -d "$DIR" ]; then
  echo "[error] 用法: bash $0 [--deps F] [--manifest F] <随包 ELF 目录>（目录不存在：${DIR:-未给}）"
  exit 2
fi

READELF="${READELF:-}"
if [ -z "$READELF" ]; then
  READELF="$(command -v readelf 2>/dev/null || true)"
fi
if [ -z "$READELF" ]; then
  # 不用 `ls … | head -1`：pipefail 之下那是本仓已定罪的形态（见文件头）。
  # glob 不命中时 bash 会给出带 * 的字面量，[ -f ] 自然判否，不需要额外容错。
  for _cand in "${ANDROID_NDK:-/nonexistent}"/toolchains/llvm/prebuilt/*/bin/llvm-readelf; do
    if [ -f "$_cand" ]; then READELF="$_cand"; break; fi
  done
fi
if [ -z "$READELF" ]; then
  echo "[error] 找不到 readelf / llvm-readelf —— 无法校验就不得放行产物。"
  exit 2
fi
# 「工具在不在」与「产物合不合格」是两种失败：前者退 2（环境），后者退 1（产物）。
# 判据只有一条 —— readelf 能不能真的跑起来。READELF 是调用方显式指定的，指错了
# （路径不存在、不可执行、被截断的二进制）与 runner 上根本没装 binutils 是同一种事故：
# 不判可执行性，取数会一份一份地失败，最终报成「产物不是合法 ELF / 读不出 Program
# Headers」，把环境问题伪装成产品的罪。判「能不能跑」而非「是不是 ELF」，因为缺共享库
# 的可执行文件同样起不来，而 `[ -x ]` 会通过。
if ! "$READELF" --version >/dev/null 2>&1; then
  echo "[error] 指定的 readelf 无法执行：$READELF"
  echo "        这是环境/用法问题（不是产物不合格）—— 取不出数据就一条判据都不会跑，拒绝校验。"
  exit 2
fi
echo "[info] 使用 readelf: $READELF"

# 系统库白名单：读不出来 / 读成空 = 判据 4 会「全部 NEEDED 都算缺失」或「全部都不算缺」，
# 两种空转都比红危险，所以宁可不放行。
if [ ! -f "$DEPS_FILE" ]; then
  echo "[error] 找不到系统库白名单: $DEPS_FILE"
  exit 2
fi
SYSTEM_LIBS=" $( { grep -v '^[[:space:]]*#' "$DEPS_FILE" | grep -v '^[[:space:]]*$' || true; } | tr -d '\r' | tr '\n' ' ') "
[ -n "${SYSTEM_LIBS// /}" ] || { echo "[error] $DEPS_FILE 里没有任何库名（是不是被清空了？）"; exit 2; }

# 可执行资产清单：判据 3 的「谁要被 exec」来自这里，不接受在本文件或调用点里另写文件名。
# 缺标记段 = 拿到空的可执行集合 = 判据 3 整条空转，所以按「读不出就不放行」处置。
if [ ! -f "$MANIFEST_FILE" ]; then
  echo "[error] 找不到可执行资产清单: $MANIFEST_FILE —— 判据 3 无从进行。"
  exit 2
fi
EXEC_SET=" $( { sed -n '/可执行资产本体/,$p' "$MANIFEST_FILE" \
                | grep -v '^[[:space:]]*#' | grep -v '^[[:space:]]*$' || true; } | tr -d '\r' | tr '\n' ' ') "
[ -n "${EXEC_SET// /}" ] || { echo "[error] $MANIFEST_FILE 里没有「可执行资产本体」段或其为空 —— 判据 3 会空转，拒绝校验。"; exit 2; }

# 先把自己读到了什么打出来，再做「有没有东西可查」的判断：退 2 的场景里
# （空目录 / 缺可执行资产）调用方也要看得见白名单与清单是不是取对了。
echo "== 校验器: $READELF  目录: $DIR =="
echo "   系统库白名单: $DEPS_FILE（$(printf '%s' "$SYSTEM_LIBS" | wc -w) 项）"
echo "   可执行资产: $EXEC_SET"

# `|| true` 是必需的：pipefail 之下，目录里没有 .so 时 ls 的非零退出会让赋值语句
# 直接终止脚本（set -e），根本走不到下面那条「没有可校验的东西」的明确报错。
SO_LIST="$(cd "$DIR" && ls *.so 2>/dev/null || true)"
if [ -z "$SO_LIST" ]; then
  echo "[error] $DIR 下没有任何 .so，没有可校验的东西（多半是下载/拷贝没落到位）。"
  exit 2
fi
BUNDLED=" $(printf '%s\n' "$SO_LIST" | tr '\n' ' ') "

# 目录里至少要有一个清单声明的可执行资产，否则「判据 3 跑过了」是假的。
SEEN_EXEC=""
for _b in $EXEC_SET; do
  case "$BUNDLED" in *" $_b "*) SEEN_EXEC="$SEEN_EXEC $_b" ;; esac
done
[ -n "$SEEN_EXEC" ] || { echo "[error] $DIR 里没有清单声明的可执行资产（$EXEC_SET）—— 判据 3 将一条不跑，拒绝校验。"; exit 2; }

fail=0
for f in "$DIR"/*.so; do
  base="$(basename "$f")"
  line=""          # 汇总本文件命中的判据，成功时一行打完
  hdr="$("$READELF" -W -h "$f" 2>/dev/null || true)"
  if [ -z "$hdr" ]; then
    echo "  [FAIL] $base —— readelf 读不出 ELF 文件头，不是合法 ELF？"
    fail=1
    continue
  fi
  phdrs="$("$READELF" -W -l "$f" 2>/dev/null || true)"
  if [ -z "$phdrs" ]; then
    echo "  [FAIL] $base —— readelf 读不出 Program Headers，形态判据全部无从进行。"
    fail=1
    continue
  fi

  # ── 1) 架构 ────────────────────────────────────────────────────────────
  machine="$(printf '%s\n' "$hdr" | awk -F': *' '/^[[:space:]]*Machine:/{gsub(/[[:space:]]+$/,"",$2); print $2}')"
  if [ "$machine" != "AArch64" ]; then
    echo "  [FAIL] $base —— 架构是「${machine:-读不出}」，不是 AArch64。"
    echo "         本仓只投 arm64-v8a；装到真机上就是 exec format error。"
    printf '%s\n' "$hdr" | { grep -E "Machine|Type:" || true; } | sed 's/^/         /'
    fail=1
    continue
  fi
  line="arch=AArch64"

  # ── 2) 16KB 页对齐（逐段取模）──────────────────────────────────────────
  load_aligns="$(printf '%s\n' "$phdrs" | awk '/^[[:space:]]*LOAD/{print $NF}')"
  if [ -z "$load_aligns" ]; then
    echo "  [FAIL] $base —— 没有 LOAD 段（或读不出），16KB 对齐判据无从进行。"
    printf '%s\n' "$phdrs" | sed 's/^/         /'
    fail=1
    continue
  fi
  bad_align=""
  n_load=0
  while IFS= read -r al; do
    [ -n "$al" ] || continue
    case "$al" in
      0x[0-9a-fA-F]*) : ;;
      *) bad_align="$bad_align $al(非十六进制，取数取错列)"; continue ;;
    esac
    dec=$(( al ))
    # 16KB = 16384 字节 = 0x4000。这里必须用十进制常量：写成 4096 就是 4KB 页，
    # 判据会放过所有 4KB 对齐的产物（夹具 ③ 那条用例就是钉它的）。
    if [ "$dec" -eq 0 ] || [ $(( dec % 16384 )) -ne 0 ]; then
      bad_align="$bad_align $al"
    fi
    n_load=$(( n_load + 1 ))
  done <<<"$load_aligns"
  if [ -n "$bad_align" ]; then
    echo "  [FAIL] $base —— 这些 LOAD 段的对齐不是 16KB 的整数倍:$bad_align"
    echo "         Android 15+ 在 16KB 页设备上会返回 ELIBBAD / Exec format error。"
    printf '%s\n' "$phdrs" | { grep -E '^ *LOAD' || true; } | sed 's/^/         /'
    fail=1
    continue
  fi
  line="$line 16KB-ok(${n_load}段)"

  # ── 动态段：判据 3/4/5 的取数 ──────────────────────────────────────────
  dyn="$("$READELF" -W -d "$f" 2>/dev/null || true)"
  has_dynamic="$(printf '%s\n' "$phdrs" | awk '/^[[:space:]]*DYNAMIC/{print "y"}')"
  needed="$(printf '%s\n' "$dyn" | awk '/NEEDED/ {gsub(/[\[\]]/,"",$NF); print $NF}')"
  runpath="$(printf '%s\n' "$dyn" | sed -n 's/.*(RUNPATH).*\[\(.*\)\].*/\1/p')"
  rpath="$(printf '%s\n' "$dyn" | sed -n 's/.*(RPATH).*\[\(.*\)\].*/\1/p')"

  # ── 3) 解释器 ──────────────────────────────────────────────────────────
  interp="$(printf '%s\n' "$phdrs" | sed -n 's/.*\[Requesting program interpreter: \(.*\)\].*/\1/p')"
  is_exec=0
  case "$EXEC_SET" in
    *" $base "*) is_exec=1 ;;
  esac
  if [ -n "$interp" ] && [ "$interp" != "/system/bin/linker64" ]; then
    echo "  [FAIL] $base —— PT_INTERP=$interp —— 这不是 bionic 的解释器。"
    echo "         说明它是拿主机（glibc）工具链链接的，真机上无法 exec。"
    fail=1
    continue
  fi
  if [ "$is_exec" = 1 ]; then
    if [ -z "$interp" ]; then
      echo "  [FAIL] $base —— 清单说它是要被 exec 的可执行资产，却没有 PT_INTERP。"
      echo "         带 DT_NEEDED 又没有解释器的 ELF，内核起不来（没人替它映射 libc）。"
      echo "         解法：确认它是静态链接（那就把它从可执行资产里摘掉并核对探针），"
      echo "         或核对 android-configure / 交叉链接参数是否用了 NDK 工具链。"
      fail=1
      continue
    fi
    line="$line interp=$interp"
  else
    line="$line ${interp:+interp=$interp}${interp:-interp=无(非可执行资产)}"
  fi

  # ── 动态段能否取数 ─────────────────────────────────────────────────────
  # 判「静态产物」用 PT_DYNAMIC 在不在，不用「readelf -d 输出了什么」：readelf 对
  # 没有动态段的文件照样打印一行 "There is no dynamic section in this file."，
  # 拿输出判空会把「取数失败」和「真的没依赖」混成同一种情形。
  if [ -z "$has_dynamic" ]; then
    echo "  [skip] $base —— 无 PT_DYNAMIC（静态产物），只判架构/对齐/解释器：$line"
    continue
  fi
  case "$dyn" in
    *Dynamic*) : ;;
    *)
      echo "  [FAIL] $base —— 有 PT_DYNAMIC 却读不出动态段内容，取数失败而非「无依赖」。"
      fail=1
      continue
      ;;
  esac

  # ── 4) 依赖闭环 ────────────────────────────────────────────────────────
  if [ -z "$needed" ]; then
    echo "  [ok]   $base —— 动态段里没有 DT_NEEDED（无外部依赖）：$line"
    continue
  fi
  missing=""
  local_deps=""
  n_needed=0
  for lib in $needed; do
    n_needed=$(( n_needed + 1 ))
    if [ "$lib" = "$base" ]; then continue; fi
    case "$SYSTEM_LIBS" in
      *" $lib "*) continue ;;
    esac
    case "$BUNDLED" in
      *" $lib "*) local_deps="$local_deps $lib" ;;
      *) missing="$missing $lib" ;;
    esac
  done
  if [ -n "$missing" ]; then
    echo "  [FAIL] $base —— 这些依赖既不在系统白名单、也没随包投放:$missing"
    echo "         白名单只住 $DEPS_FILE；装到真机上报 'cannot locate symbol'。"
    printf '%s\n' "$dyn" | { grep -E "NEEDED" || true; } | sed 's/^/         /'
    fail=1
    continue
  fi
  line="$line needed=$(printf '%s' "$needed" | wc -w)项闭环"

  # ── 5) 同目录依赖能否自解析 ────────────────────────────────────────────
  if [ -z "$local_deps" ]; then
    echo "  [ok]   $base —— 不依赖同目录随包库：$line"
    continue
  fi
  case "$runpath" in
    *'$ORIGIN'*)
      echo "  [ok]   $base —— 可自解析同目录依赖:$local_deps；$line RUNPATH=[$runpath]"
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
  echo "==> [error] 有原生产物不满足「形态 + 空环境下自解析依赖」，拒绝。"
  exit 1
fi
echo "==> [ok] 全部原生产物形态正确、可自解析同目录依赖"
