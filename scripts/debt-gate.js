#!/usr/bin/env node
'use strict';
// 债表门：读 docs/plans/os-v4-debt-registry.json，未清项（status != done）必须可见。
// 用法：node scripts/debt-gate.js [--strict]
//   默认报告模式（exit 0）；--strict 有未清项即 exit 1（用于收口阶段）。
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const strict = process.argv.includes('--strict');
const file = path.join(root, 'docs/plans/os-v4-debt-registry.json');
const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
const open = reg.items.filter((i) => i.status !== 'done');
const done = reg.items.length - open.length;
console.log('debt-gate: total=' + reg.items.length + ' done=' + done + ' open=' + open.length);
for (const i of open.slice(0, 20)) console.log('  [' + i.status + '] ' + i.id + ' ' + String(i.desc).slice(0, 70));
fs.writeFileSync(path.join(root, 'debt-gate-report.txt'),
  '# 债表门报告（' + new Date().toISOString() + '）\n\ntotal=' + reg.items.length + ' done=' + done + ' open=' + open.length + '\n\n' +
  open.map((i) => '- [' + i.status + '] ' + i.id + ' ' + i.desc).join('\n') + '\n');
if (strict && open.length) { console.error('debt-gate: FAIL（未清项 ' + open.length + '）'); process.exit(1); }
process.exit(0);
