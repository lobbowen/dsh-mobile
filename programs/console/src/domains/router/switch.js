'use strict';

// 供应商独立账号「切换控制器」（SwitchController 职责，M3）：
//  - 选号（selected→sticky→cursor；可用性由 provider.isAccountUsable 提供）
//  - 上游失败反应（reactToFailure）：信号语义（credits/window/banned/transient/none）由
//    provider.classifyResponse 判定；账号处置副作用经 provider.effect 执行；本控制器只决定
//    「是否重试 / 是否透传」。router 其余部分不再持有任何供应商语义分支。
// 绝不跨供应商 failover——每个供应商独立端点只在自己的账号池内选号。

const { headerRetryMs, bodyResetMs } = require('./providers/base');
const { pickEvidenceHeaders, MAX_BODY } = require('./evidence');

class SwitchEngine {
  constructor(opts) {
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.onPersist = opts.onPersist || null; // selected 失效自动清理时持久化
    this.onEvidence = opts.onEvidence || null; // 取证观察者：reactToFailure 对上游 >=400 响应做证据记录（尽力而为旁路）
  }

  /** 在指定供应商的账号池内选择（供应商独立端点语义）：绝不跨供应商 failover，本池无可用返回 null。
   *  opts.excludeKeys=Set → 本请求内瞬时故障（5xx/net-error）账号直接排除，强制轮换不粘滞。 */
  pickFor(provider, opts) {
    if (!provider) return null;
    return this._pickIn(provider, opts);
  }

  /** 本池选择核心（无跨供应商动作）：
   *  1) 用户选定的账号（selected 可用）→ 固定使用；
   *  2) 无 selected → 粘滞上次实际使用（仍可用则继续）；
   *  3) 都不可用 → 轮换下一个可用（cursor；反代仅选实例已运行的账号，未运行由请求按需激活）。 */
  _pickIn(p, opts) {
    const excludeKeys = (opts && opts.excludeKeys && opts.excludeKeys.size) ? opts.excludeKeys : null;
    const usable = (p.accounts || []).filter((a) => p.isAccountUsable(a)).filter((a) => !excludeKeys || !excludeKeys.has(a.key));
    // 锁定失效清理：仅当锁定账号「永久失效」（被删/封号/作废/不存在）才清空锁定——
    // 临时冻结（额度满，nextResetAt 后会恢复）保留锁定：恢复后自动继续用该账号，
    // 避免「自动轮换 → 清锁 → 列表无当前账号」的脱节（2026-09 审计修复）。
    if (p.selectedAccountKeyId) {
      const sel = p.accounts.find((a) => a.keyId === p.selectedAccountKeyId);
      const dead = !sel || sel.status === 'banned' || sel.status === 'discarded' || sel.status === 'registering';
      if (dead) {
        p.selectedAccountKeyId = null;
        if (this.onPersist) this.onPersist();
      }
    }
    if (!usable.length) return null;
    const selId = p.selectedAccountKeyId || null;
    if (selId) {
      const sel = usable.find((a) => a.keyId === selId);
      if (sel) {
        if (typeof p.markInUse === 'function') p.markInUse(sel.keyId); else p.activeAccount = sel;
        if (this.events) this.events.append('router_pick', { provider: p.name, key: sel.maskedKey });
        return sel;
      }
    }
    const cur = p.activeAccount;
    if (cur) {
      const stillUsable = usable.find((a) => a.keyId === cur.keyId);
      if (stillUsable) {
        // 纯粘滞（2026-09 取消高水位让位）：active 仍可用即继续使用，不做额度水位主动切换——
        // 400 根因已定位为实例 env 注入（回归纯默认修复），让位机制是基于错误前提的过度设计补丁。
        // 账号额度耗尽由状态机被动处理（applyDetection 冻结→恢复），选号只保证可用性粘滞。
        if (typeof p.markInUse === 'function') p.markInUse(stillUsable.keyId); else p.activeAccount = stillUsable;
        if (this.events) this.events.append('router_pick', { provider: p.name, key: stillUsable.maskedKey });
        return stillUsable;
      }
    }
    // 轮换仅选「实例已运行」的账号（反代）：未运行实例由请求按需激活（激活失败即冻结），
    // 不主动选未就绪账号——杜绝「选未就绪 → 激活失败 → 再选」的无限切换循环
    const isProxy = p.kind === 'proxy';
    const ready = (a) => !isProxy || !!(a.instance && a.instance.pid);
    const readyUsable = usable.filter(ready);
    const pool = readyUsable.length ? readyUsable : usable; // 无就绪账号时降级全池（请求侧激活）
    const start = (p.cursor || 0) % pool.length;
    const picked = pool[start];
    p.cursor = (p.cursor || 0) + 1;
    if (typeof p.markInUse === 'function') p.markInUse(picked.keyId); else p.activeAccount = picked;
    if (this.events) this.events.append('router_pick', { provider: p.name, key: picked.maskedKey });
    return picked;
  }

  /** M3：上游失败反应（唯一编排点）。
   *  ctx = { status, headers, body, attempt, attempts, error? }
   *  1) provider.classifyResponse 给出 signal；
   *  2) provider.effect 执行账号副作用（credits/window→冻结（proxy 会停实例+预热）、banned→封号；none/transient 无）；
   *  3) 返回 action：'retry'（credits/window/transient；带 transient 标记供调用方定退避）或
   *     'passthrough'（banned/none/unknown → 原样回状态/头/体，绝不误切）。 */
  reactToFailure(provider, acc, ctx) {
    const c = ctx || {};
    const status = c.status;
    const text = String(c.body || '');
    const sig = (provider && typeof provider.classifyResponse === 'function')
      ? provider.classifyResponse(status, c.headers, text)
      : 'none';
    const key = (acc && acc.maskedKey) || '?';
    const base = { signal: sig };
    let res;
    if (sig === 'credits' || sig === 'window') {
      if (sig === 'window') c.retryMs = headerRetryMs(c.headers) || bodyResetMs(text);
      if (provider && provider.effect) provider.effect(sig, acc, c);
      if (this.logger && this.logger.info) this.logger.info(sig === 'credits' ? ('CREDITS-EXHAUSTED key=' + key) : ('QUOTA-EXHAUSTED key=' + key));
      res = Object.assign({ action: 'retry' }, base);
    } else if (sig === 'banned') {
      if (provider && provider.effect) provider.effect(sig, acc, c);
      res = Object.assign({ action: 'passthrough', status, headers: c.headers, body: text, log: 'BANNED key=' + key }, base);
    } else if (sig === 'transient') {
      res = Object.assign({ action: 'retry', transient: true, log: 'TRANSIENT key=' + key + ' status=' + status }, base);
    } else {
      // none / unknown：语义错误或不可判 → 透传，绝不误切（INV-1）
      res = Object.assign({ action: 'passthrough', status, headers: c.headers, body: text }, base);
    }
    this._capture(provider, acc, c, res); // 取证旁路（尽力而为，失败不影响主路径）
    return res;
  }

  /** 取证旁路（2026-09 自动取证）：对上游 status>=400 响应经 onEvidence 观察者落一条脱敏证据
   *  （状态码/白名单头/有界体/信号/动作），供事后核对「这次分类与切换是否合理」。
   *  switch 只通知不写文件——持久化由 RouterService 的 evidence 模块负责。 */
  _capture(provider, acc, c, res) {
    const fn = this.onEvidence;
    if (!fn) return;
    const status = c.status;
    if (!(typeof status === 'number' && status >= 400)) return; // 仅上游拒绝/限额类响应
    try {
      fn({
        ts: new Date().toISOString(),
        providerId: (provider && provider.id) || null,
        provider: (provider && provider.name) || null,
        account: (acc && (acc.maskedKey || acc.keyId)) || null,
        method: c.method || null,
        path: c.path || null,
        status,
        signal: (res && res.signal) || null,
        action: (res && res.action) || null,
        transient: (res && res.transient === true) ? true : null,
        retryMs: (c && c.retryMs) || null,
        attempt: (typeof c.attempt === 'number') ? c.attempt : null,
        attempts: (typeof c.attempts === 'number') ? c.attempts : null,
        error: c.error || null,
        headers: pickEvidenceHeaders(c.headers),
        body: String(c.body || '').slice(0, MAX_BODY),
      });
    } catch (e) { /* 取证尽力而为：绝不干扰转发主路径 */ }
  }
}

module.exports = { SwitchEngine };