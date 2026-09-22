#!/usr/bin/env node
'use strict';

// 智能路由底座（RouterService）离线测试：
// 供应商 CRUD / 账号状态机 / 切换引擎选可用 / 持久化 round-trip / 一账号一实例 / 冻结释放。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

(async () => {
  const { RouterService } = require(path.join(ROOT, 'src', 'domains', 'router'));
  const { ProxyProvider } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'proxy'));
  const providerFile = path.join(TMP, 'providers.json');
  const svc = new RouterService({ config: {}, providerFile, portsFile: path.join(TMP, 'ports-router.json'), logger: { info(){}, warn(){}, error(){} }, events: null });

  // 1. 直连供应商 + 账号状态（k1 可用，k2 额度满不可用）
  const r1 = svc.addDirectProvider({ name: 'Test Direct', baseUrl: 'https://api.test.com' });
  check('添加直连供应商', r1.ok === true, JSON.stringify(r1));
  const dp = svc.getProvider(r1.id);
  dp.accounts.push({ key: 'sk-test-1', keyId: 'k1', maskedKey: '...est-1', status: 'ready', quota: { rolling: { percent: 10, status: 'ok' }, weekly: { percent: 20, status: 'ok' }, monthly: { percent: 30, status: 'ok' } }, cooldownUntil: null, registeredAt: Date.now() });
  dp.accounts.push({ key: 'sk-test-2', keyId: 'k2', maskedKey: '...est-2', status: 'ready', quota: { rolling: { percent: 10, status: 'ok' }, weekly: { percent: 100, status: 'rate-limited' }, monthly: { percent: 100, status: 'rate-limited' } }, cooldownUntil: null, registeredAt: Date.now() });
  svc._save();

  // 2. 账号选择引擎：只选可用账号（供应商独立端点在其自身账号池内选号）
  const picked = svc.switcher.pickFor(dp);
  check('切换引擎只选可用账号', picked && picked.keyId === 'k1', JSON.stringify(picked && picked.keyId));

  // 3. 持久化 round-trip：账号状态保留、进程态不落盘
  const svc2 = new RouterService({ config: {}, providerFile, portsFile: path.join(TMP, 'ports-router.json'), logger: { info(){}, warn(){}, error(){} }, events: null });
  const dp2 = svc2.getProvider(r1.id);
  check('持久化后供应商存在', !!dp2);
  check('账号状态保留', dp2.accounts.length === 2 && dp2.accounts[0].status === 'ready');

  // 3b. 额度恢复时间归一化（2026-09 审计修复）：ISO resetsAt 不得被 Number()=NaN → 30d 兜底吞掉
  const { normalizeResetTs } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base'));
  const nISO = normalizeResetTs('2026-09-21T05:54:32.950Z');
  check('normalizeResetTs ISO → epoch 毫秒', nISO === 1789970072950, String(nISO));
  check('normalizeResetTs epoch 秒 → ×1000', normalizeResetTs('1789970072') === 1789970072000, String(normalizeResetTs('1789970072')));
  check('normalizeResetTs 非法 → null', normalizeResetTs('garbage') === null && normalizeResetTs(null) === null, '');
  // _nextResetAt 用归一值：ISO resetsAt 给出精确恢复点（不再 +30d 兜底）
  const fullAcc = { quota: { monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-09-21T05:54:32.950Z' } } };
  const nr = dp2._nextResetAt(fullAcc.quota);
  check('_nextResetAt 精确解析 ISO → 不落 30d 兜底', nr.precise === true && nr.t === 1789970072950, JSON.stringify(nr));

  // 3c. 锁定/在用派生统一（2026-09 审计修复）：activeAccount 在用而无手动锁定时列表 selected 仍亮
  dp2.activeAccount = dp2.accounts[0]; // 模拟自动在用（未手动锁）
  dp2.selectedAccountKeyId = null;
  const view2 = svc2.listProviders().find((p) => p.id === r1.id);
  const rowSel = view2.accounts.find((a) => a.keyId === 'k1');
  check('未锁定时 activeAccount 在用 → 行 selected=true（列表亮当前账号）', rowSel && rowSel.selected === true, JSON.stringify(rowSel && rowSel.selected));
  check('未锁定时 view.locked=false + activeKeyId=k1', view2.locked === false && view2.activeKeyId === 'k1', JSON.stringify({ locked: view2.locked, activeKeyId: view2.activeKeyId }));
  // 显式锁定（2026-09 A 语义）：只可锁定可用账号——k1 可用 → 持久化 + locked=true
  dp2.selectedAccountKeyId = 'k1';
  svc2._save();
  const svc3 = new RouterService({ config: {}, providerFile, portsFile: path.join(TMP, 'ports-router.json'), logger: { info(){}, warn(){}, error(){} }, events: null });
  const dp3 = svc3.getProvider(r1.id);
  check('显式锁定持久化 round-trip（可用账号）', dp3.selectedAccountKeyId === 'k1', String(dp3.selectedAccountKeyId));
  // 一致性守卫：满额「ready」账号(k2)落盘后为 frozen（不再产生可预热矛盾态）
  const k2After = dp3.accounts.find((a) => a.keyId === 'k2');
  check('一致性守卫：满额 ready 账号落盘归位 frozen', k2After && k2After.status === 'frozen', JSON.stringify(k2After && k2After.status));
  const view3 = svc3.listProviders().find((p) => p.id === r1.id);
  const k1row = view3.accounts.find((a) => a.keyId === 'k1');
  const k2row = view3.accounts.find((a) => a.keyId === 'k2');
  // 锁收敛（2026-09 A）：锁只对可用账号有意义——锁定可用账号(k1) locked+selected；满额冻结账号(k2) 无锁不亮
  check('锁收敛：锁定可用账号(k1) locked=true 且高亮', k1row && k1row.locked === true && k1row.selected === true, JSON.stringify({ locked: k1row && k1row.locked, selected: k1row && k1row.selected }));
  check('锁收敛：满额冻结账号(k2) 无锁不亮', k2row && k2row.locked === false && k2row.selected === false && view3.activeKeyId === 'k1', JSON.stringify({ l: k2row && k2row.locked, s: k2row && k2row.selected, activeKeyId: view3.activeKeyId }));

  // 4. 一账号一实例去重
  const pp = new ProxyProvider({ id: 'p1', name: 'P', kind: 'proxy', proxyAppId: 'test-dry-run', app: { command: ['node', 'x', '--port', '{{port}}', '--api-key', '{{key}}'], healthPath: '/health' }, logger: { info(){}, warn(){}, error(){} }, events: null, dist: null, onPersist: () => {} });
  const i1 = await pp.ensureInstance('key-A');
  const i2 = await pp.ensureInstance('key-A');
  check('一账号一实例：重复 ensure 返回同一实例', i1 === i2);
  check('实例列表只有一条', pp.instances.length === 1, 'len=' + pp.instances.length);

  // 5. 冻结/释放（带 resetAt）
  i1.freeze('1788000000000');
  check('冻结状态+resetAt', i1.status === 'frozen' && i1.quota.resetsAt === '1788000000000');
  i1.unfreeze();
  check('解冻回 registered', i1.status === 'registered');

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
