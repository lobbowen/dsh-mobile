#!/usr/bin/env bash
# 小件原生能力件的**唯一构建实现** —— 从 .github/workflows/fast-apk.yml 的三个步骤原样抽出
# （包含它们的设计说明注释，避免"为什么这样编"的知识随重构丢失）。
#
# 为什么要抽出来：这些产物此前只能在 fast-apk 里现场编。抽成脚本后，
#   ① fast-apk 仍可直接调用（行为不变）；
#   ② 固化（pin）job 也能调用同一份实现，把产物发成不可变 Release，
#      之后 fast-apk 改为「下载 + 校验 sha256」而不再每次重编。
#
# 用法：在**仓根**任意位置执行均可（脚本自己 cd 到仓根）。
#   bash scripts/build-native-capabilities.sh
# 环境变量：
#   ABI        目标 ABI（默认 arm64-v8a；fast-apk 的 job env 里已有同名变量）
#   MANIFEST   产物清单输出路径（默认 /tmp/native-capabilities-manifest.txt）
#
# 产物落 container/app/src/main/jniLibs/<ABI>/；清单逐件给 tier / 文件名 / sha256。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
ABI="${ABI:-arm64-v8a}"
CAPS=".github/native-capabilities.txt"
MANIFEST="${MANIFEST:-/tmp/native-capabilities-manifest.txt}"

# ═══════════════════════════════════════════════════════════════════
# 1/3  Build libdshflock.so + libdshposix.so (NDK 原生桥)
# ═══════════════════════════════════════════════════════════════════
# 真机实证（2026-09-23）：dsh 两条设备死路都没有 JS 等价物——
# ① flock（下列）；② link：Android 7+ SELinux 禁 untrusted_app 硬链接，
#    dsh 会话/附件的 link 式独占发布报 EACCES ⇒ renameat2(RENAME_NOREPLACE)
#    link 用户态替代（container/native/posix/，自有代码）→ libdshposix.so，经 LD_PRELOAD 注入。
#    两库不能合并成单一 .so：NAPI_MODULE_INIT 入口每模块唯一。
# 真机实证：dsh 会话持久化硬依赖
# @deepseek-ai/node-addon-system 的 flock 绑定，上游只发 linux(glibc/musl)/
# darwin 预编译件，无 android-arm64 ⇒ 设备发消息报
# "flock is not supported on android-arm64"。flock(2) 无 JS 等价物
#（O_EXCL 锁崩溃后残留=砍能力），唯一正解=NDK 现编 vendor 的 src/flock.c
#（源码见 docs/components/native.md）放进 jniLibs —— nativeLibraryDir 是
# W^X 下唯一可 dlopen/exec 的通道（libnode.so 同款先例）。
# 刻意**不**登记进 native-assets.txt：那份清单的 ≥1MB 门槛会误杀小体积绑定。

set -euo pipefail
NDK=""
for v in "${ANDROID_NDK_LATEST_HOME:-}" "${ANDROID_NDK_HOME:-}" "${ANDROID_NDK_ROOT:-}"; do
  [ -n "$v" ] && [ -d "$v" ] && NDK="$v" && break
done
if [ -z "$NDK" ]; then
  NDK=$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1 || true)
fi
[ -n "$NDK" ] && [ -d "$NDK" ] || { echo "[error] runner 上找不到 NDK"; exit 1; }
echo "NDK=$NDK"
CC="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android21-clang"
[ -x "$CC" ] || { echo "[error] 找不到 clang: $CC"; exit 1; }

# node 头（与固化运行时同版本；NAPI 只认版本宏不认实现）
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-headers.tar.xz" \
  -o /tmp/node-headers.tar.xz
mkdir -p /tmp/node-headers
tar -xJf /tmp/node-headers.tar.xz -C /tmp/node-headers --strip-components=1
INC=/tmp/node-headers/include/node
[ -f "$INC/node_api.h" ] || { echo "[error] 头文件解压异常：缺 node_api.h"; exit 1; }

# NAPI_VERSION=9：flock.c 用到 napi_add_async_cleanup_hook（v9 起声明）；
# vendor 注释写 v8 但其源码超出 v8 面，9 是其真实下限。
mkdir -p "container/app/src/main/jniLibs/${ABI}"
"$CC" -shared -fPIC -O2 -DNAPI_VERSION=9 -I "$INC" \
  -o "container/app/src/main/jniLibs/${ABI}/libdshflock.so" container/native/flock/flock.c
SO="container/app/src/main/jniLibs/${ABI}/libdshflock.so"
SIZE=$(stat -c%s "$SO")
[ "$SIZE" -gt 1000 ] || { echo "[error] $SO 仅 $SIZE 字节，编译产物可疑"; exit 1; }
file "$SO" | grep -q "ELF 64-bit.*ARM aarch64" || { echo "[error] 产物不是 aarch64 ELF"; exit 1; }
echo "[ok] libdshflock.so $SIZE 字节 ($(file -b --mime-type "$SO" 2>/dev/null || echo ELF))"

# ② link/linkat 用户态替代（纯 libc 符号，无 NDK 头文件依赖）
"$CC" -shared -fPIC -O2 -I "$INC" \
  -o "container/app/src/main/jniLibs/${ABI}/libdshposix.so" \
  container/native/posix/link-interpose.c container/native/posix/open-fallback.c
SO2="container/app/src/main/jniLibs/${ABI}/libdshposix.so"
SIZE2=$(stat -c%s "$SO2")
[ "$SIZE2" -gt 500 ] || { echo "[error] $SO2 仅 $SIZE2 字节，编译产物可疑"; exit 1; }
file "$SO2" | grep -q "ELF 64-bit.*ARM aarch64" || { echo "[error] posix 产物不是 aarch64 ELF"; exit 1; }
echo "[ok] libdshposix.so $SIZE2 字节"

cd "$ROOT"

# ═══════════════════════════════════════════════════════════════════
# 2/3  Build capability binaries (bash / ripgrep / PTY probe)
# ═══════════════════════════════════════════════════════════════════
# android.9：终端三件套 + PTY 探针，全部 NDK 交叉编译**静态**产物：
#   · libbash.so   —— dsh-bash-local / dsh-terminal-bash 需要真 bash 二进制；
#                      Android 无 /bin/bash，可 exec 目录只有 nativeLibraryDir
#                      由 PrefixProvisioner 复制为 $PREFIX/bin 下的真名可执行文件。
#   · libdshrg.so  —— glob/grep 硬依赖 ripgrep（无 JS 等价物），由 $PREFIX 提供。
#   · libdshptyprobe.so —— 真机 PTY 能力探针（container/native/ptyprobe/，决策 node-pty 路线）。
# 失败语义：bash/rg/探针均为硬性必需（$PREFIX 依赖它们，无回退）；node-pty 走上游
# 配方，软失败（终端降级，不陪葬其它能力）。Audit 步骤如实报告 APK 内有无。
# bash 配方要点：bionic 无 termcap/readline ⇒ 预编一个 tputs 族 no-op 桩归档
# 塞进 LIBS（configure 的功能探测即真实链接通过；dsh 只跑 `bash -c` 非交互
# 管线，readline 的美化路径不参与）；--enable-static-link 产出免动态链接器
# 的 ELF，绕开 PTC 垫片教训的那整类 linker/env 问题。

set -uo pipefail
NDK=""
for v in "${ANDROID_NDK_LATEST_HOME:-}" "${ANDROID_NDK_HOME:-}" "${ANDROID_NDK_ROOT:-}"; do
  [ -n "$v" ] && [ -d "$v" ] && NDK="$v" && break
done
if [ -z "$NDK" ]; then
  NDK=$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1 || true)
fi
[ -n "$NDK" ] && [ -d "$NDK" ] || { echo "[error] runner 上找不到 NDK"; exit 1; }
TC="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
CC="$TC/aarch64-linux-android21-clang"
LLVM_AR="$TC/llvm-ar"
[ -x "$CC" ] || { echo "[error] 找不到 clang: $CC"; exit 1; }
J="container/app/src/main/jniLibs/${ABI}"
mkdir -p "$J"

check_so() { # $1=路径 $2=最小字节
  local f="$1" min="$2"
  [ -f "$f" ] || return 1
  local s; s=$(stat -c%s "$f"); [ "$s" -gt "$min" ] || return 1
  file "$f" | grep -q 'ELF 64-bit.*ARM aarch64' || return 1
  echo "[ok] $(basename "$f") $s 字节"
  file "$f" | sed 's/^/      /'
}

# ── ① PTY 探针（必须成功；见 docs/components/native.md）──
"$CC" -static -O2 -o "$J/libdshptyprobe.so" container/native/ptyprobe/pty-probe.c \
  || { echo "[error] ptyprobe 编译失败（纯 C 静态，失败即环境问题）"; exit 1; }
check_so "$J/libdshptyprobe.so" 1000 || exit 1

# ── ② bash 5.2.15 静态交叉编译 ──
BASH_VER=5.2.15
if curl -fsSL "https://ftp.gnu.org/gnu/bash/bash-${BASH_VER}.tar.gz" -o /tmp/bash.tar.gz \
   && echo "bash-${BASH_VER} sha256: $(sha256sum /tmp/bash.tar.gz | cut -d' ' -f1)" \
   && tar -xzf /tmp/bash.tar.gz -C /tmp; then
  cat > /tmp/termcap_stub.c <<'EOF'
/* bionic 无 termcap：readline 美化路径的 no-op 桩（dsh 只走非交互 bash -c） */
int tputs(const char *s, int affcnt, int (*putc_)(int)) { (void)s; (void)affcnt; (void)putc_; return 0; }
int tgetent(char *bp, const char *name) { (void)bp; (void)name; return -1; }
int tgetflag(const char *id) { (void)id; return 0; }
int tgetnum(const char *id) { (void)id; return -1; }
char *tgetstr(const char *id, char **area) { (void)id; (void)area; return 0; }
char *tgoto(const char *cap, int col, int row) { (void)cap; (void)col; (void)row; return 0; }
/* 第三轮 CI 实证：桩只给函数不够 —— configure 探到 tputs 后 readline 引用
 * termcap 填充三件套全局 PC/BC/UP（真实 termcap 库附带），必须一并定义。 */
char PC = 0;
char *BC = 0;
char *UP = 0;
EOF
  "$CC" -c -O2 /tmp/termcap_stub.c -o /tmp/termcap_stub.o \
    && "$LLVM_AR" rcs /tmp/libtermcap_stub.a /tmp/termcap_stub.o
  (
    set -e
    cd /tmp/bash-${BASH_VER}
    ./configure --host=aarch64-linux-android --build=x86_64-pc-linux-gnu \
      --prefix=/native --disable-nls --enable-static-link --without-bash-malloc \
      CC="$CC" CFLAGS="-O2 -Wno-error=implicit-function-declaration -Wno-error=int-conversion -Wno-error=incompatible-function-pointer-types -Wno-error=incompatible-pointer-types" \
      LDFLAGS="-static -Wl,--allow-multiple-definition" LIBS="/tmp/libtermcap_stub.a" \
      bash_cv_getcwd_malloc=yes bash_cv_func_sigsetjmp=present \
      bash_cv_printf_a_format=yes bash_cv_dev_fd_standard=yes \
      bash_cv_unusable_rtsigs=no > /tmp/bash-configure.log 2>&1 \
      || { echo "=== configure 失败取证 ==="; tail -40 /tmp/bash-configure.log; exit 1; }
    # CFLAGS 里的 -Wno-error 族：bash 5.2 是老式 C 风格重灾区，NDK clang ≥16
    # 把 implicit-function-declaration/int-conversion 等**默认升级为 error**，
    # 老代码在新编译器下必须显式降回 warning（首轮 CI 实证的失败面）。
    # --without-bash-malloc + --allow-multiple-definition：第二轮 CI 实证
    # ld.lld `duplicate symbol: malloc/free/calloc/realloc/memalign/
    # posix_memalign/malloc_usable_size/strtoimax` —— bash 自带 dmalloc 与
    # 静态 bionic libc 正面相撞（glibc 动态链接下不暴露，静态交叉必爆）；
    # 正解是用系统 malloc，strtoimax 兜底件残留冲突由 allow-multiple-definition
    # 按链接序解决（先定义者胜，语义均为标准实现）。
    make -j4 bash > /tmp/bash-make.log 2>&1 || {
      echo "=== make 失败取证（error 行 + 末 120 行）==="
      grep -nE "error:|Error [0-9]+$|undefined symbol" /tmp/bash-make.log | head -40 || true
      tail -120 /tmp/bash-make.log
      exit 1; }
  ) && cp -f /tmp/bash-${BASH_VER}/bash "$J/libbash.so"
  if ! check_so "$J/libbash.so" 300000; then
    echo "::error title=必需件缺失::libbash.so 未产出 —— bash 工具依赖 $PREFIX/bin/bash，无回退路径"
    exit 1
  fi
else
  echo "::error title=必需件缺失::bash 源码下载/解包失败 —— bash 工具无回退路径"
  exit 1
fi

# ── ③ ripgrep 14.1.1（cargo 交叉到 aarch64-linux-android，静态 CRT）──
if ! command -v cargo > /dev/null 2>&1; then
  echo "runner 无 cargo，装最小 rustup"
  curl -fsSf https://sh.rustup.rs -o /tmp/rustup.sh && sh /tmp/rustup.sh -y --profile minimal --default-toolchain stable >/dev/null
  export PATH="$HOME/.cargo/bin:$PATH"
fi
rustup target add aarch64-linux-android > /dev/null 2>&1 || echo "[warn] rustup target add 失败（可能非 rustup 安装）"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CC"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="-C target-feature=+crt-static"
export CC_aarch64_linux_android="$CC" CXX_aarch64_linux_android="$CC" AR_aarch64_linux_android="$LLVM_AR"
if cargo install --locked --version 14.1.1 ripgrep --target aarch64-linux-android --root /tmp/rgbin --no-track > /tmp/rg-build.log 2>&1; then
  cp -f /tmp/rgbin/bin/rg "$J/libdshrg.so"
else
  tail -30 /tmp/rg-build.log
fi
if ! check_so "$J/libdshrg.so" 300000; then
  echo "::error title=必需件缺失::libdshrg.so 未产出 —— glob/grep 依赖 $PREFIX/bin/rg，无回退路径"
  exit 1
fi

# AGP 只 strip「共享库」语义的 ELF，对这批静态可执行文件是 no-op（实证：
# 首轮日志 "Unable to strip ... packaging them as they are" ⇒ rg 33MB、
# ptyprobe 2MB 带全量符号进包）。手动 strip：NAPI 件不受影响（.dynsym
# 是动态符号表，strip-unneeded 不动它）。
for f in libbash.so libdshrg.so libdshptyprobe.so libdshflock.so libdshposix.so libdshpty.so; do
  if [ -f "$J/$f" ]; then
    before=$(stat -c%s "$J/$f"); "$TC/llvm-strip" --strip-unneeded "$J/$f" 2>/dev/null || true
    echo "[strip] $f $before -> $(stat -c%s "$J/$f") 字节"
  fi
done

echo "== 能力二进制就位情况 =="
ls -la "$J"

cd "$ROOT"

# ═══════════════════════════════════════════════════════════════════
# 3/3  Build node-pty for android-arm64 (NDK + node-gyp)
# ═══════════════════════════════════════════════════════════════════
# node-pty 只发 linux/darwin/win32 预编译件且无 wasm 兜底，PTY 只能自己编。
# 产物投 jniLibs/libdshpty.so；运行时由容器复制到 node-pty 的 loader 查找位
# （node_modules/node-pty/prebuilds/android-arm64/pty.node）。
# 失败语义：上游配方问题 => ::warning 后继续（终端能力降级，不陪葬其它能力）。

set -uo pipefail
PTY_VER="1.2.0-beta.15"
NDK=""
for v in "${ANDROID_NDK_LATEST_HOME:-}" "${ANDROID_NDK_HOME:-}" "${ANDROID_NDK_ROOT:-}"; do
  [ -n "$v" ] && [ -d "$v" ] && NDK="$v" && break
done
if [ -z "$NDK" ]; then NDK=$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1 || true); fi
[ -n "$NDK" ] && [ -d "$NDK" ] || { echo "::warning title=能力件缺失::找不到 NDK，跳过 node-pty"; exit 0; }
TC="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
# API 24：bionic 的 pty.h/forkpty 自 API 23 起才有；minSdk=24 与之相符。
export CC="$TC/aarch64-linux-android24-clang"
export CXX="$TC/aarch64-linux-android24-clang++"
export AR="$TC/llvm-ar" LINK="$CXX"
[ -x "$CC" ] || { echo "::warning title=能力件缺失::找不到 clang: $CC"; exit 0; }
rm -rf /tmp/ptybuild && mkdir -p /tmp/ptybuild && cd /tmp/ptybuild
npm pack "node-pty@${PTY_VER}" >/dev/null 2>&1 || { echo "::warning title=能力件缺失::node-pty 源码拉取失败"; exit 0; }
tar -xzf node-pty-*.tgz && cd package
# bionic 无 libutil：binding.gyp 里的 -lutil 必须去掉（含 mac 分支的 libraries!）。
python3 - <<'PY'
import re, pathlib
p = pathlib.Path('binding.gyp')
p.write_text(re.sub(r"\s*'-lutil'\s*,?", "", p.read_text()))
PY
# binding.gyp 用 require('node-addon-api') 取 targets，须装进包内。
npm install --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 || true
npx --yes node-gyp@10 rebuild --arch=arm64 --nodedir=/tmp/node-headers > /tmp/pty-gyp.log 2>&1 || {
  echo '=== node-gyp 失败取证（末 60 行）==='; tail -60 /tmp/pty-gyp.log
  echo '::warning title=能力件缺失::node-pty 构建失败 —— 终端 PTY 本包不可用'; exit 0; }
SO="build/Release/pty.node"
file "$SO" | grep -q 'ELF 64-bit.*ARM aarch64' || { echo '::warning title=能力件缺失::pty.node 非 aarch64'; tail -20 /tmp/pty-gyp.log; exit 0; }
cp -f "$SO" "${GITHUB_WORKSPACE}/container/app/src/main/jniLibs/${ABI}/libdshpty.so"
echo "[ok] libdshpty.so $(stat -c%s "${GITHUB_WORKSPACE}/container/app/src/main/jniLibs/${ABI}/libdshpty.so") 字节"

cd "$ROOT"

# ═══════════════════════════════════════════════════════════════════
# 产物清单：逐件 sha256（MISSING = 该档位缺件，由调用方决定硬红还是降级）
# ═══════════════════════════════════════════════════════════════════
[ -f "$CAPS" ] || { echo "[error] 缺少 $CAPS" >&2; exit 1; }
: > "$MANIFEST"
N=0; MISS=0
while read -r TIER LIB _ID; do
  case "$TIER" in ''|'#'*) continue ;; esac
  P="container/app/src/main/jniLibs/$ABI/$LIB"
  if [ -f "$P" ]; then
    printf '%s %s %s\n' "$TIER" "$LIB" "$(sha256sum "$P" | cut -d' ' -f1)" >> "$MANIFEST"
    N=$((N + 1))
  else
    printf '%s %s MISSING\n' "$TIER" "$LIB" >> "$MANIFEST"
    MISS=$((MISS + 1))
  fi
done < "$CAPS"
echo "=== 小件产物清单（$MANIFEST）==="; cat "$MANIFEST"
echo "在册 $N 件，缺件 $MISS 件"
