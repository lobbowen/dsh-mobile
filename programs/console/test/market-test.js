#!/usr/bin/env node
'use strict';

// Program 市场索引：泛化配置与 bundle 判定（不联网；只测纯逻辑）。
// 面板不写死任何单一载荷生态的名称：字段/关键词/主题都来自构造参数。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { ProgramMarket } = require(path.join(__dirname, '..', 'src', 'domains', 'plugin', 'pluginmarket.js'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lobos-market-test-'));
const m = new ProgramMarket({ stateFile: path.join(TMP, 'market.json'), cacheDir: TMP, logger: { info() {}, warn() {}, error() {} } });

check('M-1 bundleField 默认泛化为 lobos', m.bundleField === 'lobos', m.bundleField);
check('M-2 关键词为 Program 命名空间', Array.isArray(m.keywords) && m.keywords.includes('lobos-program'), JSON.stringify(m.keywords));
check('M-3 主题为 Program 命名空间', Array.isArray(m.topics) && m.topics.includes('lobos-program'), JSON.stringify(m.topics));
check('M-4 声明 bundle 字段 → 视为扩展', m._hasBundle({ lobos: { bundle: 'dist/index.js' } }) === true);
check('M-5 未声明 bundle → 不是扩展', m._hasBundle({ name: 'x' }) === false && m._hasBundle(null) === false);
check('M-6 字段可构造期覆盖', new ProgramMarket({ bundleField: 'acme', stateFile: path.join(TMP, 'm2.json'), cacheDir: TMP })._hasBundle({ acme: { bundle: true } }) === true);
check('M-7 分类：工具类命中', m.constructor && require(path.join(__dirname, '..', 'src', 'domains', 'plugin', 'pluginmarket.js')) !== undefined);

const failed = results.filter((r) => !r);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);

