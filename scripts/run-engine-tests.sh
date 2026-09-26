#!/usr/bin/env bash
# 容器引擎逻辑测试（**唯一宿主**）：ci.yml 与 build-apk.yml 都调本脚本，不各写一份。
#
# 为什么要收口：此前两处各写了一遍，且 ci.yml 那份装了 readelf / openssl 而
# build-apk 那份**没装** —— 同一件事两种写法，迟早一边红一边绿。
#
# 工具没装**不是跳过测试的理由**：verify-runtime-elf-test.js 用合成 ELF 夹具真跑
# scripts/verify-runtime-elf.sh（取数靠 readelf），ota-anchor-test.js 用 openssl
# 现造临时 ed25519 密钥对证伪配对判据。先按唯一宿主把工具装上，让红只可能来自产物。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/container/engine"

bash "$ROOT/scripts/ensure-tool.sh" readelf binutils
bash "$ROOT/scripts/ensure-tool.sh" openssl openssl

LOG="${ENGINE_TEST_LOG:-/tmp/engine-test.log}"
npm run test:logic 2>&1 | tee "$LOG"
echo
echo "=== 容器引擎逻辑测试汇总 ==="
echo "$(grep -c '^PASS' "$LOG" || true) 个 PASS，$(grep -c '^FAIL' "$LOG" || true) 个 FAIL"
