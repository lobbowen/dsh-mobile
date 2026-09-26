#!/usr/bin/env node
'use strict';

// node-pty 预编译件投放回归：applied / already / skipped / blocked 四态 + 不覆盖同尺寸产物。
// blocked 与 skipped 的分界（真机 2026-09-26 定罪）：树里本该有 pty.node 却没有，
// 那是**我们的供给失败**；旧实现把它记成 skipped，于是终端全灭零告警。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  <- ' + x : '')); };

const ROOT = path.join(__dirname, '..');
const { ensureNodePtyPrebuild } = require(path.join(ROOT, 'src', 'guard', 'native', 'node-pty-prebuild'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-pre-'));

const dshDir = path.join(TMP, 'dsh');
fs.mkdirSync(path.join(dshDir, 'node_modules', 'node-pty'), { recursive: true });
const src = path.join(TMP, 'pty.node');
fs.writeFileSync(src, Buffer.alloc(2048, 7));

const r1 = ensureNodePtyPrebuild(dshDir, src);
const dst = path.join(dshDir, 'node_modules', 'node-pty', 'prebuilds', 'android-arm64', 'pty.node');
check('首次投放 -> applied', r1.status === 'applied', JSON.stringify(r1));
check('落到 loader 查找位 prebuilds/android-arm64/pty.node', fs.existsSync(dst));
check('内容一致', fs.readFileSync(dst).equals(fs.readFileSync(src)));

const r2 = ensureNodePtyPrebuild(dshDir, src);
check('同尺寸二次调用 -> already（不重复写）', r2.status === 'already', JSON.stringify(r2));

const noPty = path.join(TMP, 'no-pty');
fs.mkdirSync(path.join(noPty, 'node_modules'), { recursive: true });
check('树内无 node-pty -> skipped（本就不该投）', ensureNodePtyPrebuild(noPty, src).status === 'skipped');
check('产物路径不存在 -> blocked（我们的供给失败）', ensureNodePtyPrebuild(dshDir, path.join(TMP, 'nope.node')).status === 'blocked');
// 无 node-pty 时 pty.node 缺席不是缺口：按「树里有没有依赖」定优先级，不许报警
check('无 node-pty 且无产物 -> 仍 skipped', ensureNodePtyPrebuild(noPty, null).status === 'skipped');
check('契约无 prefix（srcPath=null）-> blocked 并说明原因',
  (() => { const r = ensureNodePtyPrebuild(dshDir, null); return r.status === 'blocked' && r.reason.includes('prefix'); })());

fs.rmSync(TMP, { recursive: true, force: true });
const failed = results.filter((x) => !x);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
