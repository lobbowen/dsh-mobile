#!/usr/bin/env node
'use strict';

// provisionSharedTools 的**不静默**判据（真机事故换来的）。
//
// 事故（kernel 0.1.0-android.38 真机验收）：函数体在 `c` 定义之前就用了 `c.prefix` ⇒ ReferenceError
//   ⇒ async 拒绝 ⇒ 被调用方 supervisor.js 的 .catch(() => {}) 吞掉 ⇒ **整轮投放零日志零事件**，
//   面板上四格停在「判据随件下发，但 C 清单尚未取回」，而设备实际完全取得到线上清单（实测 673ms/200）。
//
// 判据：① 无容器契约时**不抛**（promise 永不 reject）；② 返回结果对象；③ 留下可被看见的记录。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-prov-'));
// 契约文件路径 = <DSH_SUPERVISOR_HOME>/supervisor/runtime.json；这里**故意不写**它。
process.env.DSH_SUPERVISOR_HOME = tmp;
const m = require('../src/supply/materialize');

(async () => {
  const events = [];
  const logs = [];
  const logger = { info: (l) => logs.push(l), warn: (l) => logs.push('WARN ' + l) };
  let rejected = null;
  let res = null;
  try {
    res = await m.provisionSharedTools({ logger, events: { append: (t, d) => events.push([t, d]) } });
  } catch (e) { rejected = e; }
  check('无契约时不抛（promise 不 reject）', rejected === null, rejected && rejected.message);
  check('返回空结果对象', !!res && typeof res === 'object' && Object.keys(res).length === 0);
  const seen = logs.concat(events.map((e) => e[0]));
  check('留下可被看见的记录（不许静默）', seen.length > 0, JSON.stringify(seen));

  fs.rmSync(tmp, { recursive: true, force: true });
  const passed = results.filter(Boolean).length;
  console.log('');
  console.log('结果: ' + passed + ' passed, ' + (results.length - passed) + ' failed');
  process.exit(passed === results.length ? 0 : 1);
})();
