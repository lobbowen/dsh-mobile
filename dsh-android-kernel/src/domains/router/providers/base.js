'use strict';

// 供应商基座：账号（API Key / 反代实例账号）的完整生命周期与状态管理。
// 状态前置原则：添加账号必须启动检测（拿配额）→ 检测结果直接入库（applyDetection 与运行中同机）：
//             受限（窗口满/月额度用尽）→ frozen + limit + recovery，恢复全自动；正常 → ready。
// 硬规则：一账号一实例（按 key 去重）；冻结永带 resetAt，到点自动释放。

const crypto = require('node:crypto');
const ports = require('../../../guard/lifecycle/ports').shared;

/** credits 余额不足的重探周期（ms）：预付余额无自然恢复时刻——冻结后按此周期回探，充值到位即自动解冻。 */
const CREDITS_RECHECK_MS = 10 * 60 * 1000;

// ── 上游“限额/封禁”语义识别（M1：从 forward-core 下沉到 provider 契约）──
// 默认词表只表达“这类词属于时间窗额度 / 属于预付余额”；具体供应商可覆写 classifyResponse 用专属
// 错误码/响应结构判定（INV-4：router 不再持有任何供应商关键词）。识别不了 = 宁可不切，也不误判。
// 实据（2026-09-04 核验，见 test/upstream-credits-test.js）：Command Code /alpha/generate 余额不足 =
// HTTP 400 + 原体 {"success":false,"error":{"code":"BAD_REQUEST","status":400,"message":"You have
// insufficient credits…Please purchase more credits…"}}；commandcode-api-proxy 包为 OpenAI 信封
// (type:"proxy_error", message="CC API 400: <raw>") 且仅对 5xx/429 内部重试——400 余额不足不重试，
// 必须由路由层换号；429/5xx 是“可重试瞬时”（transient）。其它供应商语义须各自覆写，勿套默认词表。
const QUOTA_KEYWORDS = ['insufficient_quota','quota_exceeded','quota reached','usage limit','5-hour usage limit','5 hour usage limit','monthly limit','weekly limit','gousagelimiterror','out of quota','quota has been exceeded'];
const CREDIT_KEYWORDS = ['insufficient credit','insufficient credits','insufficient balance','credit balance','no credits','out of credit','purchase credits','purchase more credits','add credits','billing error','balance'];

/** 默认上游限制分类（纯函数；返回 signal 字符串）：
 *  credits=预付余额不足（充值恢复）| window=时间窗配额（resetsAt 恢复）| banned=账号被封（401/403 无配额信息）
 *  | transient=平台瞬时（503/502 等，不冻结）| none=语义错误/不可判（透传，不切换）。 */
function classifyUpstreamLimited(status, text) {
  const lower = String(text || '').toLowerCase();
  const has = (kws) => kws.some((kw) => lower.includes(kw));
  if (status === 402 || has(CREDIT_KEYWORDS)) return 'credits';
  if (has(QUOTA_KEYWORDS)) return 'window';
  if (status >= 500 && status <= 599) return 'transient';
  if (status === 401 || status === 403) return 'banned';
  return 'none';
}

/** Retry-After / x-ratelimit-reset-ms 头 → 冻结时长（ms）。 */
function headerRetryMs(headers) {
  const h = headers || {};
  const epMs = h['x-ratelimit-reset-ms'];
  if (epMs !== undefined && String(epMs).trim() !== '') {
    const n = parseInt(String(epMs), 10);
    if (Number.isFinite(n) && n > 0) return Math.max(0, n - Date.now());
  }
  const raw = String(h['retry-after'] || '').trim();
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) return n * 1000;
  // HTTP-date 绝对时刻（RFC 7231，如 Wed, 21 Oct 2015 07:28:00 GMT）——2026-09-05 增强
  const at = Date.parse(raw);
  return Number.isFinite(at) && at > Date.now() ? at - Date.now() : 0;
}

/** 响应体中的 “resets in N min/sec” → 冻结时长（ms）。 */
function bodyResetMs(text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  // 相对时长: "resets in 5 min" / "retry in 30 sec"
  const m = /(?:resets?|retry|try again|after|available)\s+in\s+(\d+)\s*(min|sec|second|s|hour|hr)?/.exec(lower);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) {
      const unit = m[2] || '';
      return unit.startsWith('min') ? n * 60000
        : (unit.startsWith('hour') || unit.startsWith('hr')) ? n * 3600000
        : n * 1000;
    }
  }
  // 绝对时刻: "resets at <ISO>"（Command 实测格式）
  const iso = /(\d{4}-\d{2}-\d{2}[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)/.exec(t);
  if (iso) {
    const at = normalizeResetTs(iso[1]);
    if (at && at > Date.now()) return at - Date.now();
    if (at && at <= Date.now()) return 0;
  }
  return 0;
}

const PROVIDER_PRESETS = [
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen (Go)',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    plan: { per5hUsd: 12, weeklyUsd: 30, monthlyUsd: 60 },
    adapter: {
      quota: { type: 'opencode-usage', usagePath: '/usage' },
      pricing: { type: 'models-dev', provider: 'opencode-go' },
    },
    pricing: {},
    note: '$10/月 Go 套餐；$12/5小时、$30/周、$60/月，超出回落余额',
  },
  {
    // OpenCode 官方 AI 网关（按量付费 / 余额充值），OpenAI 兼容端点。
    // 与「OpenCode Zen (Go)」（zen/go 订阅套餐）区分：本条目为通用 Zen 网关
    // （docs.opencode.ai/docs/zen → 端点 https://opencode.ai/zen/v1）。
    // adapter=null：不做窗口额度探测（按量付费无固定窗口上限）；余额不足由上游
    // 402/429/403 响应经转发层 markQuotaExhausted 冻结账号——响应驱动，无需 usage API。
    id: 'opencode-zen-credit',
    name: 'Open Code ZEN',
    baseUrl: 'https://opencode.ai/zen/v1',
    plan: null,
    adapter: null,
    pricing: { type: 'models-dev', provider: 'opencode-zen' },
    note: 'OpenCode 官方 AI 网关：按量付费（余额充值，官方建议 Auto top-up），OpenAI 兼容 /zen/v1；无固定窗口套餐',
  },
];

function keyFingerprint(k) {
  if (!k) return 'unknown';
  const hash = crypto.createHash('sha256').update(String(k)).digest('hex').slice(0, 10);
  return hash + '…' + String(k).slice(-4);
}

function maskKey(k) {
  if (!k || String(k).length <= 8) return '***';
  return '...' + String(k).slice(-6);
}

/** 归一化窗口重置时间 → epoch 毫秒（或 null）：
 *  兼容上游返回的 ISO 字符串（'2026-09-21T05:54:32.950Z'）、epoch 毫秒/秒数字、数字字符串。
 *  历史缺陷：_nextResetAt 直接 Number(resetsAt)，ISO 串 → NaN → 30 天兜底覆写精确恢复点，
 *  导致「月窗口 09-21 重置但账号被推到 10-03 才探测恢复」的额度恢复不同步。 */
function normalizeResetTs(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || /^\d{1,13}$/.test(String(v).trim())) {
    let n = typeof v === 'number' ? v : Number(String(v).trim());
    if (!Number.isFinite(n)) return null;
    // epoch 秒/毫秒消歧：< 1e12 视为秒（毫秒纪元在 2001-09-09 才到 1e12，合法 resetsAt 不会更早）
    if (n < 1e12) n *= 1000;
    return n;
  }
  // ISO 字符串（2026-09-21T05:54:32.950Z 等）→ epoch 毫秒
  const t = Date.parse(String(v).trim());
  return Number.isFinite(t) ? t : null;
}

/** 本地时钟文本（YYYY-MM-DD HH:mm）：冻结原因/证据中的可读时间。 */
function fmtClock(ms) {
  try {
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  } catch { return ''; }
}

/** credits 受限判定（quota 维度纯函数，单源）：Command 订阅制——月度池=0 / 低余额提醒 / 汇总≤0 即受限
 *  （真实采样 2026-09-04：余额 0 时上游对请求回 400 insufficient credits，即使窗口未满）。 */
function isQuotaCreditsLow(q) {
  if (!q) return false;
  const c = q.credits;
  if (c) {
    if (c.belowThreshold === true) return true;
    if (typeof c.monthlyCredits === 'number' && Number.isFinite(c.monthlyCredits) && c.monthlyCredits <= 0) return true;
  }
  const rem = q.monthlyRemaining;
  return typeof rem === 'number' && Number.isFinite(rem) && rem <= 0;
}

/** 统一配额总览标签（展示/视图单源，2026-09 债务清理）：
 *  语义 = credits 受限优先（月额度用尽）；窗口：月窗口满 或 5h+周同时满 → 用尽；周满 → 周限额；
 *  5h 满 → 5h限额。修复旧 index.js 视图对「周+5h 同满无月窗口」返回 周限额 与 proxy 端 用尽 的分叉。 */
function quotaOverallStatus(q) {
  if (!q) return '正常';
  if (isQuotaCreditsLow(q)) return '额度用尽';
  const ex = (w) => w && (w.status === 'rate-limited' || (Number.isFinite(Number(w.percent)) && Number(w.percent) >= 100));
  const monthlyEx = ex(q.monthly), weeklyEx = ex(q.weekly), rollingEx = ex(q.rolling);
  if (monthlyEx || (weeklyEx && rollingEx)) return '用尽';
  if (weeklyEx) return '周限额';
  if (rollingEx) return '5h限额';
  return '正常';
}

/** 账号「月度额度重置」精确时刻（quota.monthlyResetAt，epoch ms）：仅当存在且在未来时返回，否则 0。
 *  2026-09 真实采样：Command 订阅面 /alpha/billing/subscriptions 的 currentPeriodEnd 即月额度随
 *  订阅续期重置的时刻（credits 原体无 period 字段，必须单独取订阅）。无期（预付充值制/未取到）
 *  回退周期轮询——不把「不可靠的未来时刻」当精确恢复点。 */
function monthlyResetAtOf(acc) {
  const q = (acc && acc.quota) || {};
  const v = Number(q && q.monthlyResetAt);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v > Date.now() ? v : 0;
}

class ProviderBase {
  constructor(opts) {
    this.id = opts.id;
    this.name = opts.name;
    this.kind = opts.kind;
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.onPersist = opts.onPersist || null;
    this.dist = opts.dist || null;
    this.accounts = [];
    this.activeAccount = null;
    this.selectedAccountKeyId = null; // 统一锁定（直连/反代共用）：持久化，用户显式锁定/切换时写
    this.cursor = 0;
    // 供应商独立 API 端点：apiPort=持久化端口绑定（激活时分配、停用保留，防漂移）；
    // activated=是否激活（激活才提供该供应商的端点服务与实例常驻，默认停用=不提供服务）
    this.apiPort = opts.apiPort || null;
    this.activated = opts.activated === true;
  }

  /** 当前「实际在用/应高亮」账号 keyId（列表/头部同源派生）：
   *   优先级 = ① 持久化锁定账号（若当前可用/在用）② 自动在用 activeAccount。
   *   锁定账号若不可用（冻结/封号中，路由已切到别的账号），则高亮实际在用的 activeAccount——
   *   保证前端定位的是「正在跑的账号」，而不是锁定的死账号（2026-09 审计修复）。 */
  selectedKeyId() {
    const locked = this.selectedAccountKeyId
      ? (this.accounts || []).find((a) => a.keyId === this.selectedAccountKeyId)
      : null;
    if (locked && (locked.status === 'ready' || (this.activeAccount && this.activeAccount.keyId === locked.keyId))) {
      return locked.keyId; // 锁定账号可用/在用 → 锁即当前
    }
    if (this.activeAccount) return this.activeAccount.keyId; // 实际在用（自动轮换/请求激活）
    return (locked && locked.keyId) || null; // 无在用（空闲）→ 仍指锁定账号供 UI 显示
  }

  async detectAccount(acc) {
    throw new Error('detectAccount must be implemented by subclass');
  }

  accountQuotaSummary(acc) {
    const q = (acc && acc.quota) || {};
    const win = (w) => (w ? { percent: w.percent ?? null, status: w.status || null, resetsAt: w.resetsAt || null } : null);
    return { rolling: win(q.rolling), weekly: win(q.weekly), monthly: win(q.monthly), overall: q.overallStatus || null };
  }

  async addAccount(key, extra) {
    const existing = this.accounts.find((a) => a.key === key);
    if (existing) return { ok: true, account: existing, already: true };
    const acc = {
      key,
      keyId: keyFingerprint(key),
      maskedKey: maskKey(key),
      status: 'registering',
      quota: null,
      registeredAt: Date.now(),
      ...(extra || {}),
    };
    this.accounts.push(acc);
    this._persist();
    const det = await this.detectAccount(acc).catch((e) => ({ ok: false, error: e.message }));
    if (!det.ok) {
      acc.status = 'discarded';
      acc.detectError = det.error;
      this._persist();
      return { ok: false, error: det.error, account: acc };
    }
    acc.quota = det.quota || null;
    const summary = this.accountQuotaSummary(acc);
    // 入库即如实、且与运行中完全同一台状态机（2026-09 用户定稿，取消 review 闸门）：
    //   检测结果直接交给 applyDetection —— 受限账号（月额度/预付 credits 用尽、时间窗满）一律
    //   frozen + limit(kind + recovery：credits 有订阅 periodEnd→at 否则 poll；window→at=窗口
    //   resetsAt)，恢复全靠主循环到点自动探测解冻；额度正常 → ready 直接入池。
    //   添加路径不再出现 review：受限与运行中被上游 400/定时探测判受限走同一处置，
    //   不存在「需人工裁决才入池」的第二轨（时间窗满同样是自动检测、到点自动解）。
    this.applyDetection(acc, { ok: true, quota: det.quota || null });
    if (acc.status === 'ready' && this.events) this.events.append('account_ready', { provider: this.name, key: acc.maskedKey });
    const limited = (acc.limit && acc.limit.kind) || null;
    return { ok: true, account: acc, review: false, ...(limited ? { limited } : {}), quota: summary };
  }

  confirmAccount(keyId) {
    const acc = this.accounts.find((a) => a.keyId === keyId);
    if (!acc) return { ok: false, error: '账号不存在' };
    if (acc.status === 'review') {
      acc.status = 'ready';
      this._persist();
      if (this.events) this.events.append('account_confirmed', { provider: this.name, key: acc.maskedKey });
    }
    return { ok: true };
  }

  discardAccount(keyId) {
    const idx = this.accounts.findIndex((a) => a.keyId === keyId);
    if (idx < 0) return { ok: false, error: '账号不存在' };
    const acc = this.accounts[idx];
    if (this.kind === 'proxy' && acc.instance) {
      try { this.stopInstance(acc.instance); } catch {}
      // 删除账号：释放该实例的持久化端口绑定（registry 登记 + inst.port）
      try { ports.unregister('proxy:' + acc.keyId); } catch {}
      acc.instance.port = null;
    }
    this.accounts.splice(idx, 1);
    this._persist();
    if (this.events) this.events.append('account_discarded', { provider: this.name, key: acc.maskedKey });
    return { ok: true };
  }

  /** credits 受限判定（单源纯函数 isQuotaCreditsLow，2026-09 债务清理）：任何携带 credits 池的
   *  quota（如 Command 订阅月额度）统一判定；窗口型无 credits 字段 → false。 */
  _isCreditsLow(acc) { return isQuotaCreditsLow(acc && acc.quota); }

  /** 上游响应 → signal（M1 契约：供应商可覆写以识别专属错误码/响应结构；router 不再内置词表）。
   *  默认 = classifyUpstreamLimited(status, bodyText)。headers 备用（Retry-After 等）。 */
  classifyResponse(status, headers, bodyText) {
    return classifyUpstreamLimited(status, bodyText);
  }

  /** 账号处置副作用（M3 契约）：router 只发 signal，具体“冻结/停实例/预热/封号”由 provider 执行。
   *  base：credits→markCreditsExhausted；window→markQuotaExhausted(ctx.retryMs)；banned→markBanned；
   *  none/transient 不施加账号级状态。子类可覆写（如 proxy 停实例+预热已在 mark* 覆写中体现）。 */
  effect(signal, acc, ctx) {
    const c = ctx || {};
    if (signal === 'credits') { if (this.markCreditsExhausted) this.markCreditsExhausted(acc); return true; }
    if (signal === 'window') { if (this.markQuotaExhausted) this.markQuotaExhausted(acc, c.retryMs); return true; }
    if (signal === 'banned') { if (this.markBanned) this.markBanned(acc, c.error || (c.status === 401 ? '401 认证失败' : '账号被封禁')); return true; }
    return false;
  }

  /** 唯一「时间窗额度用尽」判定（M4）：请求前挑号 / 响应后状态机 / 定时探测共用，杜绝重复实现。 */
  _windowExhausted(acc) {
    const sum = this.accountQuotaSummary(acc);
    return [sum.rolling, sum.weekly, sum.monthly].some((w) => w && (w.status === 'rate-limited' || (w.percent !== null && w.percent >= 100)));
  }

  /** credits 冻结的正向恢复证据 a)：月度重置到期。
   *  依据 = recovery.at（订阅 periodEnd，权威）或 nextResetAt（同值镜像）任一已过当前时刻。 */
  _creditsResetDue(acc) {
    if (!acc) return false;
    const cands = [acc.nextResetAt, acc.limit && acc.limit.recovery && acc.limit.recovery.at, acc.quota && acc.quota.monthlyResetAt];
    for (const v of cands) {
      const t = Number(v);
      if (Number.isFinite(t) && t > 0 && t <= Date.now()) return true;
    }
    return false;
  }

  /** credits 冻结的正向恢复证据 b)：余额较冻结时刻回升（充值场景；periodEnd 不变的预付池）。
   *  基线 = 冻结时刻记录的 limit.creditsAt；当前余额来自最新探测快照。
   *  阈值宽松（严格大于即成立）——误解冻风险由「下一轮 400 再冻结」兜底，漏解冻代价更高。 */
  _creditsRefilled(acc) {
    if (!acc || !acc.limit || acc.limit.kind !== 'credits') return false;
    const base = Number(acc.limit.creditsAt);
    if (!Number.isFinite(base)) return false; // 无基线（旧冻结数据）：只认证据 a)
    const q = acc.quota || {};
    const now = (typeof q.monthlyRemaining === 'number' && Number.isFinite(q.monthlyRemaining))
      ? q.monthlyRemaining
      : ((q.credits && typeof q.credits.monthlyCredits === 'number') ? q.credits.monthlyCredits : NaN);
    return Number.isFinite(now) && now > base;
  }

  /** 账号可用性判定（唯一事实，M4）：ready 且未「预付余额不足」且窗口未满。
   *  opts.checkWindows=false 时跳过窗口断言（仅校验有效性/余额）。 */
  isAccountUsable(acc, opts) {
    if (!acc || acc.status !== 'ready') return false;
    if (this._isCreditsLow(acc)) return false; // credits 余额不足不参与挑选（充值后由周期检测恢复）
    if (opts && opts.checkWindows === false) return true;
    return !this._windowExhausted(acc);
  }

  /** 统一受限冻结（2026-09 收敛：credits/window 同一套状态机——置 frozen + 记恢复点 + 设 limit +
   *  事件；cause('credits'|'window') 仅作标签供 UI/日志区分原因，不做第二套处理）。
   *  @param recovery {type:'at'|'poll', at?|periodMs?} 恢复描述；at 优先作为 nextResetAt，poll 用 now+periodMs */
  _freezeLimited(acc, cause, reason, recovery) {
    if (!acc || acc.status === 'banned' || acc.status === 'discarded') return false;
    const rec = recovery || { type: 'poll', periodMs: CREDITS_RECHECK_MS };
    const at = rec.type === 'at' && rec.at ? rec.at : 0;
    const next = at || Date.now() + (rec.periodMs || CREDITS_RECHECK_MS);
    acc.detectError = reason;
    if (acc.status !== 'frozen') this._setStatus(acc, 'frozen', next, reason, false);
    else { acc.nextResetAt = next; this._persist(); }
    const lim = this._setLimit(acc, cause, reason, rec);
    // credits 冻结记录冻结时刻的月余额基线（2026-09 月额度语义定稿）：
    // 解冻只认正向证据——periodEnd 到期，或余额较冻结时刻实质回升（充值）。
    // 快照基线使「回升」可判定；信号（400 拒绝）是冻结权威，快照只服务解冻证据比较。
    if (cause === 'credits' && lim) {
      const q = acc.quota || {};
      lim.creditsAt = (typeof q.monthlyRemaining === 'number' && Number.isFinite(q.monthlyRemaining))
        ? q.monthlyRemaining
        : ((q.credits && typeof q.credits.monthlyCredits === 'number') ? q.credits.monthlyCredits : null);
    }
    if (this.events) this.events.append('account_frozen', { provider: this.name, key: acc.maskedKey, until: at || next, kind: cause });
    return true;
  }

  /** credits 额度用尽标记（上游 400/402/429/403 报错驱动，2026-09，真实采样校准）：
   *  Command 为订阅制——monthlyCredits=0 表示本月订阅包含额度已用完（购买 credits 或月度重置后恢复），
   *  无自然“到点”恢复 → 按周期重探（购买/重置后自动解冻）。反代子类覆写为 停实例 + 预热下一个。 */
  markCreditsExhausted(acc) {
    if (!acc || acc.status === 'banned' || acc.status === 'discarded') return;
    // 月度重置（2026-09）：订阅账号的月额度用尽有精确恢复点（subscriptions.currentPeriodEnd）→
    // recovery.at 定点调度；无期（预付充值制/未取到订阅）才周期轮询（充值后自动恢复兜底）
    const monthlyAt = monthlyResetAtOf(acc);
    const recovery = monthlyAt
      ? { type: 'at', at: monthlyAt }
      : { type: 'poll', periodMs: CREDITS_RECHECK_MS };
    const reason = monthlyAt
      ? '额度用尽（原因：月额度，预计 ' + fmtClock(monthlyAt) + ' 自动恢复）'
      : '额度用尽（原因：月额度，待月度重置后自动恢复）';
    this._freezeLimited(acc, 'credits', reason, recovery);
  }


  /* ═══════ 账号状态机（统一直连/反代）═══════
   * 三态模型：限额（frozen/limited）⇄ 正常（ready，自动解冻）；封禁（banned）。
   *  - 429/403 配额响应 → markQuotaExhausted：第一时间冻结，冻结到期 = 精确 nextResetAt；
   *  - 401/403 非配额拒绝 → markBanned：封号（前端封号标签）；
   *  - 定时状态检测（_probeAccountStates）→ applyDetection：恢复自动解冻 / 仍限额保持 /
   *    其他报错记 lastProbeError；每次检测结果写 lastProbeAt（明确反馈）。
   *  - 网络失败/流中断不产生任何账号级状态（无冷却态），由转发层换 key 重试吸收。
   * 字段：status / quota / nextResetAt / lastProbeAt / lastProbeError
   */

  /** 各窗口最近恢复时间（精确优先；无精确 resetsAt 时按窗口类型给默认恢复窗口，
   *  保证冻结账号永远有可调度的自动恢复时间，不依赖手动刷新）。
   *  2026-09 修复：resetsAt 经 normalizeResetTs 归一（ISO 字符串/epoch 秒/毫秒均支持）——
   *  原实现 Number(ISO)→NaN→30d 兜底，会把精确恢复点覆写成 +30 天（额度恢复不同步根因）。
   *  @returns {t:number|null, precise:boolean} precise=true 表示来自真实 resetsAt；
   *    false 表示纯兜底（无任何满窗口给出精确恢复时间）——调用方不得用 false 覆写已精确的值。 */
  _nextResetAt(quota) {
    const q = quota || {};
    let soonest = null;
    let precise = false;
    for (const [key, w] of [['rolling', q.rolling], ['weekly', q.weekly], ['monthly', q.monthly]]) {
      if (!w) continue;
      // 仅对「满窗口」（需要恢复）计算恢复时间
      const full = w.status === 'rate-limited' || (Number.isFinite(Number(w.percent)) && Number(w.percent) >= 100);
      if (!full) continue;
      let t = normalizeResetTs(w.resetsAt);
      if (t && t > 0) {
        precise = true; // 至少一个满窗口给了真实恢复时间
      } else {
        // 兜底恢复窗口：rolling=5h、weekly=7d、monthly=30d（供应商未给精确 resetAt 时）
        t = Date.now() + (key === 'rolling' ? 5 * 3600 * 1000 : key === 'weekly' ? 7 * 24 * 3600 * 1000 : 30 * 24 * 3600 * 1000);
      }
      if (soonest === null || t < soonest) soonest = t;
    }
    return { t: soonest, precise };
  }


  _setStatus(acc, status, nextResetAt, error, autoRecover) {
    const prev = acc.status;
    acc.status = status;
    if (nextResetAt !== undefined) acc.nextResetAt = nextResetAt;
    if (error !== undefined) acc.lastProbeError = error;
    // 状态真实化（2026-09 真实采样）：冻结/封号后若还挂着在用则释放（避免「frozen 且在用」的矛盾呈现）
    if ((status === 'frozen' || status === 'banned') && this.activeAccount && this.activeAccount.keyId === acc.keyId) {
      this.markNotInUse(acc.keyId);
    }
    // 锁收敛（2026-09 A）：冻结/封号/作废 = 离开可用池 → 锁失效（与其余限额账号同一状态机，恢复后用户可重新锁定）
    if ((status === 'frozen' || status === 'banned' || status === 'discarded') && this.selectedAccountKeyId === acc.keyId) {
      this.selectedAccountKeyId = null;
    }
    this._persist();
    if (prev === status) return;
    if (this.events) {
      if (autoRecover) {
        this.events.append('account_recovered', { provider: this.name, key: acc.maskedKey, from: prev, to: status });
      } else {
        this.events.append('account_status', { provider: this.name, key: acc.maskedKey, from: prev, to: status });
      }
    }
    if (this.logger && this.logger.info) this.logger.info('account ' + acc.maskedKey + ': ' + prev + ' → ' + status);
  }

  /** limit（M2）：把「为什么受限 / 何时恢复」固化为账号一等字段，与 status 并存——
   *  window=时间窗（recovery.at=resetsAt，到点自动恢复）；credits=预付余额（recovery.poll=周期重探，充值后恢复）；
   *  banned=封禁（recovery.manual=人工/复核）。展示与恢复调度据此分列，不再把不同恢复塞进同一 frozen+nextResetAt。 */
  _ensureLimit(acc) {
    if (!acc) return null;
    if (acc.limit && acc.limit.kind) return acc.limit;
    const st = acc.status;
    let kind = null, recovery = null, reason = null;
    if (st === 'banned') { kind = 'banned'; recovery = { type: 'manual' }; reason = acc.detectError || acc.lastProbeError || '账号被封禁'; }
    else if (st === 'frozen' || st === 'limited') {
      const err = String(acc.detectError || acc.lastProbeError || '').toLowerCase();
      if (err.includes('credits') || err.includes('余额不足')) { kind = 'credits'; recovery = { type: 'poll', periodMs: CREDITS_RECHECK_MS }; reason = 'credits 余额不足（充值后自动恢复）'; }
      else { kind = 'window'; recovery = { type: 'at', at: acc.nextResetAt || null }; reason = '时间窗额度用尽'; }
    }
    if (kind) acc.limit = { kind, since: Date.now(), reason, recovery };
    return acc.limit;
  }

  _setLimit(acc, kind, reason, recovery) {
    if (!acc) return null;
    // 同 kind 重建时保留证据基线（creditsAt）：维持冻结路径会多次重建 limit，
    // 抹掉基线会使「余额回升」证据永远无法成立（解冻失灵）。
    const prevAt = (acc.limit && acc.limit.kind === kind && typeof acc.limit.creditsAt === 'number') ? acc.limit.creditsAt : undefined;
    acc.limit = { kind, since: acc.limit && acc.limit.kind === kind ? acc.limit.since : Date.now(), reason: reason || null, recovery: recovery || null };
    if (prevAt !== undefined) acc.limit.creditsAt = prevAt;
    this._persist();
    return acc.limit;
  }

  /** 429/403 配额响应：第一时间冻结账号（精确到恢复时间）。
   *  冻结状态由 nextResetAt 管理恢复；账号无任何冷却中间态。 */
  markQuotaExhausted(acc, cooldownMs) {
    // cooldownMs 恢复点优先级（2026-09-05 修复：429 body/头未给精确时间时不再一律 +5h）：
    //   1) headerRetryMs/bodyResetMs 解析到的精确时长（≤30d 封顶）；
    //   2) 已探测 quota 中「最近未来」窗口 resetsAt（官方 billing 精确值）；
    //   3) 都没有才默认 5h（历史行为兜底）。
    let cooldown = cooldownMs > 0 ? cooldownMs : 0;
    if (!(cooldown > 0)) {
      const q = (acc && acc.quota) || {};
      const now = Date.now();
      let soonest = null;
      for (const w of [q.rolling, q.weekly, q.monthly]) {
        if (!w) continue;
        const at = normalizeResetTs(w.resetsAt);
        if (at && at > now && (soonest === null || at < soonest)) soonest = at;
      }
      if (soonest !== null) cooldown = soonest - now;
    }
    const capped = cooldown > 0 ? Math.min(cooldown, 30 * 24 * 3600 * 1000) : 5 * 3600 * 1000;
    const until = Date.now() + capped;
    this._freezeLimited(acc, 'window', '额度用尽', { type: 'at', at: until });
  }

  /** 封号（401 / 403 非配额性拒绝，或检测到账号禁用）。 */
  markBanned(acc, error) {
    this._setStatus(acc, 'banned', null, error || '账号被禁用', false);
    this._setLimit(acc, 'banned', error || '账号被封禁', { type: 'manual' });
    if (this.events) this.events.append('account_banned', { provider: this.name, key: acc.maskedKey, kind: 'banned' });
  }

  /* ═══════ 维度 B：账号使用状态（2026-09 架构收敛：纯派生，不持久化）═══════
   * 决策：usage 改为从「事实」派生（activeAccount 指向 / 实例运行态 / 请求在途），
   * 不再作为可漂移的持久化目标态——旧实现 markWarming/markIdle 半接线（markIdle 死代码、
   * markWarming 永不回收复位）导致 usage=warming 粘滞，前端出现「warming 但实例已停」矛盾。
   * 派生源：status（唯一有效性事实）＋ activeAccount（在用指向）＋ 实例实况（由子类 instanceOf 提供）。 */

  /** 标记账号在用（路由选中/请求激活时调用）：只写 activeAccount（序列化含 activeAccountKeyId），不落 usage。 */
  markInUse(keyId) {
    const acc = (this.accounts || []).find((a) => a.keyId === keyId);
    if (!acc) return;
    if (!this.activeAccount || this.activeAccount.keyId !== keyId) {
      this.activeAccount = acc;
      this._persist();
    }
  }

  /** 标记账号离开在用（冻结/封号/切换离开）：清 activeAccount（不落 usage）。 */
  markNotInUse(keyId) {
    if (this.activeAccount && this.activeAccount.keyId === keyId) {
      this.activeAccount = null;
      this._persist();
    }
  }

  /** 使用状态纯派生（不读写任何持久化 usage 字段）：
   *  in-use = activeAccount 指向本账号；warming = 实例已在跑但非在用（常驻/预热拉起后待命）；
   *  idle = 其余。子类可注入 instanceOf(acc) 提供实例实况（proxy：按 keyId 查实例；direct：无实例 → null）。 */
  usageOf(acc) {
    if (!acc) return 'idle';
    if (this.activeAccount && this.activeAccount.keyId === acc.keyId) return 'in-use';
    if (typeof this.instanceOf === 'function') {
      const inst = this.instanceOf(acc);
      if (inst && inst.pid) return 'warming';
    }
    return 'idle';
  }

  /** 应用一次状态检测结果（定时轮询 / 配额刷新共用）：恢复自动解冻，仍限额保持，报错反馈。 */
  applyDetection(acc, det) {
    acc.lastProbeAt = Date.now();
    if (!det || !det.ok) {
      if (det && det.banned) {
        this._setStatus(acc, 'banned', null, det.error || '账号被禁用', false);
      } else {
        acc.lastProbeError = (det && det.error) || '状态检测失败';
        // ⚠ P1-1 修复（2026-09-12）：**探测失败也必须给一个重探时刻**。
        //
        //   缺陷：本分支此前只写 lastProbeError 就返回，**不设 nextResetAt**。
        //     而 router 的探测闸门是 `missingReset = frozen && !nextResetAt` ——
        //     于是「frozen + 探测持续失败」的账号 `needProbe` **恒真**：
        //     每 5 分钟 start→detect→stop 一次实例（启停风暴 + 高频打上游 billing），
        //     与注释声称的「立即探测**一次**确认真实额度」并不相符。
        //
        //   现补兜底重探时刻（复用 credits 的 10min 周期）：失败 → 退避重探，
        //     额度真恢复时仍会解冻（最多晚 10 分钟），但不再有启停风暴。
        //     ⚠ 仅在「没有既有恢复点」时补，避免把已精确的 nextResetAt 推后。
        if (acc.status === 'frozen' && !acc.nextResetAt) {
          acc.nextResetAt = Date.now() + CREDITS_RECHECK_MS;
        }
        this._persist();
      }
      return;
    }
    acc.lastProbeError = null;
    if (det.quota) acc.quota = det.quota;
    // credits 预付余额不足（2026-09）：与窗口额度并列的受限维度——检测到余额低于阈值即保持冻结，
    // 按固定周期重探（充值到位自动解冻）；封号/作废不受本维度干扰。
    if (acc.status !== 'banned' && acc.status !== 'discarded' && this._isCreditsLow(acc)) {
      // 月度重置（2026-09 + 二次修复）：quota.monthlyResetAt（订阅 periodEnd）已知 → recovery.at 定点；
      // 单次探测未取到订阅期（缓存/瞬时失败）时，保留既有精确 at（recovery.at 不因一次探测降级 poll——
      // 实测 EkNh 09-27 的 at 曾被覆盖回 poll 导致每 5min 临近探测死循环）。
      const monthlyAt = monthlyResetAtOf(acc);
      const prevAt = (acc.limit && acc.limit.kind === 'credits' && acc.limit.recovery && acc.limit.recovery.type === 'at' && acc.limit.recovery.at && acc.limit.recovery.at > Date.now()) ? acc.limit.recovery.at : 0;
      const effectiveAt = monthlyAt || prevAt;
      const recovery = effectiveAt
        ? { type: 'at', at: effectiveAt }
        : { type: 'poll', periodMs: CREDITS_RECHECK_MS };
      const reason = effectiveAt
        ? '额度用尽（原因：月额度，预计 ' + fmtClock(effectiveAt) + ' 自动恢复）'
        : '额度用尽（原因：月额度，待月度重置后自动恢复）';
      this._freezeLimited(acc, 'credits', reason, recovery);
      return;
    }
    if (this._windowExhausted(acc)) { // 与可用性/挑号同一窗口判定（M4 单一事实）
      // 仍限额：冻结保持，其余升级为冻结/限额（nextResetAt 精确更新）
      const nr = this._nextResetAt(acc.quota);
      // 防回推（2026-09 修复 + 2026-09 二次修复）：
      //  - 纯兜底（+5h/+30d）不得覆写已精确的 nextResetAt（否则把真实恢复点推后）；
      //  - 精确值仅在「更早」时收敛——但若既有 nextResetAt 已过期（<=now，如早前错误重排/窗口已过仍 frozen），
      //    必须无条件采纳新的精确值，否则 nextResetAt 永久卡在过期值 → 每 5min 临近探测死循环（实测 fdAkeZ）。
      const precise = nr.precise && nr.t;
      const staleExisting = acc.nextResetAt && acc.nextResetAt <= Date.now();
      if (precise && (!acc.nextResetAt || staleExisting || nr.t < acc.nextResetAt)) acc.nextResetAt = nr.t;
      else if (!precise && (!acc.nextResetAt || staleExisting)) acc.nextResetAt = nr.t; // 无精确：过期/缺失才兜底，不覆盖有效精确
      this._freezeLimited(acc, 'window', '额度用尽', { type: 'at', at: acc.nextResetAt || null });
    } else {
      // ── credits 冻结的解冻门槛（2026-09 月额度语义定稿）──
      // 上游 400 insufficient credits 是「月额度不足以服务请求」的权威信号；billing 面快照
      // （percent=99/remaining>0）是滞后的粗粒度展示数据——快照不满足冻结阈值不代表余额能服务
      // 请求。因此 credits 冻结的解冻【不回判阈值】，只认正向恢复证据：
      //   a) 月度重置到期（recovery.at/nextResetAt <= now）；
      //   b) 余额较冻结时刻回升（充值；limit.creditsAt 基线比较）。
      // 无正向证据 → 维持冻结（quota 快照已刷新供展示），按 recovery 节奏重探。
      const prev = acc.status;
      if (prev === 'frozen' && acc.limit && acc.limit.kind === 'credits') {
        const resetDue = this._creditsResetDue(acc);
        const refilled = this._creditsRefilled(acc);
        if (!resetDue && !refilled) {
          const monthlyAt = monthlyResetAtOf(acc);
          const at = acc.nextResetAt || monthlyAt || 0;
          const reason = at
            ? '额度用尽（原因：月额度，预计 ' + fmtClock(at) + ' 自动恢复）'
            : '额度用尽（原因：月额度，待月度重置后自动恢复）';
          const recovery = at ? { type: 'at', at } : { type: 'poll', periodMs: CREDITS_RECHECK_MS };
          this._setLimit(acc, 'credits', reason, recovery);
          acc.detectError = reason;
          this._persist();
          return; // 维持冻结：不是恢复，只是快照未到阈值
        }
        // 有正向证据 → 落到下方通用解冻
      }
      // 已恢复：自动解冻/解封
      acc.nextResetAt = null;
      acc.limit = null; // M2：恢复即清 limit（window/credits/banned 恢复语义各自在其 applyDetection 分支处理）
      if (prev === 'frozen' || prev === 'banned' || prev === 'limited') {
        this._setStatus(acc, 'ready', null, null, true);
      } else if (acc.status !== 'ready') {
        this._setStatus(acc, 'ready', null, null, false);
      } else {
        this._persist();
      }
    }
  }

  _persist() {
    if (this.onPersist) this.onPersist();
  }

  /** 一致性守卫（serialize 前置，2026-09 架构收敛）：ready 账号已知额度已满（窗口/credits）→
   *  写盘前归位 frozen + limit（自我修正，杜绝「ready+满额」矛盾落盘——该矛盾正是旧
   *  预热→回收死循环的燃料：_prewarmByQuota 见 ready 就预热，回收见不可用就停）。
   *  仅修正「可确证的矛盾」（quota 数据本身已显示满）；registering/review/discarded/banned 不动。
   *  纯字段修正：不调 _freezeLimited/_setStatus/_persist（serialize 在持久化路径内，避免递归写盘）。 */
  _normalizeConsistency(acc) {
    if (!acc) return;
    const st = acc.status;
    if (st !== 'ready' && st !== 'limited') return; // 仅 ready 需要修正（limited 兼容归一）
    if (st === 'registering' || st === 'review' || st === 'discarded' || st === 'banned') return;
    const q = acc.quota;
    if (!q || typeof q !== 'object') return; // 无额度数据不臆断
    const full = this._windowExhausted(acc) || this._isCreditsLow(acc);
    if (!full) return;
    const cause = this._isCreditsLow(acc) ? 'credits' : 'window';
    const nr = this._nextResetAt ? this._nextResetAt(q) : null;
    if (this.logger && this.logger.warn) this.logger.warn('consistency guard: ready 账号额度已满（' + cause + '）→ 归位 frozen key=' + (acc.maskedKey || acc.keyId));
    acc.status = 'frozen';
    if (acc.limit && acc.limit.kind) {
      // 保留既有 limit；仅确保 nextResetAt 存在
      if (!acc.nextResetAt && nr && nr.t) acc.nextResetAt = nr.t;
    } else {
      const at = (acc.nextResetAt && acc.nextResetAt > Date.now()) ? acc.nextResetAt : ((nr && nr.t) || 0);
      acc.limit = { kind: cause, since: Date.now(), reason: acc.detectError || '额度用尽（一致性归位）', recovery: at ? { type: 'at', at } : { type: 'poll', periodMs: CREDITS_RECHECK_MS } };
      if (at) acc.nextResetAt = at;
      else if (!acc.nextResetAt) acc.nextResetAt = Date.now() + CREDITS_RECHECK_MS;
    }
    if (this.activeAccount && this.activeAccount.keyId === acc.keyId) this.activeAccount = null;
  }

  /** 锁收敛（2026-09 A 定稿）：锁只对「当前可用」账号有意义——账号因任何原因离开可用池
   *  （冻结=任意额度窗口/封号/作废/不存在）即锁失效；恢复后由用户按需重新显式锁定，
   *  不存在独立于账号状态机的死锁残留。调用点：serialize 前 / _setStatus 冻结封号时 / 加载恢复后。 */
  _reconcileLock() {
    const lockedId = this.selectedAccountKeyId || null;
    if (!lockedId) return;
    const acc = (this.accounts || []).find((a) => a.keyId === lockedId);
    const usable = !!acc && acc.status === 'ready' && (typeof this.isAccountUsable !== 'function' || this.isAccountUsable(acc));
    if (!usable) {
      this.selectedAccountKeyId = null;
      if (this.selectedProxyKeyId === lockedId) this.selectedProxyKeyId = null;
    }
  }

  serialize() {
    // 锁收敛前置：先一致性归一（ready+满额→frozen）再按可用性收敛锁——死锁不落盘
    try { for (const a of (this.accounts || [])) this._normalizeConsistency(a); } catch {}
    this._reconcileLock();
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      baseUrl: this.baseUrl || null,
      apiPort: this.apiPort || null,
      activated: this.activated === true,
      plan: this.plan || null,
      pricing: this.pricing || {},
      presetId: this.presetId || null,
      adapter: this.adapter || null,
      proxyAppId: this.proxyAppId || null,
      proxyRunning: this.proxyRunning || false,
      selectedAccountKeyId: this.selectedAccountKeyId || this.selectedProxyKeyId || null,
      // ★ 统一状态机（2026-09 account-state-rework）：使用状态持久化——
      //   activeAccountKeyId = 当前在用账号（重启后恢复粘滞 + 前端锁定显示，根治「实例在跑却不显示锁定」）
      activeAccountKeyId: (this.activeAccount && this.activeAccount.keyId) || null,
      accounts: this.accounts.map((a) => {
        this._normalizeConsistency(a); // 一致性守卫：ready+满额矛盾写盘前自我修正
        return {
          key: a.key,
          keyId: a.keyId,
          maskedKey: a.maskedKey,
          // ★ 单事实源（2026-09 架构收敛）：只写 status（旧 validity/usage 双字段删除——
          //   曾出现 status=ready + validity=frozen、usage=warming 粘滞的矛盾落盘）。
          status: a.status || 'registered',
          quota: a.quota || null,
          registeredAt: a.registeredAt,
          detectError: a.detectError || null,
          nextResetAt: a.nextResetAt || null,
          limit: a.limit || null, // M2：limitKind 持久化（window/credits/banned + recovery）
          lastProbeAt: a.lastProbeAt || null,
          lastProbeError: a.lastProbeError || null,
        };
      }),
      instances: (this.instances || []).map((i) => (i.toJSON ? i.toJSON() : null)).filter(Boolean),
    };
  }
}

module.exports = { ProviderBase, keyFingerprint, maskKey, normalizeResetTs, fmtClock, monthlyResetAtOf, isQuotaCreditsLow, quotaOverallStatus, PROVIDER_PRESETS, classifyUpstreamLimited, headerRetryMs, bodyResetMs };
