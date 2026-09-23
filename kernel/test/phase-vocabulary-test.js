#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// phase 词表唯一源（K3 回归，2026-09-11）
//
// ## 修复的缺陷
//
// 仓里曾有两份**各自维护**的 phase 词表：
//   · `guard/lifecycle/objects.js` —— 控制平面 v3 canonical（supervisor.js 注释亦如此声明）；
//   · `guard/lifecycle/managed.js`   —— 一份自建副本。
//
// 两者**两个方向都不一致**：
//   副本多了 `degraded`（全仓 0 处使用 —— 死词）；
//   副本少了 `installing` / `backoff` / `failed` / `restarting`。
//
// 危害不是「不一致」本身，而是它与 `_setPhase` 的**静默丢弃**叠加：
//     _setPhase(p) { if (!PHASES.includes(p)) return; }   // 写错值 → 无声拒绝
// 于是 `managed` 侧永远表达不了 `installing`/`backoff`/`failed`/`restarting`，
// 且随时可能因副本漂移而继续无声拒绝合法值。
//
// ## 锁定不变量
//   K3-a  managed 与 objects 的 PHASES 必须是**同一数组**（同一引用，非内容相等）
//   K3-b  canonical 词表不得含死词 `degraded`
//   K3-c  canonical 必须含真实在用的状态（installing/backoff/failed/restarting）
//   K3-d  全仓不存在第二份 PHASES 字面量定义
//   K3-e  `_setPhase` 对非白名单值静默丢弃的行为**被文档化**（防被误当 bug 改掉）
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');

const managed = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'managed.js'));
const objects = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'objects.js'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// ── K3-a 同一引用（这是「唯一源」的强判据：内容相等 ≠ 同源）──
check('K3-a managed.PHASES 与 objects.PHASES 是同一数组引用',
  managed.PHASES === objects.PHASES,
  'managed===objects ? ' + (managed.PHASES === objects.PHASES));

// ── K3-b 死词 `degraded` 不得回流 ──
check('K3-b canonical 不含死词 degraded',
  !objects.PHASES.includes('degraded'),
  JSON.stringify(objects.PHASES));

// ── K3-c 真实在用的状态必须都在表内（防「合并时抄成较小的那份」）──
const needed = ['stopped', 'installing', 'starting', 'running', 'draining', 'backoff', 'failed', 'restarting'];
const missing = needed.filter((p) => !objects.PHASES.includes(p));
check('K3-c canonical 覆盖全部在用的真实状态',
  missing.length === 0,
  missing.length ? '缺 ' + missing.join(',') : '完备');

// ── K3-d 全仓不存在第二份 PHASES 字面量定义 ──
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = walk(path.join(ROOT, 'src'), []);
const defs = [];
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  // 只找「本文件自己定义一份字面量数组」的写法
  for (const m of t.matchAll(/^const PHASES\s*=\s*\[/gm)) {
    defs.push(f.replace(ROOT + path.sep, ''));
  }
}
check('K3-d 全仓只有一处 PHASES 字面量定义',
  defs.length === 1 && defs[0].endsWith(path.join('lifecycle', 'objects.js')),
  defs.length ? defs.join(', ') : '（无）');

// ── K3-e `_setPhase` 的静默丢弃行为被文档化 ──
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'guard', 'lifecycle', 'managed.js'), 'utf8');
  check('K3-e _setPhase 静默丢弃的行为有注释说明（防被误改）',
    /静默丢弃/.test(src) && /PHASES\.includes/.test(src),
    '注释与实现都在');
}

// ── 行为面：白名单执法仍然生效（合并不能把校验弄丢）──
{
  const lc = new managed.ManagedLifecycle({ id: 'k3-t', kind: 'test', name: 'T' });
  lc._setPhase('running');
  const okSet = lc.phase === 'running';
  lc._setPhase('不是合法状态');
  check('白名单执法：非法值被拒绝（phase 不变）', okSet && lc.phase === 'running', 'phase=' + lc.phase);
  // 合并后新增的合法值现在必须被接受（旧副本会静默拒绝）
  lc._setPhase('backoff');
  check('合并后 backoff 被接受（旧副本会静默拒绝）', lc.phase === 'backoff', 'phase=' + lc.phase);
  lc._setPhase('failed');
  check('合并后 failed 被接受（旧副本会静默拒绝）', lc.phase === 'failed', 'phase=' + lc.phase);
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);