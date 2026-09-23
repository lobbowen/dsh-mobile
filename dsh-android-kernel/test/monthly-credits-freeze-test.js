'use strict';

// 月额度冻结/解冻语义测试（2026-09 用户定稿）：
//  信号 = 权威：上游 400 insufficient credits → 冻结（月额度限额）——一步到位，无需阈值猜测；
//  解冻 = 只认正向证据：periodEnd 到期 或 余额较冻结时刻回升（充值）。
//  billing 面快照（percent 99/remaining>0）只刷新展示，【不得】推翻信号冻结——
//  修复前：冻结 300ms 后被补探测快照解冻 → 99% 账号 frozen/ready 秒级死循环（生产实测 1 分钟 4 轮）。
// 用法: node test/monthly-credits-freeze-test.js

const { ProviderBase } = require('../src/domains/router/providers/base');

class TestProvider extends ProviderBase {
  constructor() {
    super({ id: 't', name: 'T', kind: 'proxy' });
    this.instanceOf = () => null;
  }
  async detectAccount() { return { ok: true, quota: null }; }
}

async function main() {
  const p = new TestProvider();
  const acc = {
    key: 'k-test', keyId: 'key-882aae8a-r3t4', maskedKey: '...r3t4', status: 'ready',
    quota: {
      rolling: { status: 'ok', percent: 0 }, weekly: { status: 'ok', percent: 65 }, monthly: { status: 'ok', percent: 99 },
      monthlyRemaining: 0.067054828,
      credits: { monthlyCredits: 0.067054828, purchasedCredits: 0, freeCredits: 0, belowThreshold: false, creditThreshold: 0 },
    },
  };
  p.accounts.push(acc);

  let pass = 0, fail = 0;
  const check = (n, c, x) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + ' ← ' + (x || '')); } };

  // 场景 A：请求 400 insufficient credits → 冻结 + 基线
  p.markCreditsExhausted(acc);
  check('上游 credits 信号 → 冻结', acc.status === 'frozen' && acc.limit && acc.limit.kind === 'credits', acc.status);
  check('冻结记录余额基线（creditsAt）', typeof acc.limit.creditsAt === 'number' && Math.abs(acc.limit.creditsAt - 0.067054828) < 1e-9, String(acc.limit.creditsAt));

  // 场景 B：补探测返回同样的 99% 快照（月额度无实质变化）→ 维持冻结
  p.applyDetection(acc, { ok: true, quota: JSON.parse(JSON.stringify(acc.quota)) });
  check('快照未变化 → 维持冻结（修复前此处被解冻）', acc.status === 'frozen', acc.status);
  for (let i = 0; i < 5; i++) p.applyDetection(acc, { ok: true, quota: JSON.parse(JSON.stringify(acc.quota)) });
  check('连续快照 → 仍维持冻结', acc.status === 'frozen', acc.status);

  // 场景 C：余额回升（充值）→ 正向证据 → 解冻
  const refilled = JSON.parse(JSON.stringify(acc.quota));
  refilled.monthlyRemaining = 5.0; refilled.credits.monthlyCredits = 5.0; refilled.monthly = { status: 'ok', percent: 50 };
  p.applyDetection(acc, { ok: true, quota: refilled });
  check('余额实质回升（充值）→ 解冻 ready', acc.status === 'ready', acc.status);

  // 场景 D：periodEnd 到期 + 月度重置 → 正向证据 → 解冻
  p.markCreditsExhausted(acc);
  acc.quota.monthlyResetAt = Date.now() + 1000;
  acc.limit.recovery = { type: 'at', at: acc.quota.monthlyResetAt };
  acc.nextResetAt = acc.quota.monthlyResetAt;
  await new Promise((r) => setTimeout(r, 1100));
  const reset = JSON.parse(JSON.stringify(acc.quota));
  reset.monthlyRemaining = 10.0; reset.credits.monthlyCredits = 10.0; reset.monthly = { status: 'ok', percent: 0 };
  p.applyDetection(acc, { ok: true, quota: reset });
  check('periodEnd 到期 + 余额重置 → 解冻 ready', acc.status === 'ready', acc.status);

  // 场景 E：旧数据兼容（无 creditsAt 基线的既有冻结）→ 只认证据 a)，无到期保持冻结
  const legacy = { key: 'k2', keyId: 'legacy', maskedKey: '...legacy', status: 'frozen', quota: { rolling: { status: 'ok', percent: 0 }, weekly: { status: 'ok', percent: 65 }, monthly: { status: 'ok', percent: 99 }, monthlyRemaining: 0.05, credits: { monthlyCredits: 0.05, purchasedCredits: 0, freeCredits: 0, belowThreshold: false, creditThreshold: 0 } } };
  p.accounts.push(legacy);
  legacy.limit = { kind: 'credits', since: Date.now(), reason: 'x', recovery: { type: 'poll', periodMs: 600000 } };
  legacy.nextResetAt = Date.now() + 3600e3;
  p.applyDetection(legacy, { ok: true, quota: JSON.parse(JSON.stringify(legacy.quota)) });
  check('无基线旧冻结 + 无到期 → 维持冻结（兼容）', legacy.status === 'frozen', legacy.status);

  // 场景 F：未进入灰区的正常账号不受影响
  const normal = { key: 'k3', keyId: 'normal', maskedKey: '...normal', status: 'ready', quota: { rolling: { status: 'ok', percent: 0 }, weekly: { status: 'ok', percent: 65 }, monthly: { status: 'ok', percent: 60 }, monthlyRemaining: 3.99, credits: { monthlyCredits: 3.99, purchasedCredits: 0, freeCredits: 0, belowThreshold: false, creditThreshold: 0 } } };
  p.accounts.push(normal);
  p.applyDetection(normal, { ok: true, quota: JSON.parse(JSON.stringify(normal.quota)) });
  check('60% 正常账号不受影响', normal.status === 'ready', normal.status);

  console.log('\n==============================');
  console.log('结果: ' + passed_str(pass, fail));
  process.exit(fail > 0 ? 1 : 0);
  function passed_str(p2, f2) { return p2 + ' passed, ' + f2 + ' failed'; }
}

main().catch((e) => { console.error('monthly-credits-freeze test error:', e); process.exit(1); });
