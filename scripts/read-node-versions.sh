#!/usr/bin/env bash
# read-node-versions.sh <键> —— node 运行时事实源（assets/node-versions.json）的唯一读取出口。
# 原先 fast-apk（default+abi 两处）与 ci.yml（default 一处）各写内联 `python -c`，
# JSON 结构一变（改键名/加嵌套）最常被跑的那条链会拿着旧判据静默漂移。
# 本脚本按自身位置定位仓库根，不依赖 cwd（测试断言因此可直接 spawnSync）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
F="$ROOT/container/app/src/main/assets/node-versions.json"
key="${1:?usage: read-node-versions.sh <key>}"
python3 - "$F" "$key" <<'PY'
import json, sys
path, key = sys.argv[1], sys.argv[2]
try:
    print(json.load(open(path))[key])
except Exception as e:
    print('[FAIL] %s 读 %r: %s' % (path, key, e), file=sys.stderr)
    sys.exit(1)
PY
