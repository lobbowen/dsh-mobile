#!/usr/bin/env bash
# curl CLI —— C 层工具供给批次（供给表 env-curl 的兑现）。
#
# 与 git 件同源依赖链（zlib + openssl 静态），但**故意不传 --with-ca-path**：
#   真机实证（2026-09-28）：libcurl 一旦在编译期被钉了 CA 路径，就不再读 CURL_CA_BUNDLE、
#   也不走 OpenSSL 的 SSL_CERT_FILE 默认路径 —— 而本产品的信任根是「随产品走的 ca-bundle.pem」
#   （容器播到 $PREFIX/etc/ 并用环境三键指过去）。所以这里把 CA 交给运行期环境。
#
# 编译 API = 23：bionic 到 API 23 才把 stdin/stdout/stderr 做成真符号，
#   而 curl 命令行工具会引用它们（API 21 下链接必失败 —— 上一批为此放弃了 curl 工具）。
set -euo pipefail

HERE=$(dirname "$0")
cd "$HERE/.."
ROOT_DIR=$(pwd)

ZLIB_VERSION=1.3.2
OPENSSL_VERSION=3.6.3
CURL_VERSION=8.22.0
ANDROID_API=23

if [ -z "${CC:-}" ]; then echo "::error title=缺 CC::需要 NDK 的 clang"; exit 1; fi
OUT="${OUT:-dist}"
mkdir -p "$ROOT_DIR/$OUT/bin" "$ROOT_DIR/work"
TC_DIR=$(dirname "$CC")
if [ ! -x "$TC_DIR/aarch64-linux-android$ANDROID_API-clang" ]; then
  echo "::error title=缺 API$ANDROID_API 的 clang::NDK 里没有 aarch64-linux-android$ANDROID_API-clang"
  exit 1
fi
export CC="$TC_DIR/aarch64-linux-android$ANDROID_API-clang"
AR_BIN="$TC_DIR/llvm-ar"
RANLIB_BIN="$TC_DIR/llvm-ranlib"
export PATH="$TC_DIR:$PATH"
DEPS="$ROOT_DIR/work/curl-deps"
mkdir -p "$DEPS"
echo "[curl] 编译 API=$ANDROID_API  CC=$CC"

# ① zlib（静态）
ZLIB_URLS="https://zlib.net/fossils/zlib-$ZLIB_VERSION.tar.gz https://github.com/madler/zlib/archive/refs/tags/v$ZLIB_VERSION.tar.gz"
ZLIB_OK=0
for u in $ZLIB_URLS; do
  if curl -fsSL "$u" -o "$ROOT_DIR/work/zlib.tar.gz" && tar tzf "$ROOT_DIR/work/zlib.tar.gz" >/dev/null 2>&1; then ZLIB_OK=1; echo "[curl] zlib 源码来自 $u"; break; fi
done
[ "$ZLIB_OK" = "1" ] || { echo "::error title=zlib 取不到::所有来源都失败"; exit 1; }
rm -rf "$ROOT_DIR/work/zlib" && mkdir -p "$ROOT_DIR/work/zlib"
tar xzf "$ROOT_DIR/work/zlib.tar.gz" -C "$ROOT_DIR/work/zlib" --strip-components=1
cd "$ROOT_DIR/work/zlib"
CHOST=aarch64-linux-android CC="$CC" AR="$AR_BIN" RANLIB="$RANLIB_BIN" ./configure --prefix="$DEPS" --static >/dev/null
make -j2 >/dev/null && make install >/dev/null
echo "[curl] zlib 就位"

# ② openssl（静态、no-ui-console：去掉控制台 UI 对 stdin/stderr 的引用）
if ! curl -fsSL "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz" -o "$ROOT_DIR/work/openssl.tar.gz"; then
  echo "::error title=openssl 取不到::openssl-$OPENSSL_VERSION"; exit 1; fi
tar tzf "$ROOT_DIR/work/openssl.tar.gz" >/dev/null 2>&1 || { echo "::error title=openssl 源码不是 tar.gz::下载被墙或错误页"; exit 1; }
rm -rf "$ROOT_DIR/work/openssl" && mkdir -p "$ROOT_DIR/work/openssl"
tar xzf "$ROOT_DIR/work/openssl.tar.gz" -C "$ROOT_DIR/work/openssl" --strip-components=1
cd "$ROOT_DIR/work/openssl"
export ANDROID_API
# openssl 的 android 配置只认 ANDROID_NDK_ROOT / ANDROID_NDK_HOME（缺了它就退化去找 aarch64-linux-android-gcc，
#   报 `no NDK aarch64-linux-android-gcc on $PATH` —— git 件那边就是这么写才通的，这里对齐）。
export ANDROID_NDK_ROOT="${ANDROID_NDK_LATEST_HOME:-}"
if [ -z "$ANDROID_NDK_ROOT" ]; then ANDROID_NDK_ROOT=$(cd "$TC_DIR/../../../../.." && pwd); fi
export ANDROID_NDK_HOME="$ANDROID_NDK_ROOT"
echo "[curl] NDK root = $ANDROID_NDK_ROOT"
if ! ./Configure android-arm64 -fPIC -D__ANDROID_API__=$ANDROID_API --prefix="$DEPS" --openssldir="$DEPS/ssl" no-shared no-tests no-ui-console > "$ROOT_DIR/work/openssl-configure.log" 2>&1; then
  echo "::error title=openssl Configure 失败::尾 30 行"; tail -n 30 "$ROOT_DIR/work/openssl-configure.log"; exit 1; fi
if ! make -j2 build_libs > "$ROOT_DIR/work/openssl-build.log" 2>&1; then
  echo "::error title=openssl 编译失败::尾 30 行"; tail -n 30 "$ROOT_DIR/work/openssl-build.log"; exit 1; fi
make install_sw >/dev/null
echo "[curl] openssl 就位"

# ③ curl（静态链 openssl/zlib；**不传 CA 路径**，交给运行期环境）
if ! curl -fsSL "https://curl.se/download/curl-$CURL_VERSION.tar.gz" -o "$ROOT_DIR/work/curl.tar.gz"; then
  echo "::error title=curl 取不到::curl-$CURL_VERSION"; exit 1; fi
tar tzf "$ROOT_DIR/work/curl.tar.gz" >/dev/null 2>&1 || { echo "::error title=curl 源码不是 tar.gz::下载被墙或错误页"; exit 1; }
rm -rf "$ROOT_DIR/work/curl-src" && mkdir -p "$ROOT_DIR/work/curl-src"
tar xzf "$ROOT_DIR/work/curl.tar.gz" -C "$ROOT_DIR/work/curl-src" --strip-components=1
cd "$ROOT_DIR/work/curl-src"
export PKG_CONFIG_PATH="$DEPS/lib/pkgconfig"
export CPPFLAGS="-I$DEPS/include"
export LDFLAGS="-L$DEPS/lib"
export LIBS="-lssl -lcrypto -lz"
if ! ./configure --host=aarch64-linux-android --build=x86_64-pc-linux-gnu --prefix="$DEPS" \
  --with-openssl="$DEPS" --with-zlib="$DEPS" \
  --disable-shared --enable-static --disable-ldap --without-libpsl --without-libssh2 --without-libidn2 \
  --without-nghttp2 --without-brotli --without-zstd --disable-manual \
  --disable-ftp --disable-file --disable-dict --disable-telnet --disable-tftp \
  --disable-pop3 --disable-imap --disable-smtp --disable-gopher --disable-mqtt --disable-rtsp \
  --enable-http \
  ac_cv_lib_crypto_HMAC_Update=yes ac_cv_lib_crypto_HMAC_Init_ex=yes \
  curl_cv_lib_crypto_HMAC_Update=yes curl_cv_lib_crypto_HMAC_Init_ex=yes \
  ac_cv_lib_ssl_SSL_new=yes ac_cv_lib_ssl_SSL_connect=yes ac_cv_lib_ssl_SSL_get_peer_certificate=yes \
  CC="$CC" AR="$AR_BIN" RANLIB="$RANLIB_BIN" > "$ROOT_DIR/work/curl-configure.log" 2>&1; then
  echo "::error title=curl Configure 失败::openssl 相关行 + 尾 20 行"
  grep -i openssl "$ROOT_DIR/work/curl-configure.log" | tail -n 12 || true
  tail -n 20 "$ROOT_DIR/work/curl-configure.log" || true
  exit 1
fi
if ! make -j2 > "$ROOT_DIR/work/curl-build.log" 2>&1; then
  echo "::error title=curl 编译失败::尾 25 行"; tail -n 25 "$ROOT_DIR/work/curl-build.log"; exit 1; fi
echo "[curl] 构建完成，取真身"
CAND=""
for c in "$ROOT_DIR/work/curl-src/src/.libs/curl" "$ROOT_DIR/work/curl-src/src/curl"; do
  if [ -f "$c" ] && file -b "$c" 2>/dev/null | grep -q "aarch64"; then CAND="$c"; break; fi
done
if [ -z "$CAND" ]; then
  echo "::error title=没找到 aarch64 的 curl 真身::下面列出 src 与 src/.libs（诊断不许走管道 ——
    set -o pipefail 下 ls|head 会以 SIGPIPE 判死整脚本，把真因盖住，本批已踩过一次）"
  ls -la "$ROOT_DIR/work/curl-src/src" || true
  echo "---- src/.libs ----"
  ls -la "$ROOT_DIR/work/curl-src/src/.libs" || true
  echo "---- file 判定 ----"
  file -b "$ROOT_DIR/work/curl-src/src/curl" 2>/dev/null || true
  exit 1
fi
cp "$CAND" "$ROOT_DIR/$OUT/bin/curl"
chmod 0755 "$ROOT_DIR/$OUT/bin/curl"
if [ -n "${LLVM_STRIP:-}" ] && [ -x "${LLVM_STRIP}" ]; then "$LLVM_STRIP" "$ROOT_DIR/$OUT/bin/curl" && echo "[curl] 已 strip"; else echo "::error title=没有 LLVM_STRIP::不许产出臃肿件"; exit 1; fi
echo "$CURL_VERSION" > "$ROOT_DIR/$OUT/curl.version"
echo "[curl] 产出 $(stat -c%s "$ROOT_DIR/$OUT/bin/curl") 字节"
