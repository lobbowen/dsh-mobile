#!/usr/bin/env node
'use strict';

// 固定端口登记（src/guard/lifecycle/ports.js register）的冲突判据回归。
//
// 为什么钉这一格：ports.json 是**跨 Program 版本持久化**的账本，而守卫把固定端口登记放在
// Supervisor 构造里（早于异常处理器安装）。旧实现拿记录里的**角色名**比冲突，于是上一版
// 留下的死账（同端口、异角色名）就让新版抛错 → 守卫静默 exit 1，面板整体起不来
// （真机 2026-10-01：.49 写的 lobos-main 撞 .47 还原后的 dsh-main）。
// 现判据：只有「本进程把该角色登记在这个端口上」才算真占用；死账接管，改名两个方向都成立。
//
// 端口落在 test/_ports.js 的安全段（避开 OS ephemeral 与生产池）。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-register-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

const { PortRegistry } = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'ports'));
const P_OLD = 28731;   // 主实例端口（旧版账本里的角色名不同）
const P_API = 28732;   // 面板 API 端口
const P_USER = 28733;  // 用户/实例端口（被固定端口权威覆盖的用例）

// 直接写一份「上一版 Program 留下的」账本：同端口、异固定角色名。
const seed = (file, records) => {
  fs.writeFileSync(file, JSON.stringify({ records }, null, 2), { mode: 0o600 });
  return file;
};

// ── 1. 死账接管：旧角色名不再判冲突 ──
const f1 = path.join(TMP, 'ports-1.json');
seed(f1, [{ port: P_OLD, role: 'lobos-main', owner: 'system:lobos-main', createdAt: 1 }, { port: P_API, role: 'lobos-api', owner: 'system:lobos-api', createdAt: 1 }]);
const p1 = new PortRegistry({ file: f1 });
let err1 = null;
try { p1.register('dsh-main', P_OLD); p1.register('supervisor-api', P_API); } catch (e) { err1 = e; }
check('R1 旧版死账（异角色名、同端口）接管而不抛', err1 === null, err1 && err1.message);
check('R1 账本改写为现行角色与 owner', p1.recordOf(P_OLD).role === 'dsh-main' && p1.recordOf(P_OLD).owner === 'system:dsh-main' && p1.get('supervisor-api') === P_API, JSON.stringify(p1.list()));
check('R1 旧角色名不再留在账上', p1.get('lobos-main') === null && p1.get('lobos-api') === null);

// ── 2. 反向对照：真冲突（本进程在册的另一固定角色抢同端口）仍 fail-fast ──
const p2 = new PortRegistry({ file: path.join(TMP, 'ports-2.json') });
p2.register('supervisor-api', P_API);
let err2 = null;
try { p2.register('dsh-main', P_API); } catch (e) { err2 = e; }
check('R2 本进程另一固定角色占同端口 → 抛', err2 !== null && /已被 \[supervisor-api\] 占用/.test(err2.message), err2 && err2.message);
check('R2 抛错不破坏既有登记', p2.recordOf(P_API).role === 'supervisor-api' && p2.byOwner('system:supervisor-api') === P_API);

// ── 3. 同角色同端口重启复用（幂等，不抛、不增记录）──
const before = p1.list().length;
let err3 = null;
try { p1.register('dsh-main', P_OLD); } catch (e) { err3 = e; }
check('R3 同角色同端口再登记 → 不抛且记录数不变', err3 === null && p1.list().length === before, err3 && err3.message);

// ── 4. 改名两个方向都成立（.48→.5x 与 .49→.5x 同一判据）──
const f4 = path.join(TMP, 'ports-4.json');
seed(f4, [{ port: P_OLD, role: 'dsh-main', owner: 'system:dsh-main', createdAt: 1 }]);
const p4 = new PortRegistry({ file: f4 });
let err4 = null;
try { p4.register('lobos-main', P_OLD); } catch (e) { err4 = e; }
check('R4 反方向死账（新名在册、旧名来抢同一端口）也不抛', err4 === null, err4 && err4.message);

// ── 5. user/动态记录由固定端口权威覆盖 ──
const p5 = new PortRegistry({ file: path.join(TMP, 'ports-5.json') });
p5.registerUser(P_USER, 'instance:main');
p5.register('dsh-main', P_USER);
check('R5 固定端口权威覆盖 user 记录', p5.recordOf(P_USER).owner === 'system:dsh-main' && p5.recordOf(P_USER).role === 'dsh-main', JSON.stringify(p5.recordOf(P_USER)));

// ── 6. 接管结果必须落盘（下一进程读到的就是现行名，不留二次冲突）──
const p1b = new PortRegistry({ file: f1 });
check('R6 接管后重载账本已是现行名（跨进程一致）', p1b.recordOf(P_OLD).role === 'dsh-main' && p1b.snapshotAll().fixed['dsh-main'] === P_OLD, JSON.stringify(p1b.snapshotAll().fixed));

const failed = results.filter((r) => !r);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(failed.length ? 1 : 0);
