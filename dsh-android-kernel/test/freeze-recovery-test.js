#!/usr/bin/env node
'use strict';

// 响应驱动冻结机制端到端验证（2026-09-05 修复 A/B 验收）：
//   A) markQuotaExhausted 恢复点 = 上游 429 body 的精确 ISO 时间（非默认 +5h）；
//   B) 冻结后 _probeAfterResponseFreeze 自动补探测刷新 quota（消除 stale 快照）。
// 方法：本地 mock Command billing（/alpha/billing/credits）+ 真实 ProxyProvider，
//       不 spawn 真实实例（ensureInstance 只建对象；detectInstanceQuota 直连 mock billing）。

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-recovery-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

(async () => {
  const { ProxyProvider } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'proxy'));
  const { keyFingerprint } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base'));
  const ports = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'ports')).shared;
  ports.configureFile(path.join(TMP, 'ports-router.json'));
  const log = { info(){}, warn(){}, error(){}, debug(){} };

  // ── mock Command billing：可编程响应 ──
  let billingState = {
    limited: true,
    exceeded: 'fiveHour',
    fiveHour: { used: 3.1, cap: 3, exceeded: true, resetAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString() }, // 2h 后重置
    weekly: { used: 1, cap: 6, exceeded: false, resetAt: null },
  };
  let billingHits = 0; // billing server 被请求次数（验证补探测）
  const billing = http.createServer((req, res) => {
    billingHits++;
    const body = JSON.stringify({
      credits: { monthlyCredits: 0.5, purchasedCredits: 0, freeCredits: 0, belowThreshold: false, creditThreshold: 0 },
      windowLimits: billingState,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  await new Promise((r) => billing.listen(0, '127.0.0.1', r));
  const billingPort = billing.address().port;
  const billingBase = 'http://127.0.0.1:' + billingPort;

  const app = {
    id: 'cc-test', name: 'CC Test', real: false,
    command: ['node', '/bin/true'], // 不真实 spawn
    upstream: 'http://127.0.0.1:0',
    quota: { type: 'commandcode-billing', apiBase: billingBase, creditsPath: '/alpha/billing/credits', windowMap: { rolling: 'fiveHour', weekly: 'weekly' }, monthlyCapUsd: 10 },
  };

  // 独立测试区（互不干扰）
  async function mkProvider(id) {
    const p = new ProxyProvider({ id, name: id, kind: 'proxy', proxyAppId: 'cc-test', app, logger: log, events: null, dist: null, onPersist: () => {} });
    p.activated = true;
    return p;
  }
  async function addAcc(p, key) {
    const inst = await p.ensureInstance(key); // 只建对象不 spawn
    const acc = { key, keyId: inst.keyId, maskedKey: '...' + key.slice(-6), status: 'ready', quota: null, registeredAt: Date.now() };
    p.accounts.push(acc);
    p.instances.push(inst);
    return { p, inst, acc };
  }

  // ═══ 修复 A：429 body ISO 精确恢复点 ═══
  console.log('== 修复 A：markQuotaExhausted 用 429 body 的精确 ISO 恢复点（非默认 +5h）==');
  {
    const { p, inst, acc } = await addAcc(await mkProvider('pa'), 'sk-freeze-a');
    // 模拟一次带 CC 429 body 的 window 冻结（bodyResetMs 解析 "resets at <ISO>"）
    const bodyText = '{"error":{"message":"CC API 429: {\\"success\\":false,\\"error\\":{\\"code\\":\\"RATE_LIMITED\\",\\"status\\":429,\\"message\\":\\"You\\' + String.fromCharCode(39) + 've reached your 5-hour usage limit for your plan. Your limit resets at ' + new Date(Date.now() + 2 * 3600 * 1000).toISOString() + '. Please wait.\\"}}}"}}';
    const { classifyUpstreamLimited, bodyResetMs, headerRetryMs } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base'));
    // 断言分类 window + 解析到 ~2h（修复 A 核心：bodyResetMs 能读 ISO 绝对时间）
    const sig = classifyUpstreamLimited(429, bodyText);
    check('A1 429 CC body → signal=window', sig === 'window', String(sig));
    const retryMs = bodyResetMs(bodyText);
    check('A2 bodyResetMs 解析 ISO 绝对时间 → ~2h', retryMs > 1.9 * 3600 * 1000 && retryMs < 2.1 * 3600 * 1000, String(retryMs / 28060) + 'min');
    // 冻结：传 retryMs 给 markQuotaExhausted（等价 reactToFailure effect 路径）
    p.markQuotaExhausted(acc, headerRetryMs({}) || retryMs);
    check('A3 冻结 nextResetAt ≈ now+2h（精确恢复点，非 +5h 默认）', acc.nextResetAt && acc.nextResetAt > Date.now() + 1.8 * 3600 * 1000 && acc.nextResetAt < Date.now() + 2.2 * 3600 * 1000,
      'nextResetAt=' + new Date(acc.nextResetAt).toISOString() + ' now=' + new Date().toISOString());
    check('A4 冻结状态 frozen + limit.window', acc.status === 'frozen' && acc.limit && acc.limit.kind === 'window', acc.status + '/' + (acc.limit && acc.limit.kind));
    // 等 A 组自己的补探测定时器完成再清理（防跨组定时器交错污染计数）
    await new Promise((r) => setTimeout(r, 450));
    billingHits = 0;
  }

  // ═══ 修复 B：冻结后自动补探测刷新 quota ═══
  console.log('== 修复 B：429/400 冻结后 _probeAfterResponseFreeze 自动补探测（quota 不再 stale）==');
  {
    const { p, inst, acc } = await addAcc(await mkProvider('pb'), 'sk-freeze-b');
    const hitsBefore = billingHits;
    // 冻结（走 markQuotaExhausted 覆写 → 触发 _probeAfterResponseFreeze 的 300ms 定时补探测）
    p.markQuotaExhausted(acc, 5 * 3600 * 1000);
    check('B1 冻结后 300ms 定时补探测已排定（等 800ms）', true);
    await new Promise((r) => setTimeout(r, 800));
    // 补探测应命中 billing server（detectInstanceQuota 直连 mock）
    check('B2 补探测已访问 billing server（冻结后 quota 不再 stale）', billingHits > hitsBefore, 'hits ' + hitsBefore + '→' + billingHits);
    // quota 应刷新为真实超限（fiveHour exceeded → mapW percent 100 / rate-limited）
      const q = acc.quota || inst.quota || null;
    const rl = q && q.rolling;
    check('B3 补探测后 rolling = 100%/rate-limited（真实超限，非 stale 百分比）', !!rl && rl.status === 'rate-limited' && rl.percent === 100, JSON.stringify(rl));
    // 冻结恢复点应被 applyDetection 收敛到 billing 的精确 resetAt
    check('B4 补探测后 nextResetAt = billing resetAt（官方精确）', acc.nextResetAt && Math.abs(acc.nextResetAt - new Date(billingState.fiveHour.resetAt).getTime()) < 2000, String(acc.nextResetAt));
    // 等 B 组残留定时器全部排空（B 的 mark 排了定时器 + reconcileNow 异步）
    await new Promise((r) => setTimeout(r, 450));
    billingHits = 0;
  }

  // ═══ 修复 B 自愈：billing 显示未超限 → 冻结误判自动解冻 ═══
  console.log('== 修复 B 自愈：补探测发现未超限 → applyDetection 自动解冻 ==');
  {
    const { p, inst, acc } = await addAcc(await mkProvider('pc'), 'sk-freeze-c');
    // 先制造一次真实超限冻结，再让 billing 变健康
    billingState = { limited: false, exceeded: null, fiveHour: { used: 0.5, cap: 3, exceeded: false, resetAt: new Date(Date.now() + 3600 * 1000).toISOString() }, weekly: { used: 1, cap: 6, exceeded: false, resetAt: null } };
    // 冻结后 300ms 补探测会读到「健康」billing → applyDetection 解冻回 ready
    const hitsC = billingHits;
    p.markQuotaExhausted(acc, 5 * 3600 * 1000);
    // 轮询等待补探测完成（最多 3s）：避免固定 800ms 与跨组定时器竞态
    for (let w = 0; w < 30 && billingHits === hitsC; w++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300)); // 让 applyDetection 落定
    check('C1 billing 恢复健康 → 补探测自动解冻 ready', acc.status === 'ready', 'status=' + acc.status);
    check('C2 解冻后 limit 清空', !acc.limit, JSON.stringify(acc.limit));
    check('C3 解冻后 quota 刷新为健康（rolling 未满）', acc.quota && acc.quota.rolling && acc.quota.rolling.status === 'ok', JSON.stringify(acc.quota && acc.quota.rolling));
  }

  billing.close();
  const failed = results.filter((r) => !r).length;
  console.log('==============================');
  console.log('结果: ' + results.length + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e && e.stack || e); process.exit(1); });
