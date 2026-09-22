#!/usr/bin/env node
'use strict';

// Command Code 反代额度获取（detectInstanceQuota commandcode-billing 分支）回归测试。
// 覆盖 2026-09 审计修复的判定语义：
//   ① 窗口耗尽只由 used/cap 推导（>=100% → rate-limited），不依赖上游可选的 exceeded 标志——
//      实况 bug：上游 100% 窗口不返 exceeded 时旧实现存出 weekly.status=ok + percent=100 矛盾记录；
//   ② 信封兼容：上游可能返 { data: { windowLimits, credits } } 或平铺；
//   ③ used/cap 字符串/数字均解析；monthlyRemaining 累加（字段缺席置 null）。
// 全部经本地 fetch mock，不触碰真实 Command Code / 外部服务。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

const { ProxyProvider } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'proxy'));

// 反代 app：commandcode 型 quota 定义（与生产 proxy-apps.js 一致）
const CC_APP = {
  id: 'commandcode',
  name: 'Command Code Proxy',
  pkg: 'commandcode-api-proxy',
  healthPath: '/health', modelPath: '/v1/models', upstream: 'https://api.commandcode.ai',
  repo: null, registry: 'commandcode-api-proxy',
  // ⚠ 2026-09-12 校正：fixture 必须与生产配置（proxy-apps.js）**逐键一致** ——
  //   此前缺 `subscriptionsPath` 与 `monthlyCapUsd`，而两者在 `quota-strategies.js`
  //   里**都被消费**（:106 拉订阅期、:124 推导月用量百分比）。
  //   于是本测试一直在跑「回退分支」（无 subscriptionsPath → 用常量路径；
  //   无 monthlyCapUsd → monthly 为 null），**从未覆盖生产的真实路径**。
  //   这类「fixture 与生产配置漂移」会给出虚假的覆盖信心。
  quota: {
    type: 'commandcode-billing',
    apiBase: 'https://api.commandcode.ai',
    creditsPath: '/alpha/billing/credits',
    subscriptionsPath: '/alpha/billing/subscriptions',
    windowMap: { rolling: 'fiveHour', weekly: 'weekly', monthly: null },
    monthlyCapUsd: 10,
  },
  real: true,
};

function mkProvider() {
  const pp = new ProxyProvider({ id: 'p-cc', name: 'CC', kind: 'proxy', proxyAppId: 'commandcode', app: CC_APP, logger: { info(){}, warn(){}, error(){} }, events: null, dist: null, onPersist: () => {} });
  return pp;
}

function mkInst(pp, key) {
  const inst = pp.ensureInstance(key);
  return inst;
}

(async () => {
  // ── mock 1：100% 周窗口、无 exceeded 标志（旧实现会存 status:ok + percent:100 矛盾）──
  global.fetch = async (url, opts) => ({
    ok: true,
    json: async () => ({
      windowLimits: { fiveHour: { cap: 2000, used: 200, resetAt: Date.now() + 3600000 }, weekly: { cap: 100, used: 100, resetAt: Date.now() + 604800000 } },
      credits: { monthlyCredits: 4, purchasedCredits: 0, freeCredits: 0 },
    }),
  });
  const pp1 = mkProvider();
  const inst1 = await mkInst(pp1, 'cc-key-1');
  const r1 = await pp1.detectInstanceQuota(inst1);
  const q1 = inst1.quota;
  check('CC1 周 100% 无 exceeded → rate-limited（不再 status:ok 矛盾）', r1.ok && q1.weekly.status === 'rate-limited' && q1.weekly.percent === 100, JSON.stringify(q1.weekly));
  check('CC2 5h 20% → ok + percent=10', r1.ok && q1.rolling.status === 'ok' && q1.rolling.percent === 10, JSON.stringify(q1.rolling));
  check('CC3 overall=周限额', q1.overallStatus === '周限额', q1.overallStatus);
  check('CC4 monthlyRemaining=4（含字符串兜底累加）', q1.monthlyRemaining === 4, String(q1.monthlyRemaining));

  // ── mock 2：信封形态 { data: {...} }（上游包 data）──
  global.fetch = async () => ({ ok: true, json: async () => ({ data: { windowLimits: { fiveHour: { cap: 10, used: 10, resetAt: null } }, credits: {} } }) });
  const pp2 = mkProvider();
  const inst2 = await mkInst(pp2, 'cc-key-2');
  const r2 = await pp2.detectInstanceQuota(inst2);
  check('CC5 data 信封解包 → 5h 100% rate-limited', r2.ok && inst2.quota.rolling.status === 'rate-limited' && inst2.quota.rolling.percent === 100, JSON.stringify(inst2.quota.rolling));

  // ── mock 3：used/cap 为字符串 + 低于 100 → ok；credits 缺席 → monthlyRemaining=null ──
  global.fetch = async () => ({ ok: true, json: async () => ({ windowLimits: { fiveHour: { cap: '2000', used: '300', resetAt: Date.now() + 3600000 }, weekly: { cap: '100', used: '50', resetAt: null } } }) });
  const pp3 = mkProvider();
  const inst3 = await mkInst(pp3, 'cc-key-3');
  const r3 = await pp3.detectInstanceQuota(inst3);
  check('CC6 字符串 used/cap 解析 → 5h 15% ok', r3.ok && inst3.quota.rolling.percent === 15 && inst3.quota.rolling.status === 'ok', JSON.stringify(inst3.quota.rolling));
  check('CC7 credits 缺席 → monthlyRemaining=null', inst3.quota.monthlyRemaining === null, String(inst3.quota.monthlyRemaining));

  // ── mock 4：HTTP 失败 → ok:false 明确错误 ──
  global.fetch = async () => ({ ok: false, status: 500 });
  const pp4 = mkProvider();
  const inst4 = await mkInst(pp4, 'cc-key-4');
  const r4 = await pp4.detectInstanceQuota(inst4);
  check('CC8 上游 5xx → ok:false + 无法获取配额', r4.ok === false && /无法获取配额/.test(r4.error || ''), JSON.stringify(r4));

  // ── mock 5：月额度用尽账号 + 订阅 periodEnd（2026-09 真实采样核验）──
  // 真实原体：/alpha/billing/credits 无 period 字段；/alpha/billing/subscriptions data.currentPeriodEnd
  // 提供「月额度随订阅续期重置」的精确时刻（planId=individual-go）。
  const now5 = Date.now();
  const periodEnd = now5 + 23 * 24 * 3600 * 1000;
  let subCalls = 0;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/alpha/billing/subscriptions')) {
      subCalls += 1;
      return { ok: true, json: async () => ({ success: true, data: { status: 'active', cancelAtPeriodEnd: false, currentPeriodStart: new Date(now5 - 20 * 24 * 3600 * 1000).toISOString(), currentPeriodEnd: new Date(periodEnd).toISOString(), planId: 'individual-go' } }) };
    }
    return { ok: true, json: async () => ({ credits: { monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 }, windowLimits: { fiveHour: { cap: 3, used: 0.87 }, weekly: { cap: 6, used: 3.9 } } }) };
  };
  const pp5 = mkProvider();
  const inst5 = await mkInst(pp5, 'cc-key-5');
  const r5 = await pp5.detectInstanceQuota(inst5);
  check('CC9 credits-limited 账号取订阅 → monthlyResetAt=periodEnd', r5.ok && inst5.quota && inst5.quota.monthlyResetAt === periodEnd, JSON.stringify(inst5.quota && inst5.quota.monthlyResetAt));
  check('CC10 订阅只取一次（6h 缓存）', subCalls === 1, String(subCalls));
  const r5b = await pp5.detectInstanceQuota(inst5); // 缓存期内：沿用上次 periodEnd，不重复取
  check('CC11 缓存期内沿用 monthlyResetAt 且不重复请求', r5b.ok && inst5.quota.monthlyResetAt === periodEnd && subCalls === 1, JSON.stringify({ subCalls, mr: inst5.quota.monthlyResetAt }));

  // ── mock 6：订阅不可靠（cancelAtPeriodEnd）→ 不调度 at，回退轮询 ──
  subCalls = 0;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/alpha/billing/subscriptions')) { subCalls += 1; return { ok: true, json: async () => ({ success: true, data: { status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: new Date(now5 + 25 * 24 * 3600 * 1000).toISOString() } }) }; }
    return { ok: true, json: async () => ({ credits: { monthlyCredits: 0 }, windowLimits: { fiveHour: { cap: 3, used: 0.1 }, weekly: { cap: 6, used: 0.1 } } }) };
  };
  const pp6 = mkProvider();
  const inst6 = await mkInst(pp6, 'cc-key-6');
  const r6 = await pp6.detectInstanceQuota(inst6);
  check('CC12 cancelAtPeriodEnd → monthlyResetAt=null（回退轮询，不赌续订）', r6.ok && inst6.quota && inst6.quota.monthlyResetAt === null, JSON.stringify(inst6.quota && inst6.quota.monthlyResetAt));

  // ── mock 7：订阅查询失败 → 主额度不受影响，monthlyResetAt=null（轮询兜底）──
  subCalls = 0;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/alpha/billing/subscriptions')) { subCalls += 1; return { ok: false, status: 500 }; }
    return { ok: true, json: async () => ({ credits: { monthlyCredits: 0 }, windowLimits: { fiveHour: { cap: 3, used: 0.1 }, weekly: { cap: 6, used: 0.1 } } }) };
  };
  const pp7 = mkProvider();
  const inst7 = await mkInst(pp7, 'cc-key-7');
  const r7 = await pp7.detectInstanceQuota(inst7);
  check('CC13 订阅 5xx → 主额度仍 ok（credits.monthlyCredits=0）+ monthlyResetAt=null', r7.ok && inst7.quota && inst7.quota.credits && inst7.quota.credits.monthlyCredits === 0 && inst7.quota.monthlyResetAt === null, JSON.stringify(r7));

  // ── mock 8：额度充足账号不取订阅（零额外 API，防风控）──
  subCalls = 0;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/alpha/billing/subscriptions')) { subCalls += 1; return { ok: true, json: async () => ({ success: true, data: { currentPeriodEnd: new Date(now5 + 20 * 24 * 3600 * 1000).toISOString() } }) }; }
    return { ok: true, json: async () => ({ credits: { monthlyCredits: 6.08 }, windowLimits: { fiveHour: { cap: 3, used: 0.1 }, weekly: { cap: 6, used: 3.9 } } }) };
  };
  const pp8 = mkProvider();
  const inst8 = await mkInst(pp8, 'cc-key-8');
  const r8 = await pp8.detectInstanceQuota(inst8);
  check('CC14 额度充足 → 不取订阅（subCalls=0）且 monthlyResetAt=null', r8.ok && subCalls === 0 && inst8.quota && inst8.quota.monthlyResetAt === null, JSON.stringify({ subCalls, mr: inst8.quota && inst8.quota.monthlyResetAt }));

  delete global.fetch;
  delete global.fetch;

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
