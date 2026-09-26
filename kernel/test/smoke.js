#!/usr/bin/env node
'use strict';

// 冒烟测试：按设计文档 §12 的核心用例验证 dsh-supervisor（全部针对 mock 目标，不触碰真实 DSH）。
// 用法: node test/smoke.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
// 端口手工分配在安全段（避开 OS ephemeral 与生产池）；跨文件不撞号靠人工规划，T1 兜底。

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'dsh-supervisor');
const MOCK = path.join(__dirname, 'mock-target.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sup-test-'));

// 测试卫生（RC6）：任意退出路径统一清理 mock/守护进程——防残留进程污染下一轮运行
process.on('exit', () => {
  try { const { execSync } = require('node:child_process');
    execSync("pkill -CONT -f 'mock-target.js' || true", { stdio: 'ignore' });
    execSync("pkill -9 -f 'mock-target.js' || true", { stdio: 'ignore' });
  } catch {}
});

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

// ---- 工具 ----
function makeConfig(apiPort, targetPort, overrides = {}) {
  return {
    command: ['node', MOCK, String(targetPort)],
    healthUrl: `http://127.0.0.1:${targetPort}/`,
    probeIntervalMs: 300,
    probeTimeoutMs: 1200,
    failThreshold: 2,
    startTimeoutMs: 5000,
    stopGraceMs: 800,
    killWaitMs: 1500,
    portReleaseWaitMs: 600,
    crashWindowMs: 10000,
    crashBurst: 4,
    backoff: [1500, 3000, 6000],
    // adopt 令牌接管观察窗拉满：mock 目标从不打印 DSH 启动令牌，adopt 场景若用默认 20s 窗
    // 会在场景停留期内误触发 adopt_token_reclaim 重建（搅乱 adopted/无 spawn 断言）；
    // 令牌重建逻辑由 test/adopt-token-reclaim-test.js 用短窗专门覆盖，冒烟链路保持确定性。
    tokenReclaimGraceMs: 3600000,
    apiHost: '127.0.0.1',
    apiPort,
    stateFile: path.join(TMP, `state-${apiPort}.json`),
    logFile: path.join(TMP, `events-${apiPort}.log`),
    supervisorLogFile: path.join(TMP, `supervisor-${apiPort}.log`),
    dshLogFile: path.join(TMP, `dsh-${apiPort}.log`),
    upgradeLogFile: path.join(TMP, `upgrade-${apiPort}.log`),
    ...overrides,
  };
}

function api(port, method, p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({ error: 'parse', raw: body });
        }
      });
      res.on('error', () => resolve({ error: 'response error' }));
    });
    req.on('error', () => resolve({ error: 'conn' }));
    req.end();
  });
}

async function waitStatus(port, pred, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await api(port, 'GET', '/status');
    if (!s.error && pred(s)) return s;
    await sleep(200);
  }
  return null;
}

async function getEvents(port) {
  const r = await api(port, 'GET', '/events?limit=500');
  return (r && r.events) || [];
}

function startDaemon(cfg, env = {}) {
  const cfgPath = path.join(TMP, `cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const child = spawn('node', [CLI, 'daemon', '-c', cfgPath], {
    env: { ...process.env, DSH_SUPERVISOR_CONFIG: cfgPath, DSH_SUPERVISOR_LOCK_FILE: path.join(TMP, 'guard-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.lock'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return { child, cfgPath, out: () => out };
}

async function killDaemon(d) {
  if (!d.child.killed) d.child.kill('SIGTERM');
  await new Promise((r) => d.child.once('exit', r));
}

// ---- 场景 ----
async function main() {
  // 2026-09: 守护跟着开关走(默认关,守护开才自动拉起)
  try {
    fs.writeFileSync(path.join(TMP, 'dsh-main.json'), JSON.stringify({ guardian: true }));
  } catch (e) {}
  console.log('== S1: 自动启动（desired=running → spawn → RUNNING）==');
  const d1 = startDaemon(makeConfig(3900, 3901));
  let s = await waitStatus(3900, (x) => x.phase === 'RUNNING' && x.dshPid);
  check('daemon 自动拉起目标并进入 RUNNING', !!s, JSON.stringify(s));
  let ev = await getEvents(3900);
  check('存在 spawned 事件', ev.some((e) => e.type === 'spawned'));

  console.log('== S2: 崩溃恢复（kill -9 → 自动重启）==');
  const pid1 = s.dshPid;
  try {
    process.kill(pid1, 'SIGKILL');
  } catch {}
  s = await waitStatus(3900, (x) => x.phase === 'RUNNING' && x.dshPid && x.dshPid !== pid1, 20000);
  check('SIGKILL 后自动重启到新 pid', !!s, JSON.stringify(s));
  ev = await getEvents(3900);
  check(
    'restart_triggered 记录 exit 原因',
    ev.some((e) => e.type === 'restart_triggered' && /exit:/.test((e.data && e.data.reason) || ''))
  );

  console.log('== S3: 纯端口/进程判定——挂起进程端口仍在=健康，不误杀不重启 ==');
  const pid2 = s.dshPid;
  try {
    process.kill(pid2, 'SIGSTOP');
  } catch {}
  // 当前设计只做端口+pid 判定(已删HTTP探测)：进程虽被 SIGSTOP 挂起，但端口仍监听、pid 仍存活 → 视为健康，不重启
  await sleep(1200);
  s = await api(3900, 'GET', '/status');
  check('挂起进程不误重启(仍运行同一 pid)', s && s.phase === 'RUNNING' && s.dshPid === pid2, JSON.stringify(s));
  ev = await getEvents(3900);
  check('未触发 http_unhealthy 重启', !ev.some((e) => e.type === 'restart_triggered' && /http_unhealthy/.test((e.data && e.data.reason) || '')), JSON.stringify(ev.map((e) => e.type)));
  check('未对挂起进程使用 SIGKILL', !ev.some((e) => e.type === 'sigkill_sent'));
  // 恢复进程，供后续场景使用
  try {
    process.kill(pid2, 'SIGCONT');
  } catch {}
  s = await waitStatus(3900, (x) => x.phase === 'RUNNING' && x.dshPid === pid2, 5000);
  check('SIGCONT 恢复后运行正常', !!s, JSON.stringify(s));

  console.log('== S4: 主动停服不误拉（desired=stopped）==');
  const evPreStop = await getEvents(3900);
  const spawnBeforeStop = evPreStop.filter((e) => e.type === 'spawned').length;
  await api(3900, 'POST', '/lifecycle/dsh/stop');
  s = await waitStatus(3900, (x) => x.phase === 'STOPPED' && x.desired === 'stopped' && !x.dshPid);
  check('stop 后进入 STOPPED', !!s, JSON.stringify(s));
  await sleep(2000);
  s = await api(3900, 'GET', '/status');
  ev = await getEvents(3900);
  const spawnAfterStop = ev.filter((e) => e.type === 'spawned').length;
  check(
    'desired=stopped 期间不重新 spawn',
    s.phase === 'STOPPED' && spawnAfterStop === spawnBeforeStop,
    'phase=' + s.phase + ' spawns=' + spawnAfterStop + '/' + spawnBeforeStop
  );

  console.log('== S5: 重新启动（desired=running）==');
  await api(3900, 'POST', '/lifecycle/dsh/start');
  s = await waitStatus(3900, (x) => x.phase === 'RUNNING' && x.dshPid);
  check('start 后恢复 RUNNING', !!s, JSON.stringify(s));

  console.log('== S6: 手动重启一次（不改变 desired、不计崩溃次数）==');
  const rcBefore = s.restartCount;
  const pid3 = s.dshPid;
  await api(3900, 'POST', '/lifecycle/dsh/restart');
  s = await waitStatus(3900, (x) => x.phase === 'RUNNING' && x.dshPid && x.dshPid !== pid3, 20000);
  check('manual restart 执行', !!s, JSON.stringify(s));
  ev = await getEvents(3900);
  check('manual_restart_requested 事件存在', ev.some((e) => e.type === 'manual_restart_requested'));
  check('restartCount 未被手动重启计入', s.restartCount === rcBefore, `before=${rcBefore} after=${s.restartCount}`);
  await killDaemon(d1);
  // 场景卫生：守卫退出不动目标（守护语义）→ 显式清掉本场景最后的目标进程，防遗留 mock 在下一场景
  // 被 re-derive/adopt 误接管（S7 崩溃循环与 S1 目标端口曾因该遗留偶发串扰）。
  if (s && s.dshPid) { try { process.kill(s.dshPid, 'SIGKILL'); } catch {} }

  console.log('== S7: 崩溃循环退避（启动即挂 ×N → BACKOFF）==');
  const d2 = startDaemon(
    makeConfig(3910, 3911, { startTimeoutMs: 700, crashWindowMs: 30000 }),
    { MOCK_EXIT_ON_START: '1' }
  );
  s = await waitStatus(3910, (x) => x.phase === 'BACKOFF', 28200);
  // BACKOFF 窗口短，phase 快照可能错过；以事件为准
  ev = await getEvents(3910);
  check('crash_loop_entered 事件存在', ev.some((e) => e.type === 'crash_loop_entered'));
  if (!s) {
    s = await waitStatus(3910, (x) => x.backoffLevel >= 0, 5000);
  }
  await sleep(2500); // 等退避到期重试并再次失败，验证退避升级
  s = await waitStatus(3910, (x) => x.backoffLevel >= 1, 15000);
  check('退避级别升级（backoffLevel >= 1）', !!s, JSON.stringify(s));
  await killDaemon(d2);

  console.log('== S8: 接管既有实例（adopt）＋ 无主实例恢复 ==');
  const external = spawn('node', [MOCK, '3921'], { stdio: 'ignore' });
  await sleep(600);
  const d3 = startDaemon(makeConfig(3920, 3921));
  s = await waitStatus(3920, (x) => x.phase === 'RUNNING' && x.adopted === true, 10000);
  check('接管既有健康实例（adopted）', !!s, JSON.stringify(s));
  ev = await getEvents(3920);
  check('adopted 事件存在且无 spawn', ev.some((e) => e.type === 'adopted') && !ev.some((e) => e.type === 'spawned'));
  external.kill('SIGKILL');
  s = await waitStatus(3920, (x) => x.phase === 'RUNNING' && x.dshPid, 20000);
  check('无主实例消亡后由守卫拉起自己的实例', !!s, JSON.stringify(s));
  await killDaemon(d3);

  console.log('== S9: 端口被不健康进程占用：不硬抢、只告警（§12 用例7）==');
  const occupier = http.createServer((req, res) => { res.writeHead(500); res.end('no'); });
  await new Promise((r) => occupier.listen(3961, '127.0.0.1', r));
  const d9 = startDaemon(makeConfig(3960, 3961));
  // 不要用固定 sleep：守卫完成「探测目标端口 → 判定被占」的耗时随 runner 负载波动，
  // 固定的 3s 在较慢的 runner 上不够（实测 Windows CI #24 只有 guard_started/api_listening，
  // 于是偶发失败）。改为轮询等待目标事件，超时再判定。
  ev = await getEvents(3960);
  {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !ev.some((e) => e.type === 'port_occupied_unhealthy')) {
      await sleep(250);
      ev = await getEvents(3960);
    }
  }
  s = await api(3960, 'GET', '/status');
  check(
    '端口被占时守卫不 spawn、只记 port_occupied_unhealthy',
    ev.some((e) => e.type === 'port_occupied_unhealthy') && !ev.some((e) => e.type === 'spawned'),
    JSON.stringify(ev.map((e) => e.type))
  );
  check('占用期间保持 STOPPED 等待', s.phase === 'STOPPED', 'phase=' + s.phase);
  await killDaemon(d9);
  occupier.close();

  console.log('== S10: 守卫崩溃重启幂等，不叠加实例（§12 用例5）==');
  const cfgX = makeConfig(3970, 3971);
  const dx1 = startDaemon(cfgX);
  s = await waitStatus(3970, (x) => x.phase === 'RUNNING' && x.dshPid, 15000);
  check('首个守卫拉起目标', !!s, JSON.stringify(s));
  const targetPid1 = s.dshPid;
  ev = await getEvents(3970);
  const spawnedBeforeCrash = ev.filter((e) => e.type === 'spawned').length;
  try { process.kill(dx1.child.pid, 'SIGKILL'); } catch {}
  await sleep(800);
  const dx2 = startDaemon(cfgX);
  s = await waitStatus(3970, (x) => x.phase === 'RUNNING' && x.adopted === true, 15000);
  check('新守卫接管既有实例而非二次 spawn', !!s, JSON.stringify(s));
  ev = await getEvents(3970);
  const spawnedAfterAdopt = ev.filter((e) => e.type === 'spawned').length;
  check('接管过程未新增 spawn', spawnedAfterAdopt === spawnedBeforeCrash, spawnedBeforeCrash + ' -> ' + spawnedAfterAdopt);
  check('接管记录了目标 pid', s && s.dshPid === targetPid1, targetPid1 + ' -> ' + (s && s.dshPid));
  try { process.kill(targetPid1, 'SIGKILL'); } catch {}
  s = await waitStatus(3970, (x) => x.phase === 'RUNNING' && x.dshPid && x.dshPid !== targetPid1, 25000);
  check('无主目标消亡后新守卫拉起自己的实例', !!s, JSON.stringify(s));
  await killDaemon(dx2);

  console.log('== S11: 接管实例可被 stop 停止 ==');
  const external11 = spawn('node', [MOCK, '3981'], { stdio: 'ignore' });
  const extExited = new Promise((r) => external11.once('exit', r));
  await sleep(600);
  const d11 = startDaemon(makeConfig(3980, 3981));
  s = await waitStatus(3980, (x) => x.phase === 'RUNNING' && x.adopted === true && x.dshPid, 10000);
  check('接管外部实例并识别 pid', !!s && s.dshPid === external11.pid, JSON.stringify(s));
  await api(3980, 'POST', '/lifecycle/dsh/stop');
  const extResult = await Promise.race([extExited, sleep(6000).then(() => 'timeout')]);
  check('stop 后外部实例进程退出', extResult !== 'timeout', String(extResult));
  s = await api(3980, 'GET', '/status');
  check('守卫收敛到 STOPPED 且不再拉起', s.phase === 'STOPPED' && s.desired === 'stopped', JSON.stringify(s));
  await killDaemon(d11);

  console.log('== S12: desired=stopped 时观测无主实例，不强杀；start 无缝转正 ==');
  const ext12 = spawn('node', [MOCK, '3991'], { stdio: 'ignore' });
  await sleep(600);
  const cfg12 = makeConfig(3990, 3991);
  fs.writeFileSync(cfg12.stateFile, JSON.stringify({ desired: 'stopped' })); // 预置期望停止
  const d12 = startDaemon(cfg12);
  s = await waitStatus(3990, (x) => x.phase === 'OBSERVED' && x.adopted === true && x.dshPid === ext12.pid, 10000);
  check('期望停止下进入 OBSERVED 并识别 pid', !!s, JSON.stringify(s));
  let extAlive = true;
  try { process.kill(ext12.pid, 0); } catch { extAlive = false; }
  check('观测模式不强杀运行中的实例', extAlive);
  ev = await getEvents(3990);
  check('记录 adopted_observed 事件', ev.some((e) => e.type === 'adopted_observed'));
  await api(3990, 'POST', '/lifecycle/dsh/start');
  s = await waitStatus(3990, (x) => x.phase === 'RUNNING' && x.dshPid === ext12.pid && x.adopted === true, 10000);
  check('start 后同一实例无缝转正纳管', !!s, JSON.stringify(s));
  ev = await getEvents(3990);
  const spawns12 = ev.filter((e) => e.type === 'spawned').length;
  check('转正过程未重新 spawn', spawns12 === 0, 'spawns=' + spawns12);
  await killDaemon(d12);
  try { ext12.kill('SIGKILL'); } catch {}

  // 清理残留 mock：先 SIGCONT（S3 场景 SIGSTOP 过的挂起进程不响应 SIGTERM，pkill 默认信号会漏杀
  // → 残留 mock 占住 3900-3991 端口段，下一轮链序的 S1 会 adopt 而非 spawn，导致偶发 FAIL）；
  // 再用 SIGKILL（对任意态进程有效，含 T 态）。
  try {
    const { execSync } = require('node:child_process');
    execSync("pkill -CONT -f 'mock-target.js' || true", { stdio: 'ignore' });
    execSync("pkill -9 -f 'mock-target.js'", { stdio: 'ignore' });
  } catch {}

  console.log('\n==============================');
  console.log(`结果: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('smoke test error:', e);
  process.exit(1);
});