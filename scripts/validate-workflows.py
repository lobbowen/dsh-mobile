#!/usr/bin/env python3
"""校验 .github/workflows/*.yml 的 YAML 语法。

为什么单独一个脚本：这段检查原先在 fast-apk / build-apk 里各写一份**内联 heredoc**，
ci.yml 却没有 —— 结果是"workflow 写坏"要等到出包流程才暴露，而门禁流程反而绿灯。
提成单一脚本后，三处（含 ci.yml）都调它，且**只有一份实现**。

为什么要这个门禁：YAML 里一个未加引号的 ": " 就能让整个 workflow 解析失败，
而 GitHub 对解析失败的表现是"根本没有 job"（0 个 step），极易被误读成"没触发"。
"""
import glob
import sys

try:
    import yaml
except ImportError:
    print('[FAIL] 缺少 PyYAML（CI 环境应自带）')
    sys.exit(1)

bad = 0
files = sorted(glob.glob('.github/workflows/*.yml'))
if not files:
    print('[FAIL] 没有找到任何 workflow 文件（工作目录不对？）')
    sys.exit(1)

for f in files:
    try:
        with open(f, encoding='utf-8') as fh:
            yaml.safe_load(fh)
        print('[ok] ' + f)
    except Exception as e:  # noqa: BLE001 —— 这里就是要捕获一切解析错误
        print('[FAIL] ' + f + ': ' + str(e))
        bad += 1

sys.exit(1 if bad else 0)
