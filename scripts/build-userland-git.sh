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
export CC
# NDK 的 ar/ranlib：git 不改用 libtool，直接调 ar。
TC=$(dirname "$CC")
export AR="$TC/llvm-ar"
export RANLIB="$TC/llvm-ranlib"

# 关键：这些必须**写在 make 命令行上**。git 的 Makefile 用的是简单赋值（CC = cc），环境变量覆盖不了它 ——
#   上一轮 CI 因此用宿主 gcc 编出了 x86-64 的 git（形态门禁当场红）。
MAKE_ARGS="CC=$CC AR=$AR RANLIB=$RANLIB uname_S=Linux uname_M=aarch64 prefix=$ROOT_DIR/$OUT NO_CURL=1 NO_EXPAT=1 NO_GETTEXT=1 NO_ICONV=1 NO_TCLTK=1 NO_NSEC=1 NO_INSTALL_HARDLINKS=1 NO_PERL=1 NO_PYTHON=1 RUNTIME_PREFIX=1 ac_cv_fread_reads_directories=yes ac_cv_header_libintl_h=no ac_cv_iconv_omits_bom=no ac_cv_snprintf_returns_bogus=no"
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
echo "$GIT_VERSION" > "$ROOT_DIR/$OUT/git.version"
SIZE=$(stat -c%s "$ROOT_DIR/$OUT/bin/git")
SUBS=$(ls "$ROOT_DIR/$OUT/libexec/git-core" | wc -l)
echo "[git] 产出 bin/git（$SIZE 字节），libexec/git-core $SUBS 项"
