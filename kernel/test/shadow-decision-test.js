#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 影子决策与真实拉起门的一致性（K5 回归，2026-09-11）
//
// ## 修复的缺陷
//
// 真实拉起门是 `supervisor.js::_shouldRun()`，它有三个否决位：
//     desired !== 'running'  /  _sessionHalting()  /  _crashHalted
//
// 而影子的 `_decideMainAction()`（「纯计算应然下一步」）**只建模了第一个**。
// 于是 `guardian=false` 崩溃后停靠（`_crashHalted=true`）时：
//   · 真实 tick：`_shouldRun()` 返回 false → 不拉起；
//   · 影子：算出 `action:'start'` → 与实然 diff。
// 每拍都 diff → 日志持续刷 `[shadow] 不一致` → **G3 切换门槛（连续零 diff）永久不可达**。
//
// ## 锁定不变量
//   K5-a  crashHalted=true 时，STOPPED 不得给出 start（与 _shouldRun 一致）
//   K5-b  sessionHalting=true 时，同样不得给出 start
//   K5-c  两个否决位**优先于** probeOk（不得因探测到端口而 adopt）
//   K5-d  正常情况（无否决位）仍能给出 start —— 防「修成永不拉起」
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const desc = require(path.join(ROOT, 'src', 'guard', 'supervisor', 'converge-view.js'));
const decide = desc._decideMainAction.value;

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

check('前置：_decideMainAction 是纯函数且可取到', typeof decide === 'function', typeof decide);

// 基线快照：desired=running / phase=STOPPED / 无任何否决位
const base = () => ({
  phase: 'STOPPED', desired: 'running',
  probeOk: false, probeHttpOk: false,
  childAlive: false, adoptedAlive: false, adoptedPidSet: false, childPresent: false,
  adopted: false, observedOnly: false,
  upgradeHold: false, manualRestart: false, spawnBlocked: false,
  startDeadlinePassed: false, restartDue: true, backoffDue: true,
  crashHalted: false, sessionHalting: false,
});

// ── K5-d 基线：无否决位 → 应当 start ──
{
  const r = decide(base());
  check('K5-d 无否决位 → action=start（防修成永不拉起）', r.action === 'start', JSON.stringify(r));
}

// ── K5-a crashHalted ──
{
  const s = base(); s.crashHalted = true;
  const r = decide(s);
  check('K5-a crashHalted → 不得 start（与 _shouldRun 一致）', r.action !== 'start', JSON.stringify(r));
  check('K5-a crashHalted → reason 指明停靠等待', /crash_halted/.test(r.reason || ''), String(r.reason));
}

// ── K5-b sessionHalting ──
{
  const s = base(); s.sessionHalting = true;
  const r = decide(s);
  check('K5-b sessionHalting → 不得 start', r.action !== 'start', JSON.stringify(r));
  check('K5-b sessionHalting → reason 指明退出中', /session_halting/.test(r.reason || ''), String(r.reason));
}

// ── K5-c 否决位优先于 probeOk ──
{
  const s = base(); s.crashHalted = true; s.probeOk = true;
  const r = decide(s);
  check('K5-c crashHalted 优先于 probeOk（不得 adopt）', r.action !== 'start' && r.action !== 'adopt', JSON.stringify(r));
}

// ── 反向：desired=stopped 仍优先（不应被新分支破坏）──
{
  const s = base(); s.desired = 'stopped'; s.childAlive = true;
  const r = decide(s);
  check('desired=stopped 仍优先给出 stop', r.action === 'stop', JSON.stringify(r));
}

// ── 反向：无否决位时的 adopt 路径仍在 ──
{
  const s = base(); s.probeOk = true;
  const r = decide(s);
  check('无否决位 + probeOk → adopt（原有分支未被破坏）', r.action === 'adopt', JSON.stringify(r));
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);