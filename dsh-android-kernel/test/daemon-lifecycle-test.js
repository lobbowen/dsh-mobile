#!/usr/bin/env node
'use strict';

// 统一受管进程生命周期核心（src/infra/proc/daemon-lifecycle.js）回归：
//  - ensureRunning：身份接管 / 首启 spawn / latch barrier
//  - replace 换代：停旧→等死→等端口释放→才启新（同一 ctl 端口，绝不双代并存）
//  - superviseOnce：死透才重拉；残留先 TERM
//  - stop：TERM→等死→等端口释放→清身份
// 自包含：真实 spawn 本机 fixture（fake-ctl-daemon.js），不触碰真实 daemon/守卫。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-lc-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { DaemonLifecycle } = require(path.join(ROOT, 'src', 'guard', 'proc', 'daemon-lifecycle'));
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-ctl-daemon.js');
const CTL = 28040; // 测试专用端口段（远离生产）
const ctlHealth = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port: CTL, path: '/' }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ code: res.statusCode, body: b })); });
  req.on('error', () => resolve(null));
  req.setTimeout(1200, () => { req.destroy(); resolve(null); });
});
const waitCtl = async (ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const h = await ctlHealth(); if (h && h.code === 200) return true; await sleep(150); } return false; };

(async () => {
  const identity = path.join(TMP, 'fake.identity.json');
  const marker = path.join(TMP, 'fake.marker');
  const mk = (opts) => new DaemonLifecycle(Object.assign({
    name: 'fake', script: FAKE, args: ['--port', String(CTL), '--marker', marker],
    ctlPort: CTL, cmdMark: 'fake-ctl-daemon', identityFile: identity,
    logger: { info() {}, warn() {}, error() {} }, events: null,
  }, opts || {}));

  console.log('== 首启 + 身份 ==');
  let dl = mk();
  let r1 = dl.ensureRunning();
  check('首启 → mode=started + pid 写入身份', r1.mode === 'started' && !!r1.pid && dl.expectedPid() === r1.pid, JSON.stringify(r1));
  check('ctl 就绪', await waitCtl());
  await sleep(300);
  const alive1 = await ctlHealth();
  check('fake daemon 应答自身 pid', alive1 && JSON.parse(alive1.body).pid === dl.expectedPid(), alive1 && alive1.body);
  const pid1 = dl.expectedPid();

  console.log('== 幂等/接管：同身份再 ensure → adopted（不双拉）==');
  const dl2 = mk();
  const r2 = dl2.ensureRunning();
  check('再 ensure → adopted 同 pid', r2.mode === 'adopted' && r2.pid === pid1, JSON.stringify(r2));
  const h2 = await ctlHealth();
  check('ctl 仍同一 pid（单实例）', h2 && JSON.parse(h2.body).pid === pid1, h2 && h2.body);

  console.log('== 换代：kill 期望 pid → 新生命周期实例 replace（停残留→等死→等端口→启新同端口）==');
  try { process.kill(pid1, 'SIGKILL'); } catch {}
  await sleep(1500); // 等进程消失、端口释放
  const dlNew = mk(); // 全新实例（无历史 latch，模拟守卫重启后接管/换代）
  let replaced = null;
  for (let i = 0; i < 40; i++) {
    replaced = dlNew.ensureRunning();
    if (replaced.mode === 'started' || replaced.mode === 'adopted') break;
    if (replaced.mode === 'reclaiming') { await sleep(400); continue; } // 残留 TERM 后等释放再重试
    await sleep(200);
  }
  check('kill 后换代成功（新 pid ≠ 旧 pid，同 ctl 端口）', replaced && (replaced.mode === 'started' || replaced.mode === 'adopted') && replaced.pid !== pid1, JSON.stringify(replaced));
  const pid2 = dlNew.expectedPid();
  check('换代后 ctl 就绪且为新 pid', (await waitCtl()) && JSON.parse((await ctlHealth()).body).pid === pid2, String(pid2));
  dl = dlNew; // 后续沿用新实例

  console.log('== 换代期间 latch：进程刚死但 spawn 窗口内 → ensure → barrier（无双代）==');
  const dlB = mk();
  const rB = dlB.ensureRunning();
  await waitCtl();
  const pidB = dlB.expectedPid();
  try { process.kill(pidB, 'SIGKILL'); } catch {}
  await sleep(500);
  dlB._spawnWindowUntil = Date.now() + 20000; // 模拟刚 spawn（latch 有效）
  const r3 = dlB.ensureRunning();
  check('latch 窗口内 → mode=barrier（不双拉）', r3.mode === 'barrier', JSON.stringify(r3));
  dlB._spawnWindowUntil = 0;
  try { await dlB.stop(); } catch {}

  console.log('== stop：TERM → 等死 → 等端口释放 → 清身份 ==');
  const st = await dl.stop();
  check('stop ok + 身份已清', st.ok === true && dl.expectedPid() === null, JSON.stringify(st));
  await sleep(300);
  const h3 = await ctlHealth();
  check('端口已释放（ctl 无应答）', h3 === null, JSON.stringify(h3));

  console.log('== 孤儿回收（reclaimOrphans）：同 cmdline 的额外实例被 TERM，受管实例不受影响 ==');
  {
    const dlX = mk();
    const rX = dlX.ensureRunning();
    await waitCtl();
    const mainPid = dlX.expectedPid();
    // 再手工起一个同 cmdline 的“孤儿” fake（不同端口，模拟旧代/不可见命名空间残留）
    const { spawn } = require('node:child_process');
    const orphan = spawn(process.execPath, [FAKE, '--port', String(CTL + 100), '--marker', path.join(TMP, 'orphan.marker')], { stdio: 'ignore' });
    await sleep(800);
    const before = (await new Promise((res) => { const { execFileSync } = require('node:child_process'); try { res(execFileSync('pgrep', ['-af', 'fake-ctl-daemon'], { encoding: 'utf8' }).toString().split('\n').length); } catch { res(0); } }));
    const killed = dlX.reclaimOrphans();
    await sleep(600);
    const orphanDead = (() => { try { process.kill(orphan.pid, 0); return false; } catch { return true; } })();
    check('孤儿（同 cmdline、非受管）被 reclaimOrphans TERM', killed >= 1 && orphanDead, JSON.stringify({ killed, orphanPid: orphan.pid }));
    const mainAlive = dlX.expectedPid() === mainPid && (await ctlHealth()) && JSON.parse((await ctlHealth()).body).pid === mainPid;
    check('受管实例不受影响（同一 pid、ctl 正常）', mainAlive, String(mainPid));
    try { await dlX.stop(); } catch {}
  }

  console.log('== 残留回收：伪造身份=已死 pid + 同 cmdMark 进程占 ctl → superviseOnce 先 TERM 再启 ==');
  // 手工起一个占 ctl 的 fake（不写身份）
  const child = require('node:child_process').spawn(process.execPath, [FAKE, '--port', String(CTL), '--marker', path.join(TMP, 'x.marker')], { stdio: 'ignore' });
  await waitCtl();
  const dl3 = mk();
  dl3._writeIdentity(999999); // 期望 pid 已死
  const sv = await dl3.superviseOnce();
  check('期望死 + ctl 被残留占 → reclaiming（先 TERM 残留）', sv.mode === 'reclaiming', JSON.stringify(sv));
  // 等残留死透 + 端口释放 → 下轮 spawn
  let started = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    started = dl3.ensureRunning();
    if (started.mode === 'started') break;
  }
  check('残留清后 → 启新并 ctl 就绪', started && started.mode === 'started' && (await waitCtl()), JSON.stringify(started));
  try { await dl3.stop(); } catch {}
  if (child.pid) { try { process.kill(child.pid, 'SIGKILL'); } catch {} }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
