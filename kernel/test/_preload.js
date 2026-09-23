'use strict';

// ── 工程红线守卫（见 docs/runbook/testing-standard.md）────────────────────────
// 本文件被**每一个**内核测试以 `node --require ./test/_preload.js` 预载，
// 因此把守卫放这里 = 连"直接调用单个测试文件"也被拦住。
if (!process.env.CI) {
  console.error('');
  console.error('  ✗ 拒绝执行：本仓禁止在本地运行测试（内核）。');
  console.error('    红线与判据：docs/runbook/testing-standard.md；合法通道：CI。');
  console.error('');
  process.exit(86);
}

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
