'use strict';
// engine 测试链完整性门禁：test/ 下的测试脚本必须都在 package.json 的 test:logic 链里 ——
// 否则**新增测试会静默漏跑**（kernel 侧早有同型门禁，engine 侧此前没有）。
// 门禁法③：≤60 行 + 违例样本自证（见 proofs）。
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const chain = require(path.join(ROOT, 'package.json')).scripts['test:logic'];
const HELPERS = new Set(['harness.js', 'boot-fixture.js']); // 运行器/夹具，不单独入链
const files = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.js'));
const tests = files.filter((f) => !HELPERS.has(f));
const inChain = (f) => chain.includes('test/' + f);
const orphans = tests.filter((f) => !inChain(f));
const refs = chain.split(' && ').map((s) => (s.match(/test\/[\w.-]+\.js/) || [])[0]).filter(Boolean);
const dead = refs.filter((p) => !fs.existsSync(path.join(ROOT, p)));
// 自证：孤儿判据要能抓样本、入链判据要认得出真成员、扫描不能是空集。
const proofs = [
  ['抓孤儿', !inChain('definitely-not-in-chain.js')],
  ['认已入链', inChain(tests[0])],
  ['非空扫描', tests.length > 0],
];
const blind = proofs.filter(([, ok]) => !ok).map(([n]) => n);
if (blind.length) {
  console.log('FAIL 门禁自证失败（判据空转）: ' + blind.join(','));
  process.exit(1);
}
if (orphans.length || dead.length) {
  console.log('FAIL engine 测试链不完整：');
  orphans.forEach((f) => console.log('  未入链: test/' + f));
  dead.forEach((p) => console.log('  死引用: ' + p));
  process.exit(1);
}
console.log('PASS engine 测试链完整（' + tests.length + ' 个测试脚本全部入链，无死引用）');
