'use strict';

// SIGTERM desired 契约（P1-4 验收门）：
//  守卫被 SIGTERM/SIGINT 停止（systemd stop/重启、升级守卫）后，
//  DSH 期望状态（desired）必须保持不变——「守卫退出不动 DSH」是硬约束。
//  旧实现 shutdown → stopAll → dsh.stop → setDesired('stopped') 依赖 exit 竞态，
//  行为不确定；RC2 修复后 stopAll 默认 exclude dsh，语义由契约保证。
// 用法：node test/sigterm-desired-test.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'dsh-supervisor');
const MOCK = path.join(ROOT, 'test', 'mock-target.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sigterm-'));
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = {
  command: ['node', MOCK, '28191'], healthUrl: 'http://127.0.0.1:28191/',
  probeIntervalMs: 300, startTimeoutMs: 5000, stopGraceMs: 800, portReleaseWaitMs: 600,
  crashWindowMs: 28192, crashBurst: 5, backoff: [1500, 3000, 6000],
  apiHost: '127.0.0.1', apiPort: 28190, stateFile: path.join(TMP, 'state.json'),
  logFile: path.join(TMP, 'events.log'), supervisorLogFile: path.join(TMP, 'guard.log'),
  dshLogFile: path.join(TMP, 'dsh.log'), upgradeLogFile: path.join(TMP, 'up.log'),
};
const cfgPath = path.join(TMP, 'cfg.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
fs.writeFileSync(path.join(TMP, 'dsh-main.json'), JSON.stringify({ guardian: true }));

function api(port, method, p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 3000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ error: 'parse' }); } });
    });
    req.on('error', () => resolve({ error: 'conn' })); req.end();
  });
}
async function waitStatus(pred, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const s = await api(28190, 'GET', '/status'); if (!s.error && pred(s)) return s; await sleep(200); }
  return null;
}
function startDaemon() {
  return spawn('node', [CLI, 'daemon', '-c', cfgPath], {
    env: { ...process.env, DSH_SUPERVISOR_CONFIG: cfgPath, DSH_SUPERVISOR_LOCK_FILE: path.join(TMP, 'guard.lock') },
    stdio: 'ignore',
  });
}

async function main() {
  const d1 = startDaemon();
  const s1 = await waitStatus((x) => x.phase === 'RUNNING' && x.dshPid);
  check('首守卫拉起 DSH', !!s1, JSON.stringify(s1));
  const pid = s1 && s1.dshPid;

  d1.kill('SIGTERM'); // systemd stop/守卫升级路径
  await sleep(1200);

  const d2 = startDaemon();
  const s2 = await waitStatus((x) => x.dshPid === pid, 12000);
  check('新守卫接管原实例（adopted）', !!s2 && s2.dshPid === pid, JSON.stringify(s2));
  check('SIGTERM 后 desired 保持 running（P1-4 契约）', !!s2 && s2.desired === 'running', s2 && JSON.stringify({ desired: s2.desired, phase: s2.phase }));

  // 稳定窗口：确认收敛循环不因 shutdown 残留意图翻转 desired
  await sleep(2000);
  const s3 = await api(28190, 'GET', '/status');
  check('稳定窗口 desired 仍 running', s3.desired === 'running', JSON.stringify({ desired: s3.desired, phase: s3.phase, pid: s3.dshPid }));

  d2.kill('SIGKILL');
  try { if (pid) process.kill(pid, 'SIGKILL'); } catch {}
  await sleep(400);
  try { require('node:child_process').execSync("pkill -9 -f 'mock-target.js 28191' || true", { stdio: 'ignore' }); } catch {}

  console.log('\n==============================');
  console.log('结果: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('sigterm test error:', e); process.exit(1); });
