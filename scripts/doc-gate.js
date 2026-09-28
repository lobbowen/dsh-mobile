#!/usr/bin/env node
'use strict';
// 文档门：docs/** 与根 README 里的**相对链接**必须指向存在的文件。
// 动机：品牌门把 docs/ 整目录白名单后，文档里的死链永远不会红（复检 AUD-G42）。
// 用法：node scripts/doc-gate.js [--strict]
//   默认报告模式（exit 0，写 doc-gate-report.txt）；--strict 有死链即 exit 1。
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const strict = process.argv.includes('--strict');
const SKIP = new Set(['node_modules', '.git', 'build', 'dist']);
function walk(d, out) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.md')) out.push(p);
  }
  return out;
}
const files = [...walk(path.join(root, 'docs'), []), path.join(root, 'README.md')];
const broken = [];
for (const f of files) {
  let t; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const base = path.dirname(f);
  for (const m of t.matchAll(/\]\(([^)]+)\)/g)) {
    let target = m[1].trim().split(/\s+/)[0];
    if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
    target = target.split('#')[0];
    if (!target) continue;
    const abs = path.resolve(base, target);
    if (!fs.existsSync(abs)) broken.push(path.relative(root, f) + ' -> ' + target);
  }
}
const lines = ['# 文档门报告（' + new Date().toISOString() + '）', '', '扫描 md 文件：' + files.length, '死链：' + broken.length, ''];
lines.push(...broken);
fs.writeFileSync(path.join(root, 'doc-gate-report.txt'), lines.join('\n') + '\n');
console.log('doc-gate: files=' + files.length + ' broken=' + broken.length);
for (const b of broken.slice(0, 15)) console.log('  ' + b);
if (strict && broken.length) { console.error('doc-gate: FAIL（上面的相对链接指向不存在的文件）'); process.exit(1); }
process.exit(0);
