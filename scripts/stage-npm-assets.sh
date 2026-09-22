#!/usr/bin/env bash
# ============================================================================
#  把钉死版本的 npm 投放到 APK assets（基础环境的一部分）
# ============================================================================
#  为什么 npm 进 APK 而不是内核包：
#    · npm 与 Node 版本锁死、几乎不变 —— 变化节奏属于 L0 基础环境；
#    · 内核包要过 8MB 体积上限并随每次 OTA 重传，+3MB 纯浪费。
#  为什么放 assets 而不是 jniLibs：
#    · npm 是纯 JS，在设备上**永远不该被直接 exec**（W^X 下唯一可 exec 的
#      是 nativeLibraryDir 的 libnode.so）；它由 libnode.so 代跑，
#      路径经 runtime.json 的 npmEntry 契约投放给内核。
#  版本与 sha512 双钉：registry 内容不可假设不变；升级 npm = 主动改这里。
#
#  用法：scripts/stage-npm-assets.sh [输出目录，默认 app/src/main/assets/npm]
#  产物：npm.zip（bin/lib/node_modules/package.json）+ version.txt
# ============================================================================
set -euo pipefail

NPM_VER="11.19.0"   # Node 24.21.0 官方捆绑版
NPM_SHA512="SDd/hHg3KqHE5Ht2NHWxNYNtqCQ2pXAPLl6OtQhPyED5PHsRfrOtO199MZTIG2cQoQ1ZRI9t28shrD+2cr3AAw=="

OUT="${1:-app/src/main/assets/npm}"
REPO_ROOT="$PWD"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSLo npm.tgz "https://registry.npmjs.org/npm/-/npm-${NPM_VER}.tgz"
H="$(openssl dgst -sha512 -binary npm.tgz | openssl base64 -A)"
if [ "$H" != "$NPM_SHA512" ]; then
  echo "[stage-npm] [error] npm tarball sha512 不符: $H" >&2
  exit 1
fi
tar xzf npm.tgz

mkdir -p "$REPO_ROOT/$OUT"
# 排除 docs/html/man：设备用不到，APK 体积白涨 1MB+
( cd package && zip -rq "$REPO_ROOT/$OUT/npm.zip" bin lib node_modules package.json )
printf '%s\n' "$NPM_VER" > "$REPO_ROOT/$OUT/version.txt"

echo "[stage-npm] 完成: $OUT/npm.zip $(stat -c%s "$REPO_ROOT/$OUT/npm.zip") 字节, npm ${NPM_VER}"
