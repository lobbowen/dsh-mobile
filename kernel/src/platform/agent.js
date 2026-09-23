'use strict';

// Agent 描述符：内核从中派生包名/入口/profile/数据目录，不再硬编码某一个 Agent。
// 新增 Agent = 增一个 adapters/<id>/agent.json，内核代码不动。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'adapters');
const DEFAULT_ID = 'dsh';
let cached = null;

function load(id) {
  const want = id || process.env.DSH_AGENT || DEFAULT_ID;
  if (cached && cached.id === want) return cached;
  const file = path.join(ROOT, want, 'agent.json');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of ['id', 'npmPackage', 'entry', 'profileName', 'homeDirName']) {
    if (!d[k]) throw new Error('agent.json 缺字段 ' + k + ': ' + file);
  }
  d.dataPaths = Array.isArray(d.dataPaths) ? d.dataPaths : [];
  d.protectedPackages = Array.isArray(d.protectedPackages) ? d.protectedPackages : [];
  cached = d;
  return d;
}

module.exports = { load, DEFAULT_ID, ROOT };
