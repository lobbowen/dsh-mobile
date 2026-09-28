'use strict';

// 工程红线守卫：本文件被每个面板测试以 `node --require ./test/_preload.js` 预载。
// 守卫的唯一实现住 scripts/require-ci.js（require 即触发，非 CI 环境 exit 86）。
require('../../../scripts/require-ci.js');

// 测试隔离预载：为每个测试进程注入独立的面板状态根 LOBOS_PANEL_HOME=<temp>。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.env.LOBOS_PANEL_HOME || !String(process.env.LOBOS_PANEL_HOME).trim()) {
  process.env.LOBOS_PANEL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lobos-panel-test-'));
}

