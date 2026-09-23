#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// ManagedLifecycle 的**显式失败**处理（K4 回归，2026-09-11）
//
// ## 修复的缺陷
//
// `ManagedLifecycle.start()` 旧实现**不看回调返回的 `r.ok`**：
//     const r = await this._start();
//     this._setPhase('running');   // ← 无条件
//     this.healthy = true;         // ← 无条件
// 于是适配器明确返回 `{ok:false, error}`（如 `setRouterRunning` 在 daemon 拉不起来时）
// 也会被记为「运行中且健康」—— `/lifecycle/status` 因此**谎报成功**，
// 面板显示运行中而服务实际是死的。
//
// `stop()` 有对称缺陷：回调返回 `{ok:false}` 时仍置 `stopped` —— 面板显示「已停止」
// 而进程可能还在跑。
//
// ## 锁定不变量
//   K4-a  start 回调返回 {ok:false} → phase 不得为 running、healthy 必须 false
//   K4-b  start 回调返回 {ok:false} → 返回值必须 ok:false 且带 error
//   K4-c  start 回调**不返回 ok 字段**（历史合法形态）→ 仍视为成功（向后兼容）
//   K4-d  stop 回调返回 {ok:false} → phase 不得为 stopped、desired 不得为 stopped
//   K4-e  回调抛异常 → 与返回 {ok:false} 同等视为失败
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { ManagedLifecycle } = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'managed.js'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

(async function main() {
  // ── K4-a/b：start 显式失败 ──
  {
    const lc = new ManagedLifecycle({
      id: 't1', kind: 'test', name: 'T1',
      start: async () => ({ ok: false, error: 'daemon 拉不起来' }),
      stop: async () => ({ ok: true }),
    });
    const r = await lc.start();
    check('K4-a start 显式失败 → phase 不是 running', lc.phase !== 'running', 'phase=' + lc.phase);
    check('K4-a start 显式失败 → healthy=false', lc.healthy === false, 'healthy=' + lc.healthy);
    check('K4-b start 显式失败 → 返回 ok:false', r.ok === false, JSON.stringify(r).slice(0, 70));
    check('K4-b start 显式失败 → 带回 error', r.error === 'daemon 拉不起来', String(r.error));
    check('K4-b start 显式失败 → snapshot 相位一致', lc.snapshot().phase !== 'running', 'snapshot.phase=' + lc.snapshot().phase);
  }

  // ── K4-c：无 ok 字段的历史形态仍视为成功 ──
  {
    const lc = new ManagedLifecycle({
      id: 't2', kind: 'test', name: 'T2',
      start: async () => undefined, // 老适配器可能不返回任何东西
      stop: async () => undefined,
    });
    const r = await lc.start();
    check('K4-c 无 ok 字段 → 视为成功（向后兼容）', r.ok !== false && lc.phase === 'running', 'phase=' + lc.phase);
    check('K4-c 无 ok 字段 → healthy=true', lc.healthy === true, 'healthy=' + lc.healthy);
  }

  // ── K4-d：stop 显式失败 ──
  {
    const lc = new ManagedLifecycle({
      id: 't3', kind: 'test', name: 'T3',
      start: async () => ({ ok: true }),
      stop: async () => ({ ok: false, error: '进程没死' }),
    });
    await lc.start();
    const r = await lc.stop('test');
    check('K4-d stop 显式失败 → phase 不是 stopped', lc.phase !== 'stopped', 'phase=' + lc.phase);
    check('K4-d stop 显式失败 → desired 不是 stopped', lc.desired !== 'stopped', 'desired=' + lc.desired);
    check('K4-d stop 显式失败 → 返回 ok:false 且带 error', r.ok === false && !!r.error, JSON.stringify(r).slice(0, 70));
  }

  // ── K4-e：抛异常与显式失败同语义 ──
  {
    const lc = new ManagedLifecycle({
      id: 't4', kind: 'test', name: 'T4',
      start: async () => { throw new Error('炸了'); },
    });
    const r = await lc.start();
    check('K4-e start 抛异常 → ok:false / phase 非 running', r.ok === false && lc.phase !== 'running', 'phase=' + lc.phase);
  }

  // ── 反向：成功路径不被误伤 ──
  {
    const lc = new ManagedLifecycle({
      id: 't5', kind: 'test', name: 'T5',
      start: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
    });
    await lc.start();
    const okStart = lc.phase === 'running' && lc.healthy === true;
    await lc.stop('test');
    check('成功路径不受影响（start→running，stop→stopped）', okStart && lc.phase === 'stopped' && lc.healthy === false,
      'phase=' + lc.phase);
  }

  // ── 幂等：已在 running/starting 时 start 直接返回 already ──
  {
    const lc = new ManagedLifecycle({ id: 't6', kind: 'test', name: 'T6', start: async () => ({ ok: true }) });
    await lc.start();
    const r = await lc.start();
    check('start 幂等（已在运行 → already）', r.ok === true && r.already === true, JSON.stringify(r));
  }

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();