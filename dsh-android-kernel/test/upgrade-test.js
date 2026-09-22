#!/usr/bin/env node
'use strict';

// 升级模块离线测试：mock registry + fake installer，不碰真实 npm 与真实 DSH。
// 覆盖：版本检查 / 一键升级全链路（安装→计划内重启→健康验证）/ 已是最新跳过 / 安装失败报错。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'dsh-supervisor');
const MOCK = path.join(__dirname, 'mock-target.js');
const FAKE = path.join(__dirname, 'fake-npm.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upg-test-'));

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

// ---- 版本比较单测 ----
function testCmp() {
  const { semverCompare } = require(path.join(ROOT, 'src', 'domains', 'dist'));
  const cases = [
    ['1.0.0', '2.0.0', -1],
    ['2.0.0', '1.0.0', 1],
    ['1.0.0', '1.0.0', 0],
    ['0.1.0-rc.8', '0.1.1-rc.1', -1],
    ['0.1.1-rc.1', '0.1.1', -1],
    ['0.1.1', '0.1.1-rc.1', 1],
    ['0.1.10', '0.1.9', 1],
  ];
  let ok = true;
  for (const [a, b, want] of cases) {
    const got = semverCompare(a, b) > 0 ? 1 : semverCompare(a, b) < 0 ? -1 : 0;
    if (got !== want) {
      ok = false;
      console.log(`  cmp(${a},${b}) = ${got}, want ${want}`);
    }
  }
  check('semverCompare 单测', ok);
}

// ---- mock registry ----
function startRegistry(port, version) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version }));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// ---- 工具 ----
function api(port, method, p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 8000 }, (res) => {
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

async function waitStatus(port, pred, timeoutMs = 28220) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await api(port, 'GET', '/status');
    if (!s.error && pred(s)) return s;
    await sleep(400);
  }
  return null;
}

async function waitUpgrade(port, pred, timeoutMs = 28221) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await api(port, 'GET', '/native/status');
    const u = (s && s.upgrade) || {};
    if (!s.error && pred(u)) return u;
    await sleep(500);
  }
  return null;
}

function makePkgJson(version) {
  const p = path.join(TMP, `pkg-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ name: '@deepseek-ai/dsh', version }, null, 2));
  return p;
}

function makeConfig(apiPort, targetPort, regPort, pkgJson, overrides = {}) {
  return {
    command: ['node', MOCK, String(targetPort)],
    healthUrl: `http://127.0.0.1:${targetPort}/`,
    probeIntervalMs: 300,
    probeTimeoutMs: 1000,
    failThreshold: 2,
    startTimeoutMs: 5000,
    stopGraceMs: 600,
    killWaitMs: 1500,
    portReleaseWaitMs: 600,
    crashWindowMs: 600000,
    crashBurst: 5,
    backoff: [1500, 3000],
    apiHost: '127.0.0.1',
    apiPort,
    stateFile: path.join(TMP, `state-${apiPort}.json`),
    logFile: path.join(TMP, `events-${apiPort}.log`),
    supervisorLogFile: path.join(TMP, `supervisor-${apiPort}.log`),
    dshLogFile: path.join(TMP, `dsh-${apiPort}.log`),
    upgradeLogFile: path.join(TMP, `upgrade-${apiPort}.log`),
    packageName: '@deepseek-ai/dsh',
    registries: [`http://127.0.0.1:${regPort}`],
    updateCheckIntervalMs: 3600000,
    initialCheckDelayMs: 20000,
    upgradeTimeoutMs: 30000,
    installedPkgJsonPath: pkgJson,
    installCommandTemplate: ['node', FAKE, '{version}'],
    ...overrides,
  };
}

function startDaemon(cfg, env = {}) {
  const cfgPath = path.join(TMP, `cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
// 测试卫生（RC6）：任意退出路径统一清理 mock——防残留进程污染下一轮运行
process.on('exit', () => {
  try { const { execSync } = require('node:child_process');
    execSync("pkill -CONT -f 'mock-target.js' || true", { stdio: 'ignore' });
    execSync("pkill -9 -f 'mock-target.js' || true", { stdio: 'ignore' });
  } catch {}
});

  // 场景前提：守护开（升级时 DSH 在运行，面板给升级用户的默认形态）。
  // dsh-main.json 与 stateFile 同目录；RC2 后升级恢复还叠加 upgrade-resume 意图。
  try { fs.writeFileSync(path.join(path.dirname(cfg.stateFile), 'dsh-main.json'), JSON.stringify({ guardian: true })); } catch {}

  const child = spawn('node', [CLI, 'daemon', '-c', cfgPath], {
    env: { ...process.env, DSH_SUPERVISOR_CONFIG: cfgPath, DSH_SUPERVISOR_LOCK_FILE: path.join(TMP, 'guard-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.lock'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return { child, out: () => out };
}

async function killDaemon(d) {
  if (!d.child.killed) d.child.kill('SIGTERM');
  await new Promise((r) => d.child.once('exit', r));
}

async function main() {
  testCmp();

  console.log('== U1: 版本检查（mock registry）==');
  await startRegistry(3950, '2.0.0');
  const pkgA = makePkgJson('1.0.0');
  const cfgA = makeConfig(3940, 3941, 3950, pkgA);
  const dA = startDaemon(cfgA, { FAKE_PKG_JSON: pkgA });
  let v = null;
  {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      v = (await api(3940, 'GET', '/native/status')).versionInfo || {};
      if (!v.error && v.latest === '2.0.0') break;
      // 手动触发一次检查加速
      await api(3940, 'POST', '/native/check-update');
      await sleep(500);
    }
  }
  check('installed=1.0.0', v && v.installed === '1.0.0', JSON.stringify(v));
  check('latest=2.0.0', v && v.latest === '2.0.0');
  check('updateAvailable=true', !!(v && v.updateAvailable));

  console.log('== U2: 一键升级全链路 ==');
  // 前提：升级前 DSH 已 RUNNING（"进程已替换"断言需要 before pid；也消除首拍竞态）
  await waitStatus(3940, (x) => x.phase === 'RUNNING' && x.dshPid, 15000);
  const before = await api(3940, 'GET', '/status');
  await api(3940, 'POST', '/native/upgrade');
  const st = await waitUpgrade(3940, (x) => x.state === 'done' || x.state === 'failed');
  check('升级终态=done', st && st.state === 'done', JSON.stringify(st && st.state));
  const pkgAfter = JSON.parse(fs.readFileSync(pkgA, 'utf8'));
  check('package.json 版本已切换到 2.0.0', pkgAfter.version === '2.0.0', pkgAfter.version);
  const after = await waitStatus(3940, (x) => x.phase === 'RUNNING' && x.dshPid);
  check('升级后 DSH 恢复 RUNNING', !!after);
  check(
    'DSH 进程已被替换（新版本生效）',
    after && before.dshPid !== null && after.dshPid !== before.dshPid,
    `${before.dshPid} -> ${after && after.dshPid}`
  );
  check('计划内重启不计入崩溃窗口', after && after.restartCount === (before.restartCount || 0), `restartCount=${after && after.restartCount}`);

  console.log('== U3: 已是最新时跳过 ==');
  await api(3940, 'POST', '/native/upgrade');
  const st3 = await waitUpgrade(3940, (x) => x.state === 'done' || x.state === 'failed', 15000);
  check('重复升级被安全处理', !!st3);
  const pkg3 = JSON.parse(fs.readFileSync(pkgA, 'utf8'));
  check('版本保持 2.0.0', pkg3.version === '2.0.0', pkg3.version);

  console.log('== U4: 安装失败 → 报错且不影响运行中的 DSH ==');
  await startRegistry(3951, '3.0.0');
  const pkgB = makePkgJson('1.0.0');
  const cfgB = makeConfig(3942, 3943, 3951, pkgB);
  const dB = startDaemon(cfgB, { FAKE_MODE: 'fail', FAKE_PKG_JSON: pkgB });
  await waitStatus(3942, (x) => x.phase === 'RUNNING' && x.dshPid);
  const pidBefore = (await api(3942, 'GET', '/status')).dshPid;
  await api(3942, 'POST', '/native/upgrade');
  const st4 = await waitUpgrade(3942, (x) => x.state === 'failed' || x.state === 'done', 30000);
  check('失败终态=failed', st4 && st4.state === 'failed', JSON.stringify(st4 && st4.state));
  const pkgBAfter = JSON.parse(fs.readFileSync(pkgB, 'utf8'));
  check('失败后 package.json 未被破坏', pkgBAfter.version === '1.0.0', pkgBAfter.version);
  const s4 = await waitStatus(3942, (x) => x.phase === 'RUNNING' && x.dshPid && x.dshPid !== pidBefore, 20000);
  check('失败后 DSH 以旧版本恢复运行（新进程）', !!s4, pidBefore + ' -> ' + (s4 && s4.dshPid));
  await killDaemon(dB);

  await killDaemon(dA);

  // 清理残留 mock：SIGTERM 杀不掉 detached/挂起进程 → SIGCONT 先行 + SIGKILL（与 smoke 同款修复，防残留占端口断链）
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
  console.error('upgrade test error:', e);
  process.exit(1);
});
