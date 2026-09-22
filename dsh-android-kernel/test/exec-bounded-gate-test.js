#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// G9：子进程调用必须**有界**（2026-09-11）
//
// ## 背景（一次未完成的修复）
//
// 审计 P2-3 发现全仓 62 处 `execFileSync` 无 timeout —— systemctl/dbus 挂起、
// lsof 卡顿等即**无限期阻塞守卫事件循环**（API/探测/监督全部冻结，无超时自愈）。
//
// 于是建立了 `platform/exec.js` 并自称「同步 exec 的**唯一入口**」……
// **但它从未被接入**。2026-09-11 复核实测：
//   · 被引用次数 = 0；
//   · 仍有 22 处 `execFileSync` 没有 timeout。
//
// 这与「macOS 自启注释谎称由 LaunchAgent 代管」是**同一失效模式** ——
// 文字声称的纪律，代码里没有；且因「看起来已经有了」，反而阻止了后续检查。
//
// 本门禁把「声称」变成「会失败」。
//
// ## 断言
//   G9-a 源码中不得存在**无 timeout** 的 execFileSync/-spawnSync 调用
//   G9-b platform/exec.js 必须被实际引用（防再次变成死代码）
//   G9-c 统一执行器必须设 killSignal=SIGKILL（SIGTERM 对挂起进程可能无效）
//   G9-d 统一执行器必须设 windowsHide（GUI 进程不弹黑框，对齐壳的 CREATE_NO_WINDOW）
//
// 说明：分析基于**括号配对**提取完整调用表达式，并先剥离注释 ——
//   否则「注释里提到 execFileSync」会被误报，
//   而「调用跨多行、timeout 写在第三行」会被漏报。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const EXEC_MODULE = path.join('src', 'platform', 'exec.js');

/** 剥离注释（行注释 + 块注释），保留换行以维持行号。 */
function stripComments(src) {
  // 逐字符扫描：正确跳过字符串字面量内的 // 与 /* */
  let out = '';
  let i = 0;
  let state = 'code'; // code | line | block | sq | dq | tpl
  while (i < src.length) {
    const c = src[i];
    const n2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n2 === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n2 === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += c; i++; continue; }
      if (c === '"') { state = 'dq'; out += c; i++; continue; }
      if (c === '`') { state = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; } else { out += ' '; }
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && n2 === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += (c === '\n') ? c : ' ';
      i++; continue;
    }
    // 字符串内部：原样保留（但换行在单/双引号里非法，模板里合法）
    if (state === 'sq' || state === 'dq' || state === 'tpl') {
      if (c === '\\') { out += c + (n2 || ''); i += 2; continue; }
      if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
        state = 'code';
      }
      out += c; i++; continue;
    }
  }
  return out;
}

/** 收集 `src/` 下的 .js **以及 `bin/` 下的入口脚本**（排除测试与构建产物）。
 *
 *  ⚠ 2026-09-12（P2）：原先只扫 `src/` —— 于是 `bin/dsh-supervisor` 里的
 *    **7 处裸 `execFileSync`（全部无 timeout）**长期逃过门禁：
 *    systemctl/dbus 挂起时 CLI 会**无限阻塞**（用户看到命令卡死）。
 *  `bin/` 与会话/安装路径同属产品代码，必须同规。
 */
function jsFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name.endsWith('.js')) out.push(p);
    }
  })(path.join(ROOT, 'src'));
  // bin/ 入口是无扩展名的脚本（无 .js 后缀），必须单独收集。
  const binDir = path.join(ROOT, 'bin');
  if (fs.existsSync(binDir)) {
    for (const e of fs.readdirSync(binDir, { withFileTypes: true })) {
      if (e.isFile()) out.push(path.join(binDir, e.name));
    }
  }
  return out;
}

/** 括号配对提取每个 `execFileSync(` / `spawnSync(` 的完整调用表达式。 */
function calls(src, fnNames) {
  const out = [];
  for (const fn of fnNames) {
    const re = new RegExp('\\b' + fn + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        i++;
      }
      out.push({ at: m.index, text: src.slice(m.index, i), fn });
    }
  }
  return out;
}

// ── G9-a **只有执行器**可以调用 execFileSync/spawnSync ──
console.log('== G9-a 子进程调用只允许出现在执行器内 ==');
{
  // 2026-09-11 收紧：原先只断言「必须有 timeout」，于是 18 处调用虽然带 timeout
  // 却**绕过**统一执行器 —— 执行器头注释自称「唯一入口」，而实际不是。
  // 现全部调用点已迁入执行器，故可断言这条**绝对不变量**：
  //   `src/` 内除 `platform/exec.js` 外，不得出现 execFileSync / spawnSync。
  //
  // 为什么这比「有 timeout」强：timeout 只是**逐个调用点**的约定（容易漏、容易退化），
  // 而「只有一处能调用」把 killSignal / windowsHide / maxBuffer / 超时默认值
  // 全部收敛到**一个实现**里（与壳的 bounded.rs + B32 门禁同构）。
  const offenders = [];
  for (const f of jsFiles()) {
    const rel = path.relative(ROOT, f);
    if (rel === EXEC_MODULE) continue; // 执行器自身
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    for (const c of calls(code, ['execFileSync', 'spawnSync'])) {
      const line = code.slice(0, c.at).split(String.fromCharCode(10)).length;
      offenders.push(rel + ':' + line + ' ' + c.fn);
    }
  }
  check('G9-a 仅 platform/exec.js 调用 execFileSync/spawnSync', offenders.length === 0,
    offenders.length ? (offenders.length + ' 处绕过执行器: ' + offenders.slice(0, 4).join(', ')) : 'ok');
}
// ── G9-b 统一执行器必须被实际引用 ──
console.log('== G9-b 统一执行器被实际引用 ==');
{
  let refs = [];
  for (const f of jsFiles()) {
    const rel = path.relative(ROOT, f);
    if (rel === EXEC_MODULE) continue;
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    // 匹配 require('...exec') 形式（platform/exec 或 ../exec）
    if (/require\([^)]*[\/'"]exec['"]\s*\)/.test(code)) refs.push(rel);
  }
  check('G9-b platform/exec.js 被引用（不得再成死代码）', refs.length > 0,
    refs.length ? (refs.length + ' 个文件: ' + refs.slice(0, 3).join(', ')) : '❌ 0 引用（同 2026-09-11 发现的问题）');
}

// ── G9-c / G9-d 执行器必须具备三项保障 ──
console.log('== G9-c/d 执行器保障 ==');
{
  const exSrc = fs.readFileSync(path.join(ROOT, EXEC_MODULE), 'utf8');
  // 默认值是 `o.killSignal || 'SIGKILL'` 形态（调用方可覆盖，但默认必须硬）
  check('G9-c killSignal 默认 SIGKILL（SIGTERM 对挂起进程可能无效）',
    /killSignal[^\n]*SIGKILL/.test(exSrc), 'killSignal');
  check('G9-d windowsHide=true（GUI 进程不弹黑框，对齐壳 CREATE_NO_WINDOW）',
    /windowsHide\s*:\s*true/.test(exSrc), 'windowsHide');
  check('G9-d maxBuffer 显式化（默认 1MB，冗长输出会误判为失败）',
    /maxBuffer/.test(exSrc), 'maxBuffer');
  check('G9-d 默认超时存在', /DEFAULT_TIMEOUT_MS\s*=\s*\d+/.test(exSrc), 'DEFAULT_TIMEOUT_MS');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);