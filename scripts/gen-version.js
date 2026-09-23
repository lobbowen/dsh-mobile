#!/usr/bin/env node
'use strict';

// ============================================================================
// 版本清单生成器 —— 「各层版本到底是多少」的唯一可评审产物。
// ============================================================================
// 与 scripts/gen-native-assets.js 同款模式：CI 断言 `node scripts/gen-version.js
// && git diff --exit-code -- .github/version-manifest.json`。
//
// 为什么要生成而不是手写：
//   · 版本散落在 4 个 package.json + 1 个 version.json + 1 个运行时 tag 里，
//     手写汇总必然漂移；生成器让「漂移」变成一个能红的 diff。
//   · 生成的 JSON 直接进 git，评审时能一眼看到本次改动把哪个版本动了。
//
// 单一事实源分工：
//   · version.json                      → 壳（APK）的 versionName/versionCode
//   · assets/node-versions.json         → Node 运行时钉版（default / abi）
//   · container/engine/package.json     → 引擎版本
//   · kernel/package.json               → 内核版本（OTA 包名同源）
//   · kernel/ui/package.json            → 面板版本
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

function fail(msg) {
  console.error('[gen-version] ' + msg);
  process.exit(1);
}

const version = read('version.json');
const engine = read('container/engine/package.json');
const kernel = read('kernel/package.json');
const ui = read('kernel/ui/package.json');
// 运行时钉版**不在这里定义**：它的单一源是 container/app/src/main/assets/node-versions.json
// （工作流 fast-apk 的 "Resolve Node runtime version" 读的也是它）—— 不复制第二个源。
const nodeVersions = read('container/app/src/main/assets/node-versions.json');

const shell = version.shell || {};
const runtime = { node: nodeVersions.default, abi: nodeVersions.abi };

if (typeof shell.versionName !== 'string' || !shell.versionName.trim()) {
  fail('version.json 缺少 shell.versionName');
}
if (!Number.isInteger(shell.versionCode) || shell.versionCode < 1) {
  fail('version.json 的 shell.versionCode 必须是 >= 1 的整数');
}
if (!runtime.node || !runtime.abi) {
  fail('assets/node-versions.json 缺少 default / abi');
}
for (const [p, pkg] of [
  ['container/engine/package.json', engine],
  ['kernel/package.json', kernel],
  ['kernel/ui/package.json', ui],
]) {
  if (typeof pkg.version !== 'string' || !pkg.version) fail(p + ' 缺少 version');
}

const manifest = {
  $comment: '由 scripts/gen-version.js 生成，请勿手改；改版本请改 version.json / 各 package.json。',
  shell: {
    versionName: shell.versionName,
    versionCode: shell.versionCode,
  },
  engine: { name: engine.name, version: engine.version },
  kernel: { name: kernel.name, version: kernel.version },
  ui: { name: ui.name, version: ui.version },
  runtime: {
    node: runtime.node,
    abi: runtime.abi,
    tag: 'node-runtime-' + runtime.node + '-' + runtime.abi,
  },
};

const out = path.join(ROOT, '.github', 'version-manifest.json');
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');

console.log('[gen-version] 已生成 .github/version-manifest.json');
console.log('  shell   ' + manifest.shell.versionName + ' (code ' + manifest.shell.versionCode + ')');
console.log('  engine  ' + manifest.engine.version);
console.log('  kernel  ' + manifest.kernel.version);
console.log('  ui      ' + manifest.ui.version);
console.log('  runtime ' + manifest.runtime.tag);
