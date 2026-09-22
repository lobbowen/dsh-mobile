#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 第十三轮续：端口注册表 release 的空值顺序缺陷 + 调用方 ownerId 纪律（2026-09-13 P2）
//
// ## 缺陷（失效模式 a + g）
//
// ① PortRegistry.release(port, ownerId) 的**空值检查在 owner 比较之后**：
//      const rec = this._records.get(p);
//      if (ownerId != null && rec.owner !== ownerId) return false;   // ← rec 可能 undefined
//      if (!rec) return false;                                       // ← 永远到不了
//    实测：release(未登记端口, 任意 ownerId) → **TypeError: Cannot read properties of
//    undefined (reading 'owner')**。
//    而其文档明确写「传了 ownerId → 仅当登记 owner 匹配才释放（不匹配即 no-op，并返回 false）」——
//    「端口尚未登记/已被别处释放」恰恰是良构调用方**最常见的场景**（ownerId 参数的存在意义
//    就是让「如果归我再释放」安全）。包裹 try/catch 的调用方把它静默吞掉 → 契约无声失效；
//    未包裹的直接崩。
//
// ② 三处调用方仍**不带 ownerId** 释放（与实例域 P1-3 同一类）：
//      main-process.js  ports.release(oldPort)
//      proxy.js         ports.release(rec.port)      （list→release 之间存在 TOCTOU）
//      manager.js       ports.release(rec.port)      （同）
//    按端口号无条件释放可能删掉**他人**在期间重新登记的记录 → 新 owner 失去登记（泄漏/被重复分配）。
//
// ## 门禁
//   R-a  release 对**未登记端口 + ownerId** 必须返回 false（不抛）
//   R-b  release 的 owner 不匹配/no-op/匹配 三种语义都正确
//   R-c  全仓 release 调用方**都带 ownerId**（owner 归属纪律）
//   R-d  反向：判据能识别「先比 owner 后判空」的旧顺序（门禁非空转）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { PortRegistry } = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'ports.js'));

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r13prt-'));

// ── R-a/R-b：release 语义 ──
{
  const reg = new PortRegistry({ file: path.join(TMP, 'ports.json') });
  const P = 19001; // 两个动态池之外（managed 20000-23999 / providerApi 24000-25999）
  reg.registerUser(P, 'owner-A');

  // 未登记端口 + ownerId：必须是 no-op 返回 false，**不得抛**
  let threw = null, ret;
  try { ret = reg.release(65500, 'owner-X'); } catch (e) { threw = e; }
  check('R-a release(未登记端口, ownerId) 不抛异常（旧实现抛 TypeError）',
    threw === null, threw ? threw.constructor.name + ': ' + threw.message : 'no-throw');
  check('R-a 且返回 false（no-op，符合文档契约）', ret === false, JSON.stringify(ret));

  // 未登记 + 不带 ownerId 也应 no-op
  let threw2 = null, ret2;
  try { ret2 = reg.release(65501); } catch (e) { threw2 = e; }
  check('R-a release(未登记端口, 无 ownerId) 也不抛且返回 false',
    threw2 === null && ret2 === false, JSON.stringify({ threw2: !!threw2, ret2 }));

  // 已登记 + 错 owner → no-op 且记录保留
  check('R-b 错 owner → no-op 返回 false 且**不删**记录',
    reg.release(P, 'owner-B') === false && reg.isRegistered(P) === true, 'ok');
  // 已登记 + 对 owner → 释放
  check('R-b 对 owner → 释放返回 true',
    reg.release(P, 'owner-A') === true && reg.isRegistered(P) === false, 'ok');
}

// ── R-c：调用方 ownerId 纪律 ──
{
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  const offenders = [];
  for (const f of files) {
    if (f.endsWith(path.join('lifecycle', 'ports.js'))) continue; // 定义处
    const src = fs.readFileSync(f, 'utf8');
    // ⚠ 必须同时剥离 `*` 开头的**块注释续行** —— 本仓注释里会写
    //   「PortRegistry.release() 现已支持 ownerId」这类**说明文字**，
    //   只剥 `//` 会把它当成一次无参调用（假红，我第一版即如此）。
    const code = src.split('\n').filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    }).join('\n');
    // 找 .release( 调用：必须带第二个参数
    for (const m of code.matchAll(/\.release\(([^)]*)\)/g)) {
      const args = m[1];
      // 计数顶层逗号（粗略）：无逗号即只有一个参数
      if (args.indexOf(',') < 0) {
        offenders.push(path.relative(ROOT, f) + ' → release(' + args.trim() + ')');
      }
    }
  }
  check('R-c 全仓 release 调用方都带 ownerId（owner 归属纪律）',
    offenders.length === 0, offenders.length ? offenders.join(' | ') : '0 处');
}

// ── R-d：反向判据 ──
{
  const oldOrder = "const rec = m.get(p);\nif (ownerId != null && rec.owner !== ownerId) return false;\nif (!rec) return false;";
  // 判据：owner 比较出现在 !rec 判断之前
  const iOwner = oldOrder.indexOf('rec.owner !== ownerId');
  const iNull = oldOrder.indexOf('if (!rec)');
  check('R-d 反向：判据能识别「先比 owner 后判空」的旧顺序',
    iOwner >= 0 && iNull >= 0 && iOwner < iNull, 'hit');
  const newOrder = "const rec = m.get(p);\nif (!rec) return false;\nif (ownerId != null && rec.owner !== ownerId) return false;";
  const nOwner = newOrder.indexOf('rec.owner !== ownerId');
  const nNull = newOrder.indexOf('if (!rec)');
  check('R-d 反向：修复后的顺序不被误报', nNull >= 0 && nOwner >= 0 && nNull < nOwner, 'ok');
  // 源码级：实际实现必须是新顺序
  const code = fs.readFileSync(path.join(ROOT, 'src', 'guard', 'lifecycle', 'ports.js'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const iN = code.indexOf('if (!rec) return false;', code.indexOf('release(port, ownerId)'));
  const iO = code.indexOf('rec.owner !== ownerId', code.indexOf('release(port, ownerId)'));
  check('R-d 源码实现：空值检查在 owner 比较之前',
    iN >= 0 && iO >= 0 && iN < iO, 'null@' + iN + ' owner@' + iO);
}

fs.rmSync(TMP, { recursive: true, force: true });
const failed = results.filter((r) => !r);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
