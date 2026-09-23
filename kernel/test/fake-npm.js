#!/usr/bin/env node
'use strict';

// 升级测试用假安装器：模拟 npm install -g 的成功/失败，不碰真实 npm。
// 用法: node fake-npm.js <version>
// 环境变量:
//   FAKE_PKG_JSON  要改写的 package.json 路径（必填）
//   FAKE_MODE      ok(默认)=改写版本并退出0 | fail=退出3

const fs = require('node:fs');

const version = process.argv[2];
const pkgPath = process.env.FAKE_PKG_JSON;
const mode = process.env.FAKE_MODE || 'ok';

console.log(`[fake-npm] install ${version} mode=${mode}`);

if (!pkgPath || !version) {
  console.error('[fake-npm] missing args');
  process.exit(2);
}

if (mode === 'fail') {
  console.error('[fake-npm] simulated failure');
  process.exit(3);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
console.log(`[fake-npm] wrote ${pkgPath} -> ${version}`);
process.exit(0);
