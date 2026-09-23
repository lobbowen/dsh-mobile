#!/usr/bin/env node
'use strict';

// ============================================================================
// 跨层版本：校验 + 汇总（**只在 CI 运行**）。
// ============================================================================
// 用法：
//   node scripts/gen-version.js --check   校验各单一事实源齐全/合法（CI 门禁）
//   node scripts/gen-version.js           打印聚合清单（进 CI 日志，供评审）
//
// 为什么**不**生成一个进 git 的清单文件：
//   那会要求"本地先跑生成器、再提交结果"，与 docs/runbook/testing-standard.md 的
//   红线（本地不得调起任何仓内执行）直接冲突。改为 CI 侧校验 + 日志报告：
//   评审看 CI 日志即可看到"这次各层版本分别是什么"。
//
// 单一事实源分工（本脚本**只汇总，不产生新事实**）：
//   version.json                              壳（APK）versionName/versionCode
//   container/engine/package.json             引擎版本
//   kernel/package.json                       内核版本（OTA 包名同源）
//   kernel/ui/package.json                    面板版本
//   container/app/src/main/assets/node-versions.json  Node 运行时钉版（default/abi）
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const errors = [];

let version, engine, kernel, ui, nodeVersions;
for (const [name, assign] of [
  ['version.json', (v) => (version = v)],
  ['container/engine/package.json', (v) => (engine = v)],
  ['kernel/package.json', (v) => (kernel = v)],
  ['kernel/ui/package.json', (v) => (ui = v)],
  ['container/app/src/main/assets/node-versions.json', (v) => (nodeVersions = v)],
]) {
  try {
    assign(read(name));
  } catch (e) {
    errors.push(name + ' 无法读取/解析：' + e.message);
  }
}

const req = (cond, msg) => { if (!cond) errors.push(msg); };

if (errors.length === 0) {
  const shell = version.shell || {};
  req(typeof shell.versionName === 'string' && shell.versionName.trim() !== '', 'version.json: shell.versionName 缺失');
  req(Number.isInteger(shell.versionCode) && shell.versionCode >= 1, 'version.json: shell.versionCode 必须是 >= 1 的整数');
  req(typeof engine.version === 'string' && engine.version !== '', 'container/engine/package.json: version 缺失');
  req(typeof kernel.version === 'string' && kernel.version !== '', 'kernel/package.json: version 缺失');
  req(typeof ui.version === 'string' && ui.version !== '', 'kernel/ui/package.json: version 缺失');
  req(typeof nodeVersions.default === 'string' && nodeVersions.default !== '', 'assets/node-versions.json: default 缺失');
  req(typeof nodeVersions.abi === 'string' && nodeVersions.abi !== '', 'assets/node-versions.json: abi 缺失');
}

if (errors.length > 0) {
  console.error('[version] ✗ 校验未通过：');
  for (const e of errors) console.error('    · ' + e);
  process.exit(1);
}

const shell = version.shell;
const line = (label, val) => console.log('  ' + String(label).padEnd(9) + val);
console.log('[version] 跨层版本（各单一事实源校验通过）');
line('shell', shell.versionName + '  (versionCode=' + shell.versionCode + ')');
line('engine', engine.name + ' ' + engine.version);
line('kernel', kernel.name + ' ' + kernel.version);
line('ui', ui.name + ' ' + ui.version);
line('runtime', 'node-runtime-' + nodeVersions.default + '-' + nodeVersions.abi);
line('apk', 'app-debug-' + shell.versionName + '+' + shell.versionCode + '.apk  （发布资产名）');
