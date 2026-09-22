#!/usr/bin/env node
'use strict';

// 孤儿锁回收回归（2026-09-22，真机 dsh 重启死循环根因）：
// dsh 被 SIGKILL 后留下 <$HOME>/.dsh/**.lock（内容=持锁 pid），下次启动等锁 30s 后
// 抛 "plugin tree failed to load" 退出 → 守卫判失败再杀再启 → 永不就绪。
// 守卫 spawn 前回收持锁 pid 已死的锁；活 pid / 非 pid 内容 / node_modules 内一律不动。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-lock-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

(async () => {
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const reap = Supervisor.prototype._reapOrphanDshLocks;
  check('方法已注入 Supervisor.prototype', typeof reap === 'function');

  const events = [];
  const warns = [];
  const self = { events: { append: (n, d) => events.push({ n, d }) }, logger: { warn: (m) => warns.push(m) } };

  // 确定已死的 pid：跑一个立即退出的子进程，wait 后其 pid 不再存活
  const dead = spawnSync(process.execPath, ['-e', '']).pid;

  const home = path.join(TMP, 'home', '.dsh');
  const mk = (rel, content) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; };
  const fStale = mk('.credentials.yaml.lock', dead + '\n');
  const fEmpty = mk('.empty.lock', '');
  const fAlive = mk('.settings.yaml.lock', process.pid + '\n');
  const fWeird = mk('weird.lock', 'not-a-pid\n');
  const fNested = mk('storages/deep/a.lock', dead + '\n');
  const fTooDeep = mk('x/y/z/w/deep.lock', dead + '\n'); // 深度 >3 不进入
  const fInNodeModules = mk('profiles/node_modules/pkg/p.lock', dead + '\n');
  const fNotLock = mk('.credentials.yaml', 'keep: me\n');

  process.env.HOME = path.join(TMP, 'home');
  delete process.env.DSH_HOME;
  const reaped = reap.call(self);

  check('死 pid 根级锁被回收', !fs.existsSync(fStale));
  check('空锁（无可见主人）被回收', !fs.existsSync(fEmpty));
  check('死 pid 嵌套锁被回收（depth≤3）', !fs.existsSync(fNested));
  check('活 pid 锁不动', fs.existsSync(fAlive));
  check('内容非 pid 的 .lock 不动', fs.existsSync(fWeird));
  check('超深目录不进入', fs.existsSync(fTooDeep));
  check('node_modules 内锁不动', fs.existsSync(fInNodeModules));
  check('非 .lock 文件不碰', fs.existsSync(fNotLock));
  check('返回值即回收清单', Array.isArray(reaped) && reaped.length === 3, JSON.stringify(reaped && reaped.map((r) => path.basename(r.file))));
  check('每笔回收记事件', events.length === 3 && events.every((e) => e.n === 'orphan_lock_reaped'), JSON.stringify(events.map((e) => e.n)));
  check('事件带持锁 pid（空锁为 null）', events.some((e) => e.d.pid === dead) && events.some((e) => e.d.pid === null && e.d.file.endsWith('.empty.lock')));
  check('回收有 warn', warns.length === 1 && warns[0].includes('orphan'), JSON.stringify(warns));

  // DSH_HOME 覆盖优先（与 dsh 自身 resolveDshHome 同规则）
  const alt = path.join(TMP, 'alt-home-dir');
  fs.mkdirSync(alt, { recursive: true });
  fs.writeFileSync(path.join(alt, '.credentials.yaml.lock'), dead + '\n');
  process.env.DSH_HOME = alt;
  const reaped2 = reap.call(self);
  check('DSH_HOME 覆盖生效', reaped2.length === 1 && !fs.existsSync(path.join(alt, '.credentials.yaml.lock')));
  check('HOME 下原锁不受 DSH_HOME 影响', fs.existsSync(fTooDeep)); // 上一轮未回收的仍在原位

  // 幂等：无锁可收时空清单、零事件
  events.length = 0;
  const reaped3 = reap.call(self);
  check('无孤儿锁时为空操作', Array.isArray(reaped3) && reaped3.length === 0 && events.length === 0);

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
