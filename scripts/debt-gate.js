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
const TIERS = ['static', 'ci', 'online', 'device'];
const open = reg.items.filter((i) => i.status !== 'done');
const done = reg.items.length - open.length;
// D24：done 只说明"有人宣布做完"，不说明做到哪一层。没有档的一律按 static 记账，
// 并把「拿不出 online/device 证据」这件事打成一行可见数字，而不是埋在散文里。
const tierBad = [];
const tierCount = { unspecified: 0, static: 0, ci: 0, online: 0, device: 0 };
for (const i of reg.items.filter((x) => x.status === 'done')) {
  const t = i.evidenceTier;
  if (t === undefined) { tierCount.unspecified++; continue; }
  if (!TIERS.includes(t)) { tierBad.push(i.id + ' 的 evidenceTier 非法：' + JSON.stringify(t)); continue; }
  tierCount[t]++;
  if ((t === 'online' || t === 'device') && !i.evidenceRef) tierBad.push(i.id + ' 声称 ' + t + ' 档但没有 evidenceRef（现读时间与读数）');
}
console.log('debt-gate: total=' + reg.items.length + ' done=' + done + ' open=' + open.length);
console.log('debt-gate: done 证据档 online=' + tierCount.online + ' device=' + tierCount.device + ' ci=' + tierCount.ci + ' static=' + tierCount.static + ' 无档(按 static 记账)=' + tierCount.unspecified);
for (const i of open.slice(0, 20)) console.log('  [' + i.status + '] ' + i.id + ' ' + String(i.desc).slice(0, 70));
fs.writeFileSync(path.join(root, 'debt-gate-report.txt'),
  '# 债表门报告（' + new Date().toISOString() + '）\n\ntotal=' + reg.items.length + ' done=' + done + ' open=' + open.length + '\n\n'
  + 'done 证据档：online=' + tierCount.online + ' device=' + tierCount.device + ' ci=' + tierCount.ci + ' static=' + tierCount.static + ' 无档=' + tierCount.unspecified + '\n\n'
  + open.map((i) => '- [' + i.status + '] ' + i.id + ' ' + i.desc).join('\n') + '\n');
if (strict && tierBad.length) { console.error('debt-gate: FAIL（证据档不成立）'); for (const t of tierBad) console.error('  - ' + t); process.exit(1); }
if (strict && open.length) { console.error('debt-gate: FAIL（未清项 ' + open.length + '）'); process.exit(1); }
process.exit(0);
