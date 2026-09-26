#!/usr/bin/env bash
# 小件能力件：**命中固化就取用，否则现场编译** —— "编译一次，之后不再编"的收敛点。
#
# 判据（三者缺一即回退，绝不"看起来能用就用"）：
#   1) 当前**源指纹**（scripts/native-capabilities-fingerprint.sh）在固化记录里有条目；
#   2) 能从 Release 下载并**逐字节校验 sha256**（清单里的 sha256）；
#   3) 解包后**档位清单里每一件都在**（缺件 = 固化包不完整 → 回退）。
#
# 任一不满足 → 调 scripts/build-native-capabilities.sh 现场编译（= 收敛前的行为，永远可用）。
# 这样"固化机制坏了"只会退化成"慢"，不会退化成"打不出包"。
set -uo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"
ABI="${ABI:-arm64-v8a}"
PIN=".github/native-capabilities-pin.json"
CAPS=".github/native-capabilities.txt"
JNI="container/app/src/main/jniLibs/$ABI"

FP="$(bash scripts/native-capabilities-fingerprint.sh)"
echo "[caps] 源指纹 = $FP"

# ── 1) 查固化记录 ──
ENVF="$(mktemp)"
if ! node -e '
  const fs = require("fs");
  const [pin, fp, out] = process.argv.slice(1);
  let j = {};
  try { j = JSON.parse(fs.readFileSync(pin, "utf8")); } catch { process.exit(3); }
  const e = (j.pins || {})[fp];
  if (!e || !e.tag || !e.zip || !e.sha256) process.exit(3);
  fs.appendFileSync(out, "TAG=" + e.tag + String.fromCharCode(10) + "ZIP=" + e.zip + String.fromCharCode(10) + "SHA=" + e.sha256 + String.fromCharCode(10));
' "$PIN" "$FP" "$ENVF"; then
  echo "[caps] 该指纹未固化 —— 回退现场编译（跑 Pin native capabilities 可固化它）"
  rm -f "$ENVF"
  exec bash scripts/build-native-capabilities.sh
fi
# shellcheck disable=SC1090
set -a; . "$ENVF"; set +a
rm -f "$ENVF"
echo "[caps] 命中固化：$TAG  ($ZIP)"

# ── 2) 下载 + 逐字节校验 ──
[ -n "${GITHUB_REPOSITORY:-}" ] || { echo "[error] 环境里没有 GITHUB_REPOSITORY，不知道该去哪取 —— 回退现场编译。" >&2; exec bash scripts/build-native-capabilities.sh; }
D="$(mktemp -d)"
if ! gh release download "$TAG" -p "$ZIP" -D "$D" --repo "$GITHUB_REPOSITORY" --clobber; then
  echo "[warn] 下载 $TAG/$ZIP 失败 —— 回退现场编译。"
  exec bash scripts/build-native-capabilities.sh
fi
if ! echo "$SHA  $D/$ZIP" | sha256sum -c - >/dev/null 2>&1; then
  echo "[warn] $ZIP 的 sha256 与固化记录不符 —— 回退现场编译（不取用可疑产物）。"
  exec bash scripts/build-native-capabilities.sh
fi
echo "[caps] sha256 校验通过"

# ── 3) 解包 + 逐件核对 ──
unzip -o -q "$D/$ZIP" -d "$D/x" || { echo "[warn] 解包失败 —— 回退现场编译。"; exec bash scripts/build-native-capabilities.sh; }
mkdir -p "$JNI"
MISSING=""
N=0
while read -r TIER LIB _ID; do
  case "$TIER" in ''|'#'*) continue ;; esac
  if [ -f "$D/x/$LIB" ]; then cp "$D/x/$LIB" "$JNI/$LIB"; N=$((N + 1)); else MISSING="$MISSING $LIB"; fi
done < "$CAPS"
if [ -n "$MISSING" ]; then
  echo "[warn] 固化包里缺件:$MISSING —— 回退现场编译（不取用不完整的固化）。"
  exec bash scripts/build-native-capabilities.sh
fi
echo "[ok] 已取用固化产物 $N 件（**未重新编译**）"
