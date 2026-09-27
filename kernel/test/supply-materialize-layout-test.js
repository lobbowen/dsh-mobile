#!/usr/bin/env node
'use strict';

// C 通道物化器的**布局不变量**判据（真机事故换来的）。
//
// 事故（2026-09-28，kernel 0.1.0-android.37 真机验收）：日志里四件都报 applied，
//   盘上却只剩最后装的那件（sqlite3），另三件只剩 $PREFIX/bin 里的断链。
//   根因：所有件共用 lib/toolchain 一间，而落位是「先清终态再 rename」⇒ 每装一件抹掉前一件。
//   CI 全绿，因为这个形态只在**多个件**同时投放时出现 —— 所以这里把该形态钉住。
//
// 判据：① 一件一目录（两件不踩同一间）；② 清理旧平铺布局时只删确切知道的旧路径，
//      不碰件目录、点文件（清单水位）与锁文件；③ 暂存目录是点开头、与终态同层。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const m = require('../src/supply/materialize');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mat-'));
const prefix = path.join(tmp, 'usr');
const mkFile = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); };

// ① 一件一目录
const a = m.rootFor(prefix, 'git');
const b = m.rootFor(prefix, 'sqlite3');
check('一件一目录：两件的落位不同', a !== b, a + ' | ' + b);
check('落位形态是 lib/toolchain/<件名>', a === path.join(prefix, 'lib', 'toolchain', 'git'), a);
const st = m.stagingFor(prefix, 'git');
check('暂存目录与终态同层（rename 才原子）', path.dirname(st) === path.dirname(a), st);
check('暂存目录点开头（不会被当成件目录）', path.basename(st).charAt(0) === '.', path.basename(st));

// ② 旧平铺布局清理：只删旧的，不碰新的/点文件/锁
const tc = path.join(prefix, 'lib', 'toolchain');
mkFile(path.join(tc, 'bin', 'sqlite3'));      // 旧平铺残留
mkFile(path.join(tc, 'libexec', 'git-core', 'git-add'));
mkFile(path.join(tc, 'link-farm.txt'));
mkFile(path.join(tc, '.manifest.json'));     // 清单水位：必须留下
mkFile(path.join(prefix, 'lib', 'toolchain.lock')); // 锁：必须留下
mkFile(path.join(tc, 'git', 'bin', 'git'));  // 新布局件目录：必须留下
const removed = m.removeLegacyFlatLayout(prefix);
check('旧平铺残留被清掉（bin/libexec/link-farm.txt）',
  removed.includes('bin') && removed.includes('libexec') && removed.includes('link-farm.txt'), removed.join(','));
check('新布局的件目录未被误删', fs.existsSync(path.join(tc, 'git', 'bin', 'git')));
check('清单水位（点文件）未被误删', fs.existsSync(path.join(tc, '.manifest.json')));
check('锁文件未被误删', fs.existsSync(path.join(prefix, 'lib', 'toolchain.lock')));
check('重复清理是幂等的（第二次没有可删项）', m.removeLegacyFlatLayout(prefix).length === 0);

fs.rmSync(tmp, { recursive: true, force: true });
const passed = results.filter(Boolean).length;
console.log('');
console.log('结果: ' + passed + ' passed, ' + (results.length - passed) + ' failed');
process.exit(passed === results.length ? 0 : 1);
