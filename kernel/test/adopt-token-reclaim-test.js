#!/usr/bin/env node
'use strict';

// adopt 令牌接管回归测试（2026-09）：守卫重启后接管的主 DSH 不是本守卫 spawn 的（无 stdout 管道），
// 启动令牌只打印在旧守卫已断开的管道里 → 永久不可达 → 远程控制（relay 换 dsh-auth cookie）401。
// 验证 _maybeReclaimAdoptToken 的观察窗语义：
//   1) adopt + 主令牌空置 → 先启动观察窗，窗口过后才受控重建一次（countCrash:false）；
//   2) 重建只触发一次（_tokenReclaimTried 防循环）；
//   3) 令牌已就绪 / 本守卫 spawn（有 child）→ 不干预；
//   4) 窗口内令牌到位 → 复位观察，不重建；
//   5) 未配置 tokenReclaimGraceMs 时默认观察窗 20s。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-token-reclaim-'));

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log('  PASS ' + name);
  } else {
    failed++;
    console.log('  FAIL ' + name + (extra ? '  ← ' + extra : ''));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildSupervisor(overrides = {}) {
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const cfg = {
    command: ['node', '/nonexistent/bin/dsh', 'web'],
    healthUrl: 'http://127.0.0.1:28000/',
    apiHost: '127.0.0.1', apiPort: 28001,
    stateFile: path.join(TMP, 'state.json'),
    logFile: path.join(TMP, 'events.log'),
    supervisorLogFile: path.join(TMP, 'sup.log'),
    dshLogFile: path.join(TMP, 'dsh.log'),
    upgradeLogFile: path.join(TMP, 'upg.log'),
    ...overrides,
  };
  const cfgPath = path.join(TMP, 'cfg-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  return new Supervisor(cfg, cfgPath);
}

async function main() {
  console.log('== 令牌接管: adopt + 主令牌空置 → 观察窗后受控重建一次 ==');
  {
    const sup = buildSupervisor({ tokenReclaimGraceMs: 120 });
    const restarts = [];
    sup._beginRestart = (reason, opts) => restarts.push({ reason, opts });
    // 模拟：守卫重启后 adopt 了旧守卫 spawn 的主 DSH（无 stdout 管道、令牌不可达）
    sup.phase = 'RUNNING';
    sup.adopted = true;
    sup.adoptedPid = 99999;
    sup.child = null;
    // 播种行已删（RC2.2）：构造契约保证初始为 null；此用例同时回归 P1-1 未初始化缺陷
    // 首次 tick：令牌空置 → 只启动观察窗，不立即重建
    sup._maybeReclaimAdoptToken();
    check('观察窗内不立即重建（restart 未触发）', restarts.length === 0 && sup._tokenReclaimAt !== null);
    // 窗口未满：再次 tick 仍不重建
    sup._maybeReclaimAdoptToken();
    check('观察窗未满不重建', restarts.length === 0);
    await sleep(200);
    // 窗口已过：触发一次受控重建
    sup._maybeReclaimAdoptToken();
    check('窗口过后触发重建（reason=adopt_token_reclaim）', restarts.length === 1 && restarts[0].reason === 'adopt_token_reclaim' && restarts[0].opts.countCrash === false, JSON.stringify(restarts));
    check('重建后置 tried 标记', sup._tokenReclaimTried === true);
    // 后续 tick：tried 防循环，不再重建
    await sleep(50);
    sup._maybeReclaimAdoptToken();
    check('tried 防循环（只重建一次）', restarts.length === 1);
  }

  console.log('== 令牌接管: 主令牌已就绪 → 不干预 ==');
  {
    const sup = buildSupervisor({ tokenReclaimGraceMs: 120 });
    const restarts = [];
    sup._beginRestart = (reason, opts) => restarts.push({ reason, opts });
    sup.phase = 'RUNNING';
    sup.adopted = true;
    sup.adoptedPid = 99999;
    sup.child = null;
    // 播种行已删（RC2.2）：构造契约保证初始为 null；此用例同时回归 P1-1 未初始化缺陷
    sup.tokenService._tokens.set('main', { token: 'tok-abc' }); // 令牌可捕获/已就绪
    await sleep(200);
    sup._maybeReclaimAdoptToken();
    check('令牌就绪不触发重建', restarts.length === 0);
    check('令牌就绪不复位为重建（观察窗不启动）', sup._tokenReclaimAt === null);
  }

  console.log('== 令牌接管: 本守卫 spawn（有 child 管道）→ 不干预 ==');
  {
    const sup = buildSupervisor({ tokenReclaimGraceMs: 120 });
    const restarts = [];
    sup._beginRestart = (reason, opts) => restarts.push({ reason, opts });
    sup.phase = 'RUNNING';
    sup.adopted = false;
    sup.adoptedPid = null;
    sup.child = { pid: 11111, exitCode: null, signalCode: null }; // 自 spawn：stdout 管道在，令牌可达
    // 播种行已删（RC2.2）：构造契约保证初始为 null；此用例同时回归 P1-1 未初始化缺陷
    await sleep(200);
    sup._maybeReclaimAdoptToken();
    check('自 spawn 不触发重建', restarts.length === 0);
    check('自 spawn 不复位为重建', sup._tokenReclaimAt === null);
  }

  console.log('== 令牌接管: 观察窗内令牌到位 → 复位观察，不重建 ==');
  {
    const sup = buildSupervisor({ tokenReclaimGraceMs: 10000 });
    const restarts = [];
    sup._beginRestart = (reason, opts) => restarts.push({ reason, opts });
    sup.phase = 'RUNNING';
    sup.adopted = true;
    sup.adoptedPid = 99999;
    sup.child = null;
    // 播种行已删（RC2.2）：构造契约保证初始为 null；此用例同时回归 P1-1 未初始化缺陷
    sup._maybeReclaimAdoptToken(); // 空置 → 启动观察窗
    check('窗口启动（reclaimAt 置位）', sup._tokenReclaimAt !== null);
    sup.tokenService._tokens.set('main', { token: 'tok-late' }); // 窗口内令牌迟到（journald/回填补获）
    sup._maybeReclaimAdoptToken();
    check('令牌迟到 → 复位观察不重建', restarts.length === 0 && sup._tokenReclaimAt === null);
    await sleep(50);
    sup._maybeReclaimAdoptToken();
    check('复位后令牌仍在 → 仍不重建', restarts.length === 0 && sup._tokenReclaimAt === null);
  }

  console.log('== 令牌接管: 默认观察窗 = 20s ==');
  {
    const sup = buildSupervisor({}); // 不配 tokenReclaimGraceMs
    sup.phase = 'RUNNING';
    sup.adopted = true;
    sup.adoptedPid = 99999;
    sup.child = null;
    // 播种行已删（RC2.2）：构造契约保证初始为 null；此用例同时回归 P1-1 未初始化缺陷
    sup._maybeReclaimAdoptToken();
    const gap = sup._tokenReclaimAt - Date.now();
    check('默认窗 20000ms', gap > 18000 && gap <= 20000, 'gap=' + gap);
  }

  console.log('\n==============================');
  console.log(`结果: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
