'use strict';

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
