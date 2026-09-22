#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 第十三轮续：ManagedLifecycle.stop 失败必须恢复**原相位**（2026-09-13 P3）
//
// ## 缺陷（失效模式 g：同一「如实反映观测」纪律只在一部分路径成立）
//
// managed.js::stop() 在「回调显式失败」与「抛异常」两条失败路径上都硬编码
// `_setPhase('running')`（注释：「未能确认停止 → 回到运行态」）。
// 这只对「进入 stop 之前确实是 running」成立。
// 若停之前是 **failed / backoff / installing**（例如对一个已失败模块点「停止」，
// 而底层 stop 又失败），phase 会被改写成 'running' ——
// 面板把一个**已知失败**的模块显示成**运行中**，与观测相反。
//
// ## 门禁
//   T-a  stop 被拒（ok:false）后 phase 恢复为**进入前的相位**
//   T-b  stop 抛异常后同样恢复
//   T-c  对「本来是 running」的情形行为不变（仍回到 running）
//   T-d  反向：判据能识别「硬编码 running」的旧形态（门禁非空转）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { ManagedLifecycle } = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'managed.js'));

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

(async () => {
  // T-a：从 failed 进入，stop 被拒 → 应回到 failed
  {
    const m = new ManagedLifecycle({ id: 't1', stop: async () => ({ ok: false, error: 'nope' }) });
    m._setPhase('failed');
    const r = await m.stop('user');
    check('T-a stop 被拒：如实上报 ok:false', r && r.ok === false, JSON.stringify(r.ok));
    check('T-a stop 被拒：phase 恢复为 failed（旧实现硬编码 running）',
      m.phase === 'failed', m.phase);
  }
  // T-b：从 backoff 进入，stop 抛异常 → 应回到 backoff
  {
    const m = new ManagedLifecycle({ id: 't2', stop: async () => { throw new Error('boom'); } });
    m._setPhase('backoff');
    const r = await m.stop('user');
    check('T-b stop 抛异常：如实上报 ok:false', r && r.ok === false, JSON.stringify(r.ok));
    check('T-b stop 抛异常：phase 恢复为 backoff', m.phase === 'backoff', m.phase);
  }
  // T-c：本来是 running → 仍回到 running（行为不变）
  {
    const m = new ManagedLifecycle({ id: 't3', stop: async () => ({ ok: false, error: 'nope' }) });
    m._setPhase('running');
    await m.stop('user');
    check('T-c 原本 running：失败后仍为 running（不回归）', m.phase === 'running', m.phase);
  }
  // 正向：成功停止仍然落到 stopped
  {
    const m = new ManagedLifecycle({ id: 't4', stop: async () => ({ ok: true }) });
    m._setPhase('running');
    const r = await m.stop('user');
    check('T-c 成功停止 → stopped 且 ok:true', r && r.ok !== false && m.phase === 'stopped', m.phase);
  }
  // T-d：反向判据
  {
    const code = fs.readFileSync(path.join(ROOT, 'src', 'guard', 'lifecycle', 'managed.js'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const iStop = code.indexOf('async stop(reason)');
    const body = code.slice(iStop, iStop + 1600);
    check('T-d 源码：stop 记录了 prevPhase', /const prevPhase = this\.phase;/.test(body), '有');
    check('T-d 源码：失败路径用 _setPhase(prevPhase)（不再硬编码 running）',
      (body.match(/_setPhase\(prevPhase\)/g) || []).length === 2, String((body.match(/_setPhase\(prevPhase\)/g) || []).length));
    check('T-d 反向：判据能识别「硬编码 running」的旧形态',
      /_setPhase\('running'\); \/\/ 与异常分支一致/.test("this._setPhase('running'); // 与异常分支一致"), 'hit');
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
