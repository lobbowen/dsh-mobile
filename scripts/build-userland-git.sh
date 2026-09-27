#!/usr/bin/env bash
# git CLI —— C 层工具供给批次（供给表 env-git 的兑现）。
#
# 本件**含 https**：zlib + openssl + libcurl 全部**静态**链进 git（见下面的依赖链），
#   于是「一个件」就能 clone/fetch over https，不必再拖一串 .so（而 git 本体仍动态链 libc，
#   因为容器 Linux 语义靠 LD_PRELOAD）。本地版本控制能力同样齐备（init/add/commit/log/…）。
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

# ── https 依赖链：zlib + openssl + libcurl，全部**静态**装进 work/deps ──────────────
# 为什么静态：git 的件只带 bin/git 与少数真独立二进制，不该再拖一串 .so；
#   而 git **本体**仍动态链 libc —— 容器 Linux 语义靠 LD_PRELOAD，静态件会绕过整层
#   （verify-userland-artifact.sh 的形态门禁就是钉这条）。
DEPS="$ROOT_DIR/work/deps"
ZLIB_VERSION=1.3.2
OPENSSL_VERSION=3.6.3
CURL_VERSION=8.22.0
mkdir -p "$DEPS"
TC_DIR=$(dirname "$CC")
export ANDROID_NDK_ROOT="${ANDROID_NDK_LATEST_HOME:-}"
if [ -z "$ANDROID_NDK_ROOT" ]; then
  ANDROID_NDK_ROOT=$(cd "$TC_DIR/../../../../.." && pwd)
fi
echo "[git] NDK root = $ANDROID_NDK_ROOT"

# ① zlib（curl 与 git 都要它）
if ! curl -fsSL "https://zlib.net/fossils/zlib-$ZLIB_VERSION.tar.gz" -o work/zlib.tar.gz; then
  echo "::error title=zlib 取不到::zlib-$ZLIB_VERSION 源码"
  exit 1
fi
rm -rf work/zlib && mkdir -p work/zlib
tar xzf work/zlib.tar.gz -C work/zlib --strip-components=1
cd "$ROOT_DIR/work/zlib"
CHOST=aarch64-linux-android CC="$CC" AR="$AR_BIN" RANLIB="$RANLIB_BIN" ./configure --prefix="$DEPS" --static >/dev/null
make -j2 >/dev/null
make install >/dev/null
echo "[git] zlib 就位：$(ls "$DEPS/lib" | tr " " " " | head -c 120)"

# ② OpenSSL（静态 libssl/libcrypto；https 的 TLS 由它提供）
if ! curl -fsSL "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz" -o work/openssl.tar.gz; then
  echo "::error title=openssl 取不到::openssl-$OPENSSL_VERSION 源码"
  exit 1
fi
rm -rf work/openssl && mkdir -p work/openssl
tar xzf work/openssl.tar.gz -C work/openssl --strip-components=1
cd "$ROOT_DIR/work/openssl"
PATH="$TC_DIR:$PATH" ./Configure android-arm64 -D__ANDROID_API__=21 --prefix="$DEPS" --openssldir="$DEPS/ssl" no-shared no-tests >/dev/null
if ! make -j2 build_libs >/dev/null; then
  echo "::error title=openssl 编译失败::见上"
  exit 1
fi
make install_sw >/dev/null
echo "[git] openssl 就位：$(ls "$DEPS/lib" | grep -c "[.]a") 个 .a"

# ③ libcurl（只留 http/https，静态）
if ! curl -fsSL "https://curl.se/download/curl-$CURL_VERSION.tar.gz" -o work/curl.tar.gz; then
  echo "::error title=curl 取不到::curl-$CURL_VERSION 源码"
  exit 1
fi
rm -rf work/curl && mkdir -p work/curl
tar xzf work/curl.tar.gz -C work/curl --strip-components=1
cd "$ROOT_DIR/work/curl"
# --with-ca-path 指向安卓的系统信任库：https 校验要用它（不装 CA 包时这是唯一来源）。
./configure --host=aarch64-linux-android --build=x86_64-pc-linux-gnu --prefix="$DEPS" \
  --with-openssl="$DEPS" --with-zlib="$DEPS" --with-ca-path=/system/etc/security/cacerts \
  --disable-shared --enable-static --disable-ldap --without-libssh2 --without-libidn2 \
  --without-nghttp2 --without-brotli --without-zstd --disable-manual \
  --disable-ftp --disable-file --disable-dict --disable-telnet --disable-tftp \
  --disable-pop3 --disable-imap --disable-smtp --disable-gopher --disable-mqtt --disable-rtsp \
  --enable-http --enable-https \
  CC="$CC" AR="$AR_BIN" RANLIB="$RANLIB_BIN" CPPFLAGS="-I$DEPS/include" LDFLAGS="-L$DEPS/lib" >/dev/null
if ! make -j2 >/dev/null; then
  echo "::error title=curl 编译失败::见上"
  exit 1
fi
make install >/dev/null
echo "[git] curl 就位（静态）"

cd "$ROOT_DIR/work/git-src"

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
MAKE_ARGS="CC=$CC AR=$AR RANLIB=$RANLIB PTHREAD_LIBS= NO_RUST=1 CURLDIR=$ROOT_DIR/work/deps OPENSSLDIR=$ROOT_DIR/work/deps uname_S=Linux uname_M=aarch64 prefix=$ROOT_DIR/$OUT CSPRNG_METHOD= HAVE_SYNC_FILE_RANGE= HAVE_GETRUSAGE= HAVE_SYSINFO= NO_EXPAT=1 NO_GETTEXT=1 NO_ICONV=1 NO_TCLTK=1 NO_NSEC=1 NO_INSTALL_HARDLINKS=1 NO_PERL=1 NO_PYTHON=1 RUNTIME_PREFIX=1 ac_cv_fread_reads_directories=yes ac_cv_header_libintl_h=no ac_cv_iconv_omits_bom=no ac_cv_snprintf_returns_bogus=no"
echo "[git] make（$MAKE_ARGS）"
# 带空格的项单独作为 make 的参数：放进 $MAKE_ARGS 会因为内层引号截断外层字符串。
if ! make -j2 $MAKE_ARGS CURL_LIBS="-lcurl -lssl -lcrypto -lz" OPENSSL_LIBSSL="-lssl -lcrypto" CPPFLAGS="-I$ROOT_DIR/work/deps/include" LDFLAGS="-L$ROOT_DIR/work/deps/lib" all; then
  echo "::error title=make 失败::见上"
  exit 1
fi
echo "[git] make install"
if ! make $MAKE_ARGS CURL_LIBS="-lcurl -lssl -lcrypto -lz" OPENSSL_LIBSSL="-lssl -lcrypto" CPPFLAGS="-I$ROOT_DIR/work/deps/include" LDFLAGS="-L$ROOT_DIR/work/deps/lib" install; then
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

# ── 先 strip 再体检 ───────────────────────────────────────────────────
#   CI 实测：17 件里 27 个真独立二进制全是**未 strip** 的 ELF（各带完整符号表），
#   git-core 一项就 80 MiB。strip 是这类膨胀的对症处置（不是把阈值调大）。
STRIPPED=0
if [ -n "${LLVM_STRIP:-}" ] && [ -x "${LLVM_STRIP}" ]; then
  for f in "$ROOT_DIR/$OUT/bin/git" "$GITCORE"/*; do
    [ -f "$f" ] || continue
    [ -L "$f" ] && continue
    if "$LLVM_STRIP" "$f" 2>/dev/null; then STRIPPED=$((STRIPPED+1)); fi
  done
  echo "[git] 已 strip $STRIPPED 个二进制（strip 前 bin/git $(stat -c%s "$ROOT_DIR/$OUT/bin/git") 字节）"
else
  echo "::error title=没有 LLVM_STRIP::未 strip 的件体积会离谱（CI 实测 102 MiB）—— 中止"
  exit 1
fi
BINSIZE=$(stat -c%s "$ROOT_DIR/$OUT/bin/git")
BININODE=$(stat -c%i "$ROOT_DIR/$OUT/bin/git")
FARM="$ROOT_DIR/$OUT/link-farm.txt"
: > "$FARM"
LINKED=0
SLIMMED=0
KEPT=0
for f in "$GITCORE"/*; do
  NAME=$(basename "$f")
  # 注意：**不要**用 `[ -e ]` 过滤 —— 断链（指向已被瘦身删掉的副本）也是要登记的链接，
  #   `-e` 对它会返回假，等于把 145 项静默漏掉（CI 实证：173 项里只登记了 28）。
  [ -L "$f" ] || [ -e "$f" ] || continue
  if [ -L "$f" ]; then
    TGT=$(readlink "$f")
    printf '%s\t%s\n' "libexec/git-core/$NAME" "$TGT" >> "$FARM"
    LINKED=$((LINKED+1))
  elif [ -f "$f" ] && [ ! -L "$f" ]; then
    FSIZE=$(stat -c%s "$f")
    FINODE=$(stat -c%i "$f")
    if [ "$FINODE" = "$BININODE" ] || [ "$FSIZE" = "$BINSIZE" ]; then
      # 硬链接（同 inode）或副本（同尺寸）：两者都不该进包 —— 设备上按名单建链。
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
