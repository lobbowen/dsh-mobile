'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 配额策略注册表（2026-09 用户定稿：两种标准模式 + 供应商按策略引用）
//
// 分层契约：
//   - 「模式」（运行形态，两类，代码在 providers/direct.js 与 providers/proxy.js）：
//        direct = 供应商给 OpenAI 兼容官方端点 + 多 Key，router 直连共享端点、按 Key 池轮换；
//        proxy  = 每账号一个独立本地实例（隔离沙箱式反代），router 走本地实例端口。
//     模式类只做生命周期/运输/状态机，**不携带任何供应商解析词**。
//   - 「配额策略」（本文件）：供应商「官方配额面 → 统一 quota 结构」的取数与解析。
//     供应商在注册表（proxy-apps.js / PROVIDER_PRESETS）里用 quota.type 声明引用哪个策略；
//     新供应商同形态 → 直接引用既有 type（注册条目即引用）；形态不同 → 新增一个策略函数注册，
//     模式类与其它策略零改动（未来策略可拆独立文件，注册点仍是本表）。
//
// 现有策略：
//   window-usage        —— usage 面（官方 /usage 或反代本地实例 /usagePath），
//                          解析 { rolling, weekly, monthly }（status/percent/resetsAt 归一）。
//                          percent 是否取整由调用方按历史行为决定（direct 原样 / proxy 本地取整）。
//                          alias：opencode-usage（历史直连 adapter id）、proxy-usage（历史本地 usage id）。
//   commandcode-billing —— Command Code 官方 billing 面：/alpha/billing/credits（窗口+credits 池）
//                          + /alpha/billing/subscriptions（月度重置 periodEnd，6h 缓存、仅受限账号取）。
//                          真实采样见运行期日志与事件流。
// 返回值约定：{ ok, quota }（quota 不含 overallStatus——展示措辞由模式层按统一语义填）。
// ═══════════════════════════════════════════════════════════════════════════

const { normalizeResetTs } = require('./base');

/** Command 默认 API 根（订阅面与 credits 面同主机）。 */
const DEFAULT_API_BASE = 'https://api.commandcode.ai';
/** 订阅信息端点：月度额度随订阅续期重置的精确时刻（data.currentPeriodEnd）。 */
const SUBSCRIPTIONS_PATH = '/alpha/billing/subscriptions';
/** 订阅信息重探周期（ms）：periodEnd 仅在续订/取消/变动时变化，低频即可（防高频 billing API 触发风控）。 */
const SUBSCRIPTION_REFETCH_MS = 6 * 3600 * 1000;
/** 月度重置调度可靠性上限：periodEnd 超过该时长视为不可靠（订阅异常），回退周期轮询。 */
const MONTHLY_RESET_MAX_AHEAD_MS = 45 * 24 * 3600 * 1000;

/** usage 面解析（窗口原样归一；percent 取整与否由调用方经 roundPercent 指定，兼容历史行为）。 */
async function detectWindowUsage(ctx) {
  const { url, key, timeout, roundPercent } = ctx || {};
  const init = { signal: AbortSignal.timeout(timeout || 12000) };
  if (key) init.headers = { Authorization: 'Bearer ' + key, Accept: 'application/json' };
  const res = await fetch(url, init);
  const j = res.ok ? await res.json() : null;
  if (!j) return { ok: false, error: '无法获取配额（HTTP ' + (res.status || '?') + '）' };
  const u = j.usage || j;
  const pick = (w) => (w && typeof w === 'object')
    ? {
        status: typeof w.status === 'string' ? w.status : null,
        percent: Number.isFinite(Number(w.percent)) ? (roundPercent ? Math.round(Number(w.percent)) : Number(w.percent)) : null,
        resetsAt: normalizeResetTs(w.resetsAt),
      }
    : null;
  return { ok: true, quota: { rolling: pick(u.rolling), weekly: pick(u.weekly), monthly: pick(u.monthly) } };
}

/** Command billing 面解析（真实采样校准，2026-09-04）：
 *  /alpha/billing/credits = { credits:{ monthlyCredits,purchasedCredits,freeCredits,belowThreshold,
 *    creditThreshold }, windowLimits:{ limited, exceeded, fiveHour:{used,cap,exceeded,resetAt}, weekly } }
 *  - 窗口耗尽只由 used/cap 推导（used>=cap→100%→rate-limited），不依赖 exceeded 标志（上游对
 *    100% 窗口可能不返 exceeded，旧实现存出 status:ok+percent:100 的矛盾记录）；
 *  - credits 原体无 period 字段；月度重置精确时刻只在 subscriptions data.currentPeriodEnd——
 *    仅 credits-limited 账号取订阅（其它账号零额外 API），ctx.cache._subCheckedAt 6h 缓存；
 *  - 非 limited 清空 monthlyResetAt（陈旧日期不残留）。
 *  ctx = { key, quota:q(app.quota), cache(inst：_subCheckedAt 打点), prevQuota(inst.quota：periodEnd 沿用) } */
async function detectCommandCodeBilling(ctx) {
  const q = (ctx && ctx.quota) || {};
  const key = (ctx && ctx.key) || '';
  const cache = (ctx && ctx.cache) || null;
  const base = (q.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  const res = await fetch(base + (q.creditsPath || '/alpha/billing/credits'), { signal: AbortSignal.timeout(5000), headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
  const j = res.ok ? await res.json() : null;
  // 信封兼容（2026-09 审计修复）：上游可能返回 { data: { credits, windowLimits } } 或直接平铺
  const body = (j && typeof j === 'object' && j.data && typeof j.data === 'object' && (j.data.windowLimits || j.data.credits)) ? j.data : j;
  if (!body || !body.windowLimits) return { ok: false, error: '无法获取配额' };
  const wl = body.windowLimits;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const mapW = (name) => {
    const w = name ? wl[name] : null;
    if (!w || typeof w !== 'object') return null;
    const cap = num(w.cap), used = num(w.used);
    let pct = null;
    if (cap !== null && used !== null && cap > 0 && used >= 0) pct = Math.min(100, Math.round((used / cap) * 100));
    else if (w.exceeded === true || w.exceeded === 1 || w.exceeded === 'true') pct = 100;
    if (pct === null) return null;
    return { status: pct >= 100 ? 'rate-limited' : 'ok', percent: pct, resetsAt: normalizeResetTs(w.resetAt) };
  };
  const wm = q.windowMap || {};
  const cr = body.credits || {};
  const monthlyRemaining = [cr.monthlyCredits, cr.purchasedCredits, cr.freeCredits]
    .reduce((s, v) => { const n = num(v); return n !== null && n >= 0 ? s + n : s; }, 0);
  const hasCredits = cr.monthlyCredits !== undefined || cr.purchasedCredits !== undefined || cr.freeCredits !== undefined || cr.belowThreshold !== undefined;
  // ── 月度重置（真实采样核验）：仅 credits-limited 取订阅；非 limited → 清空 monthlyResetAt ──
  // 月额度受限 = 数据面信号（原判定）∪ 冻结面信号（ctx.creditFrozen：上游 400 拒绝驱动的冻结——
  // 冻结期间必须持续掌握 periodEnd 以呈现/调度精确恢复时刻；余额灰区（>0 但不足服务）靠数据面永远测不到）
  const creditLow = (hasCredits && ((typeof cr.monthlyCredits === 'number' && cr.monthlyCredits <= 0)
    || cr.belowThreshold === true
    || (Number.isFinite(Number(monthlyRemaining)) && Number(monthlyRemaining) <= 0)))
    || (ctx && ctx.creditFrozen === true);
  const prevReset = (ctx && ctx.prevQuota && ctx.prevQuota.monthlyResetAt) || null;
  let monthlyResetAt = null;
  if (creditLow) {
    if (!cache || !cache._subCheckedAt || Date.now() - cache._subCheckedAt >= SUBSCRIPTION_REFETCH_MS) {
      if (cache) cache._subCheckedAt = Date.now(); // 先打点再取：失败也不逐轮轰炸上游
      try {
        const subRes = await fetch(base + (q.subscriptionsPath || SUBSCRIPTIONS_PATH), { signal: AbortSignal.timeout(5000), headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
        const sj = subRes.ok ? await subRes.json() : null;
        const sdata = (sj && typeof sj === 'object' && sj.data && typeof sj.data === 'object' && sj.data.currentPeriodEnd) ? sj.data : (sj || null);
        if (sdata && typeof sdata === 'object') {
          const end = normalizeResetTs(sdata.currentPeriodEnd);
          const unreliable = sdata.cancelAtPeriodEnd === true || sdata.status === 'canceled' || sdata.status === 'past_due' || sdata.status === 'unpaid';
          // 仅「活跃、未设取消、未来且不过远」的 periodEnd 才当精确恢复点，否则回退轮询
          if (end && !unreliable && end > Date.now() && end - Date.now() <= MONTHLY_RESET_MAX_AHEAD_MS) monthlyResetAt = end;
        }
      } catch { /* 订阅查询失败：本轮无 monthlyResetAt（回退轮询），不影响主额度流程 */ }
    } else {
      monthlyResetAt = prevReset; // 缓存期内沿用上次已知 periodEnd（不重复取）
    }
  }
  // 月度窗口推导（2026-09 用户纠正）：Command 订阅含月配额池（quota.monthlyCapUsd，如 $10/月）——
  // 周窗口从池内扣（实测 weekly.used + monthlyRemaining ≈ 月上限）。有 monthlyCapUsd 且 monthlyRemaining
  // 可数 → 推导 monthly = { percent: (cap - remaining)/cap, resetsAt: 月窗口重置（订阅 periodEnd） }，
  // 使前端每月格子显示真实百分比（曾长期 monthly=null → 前端 0%，实际月额度存在）。
  const monthlyCap = q.monthlyCapUsd ? num(q.monthlyCapUsd) : null;
  const derivedMonthly = (monthlyCap !== null && Number.isFinite(Number(monthlyRemaining)) && monthlyRemaining >= 0)
    ? (() => {
        const used = Math.min(monthlyCap, Math.max(0, monthlyCap - monthlyRemaining));
        const pct = monthlyCap > 0 ? Math.min(100, Math.round((used / monthlyCap) * 100)) : 0;
        return { status: pct >= 100 ? 'rate-limited' : 'ok', percent: pct, resetsAt: monthlyResetAt || undefined };
      })()
    : mapW(wm.monthly);
  return {
    ok: true,
    quota: {
      rolling: mapW(wm.rolling), weekly: mapW(wm.weekly), monthly: derivedMonthly,
      monthlyRemaining: hasCredits ? monthlyRemaining : null,
      monthlyResetAt, // epoch ms；无期/不可靠/非 limited → null
      credits: hasCredits ? {
        monthlyCredits: num(cr.monthlyCredits),
        purchasedCredits: num(cr.purchasedCredits),
        freeCredits: num(cr.freeCredits),
        belowThreshold: cr.belowThreshold === true,
        creditThreshold: num(cr.creditThreshold),
      } : null,
      globalLimited: !!(wl && wl.limited) || null,
    },
  };
}

/** 注册表：type → 策略。kind 供模式类分派（official-billing 直连官方 API / window-usage 本地或官方 usage 面）。 */
const STRATEGIES = {
  'commandcode-billing': { kind: 'official-billing', detect: detectCommandCodeBilling },
  'window-usage': { kind: 'window-usage', detect: detectWindowUsage },
  // 历史/兼容别名（持久化 adapter.quota 或旧注册表里的 type 保持不变即可工作）
  'opencode-usage': { kind: 'window-usage', detect: detectWindowUsage },
  'proxy-usage': { kind: 'window-usage', detect: detectWindowUsage },
};

function getQuotaStrategy(type) {
  return (type && STRATEGIES[type]) || null;
}

module.exports = { getQuotaStrategy };
