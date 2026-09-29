#!/usr/bin/env bash
# pnpm —— C 层工具供给批次里**上游已发 android 变体**的那一颗（其余四颗本仓交叉编译）。
#
# 为什么不编译：pnpm 自己发 `@pnpm/exe.android-arm64`（单文件 ELF，PT_INTERP=/system/bin/linker64），
# 形态是否合格由 verify-userland-artifact.sh 一处判（ELF 判据单一宿主），这里不重复一份尺子。
#
# 为什么由 CI 取而不是设备上 `npm i -g pnpm`：设备所在网络取不到 registry.npmjs.org（GitHub 也不可达），
#   设备唯一的取件口是对象存储 ⇒ 投放动作只能住在发布面，件仍按 C 的清单形状（zip + 内容寻址名 + sha256）落 `$PREFIX/bin/pnpm`。
#
# 双钉的理由：registry 内容不可假设不变（与 build-userland-npm.sh 同一条纪律）。
#   · tarball 的 sha512 = 上游 packument 的 `dist.integrity`；
#   · **件内 ELF 的 sha256** —— 清单/真机钉的是 zip，而 zip 每次重打包字节都不同，
#     所以「取回的还是不是那颗件」只能钉在 ELF 自身上。
set -euo pipefail

HERE=$(dirname "$0")
cd "$HERE/.."
ROOT_DIR=$(pwd)

PNPM_VERSION=12.7.0
TARBALL_SHA512_B64=gJTCsUbazAEbIMF9l2t+z3YWHCI0AiThtBsxU6FrxXK0tZsBRZZWpleLs0uY8Dy6V0RcPEusn3UyuAyFn3dkeA==
ELF_SHA256=ce0b5e064552f60ec5b153d767b464f8d64f7659dbc2c58780679ac7e5bdfe78
ELF_SIZE=47033992
TARBALL=https://registry.npmjs.org/@pnpm/exe.android-arm64/-/exe.android-arm64-${PNPM_VERSION}.tgz

# 钉本身先自证形状：sha512 的 base64 恒为 88 字且以 == 结尾（64 字节 %3==1），sha256 十六进制恒 64 字。
# 抄漏一位 padding 时，比对处的红话会写成「上游内容变了」，把人往错方向支（2026-09-30 CI 实吃到过）。
if [ "${#TARBALL_SHA512_B64}" != 88 ]; then
  echo "::error title=钉本身不合法::sha512 的 base64 应为 88 字，实为 ${#TARBALL_SHA512_B64} 字"
  exit 1
fi
case "$TARBALL_SHA512_B64" in
  *==) : ;;
  *) echo "::error title=钉本身不合法::sha512 的 base64 应以 == 结尾（64 字节 %3==1），实为 ${TARBALL_SHA512_B64: -2}"; exit 1 ;;
esac
if [ "${#ELF_SHA256}" != 64 ]; then
  echo "::error title=钉本身不合法::sha256 十六进制应为 64 字，实为 ${#ELF_SHA256} 字"
  exit 1
fi

OUT="${OUT:-dist}"
mkdir -p "$ROOT_DIR/$OUT/bin" "$ROOT_DIR/work"

echo "[pnpm] 取上游 android-arm64 变体 $TARBALL"
if ! curl -fsSL "$TARBALL" -o "$ROOT_DIR/work/pnpm-exe.tgz"; then
  echo "::error title=取不到上游件::$TARBALL"
  exit 1
fi

GOT512=$(openssl dgst -sha512 -binary "$ROOT_DIR/work/pnpm-exe.tgz" | openssl base64 -A)
if [ "$GOT512" != "$TARBALL_SHA512_B64" ]; then
  echo "::error title=tarball sha512 不符::实取 $GOT512 ≠ 钉住的 $TARBALL_SHA512_B64（上游内容变了，升级要主动改这里）"
  exit 1
fi
echo "[pnpm] tarball $(stat -c%s "$ROOT_DIR/work/pnpm-exe.tgz") 字节，sha512 与上游 packument 一致"

rm -rf "$ROOT_DIR/work/pnpm" && mkdir -p "$ROOT_DIR/work/pnpm"
tar xzf "$ROOT_DIR/work/pnpm-exe.tgz" -C "$ROOT_DIR/work/pnpm" --strip-components=1
SRC="$ROOT_DIR/work/pnpm/pnpm"
if [ ! -f "$SRC" ]; then
  echo "::error title=件里找不到 ELF 真身::期望 package/pnpm（上游改包结构了？）；实际内容如下"
  ls -la "$ROOT_DIR/work/pnpm" || true
  exit 1
fi

GOT256=$(sha256sum "$SRC" | cut -d' ' -f1)
if [ "$GOT256" != "$ELF_SHA256" ]; then
  echo "::error title=ELF sha256 不符::实取 $GOT256 ≠ 钉住的 $ELF_SHA256"
  exit 1
fi
SIZE=$(stat -c%s "$SRC")
if [ "$SIZE" != "$ELF_SIZE" ]; then
  echo "::error title=ELF 尺寸不符::$SIZE ≠ $ELF_SIZE"
  exit 1
fi
# 只要「是个 ELF」这一格：aarch64 与动态链接的判定归 verify-userland-artifact.sh，不在这里抄第二份。
MAGIC=$(head -c 4 "$SRC" | od -An -tx1 | tr -d ' \n')
if [ "$MAGIC" != "7f454c46" ]; then
  echo "::error title=真身不是 ELF::前四字节 $MAGIC"
  exit 1
fi

cp "$SRC" "$ROOT_DIR/$OUT/bin/pnpm"
chmod 0755 "$ROOT_DIR/$OUT/bin/pnpm"
printf '%s\n' "$PNPM_VERSION" > "$ROOT_DIR/$OUT/pnpm.version"
echo "[pnpm] 产出 $ROOT_DIR/$OUT/bin/pnpm（$SIZE 字节，sha256 $GOT256）"
