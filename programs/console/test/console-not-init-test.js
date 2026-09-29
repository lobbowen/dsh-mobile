#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// console 不是 init / 可停可换 —— 硬不变量门禁（债 A10/A11/A12/D9）
//
// 锁定：
//   N-1  不存在 console.js（系统职责已下沉；D9）
//   N-2  不存在 guard/ assembler/ d2/ domains/dist/（系统级职责目录）
//   N-3  bin/panel 不拉起/监督系统组件：无 child_process.spawn/fork、无锁文件、
//        无 daemon 自拉起、无 checkpoint/replay 续跑（A16）
//   N-4  manifest.json role=system、entry=bin/panel；package.json name=lobos-console-panel、bin.panel
//   N-5  docs/components/console-system-api.md 存在，且列出关键 OS 原生接口（os.state.get / os.instances.action /
//        os.appmgr.install / os.ports.* / os.journal.*）
//   N-6  api 层不得在本进程内分配端口/装运行时（端口权威在 OS PortBroker）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

// N-1 / N-2
check('N-1 无 console.js（D9 整体删除）', !fs.existsSync(path.join(ROOT, 'src', 'console.js')));
for (const d of ['guard', path.join('assembler'), 'd2', path.join('domains', 'dist')]) {
  check('N-2 无系统级目录 src/' + d, !fs.existsSync(path.join(ROOT, 'src', d)));
}

// N-3 bin/panel 是面板入口，不是 init
const binSrc = fs.readFileSync(path.join(ROOT, 'bin', 'panel'), 'utf8');
check('N-3 bin/panel 不 spawn/fork 子进程', !/child_process/.test(binSrc) && !/\bspawn\s*\(/.test(binSrc) && !/\bfork\s*\(/.test(binSrc));
check('N-3 bin/panel 无锁文件/daemon 自拉起', !/lockFile|LOCK_FILE|daemonize|自拉起/i.test(binSrc) && !/require\([^)]*console/.test(binSrc));
const srcFiles = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) srcFiles.push(p); } })(path.join(ROOT, 'src'));
const allSrc = srcFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
check('N-3 源码无 checkpoint/replay 续跑机制（A16）', !/checkpoint|\breplay\b|resumeFrom/.test(allSrc));
check('N-3 源码不监督子进程（无 child_process）', !/require\(['"]node:child_process['"]\)|require\(['"]child_process['"]\)/.test(allSrc));

// N-4 清单契约
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('N-4 manifest.role=system', manifest.role === 'system', manifest.role);
check('N-4 manifest.entry=bin/panel', manifest.entry === 'bin/panel', manifest.entry);
check('N-4 package.name=lobos-console-panel', pkg.name === 'lobos-console-panel', pkg.name);
check('N-4 package.bin.panel', !!(pkg.bin && pkg.bin.panel), JSON.stringify(pkg.bin));

// N-5 接口清单
const sysapi = fs.existsSync(path.join(ROOT, '..', '..', 'docs', 'components', 'console-system-api.md')) ? fs.readFileSync(path.join(ROOT, '..', '..', 'docs', 'components', 'console-system-api.md'), 'utf8') : '';
check('N-5 docs/components/console-system-api.md 存在', sysapi.length > 0);
for (const m of ['os.state.get', 'os.instances.action', 'os.appmgr.install', 'os.ports.', 'os.journal.']) {
  check('N-5 docs/components/console-system-api.md 声明 ' + m, sysapi.includes(m));
}

// N-6 端口/运行时不在面板内实现
check('N-6 面板不持有 ports.json / 不分配端口', !/ports\.json/.test(allSrc) && !/PortRegistry|ports\.allocate|claimSlot/.test(allSrc));
check('N-6 面板不装配运行时', !/assembler|runtime-contract/.test(allSrc));

// N-7 载荷只许用 OS 声明的 WebView 桥（公理 D / 复检 AUD-G30）
const hf = fs.readFileSync(path.join(ROOT, 'ui', 'public', 'host-frame.js'), 'utf8');
const allowed = new Set(['LobosNative', 'lobosDeliverResult']);
const known = new Set(['addEventListener', 'removeEventListener', 'postMessage', 'parent', 'top', 'self']);
const bridges = [...hf.matchAll(/window\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  .filter((n) => !known.has(n) && !allowed.has(n));
check('N-7 只用 OS 声明的 WebView 桥', bridges.length === 0, bridges.join(','));
const failed = results.filter((r) => !r);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);

