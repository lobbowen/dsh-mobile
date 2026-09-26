#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 批 F 缺陷回归（K6 / K7 / K9 / K10，2026-09-11）
//
// 四个缺陷各自独立，但**共享同一根因族**：
// 「注释声称的行为」与「代码实际行为」不一致，且不一致处**静默**。
//
// K6 identity.js 声称有 Host 校验，实现里从未读取 req.headers.host
// K7 ports.js 用 process.env.HOME || '/tmp'，Windows 无 HOME → 状态文件分裂
// K9 正则 [^s] 写成字符类（意图 [^\s]），静默截断/跨行
// K10 卸载失败仍无条件删 manifest → 残留不可追
//
// 本测试逐条把「声称」变成「断言」。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// ── K7 ports.js 不用 HOME 兜底 ──
console.log('== K7 端口注册表路径（三平台一致）==');
{
  const p = path.join(ROOT, 'src', 'guard', 'lifecycle', 'ports.js');
  const src = fs.readFileSync(p, 'utf8');
  const code = src.split(String.fromCharCode(10))
    .filter((l) => !/^\s*\/\//.test(l)).join(String.fromCharCode(10));
  check('K7 不再使用 process.env.HOME（Windows 无该变量）',
    !/process\.env\.HOME/.test(code), 'HOME');
  check('K7 不再把 /tmp 作为兜底（状态文件会与 state.json 分裂）',
    !code.includes("'/tmp'"), '/tmp');
  // 2026-09-15：路径改由**产品状态根**（src/platform/state-root.js）给出 ——
  // 仍是三平台正确来源，且与 state.json 同域（不分裂）；不再各自 os.homedir()。
  check('K7 经产品状态根解析端口文件（platform/state-root）',
    /platform\/state-root/.test(code) && /supervisorDir\(\)/.test(code), 'state-root');
}

// ── K9 版本解析正则 ──
console.log('== K9 版本解析正则 ==');
{
  const p = path.join(ROOT, 'src', 'guard', 'supervisor', 'settings-view.js');
  const srcAll = fs.readFileSync(p, 'utf8');
  // 必须**先剥离注释**再断言：修复说明里会引用错误形态 [^s] 作对照，
  // 若不剥注释，正确的修复反而会被自己的说明文字判为「仍有误用」。
  const src = srcAll.split(String.fromCharCode(10))
    .filter((l) => !/^\s*\/\//.test(l)).join(String.fromCharCode(10));
  check('K9 不再有 [^s] 字符类误用（已剥注释）', !/\[\^s\]/.test(src), '[^s]');
  check('K9 使用 [^\\s]（正确的「非空白」）', /\[\^\\s\]/.test(src), '[^\\s]');
}

// ── K10 卸载失败保留 manifest ──
console.log('== K10 卸载失败时保留 manifest ==');
{
  const p = path.join(ROOT, 'src', 'guard', 'native', 'manager.js');
  const src = fs.readFileSync(p, 'utf8');
  // 找出 uninstall 相关块：rm(this.manifestFile) 必须**在成功分支内**
  const idx = src.indexOf('npm uninstall exit');
  check('K10 有「卸载失败」处理分支', idx > 0, idx > 0 ? 'ok' : '未找到');
  if (idx > 0) {
    // 取该分支前后各 900 字符，检查 rm 是否被 exitCode===0 守卫
    const seg = src.slice(Math.max(0, idx - 900), idx + 400);
    check('K10 删除 manifest 受 exitCode===0 守卫（失败时保留以便重试）',
      /if\s*\(exitCode\s*===\s*0\)\s*\{\s*\n\s*rm\(this\.manifestFile\)/.test(seg),
      'exitCode===0 → rm');
  }
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);