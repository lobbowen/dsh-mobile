#!/usr/bin/env node
'use strict';

// Agent 描述符回归：内核必须完全从 adapters/<id>/agent.json 派生，不得再硬编码某个 Agent。

const fs = require('node:fs');
const path = require('node:path');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  <- ' + x : '')); };

const ROOT = path.join(__dirname, '..');
const agent = require(path.join(ROOT, 'src', 'platform', 'agent'));

const d = agent.load();
check('描述符可加载且字段齐全', !!(d.id && d.npmPackage && d.entry && d.profileName && d.homeDirName), JSON.stringify(d));
check('dataPaths 非空数组', Array.isArray(d.dataPaths) && d.dataPaths.length > 0);
check('protectedPackages 非空数组', Array.isArray(d.protectedPackages) && d.protectedPackages.length > 0);
check('未知 id 抛错（不静默回退）', (() => { try { agent.load('__nope__'); return false; } catch { return true; } })());

const cfg = require(path.join(ROOT, 'src', 'platform', 'config'));
check('config 默认包名派生自描述符', cfg.DEFAULTS.packageName === d.npmPackage, cfg.DEFAULTS.packageName);
check('config 默认 profile 派生自描述符', cfg.DEFAULTS.pluginsProfileName === d.profileName, cfg.DEFAULTS.pluginsProfileName);

const offenders = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith('.js')) continue;
    const t = fs.readFileSync(p, 'utf8');
    for (const line of t.split(String.fromCharCode(10))) {
      const s = line.trim();
      if (s.startsWith('//') || s.startsWith('*')) continue;
      if (/['"]@deepseek-ai\/dsh['"]/.test(line)) offenders.push(path.relative(ROOT, p) + ' :: ' + s.slice(0, 80));
    }
  }
})(path.join(ROOT, 'src'));
check('src 无硬编码的 @deepseek-ai/dsh 字面量', offenders.length === 0, offenders.join(' | '));

const failed = results.filter((x) => !x);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
