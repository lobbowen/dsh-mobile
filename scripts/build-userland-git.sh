#!/usr/bin/env bash
# git CLI —— C 层工具供给批次（供给表 env-git 的兑现）。
#
# 本件**不含 https**（NO_CURL=1）：https 远端要 openssl + libcurl 一整条依赖链，那是下一批 ——
#   目录里 env-git-https 那格在册、有到期日。本批给的是**本地版本控制**（init/add/commit/log/diff/
#   branch/checkout/stash/grep…），也就是 agent 最常用的那部分。
#
# 为什么 RUNTIME_PREFIX=1：git 把 gitexecdir / template_dir **编进二进制**。我们构建时的 prefix 是
#   CI 上的临时路径，编进去到设备上就指向不存在的地方（表现为「git 少了子命令」）。RUNTIME_PREFIX
#   让它按**可执行文件自己的位置**在运行期推导这些路径 —— 与我们的落位方式（件解包到
#   $PREFIX/lib/toolchain，bin/git 是指向它的 symlink）天然合拍。
#
# 为什么 NO_INSTALL_HARDLINKS=1：安卓上硬链接不可用（Termux 同款），改用符号链接；
#   而我们的解包器**支持符号链接**（为此专门补过，见 kernel/src/supply/materialize.js）。
# 为什么 NO_GETTEXT / NO_ICONV / NO_NSEC：安卓无对应设施（gettext、iconv、nsec 时间戳）。
#
# 写法纪律：命令替换只在裸赋值里；不写带嵌套命令替换的双引号串；每步有声音。
set -euo pipefail

HERE=$(dirname "$0")
cd "$HERE/.."
ROOT_DIR=$(pwd)

GIT_VERSION=2.55.0
SRC_URL=https://mirrors.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.xz

if [ -z "${CC:-}" ]; then
  echo "::error title=缺 CC::需要 CC（aarch64-linux-android21-clang）"
  exit 1
fi

OUT="${OUT:-dist}"
mkdir -p "$ROOT_DIR/$OUT/bin" work

echo "[git] 取源码 $SRC_URL"
if ! curl -fsSL "$SRC_URL" -o work/git.tar.xz; then
  echo "::error title=源码取不到::$SRC_URL"
  exit 1
fi
echo "[git] 源码包 $(stat -c%s work/git.tar.xz) 字节"
rm -rf work/git-src && mkdir -p work/git-src
if ! tar xJf work/git.tar.xz -C work/git-src --strip-components=1; then
  echo "::error title=解包失败::tar.xz 损坏或上游换了压缩格式"
  exit 1
fi
[ -f work/git-src/Makefile ] || { echo "::error title=源码树异常::没有 Makefile"; exit 1; }
echo "[git] 源码树就位"

cd "$ROOT_DIR/work/git-src"

# ── Termux 的 bionic 补丁集（钉到它们的 commit，构建可复现）────────────────────────────
# 为什么必须打：git 上游按 Linux 假设写代码，安卓的 bionic 有几处不满足 ——
#   · run-command.c：用了 pthread cancellation，bionic 没有（用 #ifndef __ANDROID__ 包起来）
#   · config.mak.uname：去掉 HAVE_SYNC_FILE_RANGE（API 26 才有，我们 target 21）
#   · disable-fdsan / disable_daemon_syslog：安卓的 fdsan 与无 syslog 的实情
#   · compat-posix.h / config.c / help.c / tempfile.c：其余 bionic 缺口
# 补丁失败必须**硬红**：静默失败会得到一个「看着编过了、其实少一块」的 git。
TERMUX_COMMIT=a897f5641358fad33d5d6e76c65335695b1da0fc
PATCHES="config.mak.uname.patch run-command.c.patch disable-fdsan.patch disable_daemon_syslog.patch compat-posix.h.patch config.c.patch help.c.patch tempfile.c.patch"
for p in $PATCHES; do
  URL="https://raw.githubusercontent.com/termux/termux-packages/$TERMUX_COMMIT/packages/git/$p"
  if ! curl -fsSL "$URL" -o "$ROOT_DIR/work/$p"; then
    echo "::error title=补丁取不到::$URL"
    exit 1
  fi
  if ! patch -p1 -i "$ROOT_DIR/work/$p"; then
    echo "::error title=补丁打不上::$p —— 上游 git 版本与 Termux 补丁集不匹配？"
    exit 1
  fi
  echo "[git] 补丁已打：$p"
done
export CC
# NDK 的 ar/ranlib：git 不改用 libtool，直接调 ar。
TC=$(dirname "$CC")
export AR="$TC/llvm-ar"
export RANLIB="$TC/llvm-ranlib"

# 关键：这些必须**写在 make 命令行上**。git 的 Makefile 用的是简单赋值（CC = cc），环境变量覆盖不了它 ——
#   上一轮 CI 因此用宿主 gcc 编出了 x86-64 的 git（形态门禁当场红）。
# bionic 没有独立的 libpthread（pthread 就在 libc 里），清掉 PTHREAD_LIBS 才不会 -lpthread 链接失败。
MAKE_ARGS="CC=$CC AR=$AR RANLIB=$RANLIB PTHREAD_LIBS= NO_RUST=1 uname_S=Linux uname_M=aarch64 prefix=$ROOT_DIR/$OUT CSPRNG_METHOD= HAVE_SYNC_FILE_RANGE= HAVE_GETRUSAGE= HAVE_SYSINFO= NO_CURL=1 NO_OPENSSL=1 NO_EXPAT=1 NO_GETTEXT=1 NO_ICONV=1 NO_TCLTK=1 NO_NSEC=1 NO_INSTALL_HARDLINKS=1 NO_PERL=1 NO_PYTHON=1 RUNTIME_PREFIX=1 ac_cv_fread_reads_directories=yes ac_cv_header_libintl_h=no ac_cv_iconv_omits_bom=no ac_cv_snprintf_returns_bogus=no"
echo "[git] make（$MAKE_ARGS）"
if ! make -j2 $MAKE_ARGS all; then
  echo "::error title=make 失败::见上"
  exit 1
fi
echo "[git] make install"
if ! make $MAKE_ARGS install; then
  echo "::error title=install 失败::见上"
  exit 1
fi

[ -x "$ROOT_DIR/$OUT/bin/git" ] || { echo "::error title=没产出 bin/git::install 落点与预期不符"; ls -la "$ROOT_DIR/$OUT" || true; exit 1; }
if [ ! -d "$ROOT_DIR/$OUT/libexec/git-core" ]; then
  echo "::error title=缺 libexec/git-core::git 的子命令目录没装上（RUNTIME_PREFIX/prefix 落点问题）"
  exit 1
fi
rm -f "$ROOT_DIR/$OUT/bin/git-credential-"* 2>/dev/null || true

# ── 链接农场：只带名单，链接在设备上生成 ────────────────────────────────
#   install 可能把 libexec/git-core 的子命令做成**副本**（与 bin/git 同尺寸），那会让件体积爆炸
#   （CI 实测 1.29 GB）。把可推导的链接抽成名单、删掉副本；设备侧由物化器按名单建链。
#   为什么这样对：链接是**可推导的**，就不该进包 —— 与「shebang 约定补在 D1 而不是给每件手写包装」同一条纪律。
GITCORE="$ROOT_DIR/$OUT/libexec/git-core"
BINSIZE=$(stat -c%s "$ROOT_DIR/$OUT/bin/git")
FARM="$ROOT_DIR/$OUT/link-farm.txt"
: > "$FARM"
LINKED=0
SLIMMED=0
KEPT=0
for f in "$GITCORE"/*; do
  [ -e "$f" ] || continue
  NAME=$(basename "$f")
  if [ -L "$f" ]; then
    TGT=$(readlink "$f")
    printf '%s\t%s\n' "libexec/git-core/$NAME" "$TGT" >> "$FARM"
    LINKED=$((LINKED+1))
  elif [ -f "$f" ]; then
    FSIZE=$(stat -c%s "$f")
    if [ "$FSIZE" = "$BINSIZE" ]; then
      printf '%s\t%s\n' "libexec/git-core/$NAME" "../../bin/git" >> "$FARM"
      rm -f "$f"
      SLIMMED=$((SLIMMED+1))
    else
      KEPT=$((KEPT+1))
    fi
  fi
done
echo "[git] 链接农场：符号链接 $LINKED、副本瘦身 $SLIMMED、真独立文件 $KEPT"
TREE=$(du -sm "$ROOT_DIR/$OUT" | cut -f1)
echo "[git] 件树体积 ${TREE} MiB"
if [ "$TREE" -gt 60 ]; then
  echo "::error title=件太大::${TREE} MiB —— 链接农场没生效？（bin/git $BINSIZE 字节）"
  exit 1
fi
echo "$GIT_VERSION" > "$ROOT_DIR/$OUT/git.version"
SIZE=$(stat -c%s "$ROOT_DIR/$OUT/bin/git")
SUBS=$(ls "$ROOT_DIR/$OUT/libexec/git-core" | wc -l)
echo "[git] 产出 bin/git（$SIZE 字节），libexec/git-core $SUBS 项"
