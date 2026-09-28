#!/usr/bin/env node
'use strict';

// API 契约面强制测试：源码里的每条路由都必须在 src/api/surface.js 登记（双向一致）。
// 系统级入口（进程监督/端口分配/安装执行/续跑）不在本表——它们归 OS 原生。

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const API_DIR = path.join(ROOT, 'src', 'api');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

const { SURFACE, PREFIXES, CATEGORIES, summary } = require(path.join(API_DIR, 'surface'));

function extract() {
  const exact = new Map();
  const prefix = new Map();
  for (const f of fs.readdirSync(API_DIR).filter((x) => x.endsWith('.js') && !['index.js', 'surface.js', '_os.js'].includes(x))) {
    const s = fs.readFileSync(path.join(API_DIR, f), 'utf8');
    let m;
    const re = /pathname === '([^']+)'/g;
    while ((m = re.exec(s))) { if (!exact.has(m[1])) exact.set(m[1], new Set()); exact.get(m[1]).add(f); }
    const rp = /pathname\.startsWith\('([^']+)'\)/g;
    while ((m = rp.exec(s))) { if (!prefix.has(m[1])) prefix.set(m[1], new Set()); prefix.get(m[1]).add(f); }
  }
  return { exact, prefix };
}

const { exact, prefix } = extract();
const declaredExact = new Set(SURFACE.map((e) => e.path));
const declaredPrefix = new Set(PREFIXES.map((e) => e.prefix));

console.log('== API 契约面：清单结构 ==');
check('全部条目分类合法', SURFACE.every((e) => CATEGORIES.includes(e.category)) && PREFIXES.every((e) => CATEGORIES.includes(e.category)), JSON.stringify(summary()));
check('每个条目声明 methods 与 consumers', SURFACE.every((e) => Array.isArray(e.methods) && e.methods.length > 0 && e.consumers && e.consumers.length > 0), 'ok');
check('每个条目有 note', SURFACE.every((e) => typeof e.note === 'string' && e.note.length > 0) && PREFIXES.every((e) => typeof e.note === 'string' && e.note.length > 0), 'ok');
check('无 deprecated 条目（新仓不留兼容桩）', SURFACE.filter((e) => e.category === 'deprecated').length === 0, 'clean');

console.log('== 双向一致：源码 <-> 清单 ==');
const undeclared = [...exact.keys()].filter((p) => !declaredExact.has(p));
check('源码中所有精确路由均已登记', undeclared.length === 0, undeclared.join(', ') || 'clean');
const phantom = [...declaredExact].filter((p) => !exact.has(p));
check('清单中所有精确路由均存在于源码', phantom.length === 0, phantom.join(', ') || 'clean');
const undeclaredPrefix = [...prefix.keys()].filter((p) => !declaredPrefix.has(p));
check('源码中所有前缀路由均已登记', undeclaredPrefix.length === 0, undeclaredPrefix.join(', ') || 'clean');
const phantomPrefix = [...declaredPrefix].filter((p) => !prefix.has(p));
check('清单中所有前缀路由均存在于源码', phantomPrefix.length === 0, phantomPrefix.join(', ') || 'clean');

console.log('== 已删除的系统级端点不得复活 ==');
const srcAll = fs.readdirSync(API_DIR).filter((x) => x.endsWith('.js')).map((f) => fs.readFileSync(path.join(API_DIR, f), 'utf8')).join('\n');
for (const gone of ['/self-update/', '/autostart', '/settings/close-action', '/router/', '/logs/events-tail']) {
  check('已删除端点不得复活: ' + gone, srcAll.indexOf(gone) < 0, 'clean');
}

const failed = results.filter((r) => !r);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);

