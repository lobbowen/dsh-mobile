#!/usr/bin/env node
'use strict';

// 子进程 stderr 取证捕获回归（2026-09-22，真机 dsh 秒退 exit:1 且屏幕零输出）：
// 管道里的 stderr 写是异步的，子进程 process.exit() 急死会把未 flush 的崩溃栈丢在
// 自己的管道缓冲里——守卫和屏幕都看不到。改为文件 fd 捕获（POSIX 文件写同步，急死不丢），
// 守卫轮询镜像上屏，并把尾部挂进 dsh_exited 事件。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stderr-capture-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

function makeFake(dshLogFile) {
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const events = [];
  const warns = [];
  const infos = [];
  const restarts = [];
  const fake = Object.create(Supervisor.prototype);
  fake.config = { dshLogFile, startTimeoutMs: 5000, command: ['stub'] };
  fake.events = { append: (n, d) => events.push({ n, d }) };
  fake.logger = { info: (m) => infos.push(m), warn: (m) => warns.push(m), error: (m) => warns.push('E:' + m) };
  fake.nativeManager = { status: () => ({ installed: true, binPath: 'x' }) };
  fake.tokenService = { feedLine: () => {} };
  fake.dshWriter = { write: () => {} };
  fake.notify = () => {};
  fake.writeState = () => {};
  fake._actNote = () => {};
  fake._reapOrphanDshLocks = () => [];
  fake._beginRestart = (reason) => restarts.push(reason);
  fake._stopping = false;
  let child = null;
  let phase = 'STOPPED';
  fake._mSetChild = (c) => { child = c; };
  fake._mChild = () => child;
  fake._mSetAdopted = () => {};
  fake._mSetAdoptPid = () => {};
  fake._mSetPhase = (p) => { phase = p; };
  fake._mPhase = () => phase;
  fake._mSetStartDeadline = () => {};
  fake._mDesired = () => 'running';
  fake._mGuardian = () => true;
  fake._mSetFailStreak = () => {};
  fake._mSetSpawnBlockedUntil = () => {};
  fake._mMissingNotified = () => false;
  fake._mSetMissingNotified = () => {};
  return { fake, events, warns, restarts };
}

const waitFor = async (fn, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('超时等待: ' + label);
};

(async () => {
  // 吞掉守卫镜像到自身 stderr 的子进程行（[stderr] 前缀），避免污染测试输出；
  // 断言走捕获文件与事件，不依赖终端回显。
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => (String(chunk).startsWith('[stderr]') ? true : realErr(chunk, ...rest));
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  check('_openStderrCapture 已注入 Supervisor.prototype', typeof Supervisor.prototype._openStderrCapture === 'function');
  check('_startProcess 已注入 Supervisor.prototype', typeof Supervisor.prototype._startProcess === 'function');

  const dshLogFile = path.join(TMP, 'dsh.log');
  const errPath = path.join(TMP, 'dsh-stderr.log');

  // —— 第 1 轮：子进程写一行 stderr 后 process.exit(1)（模拟"急死"）——
  const r1 = makeFake(dshLogFile);
  r1.fake.spawnCommand = () => [process.execPath, '-e', 'process.stderr.write("BOOM-ONE\\n"); process.exit(1)'];
  await r1.fake._startProcess();
  await waitFor(() => r1.events.some((e) => e.n === 'dsh_exited'), 8000, 'dsh_exited(第1轮)');
  const ex1 = r1.events.find((e) => e.n === 'dsh_exited');
  check('退出事件带退出码', ex1.d.code === 1, JSON.stringify(ex1.d.code));
  check('退出事件带 stderrTail（急死前的行已捕获）', Array.isArray(ex1.d.stderrTail) && ex1.d.stderrTail.some((l) => l.includes('BOOM-ONE')), JSON.stringify(ex1.d.stderrTail));
  check('stderr 捕获文件已落盘该行', fs.existsSync(errPath) && fs.readFileSync(errPath, 'utf8').includes('BOOM-ONE'));
  check('捕获文件路径在 dsh.log 同目录', errPath === path.join(path.dirname(dshLogFile), 'dsh-stderr.log'));
  check('崩溃后进入重启决策', r1.restarts.some((x) => x === 'exit:1'), JSON.stringify(r1.restarts));

  // —— 第 2 轮：换标记，验证 per-spawn 截断（上一轮死因不得顶给本轮）——
  const r2 = makeFake(dshLogFile);
  r2.fake.spawnCommand = () => [process.execPath, '-e', 'process.stderr.write("BOOM-TWO\\n"); process.exit(2)'];
  await r2.fake._startProcess();
  await waitFor(() => r2.events.some((e) => e.n === 'dsh_exited'), 8000, 'dsh_exited(第2轮)');
  const ex2 = r2.events.find((e) => e.n === 'dsh_exited');
  const txt2 = fs.readFileSync(errPath, 'utf8');
  check('新一轮捕获从零计（旧标记已被截断掉）', txt2.includes('BOOM-TWO') && !txt2.includes('BOOM-ONE'), JSON.stringify(txt2.trim()));
  check('本轮 stderrTail 只含本轮输出', ex2.d.stderrTail.some((l) => l.includes('BOOM-TWO')) && !ex2.d.stderrTail.some((l) => l.includes('BOOM-ONE')));

  // —— 第 3 轮：大块 stderr + 立即 process.exit —— 文件写同步，不得截尾 ——
  const r3 = makeFake(dshLogFile);
  r3.fake.spawnCommand = () => [process.execPath, '-e', 'process.stderr.write("X".repeat(200000) + "\\n"); process.exit(1)'];
  await r3.fake._startProcess();
  await waitFor(() => r3.events.some((e) => e.n === 'dsh_exited'), 8000, 'dsh_exited(第3轮)');
  const txt3 = fs.readFileSync(errPath, 'utf8');
  check('急死前的大块 stderr 完整落盘（管道会丢，文件不丢）', (txt3.match(/X/g) || []).length >= 200000, 'len=' + txt3.length);
  const ex3 = r3.events.find((e) => e.n === 'dsh_exited');
  check('大块输出尾部仍进 stderrTail', ex3.d.stderrTail.length > 0 && ex3.d.stderrTail[ex3.d.stderrTail.length - 1].startsWith('[stderr] X'));

  // —— 第 4 轮：零输出非零退出 —— "没有输出"本身必须留痕 ——
  const r4 = makeFake(dshLogFile);
  r4.fake.spawnCommand = () => [process.execPath, '-e', 'process.exit(3)'];
  await r4.fake._startProcess();
  await waitFor(() => r4.events.some((e) => e.n === 'dsh_exited'), 8000, 'dsh_exited(第4轮)');
  const ex4 = r4.events.find((e) => e.n === 'dsh_exited');
  check('零输出崩溃记为显式警告', r4.warns.some((w) => w.includes('no output') && w.includes('code=3')), JSON.stringify(r4.warns));
  check('零输出时 stderrTail 为空数组', Array.isArray(ex4.d.stderrTail) && ex4.d.stderrTail.length === 0);

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
