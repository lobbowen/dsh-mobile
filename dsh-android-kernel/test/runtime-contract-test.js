#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 运行期启动契约（壳写、内核读）门禁（2026-09-15）
//
// ## 解决的问题
//   内核自身也要执行 npm（自更新 / 装 DSH / 插件）。旧实现用 ambient PATH 的裸 npm
//   与 process.env；GUI/服务环境的 PATH 常不含 nvm/fnm 的 npm → 「壳能装、内核自己装不了」。
//   现统一读壳投放的 ~/.dsh/supervisor/runtime.json（schema 2）。
//
// ## 锁定不变量
//   R-1  read() 解析 schema2/兼容 schema1；缺失/损坏返回 null（绝不抛）
//   R-2  npmBin() 契约优先、不可用退回 fallback
//   R-3  withPath() 把 nodeBinDir 置于 PATH 首位（分隔符跨平台）
//   R-4  消费点接入：dist/index.js 的 npm 与 env、env-catalog 的 minNode
//   R-5  反向：无契约时退回 ambient（不空转）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rc = require(path.join(ROOT, 'src', 'platform', 'runtime-contract.js'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : '')); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rtc-'));
// 产品状态根隔离（独立于 DSH）：runtime.json 落在 <DSH_SUPERVISOR_HOME>/supervisor。
process.env.DSH_SUPERVISOR_HOME = TMP;
const SUP = path.join(TMP, 'supervisor');
fs.mkdirSync(SUP, { recursive: true });
const NODE_DIR = path.join(TMP, 'nodebin');
fs.mkdirSync(NODE_DIR, { recursive: true });
const NODE = path.join(NODE_DIR, process.platform === 'win32' ? 'node.exe' : 'node');
const NPM = path.join(NODE_DIR, process.platform === 'win32' ? 'npm.cmd' : 'npm');
fs.writeFileSync(NODE, '#!/bin/sh\n');
fs.writeFileSync(NPM, '#!/bin/sh\n');

const savedHome = process.env.HOME; const savedUp = process.env.USERPROFILE;
process.env.HOME = TMP; process.env.USERPROFILE = TMP;

// R-5 反向：无契约 → null + fallback。
check('R-5 无契约时 read()=null', rc.read() === null);
check('R-5 无契约时 npmBin 退回 fallback', rc.npmBin('FALLBACK') === 'FALLBACK');

// schema 2 写入。
fs.writeFileSync(path.join(SUP, 'runtime.json'), JSON.stringify({
  schema: 2, writtenBy: 'test',
  nodePath: NODE, nodeVersion: 'v22.12.0', nodeBinDir: NODE_DIR, npmPath: NPM, minNode: 'v22.12.0',
}), null, 2);

const c2 = rc.read();
check('R-1 schema2 解析出 node/npm/binDir', !!(c2 && c2.nodePath === NODE && c2.npmPath === NPM && c2.nodeBinDir === NODE_DIR), JSON.stringify(c2 && { n: c2.nodePath, m: c2.npmPath }));
check('R-2 npmBin 契约优先（绝对 npm）', rc.npmBin('FALLBACK') === NPM, rc.npmBin('FALLBACK'));
const env = rc.withPath({ PATH: '/ambient/bin' });
check('R-3 withPath 把 nodeBinDir 置于首位', env.PATH.indexOf(NODE_DIR) === 0, env.PATH);
check('R-3 保留 ambient PATH', env.PATH.indexOf('/ambient/bin') > 0, env.PATH);

// schema 1 兼容（只有顶层旧键）。
fs.writeFileSync(path.join(SUP, 'runtime.json'), JSON.stringify({ schema: 1, nodePath: NODE, nodeVersion: 'v22.12.0', minNode: 'v22.12.0' }), null, 2);
const c1 = rc.read();
check('R-1 schema1 兼容（binDir 由 nodePath 推导前仍可读 minNode）', !!(c1 && c1.minNode === 'v22.12.0' && c1.nodePath === NODE), JSON.stringify(c1));

// 损坏 JSON → null（不抛）。
fs.writeFileSync(path.join(SUP, 'runtime.json'), '{ bad json', 'utf8');
check('R-1 损坏 JSON → null（不抛）', rc.read() === null);

// R-6 契约版本握手：本侧 schema 常量必须与壳写入的 schema 一致（各自断言，不跨仓读源码）。
check('R-6 契约 schema 版本 = 2（与壳 handshake）', rc.SUPPORTED_SCHEMA === 2, String(rc.SUPPORTED_SCHEMA));

// R-4 消费点接入（静态）。
const dist = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'dist', 'index.js'), 'utf8');
check('R-4 dist/index.js 用契约解析 npm', /runtimeContract\.npmBin\(/.test(dist), 'ok');
check('R-4 dist/index.js 用契约注入 PATH', /runtimeContract\.withPath\(/.test(dist), 'ok');
const ec = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'env-catalog.js'), 'utf8');
check('R-4 env-catalog 用契约读 minNode', /runtime-contract/.test(ec), 'ok');

process.env.HOME = savedHome; process.env.USERPROFILE = savedUp;
delete process.env.DSH_SUPERVISOR_HOME;
fs.rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
