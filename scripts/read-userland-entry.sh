#!/usr/bin/env bash
# read-userland-entry.sh <工具名> —— C 层一件的**可执行面在件内的路径**的唯一读取出口。
#
# 为什么要有这个出口：入口先前由两处各自推导 —— 打包脚本硬看 `dist/bin/<名>`、发布器硬写
#   `entry: 'bin/' + 名`（`SupplyProvisioner` 只是最后读清单那一格）。推导不是判据：
#   npm 撞上的就是它 —— 包里与真名同名的 `bin/npm` 是 Windows 安装器用的 bash shim（在我们的布局里
#   必挂），真正能被解释器接住的是它自己 package.json 的 bin 映射指着的 `bin/npm-cli.js`。
# 所以这里**不给默认值**：没声明就是空 + 退 1，让调用方判红。「加一件」必须同时说清入口，
#   与「件没有能力判据就不许发布」是同一条纪律。
#
# 事实源：scripts/userland-verify.json 的 criteria.<件>.entry（发布侧副本；随件下发到清单）。
# 本脚本按自身位置定位仓库根，不依赖 cwd（与 read-node-versions.sh 同）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
F="$ROOT/scripts/userland-verify.json"
key="${1:?usage: read-userland-entry.sh <tool>}"
python3 - "$F" "$key" <<'PY'
import json, sys
path, tool = sys.argv[1], sys.argv[2]
try:
    j = json.load(open(path))
    crit = j.get('criteria') or {}
    entry = (crit.get(tool) or {}).get('entry')
except Exception as e:
    print('[FAIL] %s 读 %r: %s' % (path, tool, e), file=sys.stderr)
    sys.exit(1)
if not entry or '/' not in entry or entry.startswith('/') or '..' in entry.split('/'):
    print('[FAIL] %s: 件 %r 的 entry 未声明或不合规（应为件内相对路径，如 bin/<名>）' % (path, tool), file=sys.stderr)
    sys.exit(1)
print(entry)
PY
