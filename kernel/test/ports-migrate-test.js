#!/usr/bin/env node
'use strict';

// migrateRouterSegment 契约（迁移S2，src/guard/lifecycle/ports.js:104）：
//   router 自治端口段（owner 前缀 proxy:/providerApi:）从共享 oldFile 迁出到 newFile 并清旧段；
//   幂等（无 router 段时 0 条）；目标合并去重；守卫段（system:/inst: 等）保留在旧文件。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
// 端口手工分配在安全段（避开 OS ephemeral 与生产池）；跨文件不撞号靠人工规划，T1 兜底。

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-mig-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

(async () => {
  const { PortRegistry } = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'ports'));
  const ports = new PortRegistry({ file: path.join(TMP, 'unused.json') });

  const oldF = path.join(TMP, 'mig-old.json');
  const newF = path.join(TMP, 'mig-new.json');

  // 首次迁移：2 条 router 段迁出，旧文件清 router 段
  fs.writeFileSync(oldF, JSON.stringify({ records: [
    { port: 28140, role: 'proxyInstance', owner: 'proxy:k1' },
    { port: 28142, role: 'providerApi', owner: 'providerApi:p1' },
    { port: 3080, role: 'dsh-main', owner: 'system:dsh-main' },
    { port: 3081, role: 'user', owner: 'inst:main' },
  ] }, null, 2));
  const moved = ports.migrateRouterSegment(oldF, newF);
  const oldDoc = JSON.parse(fs.readFileSync(oldF, 'utf8'));
  const newDoc = JSON.parse(fs.readFileSync(newF, 'utf8'));
  const isRouterRec = (r) => String((r && r.owner) || '').startsWith('proxy:') || String((r && r.owner) || '').startsWith('providerApi:');
  check('MIG-1 迁移 2 条 router 段', moved === 2, String(moved));
  check('MIG-2 旧文件保留守卫段、清除 router 段', oldDoc.records.length === 2 && !oldDoc.records.some(isRouterRec), JSON.stringify(oldDoc.records));
  check('MIG-3 新文件含 2 条 router 段', newDoc.records.length === 2 && newDoc.records.every(isRouterRec), JSON.stringify(newDoc.records));

  // 幂等：旧文件已无 router 段 → 二次迁移 0 条
  const moved2 = ports.migrateRouterSegment(oldF, newF);
  check('MIG-4 幂等（无 router 段时迁移 0 条）', moved2 === 0, String(moved2));

  // 目标已有记录时合并去重
  fs.writeFileSync(oldF, JSON.stringify({ records: [
    { port: 28141, role: 'proxyInstance', owner: 'proxy:k2' },
    { port: 3080, role: 'dsh-main', owner: 'system:dsh-main' },
  ] }, null, 2));
  fs.writeFileSync(newF, JSON.stringify({ records: [{ port: 28140, role: 'proxyInstance', owner: 'proxy:k1' }] }, null, 2));
  const moved3 = ports.migrateRouterSegment(oldF, newF);
  const newDoc3 = JSON.parse(fs.readFileSync(newF, 'utf8'));
  check('MIG-5 目标合并去重（新增 28141，保留既有 28140）', moved3 === 1 && newDoc3.records.length === 2, 'moved=' + moved3 + ' recs=' + newDoc3.records.length);

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
