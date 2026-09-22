#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// P1-E：局域网访问必须真的可用，同时**不放宽**对公网的拒绝
//
// ## 缺陷（注释与行为相反）
//
// `api/index.js` 头部**明文声称**：
//   「只允许本机(回环)与 RFC1918 私有 IP 的 Host/Origin → 外部/公网主机被拒」
// 而闸①（Host）与闸②（Origin）此前只查 `LOOPBACK_HOSTS`。
//
// 后果：开启「局域网访问」（apiHost=0.0.0.0）后：
//   · 面板 GET 能打开（静态资源不走 originAllowed）；
//   · 但**所有写操作静默 403** —— 与注释承诺完全相同的行为相反。
//
// 实测（直调 originAllowed）：LAN Host + LAN Origin = DENY；LAN 无 Origin = DENY。
//
// ## 根因
//
// `api/identity.js` 早已有 `isPrivateIpv4()`（且 `socketIsTrusted` 用的就是它），
// 但 Host/Origin 闸**从未消费** —— 同一事实两处实现，其中一处漏了。
//
// ## 锁定不变量（**双向**：既要放行局域网，也不能放宽公网）
//   E-a  局域网 RFC1918 Host/Origin → ALLOW（10.x / 172.16-31.x / 192.168.x）
//   E-b  回环与壳 Origin → 仍然 ALLOW（不得回归）
//   E-c  恶意 Origin（evil.com）→ 仍 DENY
//   E-d  DNS-rebinding（Host=evil.com）→ 仍 DENY
//   E-e  公网 IP Host（8.8.8.8）→ 仍 DENY
//   E-f  边界正确：172.32.x（非私有）与 172.15.x（非私有）→ DENY
//   E-g  判定复用 identity 的同一份实现（不重写第二份 RFC1918）
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');

const { originAllowed } = require(path.join(ROOT, 'src', 'api', 'index.js'));
const identity = require(path.join(ROOT, 'src', 'api', 'identity.js'));

const PORT = '36360';
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };
const allow = (h) => originAllowed({ headers: h }, PORT);

// ── E-a：局域网（这是修复的主体）──
check('E-a 192.168.x 浏览器（Host+Origin 同源）→ ALLOW',
  allow({ host: '192.168.1.5:' + PORT, origin: 'http://192.168.1.5:' + PORT }) === true);
check('E-a 10.x 网段 → ALLOW',
  allow({ host: '10.0.0.7:' + PORT, origin: 'http://10.0.0.7:' + PORT }) === true);
check('E-a 172.16.x 网段 → ALLOW',
  allow({ host: '172.16.3.9:' + PORT, origin: 'http://172.16.3.9:' + PORT }) === true);
check('E-a 172.31.x（私有上界）→ ALLOW',
  allow({ host: '172.31.255.254:' + PORT }) === true);
check('E-a 局域网无 Origin（curl）→ ALLOW',
  allow({ host: '192.168.1.5:' + PORT }) === true);

// ── E-b：回环/壳源不得回归 ──
check('E-b 回环 Host+Origin → ALLOW',
  allow({ host: '127.0.0.1:' + PORT, origin: 'http://127.0.0.1:' + PORT }) === true);
check('E-b 回环无 Origin（本机 curl）→ ALLOW', allow({ host: '127.0.0.1:' + PORT }) === true);
check('E-b 壳 Origin（tauri://localhost）→ DENY（无桌面壳，面板由内核同源托管）',
  allow({ host: '127.0.0.1:' + PORT, origin: 'tauri://localhost' }) === false);

// ── E-c..f：**安全不得放宽**（这一半比放行更重要）──
check('E-c 恶意 Origin（evil.com）→ DENY',
  allow({ host: '127.0.0.1:' + PORT, origin: 'http://evil.com' }) === false);
check('E-c 恶意 Origin + LAN Host → DENY',
  allow({ host: '192.168.1.5:' + PORT, origin: 'http://evil.com' }) === false);
check('E-d DNS-rebinding（Host=evil.com）→ DENY',
  allow({ host: 'evil.com:' + PORT, origin: 'http://127.0.0.1:' + PORT }) === false);
check('E-e 公网 IP Host（8.8.8.8）→ DENY', allow({ host: '8.8.8.8:' + PORT }) === false);
check('E-e 公网 IP Origin → DENY',
  allow({ host: '127.0.0.1:' + PORT, origin: 'http://8.8.8.8:' + PORT }) === false);
check('E-f 边界：172.32.x（非私有）→ DENY', allow({ host: '172.32.0.1:' + PORT }) === false);
check('E-f 边界：172.15.x（非私有）→ DENY', allow({ host: '172.15.0.1:' + PORT }) === false);
check('E-f 边界：11.x（非私有）→ DENY', allow({ host: '11.0.0.1:' + PORT }) === false);
check('E-f 边界：192.169.x（非私有）→ DENY', allow({ host: '192.169.0.1:' + PORT }) === false);

// ── E-g：复用同一份实现（防「再写一份 RFC1918」）──
check('E-g identity 导出 isPrivateIpv4', typeof identity.isPrivateIpv4 === 'function');
// 断言「确实从 identity 取了 isPrivateIpv4」——按**语义**而非格式（解构可能跨行/带注释）。
{
  const idx = fs.readFileSync(path.join(ROOT, 'src', 'api', 'index.js'), 'utf8');
  const m = idx.match(/const\s*\{([^}]*)\}\s*=\s*require\(['"]\.\/identity['"]\)/);
  check('E-g index.js 从 identity 解构出 isPrivateIpv4',
    !!m && /isPrivateIpv4/.test(m[1]), m ? m[1].replace(/\s+/g, ' ').trim() : '（未找到解构）');
}
check('E-g index.js 不再有第二份 isPrivateIpv4 定义',
  !/function\s+isPrivateIpv4\s*\(/.test(
    fs.readFileSync(path.join(ROOT, 'src', 'api', 'index.js'), 'utf8')
  ));

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);