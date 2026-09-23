#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// `ManagedLifecycle.restart()` 回退路径必须**尊重 stop/start 的显式失败**
//（第十轮，2026-09-12）
//
// ## 缺陷
//
// 无 `_restart` 回调时（通用模块走 stop→start），原实现：
//
//     const wasDesired = this.desired;
//     await this.stop('restart');      // 返回值丢弃
//     if (wasDesired === 'running') await this.start();   // 返回值丢弃
//     return { ok: true };             // ← 无条件成功
//
// 于是 `POST /lifecycle/{id}/restart`（api/lifecycle.js:73）在「停不掉」或「起不来」时
// 仍报成功 → 面板显示「已重启」而模块实际是死的/还活着。
//
// 这是 K4 修复（start/stop 尊重 `{ok:false}`）的**对称面被遗漏**：
//   同一纪律覆盖了 start/stop，漏了 restart 的回退分支。
//
// ## 锁定不变量
//   P-a  stop 返回 `{ok:false}` → restart 报 `{ok:false}`（且 error 含「停止失败」）
//   P-b  start 返回 `{ok:false}` → restart 报 `{ok:false}`（且 error 含「启动失败」）
//   P-c  两步都成功 → restart 报 `{ok:true}`（不误伤正常路径）
//   P-d  有 `_restart` 回调时仍优先用回调（且尊重其 `{ok:false}`）
//   P-e  回退路径不吞异常（throw → `{ok:false}`）
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { ManagedLifecycle } = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'managed.js'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const mk = (o) => new ManagedLifecycle(Object.assign({
  id: 'm1', kind: 'module', name: 'm1',
  logger: { info() {}, warn() {}, error() {} },
}, o));

(async () => {
  // ── P-a：stop 失败 ──
  {
    const lc = mk({
      start: async () => ({ ok: true }),
      stop: async () => ({ ok: false, error: '进程未退出' }),
    });
    lc.desired = 'running';
    lc.phase = 'running';
    const r = await lc.restart();
    check('P-a stop 失败 → restart 报 ok:false', r.ok === false, JSON.stringify({ ok: r.ok, error: r.error }));
    check('P-a error 标明是「停止失败」', /停止失败/.test(String(r.error)), String(r.error));
  }

  // ── P-b：start 失败（stop 成功）──
  {
    const lc = mk({
      start: async () => ({ ok: false, error: '单元起不来' }),
      stop: async () => ({ ok: true }),
    });
    lc.desired = 'running';
    lc.phase = 'running';
    const r = await lc.restart();
    check('P-b start 失败 → restart 报 ok:false', r.ok === false, JSON.stringify({ ok: r.ok, error: r.error }));
    check('P-b error 标明是「启动失败」', /启动失败/.test(String(r.error)), String(r.error));
  }

  // ── P-c：两步都成功 ──
  {
    const seen = [];
    const lc = mk({
      start: async () => { seen.push('start'); return { ok: true }; },
      stop: async () => { seen.push('stop'); return { ok: true }; },
    });
    lc.desired = 'running';
    lc.phase = 'running';
    const r = await lc.restart();
    check('P-c 两步成功 → ok:true（正常路径不误伤）', r.ok === true, JSON.stringify({ ok: r.ok }));
    check('P-c 确实走了 stop→start', seen.join(',') === 'stop,start', seen.join(','));
  }

  // ── P-d：_restart 回调优先 ──
  {
    let usedCb = false;
    const lc = mk({
      restart: async () => { usedCb = true; return { ok: false, error: '回调明确失败' }; },
      start: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
    });
    lc.desired = 'running';
    lc.phase = 'running';
    const r = await lc.restart();
    check('P-d 有回调时优先用回调', usedCb === true, '用了回调');
    check('P-d 回调 ok:false 被尊重', r.ok === false && /回调明确失败/.test(String(r.error)), JSON.stringify({ ok: r.ok, error: r.error }));
  }

  // ── P-e：回退路径不吞异常 ──
  {
    const lc = mk({
      start: async () => ({ ok: true }),
      stop: async () => { throw new Error('stop 抛了'); },
    });
    lc.desired = 'running';
    lc.phase = 'running';
    let threw = null;
    let r = null;
    try { r = await lc.restart(); } catch (e) { threw = e; }
    // stop() 内部已 try/catch → 返回 {ok:false}；restart 应把它当失败上报，而不是抛或当成功
    check('P-e stop 抛异常 → restart 不抛出', threw === null, threw ? threw.message : '无异常');
    check('P-e 且如实报 ok:false', r && r.ok === false, JSON.stringify({ ok: r && r.ok, error: r && r.error }));
  }

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();