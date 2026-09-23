#!/usr/bin/env node
'use strict';

// sharp wasm 回退补给回归：三态 + 只拷 @img/@emnapi + 不扰动其它 node_modules 内容。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  <- ' + x : '')); };

const ROOT = path.join(__dirname, '..');
const { ensureSharpWasm, PKG } = require(path.join(ROOT, 'src', 'guard', 'native', 'sharp-wasm'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sharp-wasm-test-'));

// 假 npm：把包写进 --prefix 指向的目录
const fakeNpm = path.join(TMP, 'fake-npm.js');
fs.writeFileSync(fakeNpm, [
  "'use strict';",
  "const fs=require('node:fs');const path=require('node:path');",
  "const i=process.argv.indexOf('--prefix');const dir=process.argv[i+1];",
  "for (const s of ['@img/sharp-wasm32','@emnapi/runtime']) {",
  "  const d=path.join(dir,'node_modules',...s.split('/'));fs.mkdirSync(d,{recursive:true});",
  "  fs.writeFileSync(path.join(d,'package.json'),JSON.stringify({name:s,version:'0.0.0'}));",
  "}",
  "console.log('fake install ok');",
].join(String.fromCharCode(10)));
const npmInvocation = { bin: process.execPath, args: [fakeNpm] };

const dshDir = path.join(TMP, 'dsh');
fs.mkdirSync(path.join(dshDir, 'node_modules', 'sharp'), { recursive: true });
fs.writeFileSync(path.join(dshDir, 'node_modules', 'sharp', 'package.json'), '{}');
fs.mkdirSync(path.join(dshDir, 'node_modules', 'node-pty'), { recursive: true });

const r1 = ensureSharpWasm(dshDir, { npmInvocation, tmpdir: TMP });
check('首次补给 -> applied', r1.status === 'applied', JSON.stringify(r1));
check(PKG + ' 就位', fs.existsSync(path.join(dshDir, 'node_modules', '@img', 'sharp-wasm32', 'package.json')));
check('@emnapi 依赖一并就位', fs.existsSync(path.join(dshDir, 'node_modules', '@emnapi', 'runtime', 'package.json')));
check('未扰动其它依赖', fs.existsSync(path.join(dshDir, 'node_modules', 'node-pty')));

const r2 = ensureSharpWasm(dshDir, { npmInvocation, tmpdir: TMP });
check('二次调用幂等 -> already', r2.status === 'already', JSON.stringify(r2));

const empty = path.join(TMP, 'no-sharp');
fs.mkdirSync(path.join(empty, 'node_modules'), { recursive: true });
const r3 = ensureSharpWasm(empty, { npmInvocation, tmpdir: TMP });
check('无 sharp -> skipped（不误装）', r3.status === 'skipped', JSON.stringify(r3));

fs.rmSync(TMP, { recursive: true, force: true });
const failed = results.filter((x) => !x);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
