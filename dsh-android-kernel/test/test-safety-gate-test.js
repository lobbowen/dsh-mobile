#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 测试**不得产生真实副作用**（P1-F 事故后立的门禁，2026-09-12）
//
// ## 事故
//
// 我写 P1-F 行为测试时，用「patch 模块导出」的方式替换 npm 可执行：
//
// ```js
// const execPath = require('.../exec-path.js');
// execPath.npmBin = () => fakeNpm;   // ← 看起来对，实际无效
// ```
//
// 但 `const { npmBin } = require(...)` 是**值绑定**：调用方拿到的是函数值，
// patch 模块导出**不会**影响已解构的绑定。于是那次「伪造的 npm 挂起」
// 实际执行了**真实 `npm uninstall -g`**。
//
// 那次恰好是 no-op（目标 prefix 从未安装该包），但这是**侥幸**：
// 若目标 prefix 真有包，测试就会删掉用户环境。
//
// ## 门禁内容
//   A  测试文件不得 patch require(...) 得到的模块对象的导出以伪造依赖
//      （识别形如 `<mod>.<fn> = ...` 其中 `<mod>` 来自 require 绑定）
//   B  若测试需要假外部命令，必须用 `new X({ npmBin: ... })` 这类**构造期注入**
//   C  卸载/安装相关测试必须显式注入，绝不依赖真实 npm
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const testDir = path.join(ROOT, 'test');
const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.js') && f !== path.basename(__filename));

// ── A：识别「patch require 绑定的模块导出」──
// 形态：先 `const X = require('...')`（非解构），后 `X.someFn = ...`
const offenders = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(testDir, f), 'utf8');
  const lines = src.split(String.fromCharCode(10));
  // 收集非解构的 require 绑定名（`const X = require(...)`）
  const mods = new Set();
  for (const l of lines) {
    const m = l.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(/);
    if (m) mods.add(m[1]);
  }
  if (!mods.size) continue;
  lines.forEach((l, i) => {
    const s = l.trim();
    if (s.startsWith('//')) return;
    for (const mod of mods) {
      // `X.foo = ...`（赋值给模块对象的属性）—— 典型的依赖伪造
      const re = new RegExp('(^|[^\\w$.])' + mod.replace(/[$]/g, '\\$') + '\\s*\\.\\s*[A-Za-z_$][\\w$]*\\s*=[^=]');
      if (re.test(l)) offenders.push(f + ':' + (i + 1) + '  ' + s.slice(0, 60) + '  [模块 ' + mod + ']');
    }
  });
}
check('A 测试未 patch 模块导出以伪造依赖（值绑定无效 → 会跑真实副作用）',
  offenders.length === 0,
  offenders.length ? offenders.join(' | ') : '未发现');

// ── B/C：卸载/安装类行为测试必须显式注入 npmBin ──
{
  const behaviorFiles = files.filter((f) => /uninstall|install/.test(f) && /behavior/.test(f));
  check('B 存在卸载/安装行为测试', behaviorFiles.length > 0, behaviorFiles.join(',') || '（无）');
  for (const f of behaviorFiles) {
    const src = fs.readFileSync(path.join(testDir, f), 'utf8');
    check('C ' + f + ' 显式注入 npmBin（绝不解析到真实 npm）',
      /npmBin\s*:/.test(src), '已注入');
    check('C ' + f + ' 有「绝不用真实 npm」的前置断言',
      /_npmBin/.test(src), '有');
  }
}

// ── 反向：门禁自身必须能识别伪造（自检）──
{
  const probe = ['const execPath = require("./x");', 'execPath.npmBin = () => 1;'].join(String.fromCharCode(10));
  const mods = new Set();
  for (const l of probe.split(String.fromCharCode(10))) {
    const m = l.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(/);
    if (m) mods.add(m[1]);
  }
  let hit = false;
  for (const mod of mods) {
    if (new RegExp('(^|[^\\w$.])' + mod + '\\s*\\.\\s*[A-Za-z_$][\\w$]*\\s*=[^=]').test(probe)) hit = true;
  }
  check('反向：识别逻辑对已知伪造样本有效（门禁非空转）', hit === true, 'hit=' + hit);
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);