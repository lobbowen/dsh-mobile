'use strict';
// 分层依赖门禁：L0 容器 与 L1 内核 不得互相引用源码；容器不得内置 Agent 产品名。
// 规则来源：docs/STORAGE-STANDARD.md §1 / ARCHITECTURE 分层约定。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.gradle', '.cache']);
const problems = [];

function walk(dir, out, filter) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, filter);
    else if (e.isFile() && (!filter || filter(p))) out.push(p);
  }
}
const rel = (p) => path.relative(ROOT, p);

// R1：容器 Kotlin 不得出现 Agent 产品名（容器不认识具体 Agent）
const AGENT = /codex|claude|openai|anthropic|deepseek/i;
const kt = [];
walk(path.join(ROOT, 'container', 'app'), kt, (p) => p.endsWith('.kt'));
for (const f of kt) if (AGENT.test(fs.readFileSync(f, 'utf8'))) problems.push('R1 容器 Kotlin 含 Agent 产品名: ' + rel(f));

// R2：内核非测试代码不得 require 到 container/
const kj = [];
walk(path.join(ROOT, 'kernel'), kj, (p) => p.endsWith('.js') && !rel(p).startsWith('kernel/test/'));
for (const f of kj) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/require\(['"]([^'"]+)['"]/g)) {
    if (m[1].includes('container/')) problems.push('R2 内核引用容器源码: ' + rel(f) + ' -> ' + m[1]);
  }
}

// R3：容器引擎非测试代码不得 require 到内核源码（tests 允许，见 bridge-interop）
const ej = [];
walk(path.join(ROOT, 'container', 'engine'), ej, (p) => p.endsWith('.js') && !rel(p).startsWith('container/engine/test/'));
for (const f of ej) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/require\(['"]([^'"]+)['"]/g)) {
    if (m[1].includes('kernel/') && m[1].includes('..')) problems.push('R3 容器引擎引用内核源码: ' + rel(f) + ' -> ' + m[1]);
  }
}

if (problems.length) {
  console.log('FAIL 分层依赖违规：');
  problems.forEach((p) => console.log('  ' + p));
  console.log('\n结果: 0 passed, 1 failed');
  process.exit(1);
}
console.log('PASS 分层依赖无违规（R1 容器无 Agent 名 / R2 内核不引容器 / R3 引擎不引内核）');
console.log('结果: 1 passed, 0 failed');
