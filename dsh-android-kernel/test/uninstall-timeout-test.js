#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// P1-F：npm uninstall 必须有**超时看门狗**，且卸载锁必须**结构性释放**
//
// ## 缺陷
//
// `guard/native/manager.js` 的卸载路径旧实现：
//   · `spawn(npmBin(), uninstallArgs, ...)` **无 timeout / 无 killSignal**；
//   · Promise 只监听 `error` / `exit`，npm 挂起即**永不 settle**；
//   · `this.uninstalling` 只在函数末尾复位 —— 于是永为真。
//
// 后果链：npm 挂起（registry 不可达 / 凭证助手等待 / 网络盘卡住）
//   → Promise 永不 settle → `uninstalling` 永为真
//   → `install`/`uninstall`/`startUninstall` **全部被拒**
//   → 任务永久 running，用户只能重启守卫。
//
// 对照：同仓**安装**路径（`domains/dist.runNpmInstall`）本就有 timeout + killTree，唯独卸载漏了。
//
// ## 锁定不变量
//   F-a  卸载 spawn 有超时常量与看门狗（clearTimeout/setTimeout 成对）
//   F-b  超时路径会**终止进程树**（不能只杀父进程）
//   F-c  锁释放位于 `finally`（任何路径含抛出都会释放）
//   F-d  超时事实对用户**可见**（结果里带回 timedOut + 可重试文案）
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'guard', 'native', 'manager.js'), 'utf8');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// 取卸载函数体（从 uninstall 的锁置位到函数结束），避免断言命中别处
const start = SRC.indexOf('this.uninstalling = true;');
const end = SRC.indexOf('module.exports');
const region = (start >= 0 && end > start) ? SRC.slice(start, end) : '';
check('前置：定位到卸载函数体', region.length > 500, region.length + ' 字符');

// ── F-a：超时看门狗 ──
check('F-a 存在卸载超时常量', /UNINSTALL_TIMEOUT_MS\s*=/.test(region), (region.match(/UNINSTALL_TIMEOUT_MS\s*=[^;]*/) || [''])[0]);
check('F-a 存在 setTimeout 看门狗', /setTimeout\(/.test(region), '有');
check('F-a 看门狗在 settle 时被清除（clearTimeout）', /clearTimeout\(timer\)/.test(region), '有');
check('F-a 有 done 幂等位（防超时与 exit 竞态双 resolve）', /if \(done\) return/.test(region), '有');

// ── F-b：超时要杀进程树 ──
check('F-b 超时路径终止进程树（killTree）', /killTree\(/.test(region), '有');
check('F-b 引用了平台进程树的统一实现', /platform\/os\/process/.test(region), '有');

// ── F-c：锁在 finally 中释放 ──
check('F-c 存在 try/finally 结构', /\} finally \{/.test(region), '有');
{
  const fin = region.slice(region.indexOf('} finally {'), region.indexOf('} finally {') + 220);
  check('F-c finally 中释放卸载锁', /this\.uninstalling = null/.test(fin), (fin.match(/this\.uninstalling[^;]*/) || [''])[0]);
}

// ── F-d：超时事实可见 ──
check('F-d 结果带 timedOut 字段', /timedOut:\s*uninstallTimedOut/.test(region), (region.match(/timedOut:[^,]*/) || [''])[0]);
check('F-d 超时文案说明「可重试」', /可重试/.test(region), '有');

// ── 反向：不能因为加了超时就丢掉 K10 的「失败保留 manifest」语义 ──
check('反向：失败仍保留 manifest（K10 未回退）', /if \(exitCode === 0\) \{\s*[\s\S]{0,40}rm\(this\.manifestFile\)/.test(region), '保留');

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);