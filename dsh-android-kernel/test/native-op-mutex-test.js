#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 原生 DSH 管理器的**操作互斥**（第九轮，2026-09-12）
//
// ## 缺陷
//
// `install()` / `upgrade()` / `uninstall()` 是三个会写 npm 全局目录的重操作，
// 必须互斥。但它们的检查**不对称**：
//
//   · `upgrade()` **从不设置** `this.installing`，也**不检查**它；
//   · `install()` **不检查** `busy()`（即 upgradeState 非 idle/done/failed）；
//   · 两者共享 task key `('native','main')`，故互斥**完全依赖** `tasks.isBusy()` 这一**可选**依赖。
//
// 生产中 `tasks` 总被注入（supervisor.js:328-334）故当前成立；但：
//   · API 层 `/native/upgrade` 只查 `busy()`，**不查 `installing`**（api/native.js:41）；
//   · 未注入 tasks 时（嵌入/测试/将来重构）install 与 upgrade 会**并发跑两个
//     `npm install -g`** —— 同前缀并发写 npm 全局目录，结果不可预期。
//
// ## 锁定不变量
//   K-a  install() 必须检查 busy()（升级中拒绝安装）
//   K-b  upgrade() 必须检查 installing / uninstalling（安装/卸载中拒绝升级）
//   K-c  uninstall() 必须同时检查两者（既有行为，防回归）
//   K-d  行为级：置位锁后，三个入口都必须**拒绝**且不触碰 npm
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const src = fs.readFileSync(path.join(ROOT, 'src', 'guard', 'native', 'manager.js'), 'utf8');
const { NativeManager } = require(path.join(ROOT, 'src', 'guard', 'native', 'manager.js'));

const bodyOf = (name) => {
  const m = src.match(new RegExp('async ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}'));
  return m ? m[0] : '';
};

const bInstall = bodyOf('install');
const bUpgrade = bodyOf('upgrade');
const bUninstall = bodyOf('uninstall');
check('K-a/b/c 三个入口均已定位', !!bInstall && !!bUpgrade && !!bUninstall,
  'install=' + !!bInstall + ' upgrade=' + !!bUpgrade + ' uninstall=' + !!bUninstall);

check('K-a install 检查 busy()（升级中拒绝）', /if \(this\.busy\(\)\)/.test(bInstall), '有');
check('K-b upgrade 检查 installing', /if \(this\.installing\)/.test(bUpgrade), '有');
check('K-b upgrade 检查 uninstalling', /if \(this\.uninstalling\)/.test(bUpgrade), '有');
check('K-c uninstall 检查 installing', /if \(this\.installing\)/.test(bUninstall), '有');
check('K-c uninstall 检查 uninstalling', /if \(this\.uninstalling\)/.test(bUninstall), '有');
// ⚠ 本条是行为测试 K-d 抓出来的**真实缺口**：uninstall 原本不查 busy()，
//   故「升级进行中」时能通过全部检查 → 会在 npm 正装新版时卸载它。
check('K-c uninstall 检查 busy()（升级中拒绝）', /if \(this\.busy\(\)\)/.test(bUninstall), '有');

// ── K-d：行为级（包进 async IIFE：顶层 await 会被 Node 判为 ESM）──
(async () => {
// ── K-d：行为级 —— 三个入口在锁置位时必须拒绝（且不 spawn npm）──
//   构造最小 harness：不解真实配置，只验前置拒绝路径。
{
  const mk = () => {
    const m = Object.create(NativeManager.prototype);
    m.config = { packageName: '@deepseek-ai/dsh' };
    m.logger = { warn() {}, info() {}, debug() {}, error() {} };
    m.tasks = null;      // 关键：**不注入 tasks** —— 正是缺陷会暴露的场景
    m.events = null;
    m.installing = null;
    m.uninstalling = null;
    m.upgradeState = 'idle';
    m.stateDir = require('node:os').tmpdir();
    // 若前置拒绝失效，会走到这里 —— 直接抛错让测试暴露
    m._runInstall = () => { throw new Error('不应到达 _runInstall（前置锁失效）'); };
    m.checkEnvironment = () => ({ ok: true, errors: [] });
    m._latestVersion = () => { throw new Error('不应到达 _latestVersion（前置锁失效）'); };
    m._selectRegistry = () => { throw new Error('不应到达 _selectRegistry（前置锁失效）'); };
    m._manifest = () => null;
    return m;
  };

  // ① installing 置位 → upgrade 与 uninstall 都必须拒绝
  const m1 = mk(); m1.installing = true;
  const up1 = await Promise.resolve(m1.upgrade('1.0.0')).catch((e) => ({ threw: e.message }));
  const un1 = await Promise.resolve(m1.uninstall()).catch((e) => ({ threw: e.message }));
  check('K-d installing 置位时 upgrade 拒绝', up1 && up1.ok === false && !up1.threw, JSON.stringify(up1));
  check('K-d installing 置位时 uninstall 拒绝', un1 && un1.ok === false && !un1.threw, JSON.stringify(un1));

  // ② upgradeState 非终态 → install 与 uninstall 都必须拒绝
  //   ⚠ **各自用独立的 mgr**：`install()` 在通过前置检查后会置 `this.installing = true`，
  //     若共用同一个实例，`uninstall()` 会因为**那个**锁被拒 —— 测试便成了假通过
  //     （我第一版就如此：注掉 uninstall 的 busy 检查仍然 PASS）。
  const m2a = mk(); m2a.upgradeState = 'restarting';
  const in2 = await Promise.resolve(m2a.install('1.0.0')).catch((e) => ({ threw: e.message }));
  check('K-d 升级中 install 拒绝', in2 && in2.ok === false && !in2.threw, JSON.stringify(in2));
  const m2b = mk(); m2b.upgradeState = 'restarting';
  const un2 = await Promise.resolve(m2b.uninstall()).catch((e) => ({ threw: e.message }));
  check('K-d 升级中 uninstall 拒绝', un2 && un2.ok === false && !un2.threw, JSON.stringify(un2));

  // ③ 反向：未置锁时 install 不应被「升级中」误拒（会走到 _latestVersion 并因其抛错而被捕获）
  const m3 = mk();
  const in3 = await Promise.resolve(m3.install('1.0.0')).catch((e) => ({ threw: e.message }));
  check('K-d 反向：无锁时 install 不因「升级中」被拒（走到真实路径）',
    in3 && /前置锁失效|不应到达/.test(String(in3.threw || in3.error || '')),
    JSON.stringify(in3));
}


})().then(() => {
  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
});
