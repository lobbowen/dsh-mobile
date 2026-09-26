#!/usr/bin/env node
'use strict';

// G9：子进程调用必须**有界**。
// 背景（2026-09-11）：platform/exec.js 自称「同步 exec 的唯一入口」却**从未被接入**
// （被引用 0 次，仍有 22 处 execFileSync 无 timeout）—— 与「注释声称的纪律、代码里没有」
// 是同一失效模式。本门禁把「声称」变成「会失败」：
//   G9-a 除执行器外不得出现 execFileSync / spawnSync。这比「每个调用点都写 timeout」强：
//        它把 killSignal / windowsHide / maxBuffer / 默认超时收敛到**一个实现**里。
//   G9-b 执行器必须被实际引用（防再次变成死代码）
//   G9-c 执行器 killSignal 默认 SIGKILL（SIGTERM 对挂起进程可能无效）
//   G9-d 执行器必须 windowsHide / maxBuffer / 默认超时
//   G9-e 自证：注释里的调用不算、真调用算数、跨行调用配对完整
// 扫描与注释剥离的唯一实现住 kernel/test/_scan.js（门禁法①/③）。

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const EXEC_MODULE = path.join('src', 'platform', 'exec.js');
const { stripComments, calls, bannedCalls, filesRequiring } = require('./_scan.js');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

console.log('== G9-a 子进程调用只允许出现在执行器内 ==');
{
  const off = bannedCalls(ROOT, ['execFileSync', 'spawnSync'], EXEC_MODULE);
  check('G9-a 仅 platform/exec.js 调用 execFileSync/spawnSync', off.length === 0,
    off.length ? (off.length + ' 处绕过执行器: ' + off.slice(0, 4).join(', ')) : 'ok');
}

console.log('== G9-b 统一执行器被实际引用 ==');
{
  const refs = filesRequiring(ROOT, /require\([^)]*[\/'"]exec['"]\s*\)/, EXEC_MODULE);
  check('G9-b platform/exec.js 被引用（不得再成死代码）', refs.length > 0,
    refs.length ? (refs.length + ' 个文件: ' + refs.slice(0, 3).join(', ')) : '0 引用（同 2026-09-11 发现的问题）');
}

console.log('== G9-c/d 执行器保障 ==');
{
  const ex = fs.readFileSync(path.join(ROOT, EXEC_MODULE), 'utf8');
  check('G9-c killSignal 默认 SIGKILL（SIGTERM 对挂起进程可能无效）', /killSignal[^\n]*SIGKILL/.test(ex), 'killSignal');
  check('G9-d windowsHide=true（GUI 进程不弹黑框，对齐壳 CREATE_NO_WINDOW）', /windowsHide\s*:\s*true/.test(ex), 'windowsHide');
  check('G9-d maxBuffer 显式化（默认 1MB，冗长输出会误判为失败）', /maxBuffer/.test(ex), 'maxBuffer');
  check('G9-d 默认超时存在', /DEFAULT_TIMEOUT_MS\s*=\s*\d+/.test(ex), 'DEFAULT_TIMEOUT_MS');
}

console.log('== G9-e 自证 ==');
{
  const NL = String.fromCharCode(10);
  const probe = stripComments(['// execFileSync("x") 注释里的调用不算数', 'const y = spawnSync("z");'].join(NL));
  check('G9-e 自证：注释里的调用不算、真调用必须被认出',
    calls(probe, ['execFileSync']).length === 0 && calls(probe, ['spawnSync']).length === 1, 'ok');
  const multi = calls('spawnSync("a", {' + NL + '  timeout: 1,' + NL + '})', ['spawnSync']);
  check('G9-e 自证：跨行调用括号配对完整',
    multi.length === 1 && multi[0].text.trim().endsWith(')') && multi[0].text.includes('timeout: 1'), 'ok');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
