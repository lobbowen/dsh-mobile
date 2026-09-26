'use strict';
// 分层依赖门禁：L0 容器 与 L1 内核 不得互相引用源码；容器不得内置 Agent 产品名。
// 规则来源：docs/standards/storage.md §1 / docs/architecture.md 分层约定。
// 门禁法③：扫描门禁 ≤60 行，且必须带违例样本自证（见文末 proofs）。
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
const reqs = (src) => [...src.matchAll(/require\(['"]([^'"]+)['"]/g)].map((m) => m[1]);
const collect = (dir, filter) => { const o = []; walk(dir, o, filter); return o; };

// R1：容器 Kotlin 不得出现 Agent 产品名（容器不认识具体 Agent）
const AGENT = /codex|claude|openai|anthropic|deepseek/i;
const kt = collect(path.join(ROOT, 'container', 'app'), (p) => p.endsWith('.kt'));
for (const f of kt) if (AGENT.test(fs.readFileSync(f, 'utf8'))) problems.push('R1 容器 Kotlin 含 Agent 产品名: ' + rel(f));

// R2：内核非测试代码不得 require 到 container/
const kj = collect(path.join(ROOT, 'kernel'), (p) => p.endsWith('.js') && !rel(p).startsWith('kernel/test/'));
for (const f of kj) for (const s of reqs(fs.readFileSync(f, 'utf8'))) if (s.includes('container/')) problems.push('R2 内核引用容器源码: ' + rel(f) + ' -> ' + s);

// R3：容器引擎非测试代码不得 require 到内核源码（tests 允许，见 bridge-interop）
const ej = collect(path.join(ROOT, 'container', 'engine'), (p) => p.endsWith('.js') && !rel(p).startsWith('container/engine/test/'));
for (const f of ej) for (const s of reqs(fs.readFileSync(f, 'utf8'))) if (s.includes('kernel/') && s.includes('..')) problems.push('R3 容器引擎引用内核源码: ' + rel(f) + ' -> ' + s);

// 自证：判据要能抓样本、目录要真扫到文件 —— 否则「零命中」是空转。
const proofs = [
  ['R1', AGENT.test('com.deepseek.X') && !AGENT.test('class A')],
  ['R2', reqs("require('../../container/engine/x')").some((s) => s.includes('container/'))],
  ['R3', reqs("require('../kernel/src/x')").some((s) => s.includes('kernel/') && s.includes('..'))],
  ['覆盖', kt.length > 0 && kj.length > 0 && ej.length > 0],
];
const blind = proofs.filter(([, ok]) => !ok).map(([n]) => n);
if (blind.length) {
  console.log('FAIL 门禁自证失败（判据空转，零命中不代表清白）: ' + blind.join(','));
  console.log(String.fromCharCode(10) + '结果: 0 passed, 1 failed');
  process.exit(1);
}
if (problems.length) {
  console.log('FAIL 分层依赖违规：');
  problems.forEach((p) => console.log('  ' + p));
  console.log(String.fromCharCode(10) + '结果: 0 passed, 1 failed');
  process.exit(1);
}
console.log('PASS 分层依赖无违规（R1 容器无 Agent 名 / R2 内核不引容器 / R3 引擎不引内核）');
console.log('结果: 1 passed, 0 failed');
