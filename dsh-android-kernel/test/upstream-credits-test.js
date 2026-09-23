#!/usr/bin/env node
'use strict';

// 上游 credits 余额不足 → 切换（2026-09 修复）回归：
//  - classifyUpstreamLimited：400/402/429/403 中 insufficient credits/billing/balance 识别为 'credits'（窗口词为 'window'，其余 'none'）
//  - ProviderBase.markCreditsExhausted：冻结 + 周期重探（充值后自动恢复语义）
//  - credits-low 账号被 isAccountUsable 排除（不参与挑选）
// 自包含，不触碰真实 daemon/账号/上游。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { ProviderBase, classifyUpstreamLimited, isQuotaCreditsLow, quotaOverallStatus } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base'));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : '')); }
}

async function main() {
  console.log('== 上游限制分类 classifyUpstreamLimited ==');
  // 实据（2026-09-04 核验，非臆测）：
  // - Command /alpha/generate 原始错误体：{"success":false,"error":{"code":"BAD_REQUEST","status":400,
  //   "message":"You have insufficient credits to make this request. Please purchase more credits…"}}
  // - commandcode-api-proxy 将其包为 OpenAI 信封 type:"proxy_error"，message="CC API 400: <raw>"，
  //   且代理层只对 5xx/429 做内部重试（upstream.ts retryable = status>=500||429）——400 余额不足不重试，
  //   必须由路由层换号。
  check('真实样本：CC 400 success=false error.code=BAD_REQUEST → credits',
    classifyUpstreamLimited(400, '{"success":false,"error":{"code":"BAD_REQUEST","status":400,"message":"You have insufficient credits to make this request. Please purchase more credits to continue using the service.","docs":"https://commandcode.ai/docs/reference/errors/bad_request"}}') === 'credits');
  check('真实样本：commandcode-api-proxy 信封(CC API 400 内嵌原体) → credits',
    classifyUpstreamLimited(400, '{"error":{"message":"CC API 400: {\"success\":false,\"error\":{\"code\":\"BAD_REQUEST\",\"status\":400,\"message\":\"You have insufficient credits to make this request. Please purchase more credits.\"}}","type":"proxy_error"}}') === 'credits');
  check('400 insufficient credits → credits', classifyUpstreamLimited(400, '{"error":{"code":"BAD_REQUEST","message":"You have insufficient credits to make this request."}}') === 'credits');
  check('400 大写/变体 insufficient balance → credits', classifyUpstreamLimited(400, 'insufficient balance, please top up') === 'credits');
  check('400 无 credits 关键词（上下文过长等业务拒绝）→ none', classifyUpstreamLimited(400, '{"error":"context length exceeded"}') === 'none');
  check('402 任意 → credits', classifyUpstreamLimited(402, 'payment required') === 'credits');
  check('429 quota 窗口词 → window', classifyUpstreamLimited(429, '{"error":{"message":"monthly limit exceeded"}}') === 'window');
  check('429 billing/credits 词优先 → credits', classifyUpstreamLimited(429, 'billing error: insufficient credits') === 'credits');
  check('403 无词 → banned（401/403 无配额信息=封号语义）', classifyUpstreamLimited(403, 'forbidden') === 'banned');
  check('429 无词 → none（不误判为限额）', classifyUpstreamLimited(429, 'rate limited, retry later') === 'none');
  check('503 → transient（不冻结）', classifyUpstreamLimited(503, 'service unavailable') === 'transient');
  check('401 → banned', classifyUpstreamLimited(401, 'invalid api key') === 'banned');
  check('200 → none', classifyUpstreamLimited(200, 'ok') === 'none');
  check('500 平台错 → transient', classifyUpstreamLimited(500, 'internal error') === 'transient');

  console.log('== ProviderBase.markCreditsExhausted（冻结 + 周期重探）==');
  {
    let persisted = 0;
    const p = new ProviderBase({ id: 't', name: 'T', kind: 'direct', onPersist: () => { persisted += 1; } });
    const acc = { key: 'k1', keyId: 'k1', status: 'ready', maskedKey: '...k1', quota: { monthlyRemaining: 0 } };
    p.accounts.push(acc);
    p.markCreditsExhausted(acc);
    check('冻结为 frozen', acc.status === 'frozen', acc.status);
    check('带周期重探 nextResetAt(≈10min)', acc.nextResetAt && acc.nextResetAt - Date.now() > 9 * 60 * 1000 && acc.nextResetAt - Date.now() <= 10 * 60 * 1000, acc.nextResetAt ? acc.nextResetAt - Date.now() : null);
    check('detectError 说明（统一额度用尽文案，含恢复语义）', String(acc.detectError).includes('额度用尽'), acc.detectError);
    check('credits 语义由 limit.kind 表达（不再靠文案 credits 字样）', acc.limit && acc.limit.kind === 'credits', JSON.stringify(acc.limit));
    check('触发持久化', persisted > 0, persisted);
    check('冻结后不再可用（不可挑选）', p.isAccountUsable(acc) === false);
  }

  console.log('== credits-low 在 isAccountUsable 中排除（检测到低余额即使 ready 也不选）==');
  {
    const p = new ProviderBase({ id: 't2', name: 'T2', kind: 'direct' });
    p._isCreditsLow = (a) => !!(a.quota && ((typeof a.quota.monthlyRemaining === 'number' && a.quota.monthlyRemaining <= 0) || (a.quota.credits && a.quota.credits.belowThreshold === true)));
    const acc = { key: 'k2', keyId: 'k2', status: 'ready', maskedKey: '...k2', quota: { rolling: { status: 'ok', percent: 10 }, weekly: { status: 'ok', percent: 10 }, monthly: null, monthlyRemaining: 0, credits: { monthlyCredits: 0, belowThreshold: false } } };
    check('余额=0 → 不可用（真实采样：0 余额会被上游拒付）', p.isAccountUsable(acc) === false);
    acc.quota.monthlyRemaining = 5; acc.quota.credits = { monthlyCredits: 5, belowThreshold: false };
    check('充值后余额>0 → 恢复可用', p.isAccountUsable(acc) === true);
    acc.quota.credits = { monthlyCredits: 5, belowThreshold: true };
    check('belowThreshold=true（官方低余额提醒）→ 不可用', p.isAccountUsable(acc) === false);
  }

  console.log('== M2：limit.kind + recovery 一等化 ==');
  {
    const p = new ProviderBase({ id: 't3', name: 'T3', kind: 'direct' });
    const acc = { key: 'kq', keyId: 'kq', status: 'ready', maskedKey: '...kq', quota: { rolling: { status: 'ok', percent: 1 }, weekly: { status: 'ok', percent: 1 } } };
    p.markQuotaExhausted(acc, 7200000);
    check('markQuota → limit.kind=window', acc.limit && acc.limit.kind === 'window', acc.limit);
    check('window recovery.at=nextResetAt', acc.limit && acc.limit.recovery && acc.limit.recovery.type === 'at' && acc.limit.recovery.at === acc.nextResetAt, acc.limit && acc.limit.recovery);
    const ab = { key: 'kb', keyId: 'kb', status: 'ready', maskedKey: '...kb' };
    p.markBanned(ab, '401');
    check('markBanned → limit.kind=banned + manual', ab.limit && ab.limit.kind === 'banned' && ab.limit.recovery && ab.limit.recovery.type === 'manual', ab.limit);
    const ac = { key: 'kc2', keyId: 'kc2', status: 'ready', maskedKey: '...kc2', quota: { monthlyRemaining: 0, credits: { monthlyCredits: 0, belowThreshold: false } } };
    p._isCreditsLow = (a) => !!(a.quota && ((typeof a.quota.monthlyRemaining === 'number' && a.quota.monthlyRemaining <= 0) || (a.quota.credits && a.quota.credits.belowThreshold === true)));
    p.markCreditsExhausted(ac);
    check('markCredits → limit.kind=credits + poll', ac.limit && ac.limit.kind === 'credits' && ac.limit.recovery && ac.limit.recovery.type === 'poll', ac.limit);
  }
  {
    const p = new ProviderBase({ id: 't4', name: 'T4', kind: 'direct' });
    const acc = { key: 'kc', keyId: 'kc', status: 'frozen', maskedKey: '...kc', quota: { monthlyRemaining: 0 }, detectError: 'credits 余额不足（充值后自动恢复）', nextResetAt: Date.now() + 1000 };
    check('旧 frozen+credits 数据 _ensureLimit 归一为 credits/poll', (p._ensureLimit(acc) || {}).kind === 'credits' && p._ensureLimit(acc).recovery.type === 'poll', p._ensureLimit(acc));
    p._isCreditsLow = (a) => !!(a.quota && typeof a.quota.monthlyRemaining === 'number' && a.quota.monthlyRemaining <= 0);
    acc.quota.monthlyRemaining = 6;
    acc.status = 'frozen'; acc.limit = null; acc.nextResetAt = Date.now() - 1000;
    p.applyDetection(acc, { ok: true, quota: { rolling: { status: 'ok', percent: 1 }, weekly: { status: 'ok', percent: 1 }, monthlyRemaining: 6 } });
    check('余额恢复 → 解冻 ready', acc.status === 'ready', acc.status);
    check('余额恢复 → limit 清空', !acc.limit || !acc.limit.kind, acc.limit);
    acc.status = 'ready'; acc.limit = null; acc.nextResetAt = null; acc.quota.monthlyRemaining = 0;
    p.applyDetection(acc, { ok: true, quota: { rolling: { status: 'ok', percent: 1 }, weekly: { status: 'ok', percent: 1 }, monthlyRemaining: 0 } });
    check('仍余额不足 → 保持 frozen', acc.status === 'frozen', acc.status);
    check('仍余额不足 → limit.kind=credits poll', acc.limit && acc.limit.kind === 'credits' && acc.limit.recovery.type === 'poll', acc.limit);
    check('credits poll 调度 ≈+10min', acc.nextResetAt && acc.nextResetAt - Date.now() > 9 * 60 * 1000 && acc.nextResetAt - Date.now() <= 10 * 60 * 1000);
  }
  {
    const p = new ProviderBase({ id: 't5', name: 'T5', kind: 'direct' });
    const acc = { key: 'kw', keyId: 'kw', status: 'frozen', maskedKey: '...kw', nextResetAt: Date.now() - 1000, quota: { monthly: { status: 'rate-limited', percent: 100, resetsAt: Date.now() + 3000 } } };
    p.applyDetection(acc, { ok: true, quota: acc.quota });
    check('window 仍满 → limit.kind=window recovery.at', acc.limit && acc.limit.kind === 'window' && acc.limit.recovery.type === 'at', acc.limit);
  }

  console.log('== 月度重置：quota.monthlyResetAt（订阅 currentPeriodEnd）→ recovery.at 定点调度 ==');
  {
    const p = new ProviderBase({ id: 't6', name: 'T6', kind: 'direct', onPersist: () => {} });
    const at = Date.now() + 20 * 24 * 3600 * 1000;
    const acc = { key: 'km', keyId: 'km', status: 'ready', maskedKey: '...km', quota: { monthlyCredits: 0, monthlyRemaining: 0, monthlyResetAt: at } };
    p.accounts.push(acc);
    p.markCreditsExhausted(acc);
    check('monthlyResetAt 已知 → limit.kind=credits + recovery.at 精确点', acc.limit && acc.limit.kind === 'credits' && acc.limit.recovery && acc.limit.recovery.type === 'at' && acc.limit.recovery.at === at, acc.limit && acc.limit.recovery);
    check('at 调度 → nextResetAt=monthlyResetAt（不再 +10min 轮询）', acc.nextResetAt === at, acc.nextResetAt ? String(acc.nextResetAt - Date.now()) : 'null');
    check('detectError 含预计重置时间', String(acc.detectError).includes('自动恢复') && String(acc.detectError).includes(String(new Date(at).getFullYear())), acc.detectError);
    check('月额度 0 仍排除挑选', p.isAccountUsable(acc) === false);
  }
  {
    const p = new ProviderBase({ id: 't7', name: 'T7', kind: 'direct', onPersist: () => {} });
    const stale = Date.now() - 3600000; // 陈旧 periodEnd（已过期）不得当精确恢复点
    const acc = { key: 'ks', keyId: 'ks', status: 'frozen', maskedKey: '...ks', quota: { monthlyCredits: 0, monthlyRemaining: 0, monthlyResetAt: stale }, detectError: 'credits 余额不足（充值后自动恢复）', nextResetAt: Date.now() - 1000 };
    p._isCreditsLow = (a) => !!(a.quota && typeof a.quota.monthlyRemaining === 'number' && a.quota.monthlyRemaining <= 0);
    p.applyDetection(acc, { ok: true, quota: { rolling: { status: 'ok', percent: 1 }, weekly: { status: 'ok', percent: 1 }, monthlyRemaining: 0, monthlyResetAt: stale } });
    check('过期 monthlyResetAt → 回退 credits/poll（不赌不可靠恢复点）', acc.limit && acc.limit.kind === 'credits' && acc.limit.recovery && acc.limit.recovery.type === 'poll', acc.limit);
  }
  {
    const p = new ProviderBase({ id: 't8', name: 'T8', kind: 'direct', onPersist: () => {} });
    const at = Date.now() + 30 * 24 * 3600 * 1000;
    const acc = { key: 'ka', keyId: 'ka', status: 'frozen', maskedKey: '...ka', quota: { monthlyCredits: 0 }, detectError: 'credits 余额不足', nextResetAt: Date.now() - 1000 };
    p._isCreditsLow = (a) => !!(a.quota && typeof a.quota.monthlyCredits === 'number' && a.quota.monthlyCredits <= 0);
    p.applyDetection(acc, { ok: true, quota: { rolling: { status: 'ok', percent: 1 }, weekly: { status: 'ok', percent: 1 }, monthlyCredits: 0, monthlyResetAt: at } });
    check('applyDetection 带 monthlyResetAt → recovery.at + nextResetAt=at', acc.limit && acc.limit.kind === 'credits' && acc.limit.recovery.type === 'at' && acc.limit.recovery.at === at && acc.nextResetAt === at, JSON.stringify(acc.limit));
    check('applyDetection at 原因含预计重置时间', String(acc.detectError).includes('自动恢复'), acc.detectError);
  }
  {
    const p = new ProviderBase({ id: 't9', name: 'T9', kind: 'direct', onPersist: () => {} });
    const acc = { key: 'ka2', keyId: 'ka2', status: 'frozen', maskedKey: '...ka2', quota: { monthlyCredits: 0 }, detectError: 'credits 余额不足', nextResetAt: Date.now() - 1000 };
    p._isCreditsLow = (a) => !!(a.quota && typeof a.quota.monthlyCredits === 'number' && a.quota.monthlyCredits <= 0);
    p.applyDetection(acc, { ok: true, quota: { rolling: { status: 'ok', percent: 1 }, weekly: { status: 'ok', percent: 1 }, monthlyCredits: 0 } });
    check('无 monthlyResetAt → applyDetection 保持 credits/poll', acc.limit && acc.limit.kind === 'credits' && acc.limit.recovery.type === 'poll', acc.limit);
  }

  console.log('== 自动取证：reactToFailure 对上游 >=400 响应经 onEvidence 落证据 ==');
  {
    const { SwitchEngine } = require(path.join(ROOT, 'src', 'domains', 'router', 'switch'));
    const evidences = [];
    const se = new SwitchEngine({ logger: { info(){} }, onEvidence: (r) => evidences.push(r) });
    const effects = [];
    const prov = {
      id: 'prov-x', name: 'ProviderX',
      classifyResponse: (status, headers, text) => classifyUpstreamLimited(status, text),
      effect: (sig, acc) => { effects.push(sig + ':' + acc.maskedKey); },
    };
    const acc = { maskedKey: '...k9' };
    // 真实样本：CC 400 insufficient credits 原体（见本文件头部实据）
    const ccBody = '{"success":false,"error":{"code":"BAD_REQUEST","status":400,"message":"You have insufficient credits to make this request. Please purchase more credits to continue using the service."}}';
    const r1 = se.reactToFailure(prov, acc, { status: 400, headers: { 'Retry-After': '60', 'set-cookie': ['x=1'], authorization: 'Bearer sk-xxx' }, body: ccBody, attempt: 0, attempts: 3, method: 'POST', path: '/v1/chat/completions' });
    check('credits 400 → action=retry', r1 && r1.action === 'retry' && r1.signal === 'credits', JSON.stringify(r1));
    check('effect 已执行（credits）', effects.length === 1 && effects[0] === 'credits:...k9', String(effects));
    const ev1 = evidences.find((e) => e.status === 400 && e.signal === 'credits');
    check('证据：400 credits + action/account/method/path/attempt', !!ev1 && ev1.action === 'retry' && ev1.account === '...k9' && ev1.method === 'POST' && ev1.path === '/v1/chat/completions' && ev1.attempt === 0 && ev1.attempts === 3 && ev1.providerId === 'prov-x', JSON.stringify(ev1));
    check('证据：白名单头（Retry-After 大小写归一）、剔除敏感头', !!ev1 && ev1.headers && ev1.headers['retry-after'] === '60' && ev1.headers.authorization === undefined && ev1.headers['set-cookie'] === undefined, JSON.stringify(ev1 && ev1.headers));
    check('证据体有界且含错误原文', !!ev1 && typeof ev1.body === 'string' && ev1.body.includes('insufficient credits'), ev1 && ev1.body && ev1.body.slice(0, 100));
    const r2 = se.reactToFailure(prov, acc, { status: 503, body: 'service unavailable', attempt: 0, attempts: 3 });
    check('503 transient → retry + 证据带 transient 标记', r2 && r2.action === 'retry' && r2.transient === true && evidences.some((e) => e.status === 503 && e.signal === 'transient' && e.transient === true), JSON.stringify(r2));
    const r3 = se.reactToFailure(prov, acc, { status: 403, body: 'forbidden', attempt: 1, attempts: 3 });
    check('403 无词 banned → passthrough + 证据', r3 && r3.action === 'passthrough' && evidences.some((e) => e.status === 403 && e.signal === 'banned' && e.action === 'passthrough'), JSON.stringify(r3));
    const r4 = se.reactToFailure(prov, acc, { status: 400, body: '{"error":"context length exceeded"}', attempt: 2, attempts: 3 });
    check('400 无词 none → passthrough 不误切，也有证据（可核对“不切”合理）', r4 && r4.action === 'passthrough' && r4.signal === 'none' && evidences.some((e) => e.status === 400 && e.signal === 'none'), JSON.stringify(r4));
    const before = evidences.length;
    se.reactToFailure(prov, acc, { status: 200, body: 'ok' });
    check('2xx 不产生证据（仅上游拒绝/限额类）', evidences.length === before, String(evidences.length - before));
  }

  console.log('== bodyResetMs/headerRetryMs：ISO 绝对重置时间解析（2026-09-05 修复，Command 实测格式）==');
  {
    const { bodyResetMs, headerRetryMs } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base'));
    // CC 429 真实样本：body 用绝对 ISO 时间而非 "resets in N min"（动态未来 2h，防时间流逝致测试失效）
    const isoStr = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const cc429 = '{"error":{"message":"CC API 429: {\\"success\\":false,\\"error\\":{\\"code\\":\\"RATE_LIMITED\\",\\"status\\":429,\\"message\\":\\"You' + String.fromCharCode(39) + 've reached your 5-hour usage limit for your plan. Your limit resets at ' + isoStr + '. Please wait for the window to reset or upgrade your plan to continue.\\"}}}}';
    const isoMs = bodyResetMs(cc429);
    const expectMs = new Date(isoStr).getTime() - Date.now();
    check('bodyResetMs 解析 "resets at <ISO>" → 精确到绝对时刻的剩余 ms', isoMs > 0 && Math.abs(isoMs - expectMs) < 2000, isoMs + ' vs ' + expectMs);
    check('bodyResetMs 相对时长 "resets in 5 min" → 300000', bodyResetMs('resets in 5 min') === 300000, String(bodyResetMs('resets in 5 min')));
    check('bodyResetMs 相对时长 "retry in 30 sec" → 30000', bodyResetMs('retry in 30 sec') === 30000, String(bodyResetMs('retry in 30 sec')));
    check('bodyResetMs 无时间信息 → 0（上层走默认 +5h）', bodyResetMs('some other error') === 0, String(bodyResetMs('some other error')));
    check('headerRetryMs Retry-After 秒数 → n*1000', headerRetryMs({ 'retry-after': '120' }) === 120000, String(headerRetryMs({ 'retry-after': '120' })));
    const httpDate = new Date(Date.now() + 90 * 1000).toUTCString();
    const hd = headerRetryMs({ 'retry-after': httpDate });
    check('headerRetryMs HTTP-date 绝对时刻 → 剩余 ms（≈90s）', hd > 80000 && hd < 100000, String(hd));
    check('headerRetryMs 无头 → 0', headerRetryMs({}) === 0, String(headerRetryMs({})));
  }

  console.log('== 新账号入库判定：检测后如实列示（2026-09 用户定稿）==');
  {
    const p = new ProviderBase({ id: 'ta', name: 'TA', kind: 'direct' });
    p._isCreditsLow = (a) => !!(a.quota && (typeof a.quota.monthlyCredits === 'number' && a.quota.monthlyCredits <= 0));
    p.detectAccount = async () => ({ ok: true, quota: { rolling: { status: 'ok', percent: 10 }, weekly: { status: 'ok', percent: 10 }, monthlyCredits: 0, credits: { monthlyCredits: 0, belowThreshold: false } } });
    const r = await p.addAccount('nk-credits0');
    check('月额度用尽新账号：检测后入库为 frozen（不再 ready/review/discard）', r.ok && r.account && r.account.status === 'frozen', JSON.stringify(r && r.account && r.account.status));
    check('返回 limited=credits 标识（前端可提示）', r.limited === 'credits' && r.review === false, JSON.stringify({ limited: r.limited, review: r.review }));
    check('limit.kind=credits + poll（无订阅期 → 轮询兜底）', r.account.limit && r.account.limit.kind === 'credits' && r.account.limit.recovery && r.account.limit.recovery.type === 'poll', JSON.stringify(r.account.limit));
    check('冻结后不参与挑选', p.isAccountUsable(r.account) === false);
  }
  {
    const p = new ProviderBase({ id: 'tb', name: 'TB', kind: 'direct' });
    const at = Date.now() + 25 * 24 * 3600 * 1000;
    p._isCreditsLow = (a) => !!(a.quota && (typeof a.quota.monthlyCredits === 'number' && a.quota.monthlyCredits <= 0));
    p.detectAccount = async () => ({ ok: true, quota: { rolling: { status: 'ok', percent: 5 }, weekly: { status: 'ok', percent: 5 }, monthlyCredits: 0, monthlyResetAt: at, credits: { monthlyCredits: 0, belowThreshold: false } } });
    const r = await p.addAccount('nk-credits-at');
    check('有订阅 periodEnd → 入库 frozen + recovery.at 定点（预计重置自动解冻）', r.ok && r.account.status === 'frozen' && r.account.limit && r.account.limit.kind === 'credits' && r.account.limit.recovery.type === 'at' && r.account.limit.recovery.at === at && r.account.nextResetAt === at, JSON.stringify(r.account.limit));
    check('detectError 含预计重置时间', String(r.account.detectError).includes('自动恢复'), r.account.detectError);
  }
  {
    const p = new ProviderBase({ id: 'tc', name: 'TC', kind: 'direct' });
    const weeklyResetAt = Date.now() + 3600000;
    p.detectAccount = async () => ({ ok: true, quota: { rolling: { status: 'ok', percent: 30 }, weekly: { status: 'rate-limited', percent: 100, resetsAt: weeklyResetAt }, monthly: null } });
    const r = await p.addAccount('nk-windowfull');
    check('窗口满新账号：直接 frozen + window 冻结（不再 review 人工闸门）', r.ok && r.account.status === 'frozen' && r.limited === 'window' && r.review === false, JSON.stringify({ status: r.account && r.account.status, limited: r.limited, review: r.review }));
    check('窗口满：limit.kind=window + recovery.at=周窗口 resetsAt（到点自动解冻）', r.account.limit && r.account.limit.kind === 'window' && r.account.limit.recovery && r.account.limit.recovery.type === 'at' && r.account.limit.recovery.at === weeklyResetAt && r.account.nextResetAt === weeklyResetAt, JSON.stringify(r.account.limit));
    check('窗口满冻结后不参与挑选（自动等待恢复，不占选号）', p.isAccountUsable(r.account) === false);
  }
  {
    // 运行中账号窗口满（applyDetection 路径）与添加时窗口满完全同机（防两套待遇回归）
    const p = new ProviderBase({ id: 'tc2', name: 'TC2', kind: 'direct' });
    const weeklyResetAt = Date.now() + 7200000;
    const acc = { key: 'kw2', keyId: 'kw2', status: 'ready', maskedKey: '...kw2', quota: { rolling: { status: 'ok', percent: 10 }, weekly: { status: 'ok', percent: 90 }, monthly: null } };
    p.accounts.push(acc);
    p.applyDetection(acc, { ok: true, quota: { rolling: { status: 'ok', percent: 10 }, weekly: { status: 'rate-limited', percent: 100, resetsAt: weeklyResetAt }, monthly: null } });
    check('运行中窗口满（探测判定）：frozen + window/at 与添加时同一处置', acc.status === 'frozen' && acc.limit && acc.limit.kind === 'window' && acc.limit.recovery.type === 'at' && acc.limit.recovery.at === weeklyResetAt, JSON.stringify(acc.limit));
  }
  {
    const p = new ProviderBase({ id: 'td', name: 'TD', kind: 'direct' });
    p.detectAccount = async () => ({ ok: true, quota: { rolling: { status: 'ok', percent: 30 }, weekly: { status: 'ok', percent: 40 }, monthly: null } });
    const r = await p.addAccount('nk-ready');
    check('额度正常新账号 → ready 直接入池', r.ok && r.review === false && r.account.status === 'ready', JSON.stringify(r.account && r.account.status));
  }

  console.log('== 配额总览标签/credits 判定单源（2026-09 债务清理：修复 proxy/index 两处实现分叉）==');
  {
    check('credits0 + 周满 → 额度用尽（credits 优先）', quotaOverallStatus({ rolling: { status: 'ok', percent: 10 }, weekly: { status: 'rate-limited', percent: 100 }, monthly: null, monthlyCredits: 0, monthlyRemaining: 0, credits: { monthlyCredits: 0, belowThreshold: false } }) === '额度用尽');
    // 漂移回归：旧 index.js 视图对「无月窗口 + 5h/周同满」返回 周限额，与 proxy 端 用尽 不一致
    check('周+5h 同满（无月窗口）→ 用尽（视图与检测同源）', quotaOverallStatus({ rolling: { status: 'rate-limited', percent: 100 }, weekly: { status: 'rate-limited', percent: 100 }, monthly: null }) === '用尽', quotaOverallStatus({ rolling: { status: 'rate-limited', percent: 100 }, weekly: { status: 'rate-limited', percent: 100 }, monthly: null }));
    check('仅周满 → 周限额', quotaOverallStatus({ rolling: { status: 'ok', percent: 30 }, weekly: { status: 'rate-limited', percent: 100 }, monthly: null }) === '周限额');
    check('仅 5h 满 → 5h限额', quotaOverallStatus({ rolling: { status: 'rate-limited', percent: 100 }, weekly: { status: 'ok', percent: 30 }, monthly: null }) === '5h限额');
    check('月窗口满 → 用尽', quotaOverallStatus({ rolling: { status: 'ok', percent: 10 }, weekly: { status: 'ok', percent: 20 }, monthly: { status: 'rate-limited', percent: 100 } }) === '用尽');
    check('正常 → 正常 / null → 正常', quotaOverallStatus({ rolling: { status: 'ok', percent: 10 }, weekly: { status: 'ok', percent: 20 }, monthly: null }) === '正常' && quotaOverallStatus(null) === '正常');
    check('isQuotaCreditsLow：mr=0 true / belowThreshold true / 无 credits 信息 false', isQuotaCreditsLow({ monthlyRemaining: 0 }) === true && isQuotaCreditsLow({ credits: { monthlyCredits: 5, belowThreshold: true } }) === true && isQuotaCreditsLow({ weekly: { status: 'ok', percent: 10 } }) === false && isQuotaCreditsLow(null) === false);
  }

  console.log('== applyDetection 收敛修复（2026-09 二次）：过期 nextResetAt 采纳新精确值 / credits at 不降级）==');
  {
    // Bug1: window 分支——既有 nextResetAt 已过期(01:58)但真实 resetsAt 在 6 天后 → 必须采纳新精确值，
    // 否则永久卡过期值 → 每 5min 临近探测死循环
    const p = new ProviderBase({ id: 'tb1', name: 'TB1', kind: 'direct' });
    const realReset = Date.now() + 6 * 24 * 3600 * 1000;
    const acc = { key: 'kw-stale', keyId: 'kw-stale', status: 'frozen', maskedKey: '...kw-stale', quota: { rolling: { status: 'ok', percent: 10 }, weekly: { status: 'rate-limited', percent: 100, resetsAt: realReset }, monthly: null }, nextResetAt: Date.now() - 2 * 3600 * 1000, limit: { kind: 'window', since: Date.now() - 86400000, recovery: { type: 'at', at: Date.now() - 2 * 3600 * 1000 } } };
    p.applyDetection(acc, { ok: true, quota: acc.quota });
    check('过期 nextResetAt → 采纳真实 resetsAt（不再卡死）', acc.nextResetAt === realReset && acc.limit.recovery.at === realReset, JSON.stringify({ next: acc.nextResetAt, limitAt: acc.limit.recovery.at }));
  }
  {
    // Bug2: credits 分支——单次探测未取到 monthlyResetAt（quota.monthlyResetAt=null）但既有 recovery.at 在未来 →
    // 保留 at，不降级 poll（否则每 5min 临近探测死循环）
    const p = new ProviderBase({ id: 'tb2', name: 'TB2', kind: 'direct' });
    const at = Date.now() + 20 * 24 * 3600 * 1000;
    const acc = { key: 'kc-at', keyId: 'kc-at', status: 'frozen', maskedKey: '...kc-at', quota: { monthlyCredits: 0, monthlyRemaining: 0 }, detectError: 'credits 余额不足', nextResetAt: at, limit: { kind: 'credits', since: Date.now() - 1000, recovery: { type: 'at', at } } };
    p._isCreditsLow = (a) => !!(a.quota && typeof a.quota.monthlyRemaining === 'number' && a.quota.monthlyRemaining <= 0);
    p.applyDetection(acc, { ok: true, quota: { rolling: { status: 'ok', percent: 1 }, weekly: { status: 'ok', percent: 1 }, monthlyCredits: 0, monthlyRemaining: 0 } });
    check('探测缺失 monthlyResetAt → 保留既有 recovery.at（不降级 poll）', acc.limit && acc.limit.kind === 'credits' && acc.limit.recovery.type === 'at' && acc.limit.recovery.at === at, JSON.stringify(acc.limit));
  }

  console.log('\n==============================');
  console.log('结果: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("ERR", e); process.exit(1); });
