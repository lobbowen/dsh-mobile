#!/usr/bin/env bash
# jq CLI —— C 层工具供给批次（供给表 env-jq 的兑现）。
#
# 为什么自己编：上游只发 linux/macos/windows 的预编译件（有 aarch64 linux，但那是 glibc），
# 没有 android/bionic 产物。
# 为什么动态：容器 Linux 语义靠 LD_PRELOAD 落地，静态件会绕过整层（形态由 verify-userland-artifact.sh 钉住）。
#
# 关键断言（本脚本自己立、自己查）：**不得依赖 libonig.so**。
#   jq 的 --with-oniguruma=builtin 走 vendored oniguruma；若它被编成共享库，jq 上机就会找不到它
#   （我们的件只有 bin/jq 一个文件）。所以构建后查 DT_NEEDED：出现 libonig 即硬失败 ——
#   宁可在 CI 红，也不要在真机上得到「jq 起不来」。
#
# 写法纪律（沿用 sqlite3 那轮的教训）：命令替换只在裸赋值里；可能不命中的管道带 `|| true`；每步有声音。
set -euo pipefail

HERE=$(dirname "$0")
cd "$HERE/.."
ROOT_DIR=$(pwd)   # 绝对仓根：脚本中途会 cd 进源码树，后续一律用它拼路径

JQ_VERSION=1.8.2
REL_BASE=https://github.com/jqlang/jq/releases/download/jq-${JQ_VERSION}

if [ -z "${CC:-}" ]; then
  echo "::error title=缺 CC::需要 CC（aarch64-linux-android21-clang）"
  exit 1
fi

OUT="${OUT:-dist}"
mkdir -p "$OUT/bin" work
TC=$(dirname "$CC")
AR_BIN="$TC/llvm-ar"
RANLIB_BIN="$TC/llvm-ranlib"
READELF_BIN="$TC/llvm-readelf"
for f in "$AR_BIN" "$RANLIB_BIN" "$READELF_BIN"; do
  [ -x "$f" ] || { echo "::error title=缺工具::$f 不存在"; exit 1; }
done

echo "[jq] 取 jq-$JQ_VERSION 源码包"
if ! curl -fsSL "$REL_BASE/jq-$JQ_VERSION.tar.gz" -o work/jq.tar.gz; then
  echo "::error title=源码包取不到::$REL_BASE/jq-$JQ_VERSION.tar.gz"
  exit 1
fi
if ! curl -fsSL "$REL_BASE/sha256sum.txt" -o work/jq.sha256.txt; then
  echo "::error title=校验和取不到::$REL_BASE/sha256sum.txt"
  exit 1
fi
WANT=$(grep -E "jq-$JQ_VERSION[.]tar[.]gz" work/jq.sha256.txt | head -n 1 | awk '{print $1}' || true)
if [ -z "$WANT" ]; then
  echo "::error title=校验和里没有该文件::sha256sum.txt 里找不到 jq-$JQ_VERSION.tar.gz（上游改名了？）"
  head -n 5 work/jq.sha256.txt || true
  exit 1
fi
GOT=$(sha256sum work/jq.tar.gz | cut -d' ' -f1)
if [ "$GOT" != "$WANT" ]; then
  echo "::error title=源码包校验不过::sha256 $GOT ≠ 上游 $WANT"
  exit 1
fi
echo "[jq] 源码包 $(stat -c%s work/jq.tar.gz) 字节，sha256 与上游一致"

rm -rf work/jq && mkdir -p work/jq
tar xzf work/jq.tar.gz -C work/jq --strip-components=1
[ -f work/jq/configure ] || { echo "::error title=发布包里没有 configure::上游 release 包应自带 configure"; exit 1; }
if [ ! -d work/jq/vendor/oniguruma ]; then
  echo "::error title=发布包里没有 vendored oniguruma::需要 vendor/oniguruma（--with-oniguruma=builtin 的前提）"
  ls work/jq/vendor 2>/dev/null || true
  ls work/jq/modules 2>/dev/null || true
  exit 1
fi
echo "[jq] 源码树就位（含 vendored oniguruma）"

cd work/jq
export CC AR="$AR_BIN" RANLIB="$RANLIB_BIN" CFLAGS="-O2 -DNDEBUG"
CONFIGURE_COMMON="--host=aarch64-linux-android --build=x86_64-pc-linux-gnu"

# ① vendored oniguruma：**静态**编到自己的 prefix（单文件件不许带 .so 出门）
ONIG_PREFIX="$ROOT_DIR/work/onig"
echo "[jq] 静态编 vendored oniguruma → $ONIG_PREFIX"
cd "$ROOT_DIR/work/jq/vendor/oniguruma"
if [ ! -x ./configure ]; then
  echo "[jq] vendor/oniguruma 没有 configure，用 autoreconf 生成"
  if ! autoreconf -i >/dev/null 2>&1; then
    echo "::error title=autoreconf 失败::vendor/oniguruma 需要 autoconf/automake/libtool"
    exit 1
  fi
fi
./configure $CONFIGURE_COMMON --prefix="$ONIG_PREFIX" --disable-shared --enable-static \
  --disable-dependency-tracking CC="$CC" AR="$AR_BIN" RANLIB="$RANLIB_BIN" >/dev/null
if ! make -j2 >/dev/null; then
  echo "::error title=oniguruma 编译失败::静态编不过，jq 就会带 .so 出门，不可接受"
  exit 1
fi
make install >/dev/null
echo "[jq] oniguruma 就位：$(ls "$ONIG_PREFIX/lib" | tr '\n' ' ')"

# ② jq：静态链 libjq 与 oniguruma，只留系统库依赖
cd "$ROOT_DIR/work/jq"
echo "[jq] configure jq（--disable-shared --enable-static --with-oniguruma=<prefix>）"
./configure $CONFIGURE_COMMON --disable-shared --enable-static --disable-docs \
  --with-oniguruma="$ONIG_PREFIX" CC="$CC" AR="$AR_BIN" RANLIB="$RANLIB_BIN" >/dev/null
echo "[jq] make"
if ! make -j2 >/dev/null; then
  echo "::error title=make 失败::见上"
  exit 1
fi

# 真身在 .libs/（构建目录里的同名 jq 是 libtool 的包装脚本）
if [ ! -x .libs/jq ]; then
  echo "::error title=找不到真身::.libs/jq 不存在（libtool 布局变了？）"
  ls -la .libs 2>/dev/null | head -n 10 || true
  exit 1
fi
cp .libs/jq "$ROOT_DIR/$OUT/bin/jq"chmod 0755 "$ROOT_DIR/$OUT/bin/jq"
# 自检：产物必须是 ELF（不是包装脚本、不是空壳）——fail fast，别等 verify 那一关才发现。
if ! "$READELF_BIN" -h "$ROOT_DIR/$OUT/bin/jq" >/dev/null 2>&1; then
  echo "::error title=产物不是 ELF::$(file -b "$ROOT_DIR/$OUT/bin/jq")"
  exit 1
fi

# 自证：不得依赖 libonig（否则上机缺库）
if "$READELF_BIN" -d "$ROOT_DIR/$OUT/bin/jq" | grep -q 'libonig'; then
  echo "::error title=jq 依赖外部 libonig::vendored oniguruma 被编成了共享库 —— 我们的件只有 bin/jq，上机必缺库"
  "$READELF_BIN" -d "$ROOT_DIR/$OUT/bin/jq" | grep -i needed || true
  exit 1
fi
echo "$JQ_VERSION" > "$ROOT_DIR/$OUT/jq.version"
SIZE=$(stat -c%s "$ROOT_DIR/$OUT/bin/jq")
echo "[jq] 产出 $ROOT_DIR/$OUT/bin/jq（$SIZE 字节，无外部 libonig）"
