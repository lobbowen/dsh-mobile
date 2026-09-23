#!/usr/bin/env node
'use strict';

// node-pty 预编译件投放回归：applied / already / skipped 三态 + 不覆盖同尺寸产物。

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
check('树内无 node-pty -> skipped', ensureNodePtyPrebuild(noPty, src).status === 'skipped');
check('产物缺失 -> skipped', ensureNodePtyPrebuild(dshDir, path.join(TMP, 'nope.node')).status === 'skipped');

fs.rmSync(TMP, { recursive: true, force: true });
const failed = results.filter((x) => !x);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
