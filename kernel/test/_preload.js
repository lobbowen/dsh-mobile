'use strict';

// ── 工程红线守卫（见 docs/standards/testing.md）────────────────────────
// 本文件被**每一个**内核测试以 `node --require ./test/_preload.js` 预载，
// 因此把守卫放这里 = 连"直接调用单个测试文件"也被拦住。
// 守卫的唯一实现住 scripts/require-ci.js（require 即触发，非 CI 环境 exit 86）。
// 不在本文件重写第二份 —— 同一判据只许一处实现（门禁法①）。
require('../../scripts/require-ci.js');

// 测试隔离预载（跨平台，不依赖 shell 的 export/set 语法）。
//   为每个测试进程注入独立的产品状态根：DSH_SUPERVISOR_HOME=<temp>。
//   子进程（测试 spawn 的 daemon 等）继承该变量 ⇒ 与父测试共享同一状态根。
//   Windows 的 cmd 不认 export VAR=...，故不能用 package.json 前缀注入 —— 用 node --require。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.env.DSH_SUPERVISOR_HOME || !String(process.env.DSH_SUPERVISOR_HOME).trim()) {
  process.env.DSH_SUPERVISOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-'));
}
