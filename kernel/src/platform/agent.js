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
  // 平台适配声明（android 节）：产品在安卓容器里需要的内核侧适配。
  // launchFlags = 启动该产品的 CLI / 主进程时，必须在 node 与脚本入口之间注入的参数
  // （如 --expose-internals：dsh app-boot 硬 require 内部模块）。
  // 为什么放描述符：这是**产品契约**，不是内核的私有知识 —— 内核只照单注入，不猜产品。
  d.android = (d.android && typeof d.android === 'object' && !Array.isArray(d.android)) ? d.android : {};
  d.android.launchFlags = Array.isArray(d.android.launchFlags)
    ? d.android.launchFlags.filter((x) => typeof x === 'string' && x.length > 0)
    : [];
  cached = d;
  return d;
}

module.exports = { load, DEFAULT_ID, ROOT };
