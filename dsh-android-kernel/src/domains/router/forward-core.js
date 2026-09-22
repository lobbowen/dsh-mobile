'use strict';

// 转发核心（完整）：代理 + 用量统计 + 流式/断流 + 额度耗尽切换。
// 作为 RouterService 的方法集使用（this 绑定 RouterService 实例）。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const HOP_HEADERS = new Set(['connection','proxy-connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
const { keyFingerprint, maskKey } = require('./providers/base');
// M1（2026-09）：上游响应语义（credits/window/banned/transient/none）由 provider.classifyResponse 判定——
// router 不再持有任何供应商词表/状态码特判（INV-4）；默认实现与覆盖点在 providers/base.js。
/** 读上游响应体（有界：**字节上限 + 时间上限**）：限制判定 / 透传都需要。
 *
 *  ⚠ P2 修复（2026-09-12）：原实现**只有字节上限、没有时间上限** ——
 *    它只监听 `end`/`error`，若上游「先发响应头（4xx/5xx）、再挂住不结束」，
 *    本 Promise **永不 settle**。
 *
 *    更要紧的是**调用时机**：`forwardOnce` 在收到响应头时就会 settle 并清掉
 *    connectGuard/responseGuard，故这次读取发生在**所有超时守卫解除之后** ——
 *    该请求的 handler 会永远 await（客户端连接悬挂、永不返回）。
 *
 *  修法：加 `timeoutMs`（默认 15s）。超时即**带已有内容 resolve**（而不是 reject）——
 *    语义与原实现一致（上游出错时也返回已读到的部分），调用方照常做 classifyResponse。
 *    并顺手 `destroy()`，避免半开的连接残留。
 *
 *  ⚠ 为什么是「带部分内容 resolve」而非「报错」：本函数服务于**错误响应的判定**
 *    （`status >= 400` 分支），此时「读到多少算多少」正是调用方需要的；
 *    若改成 reject，会把一次上游异常升级成 router 自身的异常路径。
 */
function readUpstreamBody(ur, maxBytes, timeoutMs) {
  return new Promise((resolve) => {
    let text = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(text);
    };
    const timer = setTimeout(() => {
      // 时间上限：上游半开（发了头不结束）时保住调用方不悬挂。
      try { ur.destroy(); } catch {}
      finish();
    }, timeoutMs || 15000);
    if (timer.unref) timer.unref();
    ur.on('data', (c) => { if (text.length < (maxBytes || 65536)) text += c; });
    ur.on('end', finish);
    ur.on('error', finish);
    ur.on('close', finish); // 连接被对端关闭但未触发 end/error 的兜底
  });
}

function joinUpstream(base, reqPath, rawQuery) {
  const u = new URL(base);
  let p = reqPath;
  const trimmed = u.pathname.replace(/\/+$/, '');
  if (p.startsWith('/v1') && (trimmed === '/v1' || trimmed.endsWith('/v1'))) p = p.slice(3);
  u.pathname = trimmed + '/' + p.replace(/^\/+/, '');
  u.search = rawQuery || '';
  return u.toString();
}
function extractUsage(text) {
  if (!text) return null;
  let searchFrom = 0, best = null;
  while (true) {
    const usageKey = text.indexOf('"usage"', searchFrom);
    if (usageKey === -1) break;
    const after = text.slice(usageKey + 8);
    if (!after.trimStart().startsWith('{')) { searchFrom = usageKey + 8; continue; }
    const start = text.indexOf('{', usageKey);
    if (start === -1) break;
    let depth = 0, end = -1;
    for (let i = start; i < text.length; i++) { if (text[i] === '{') depth++; else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } } }
    if (end === -1) break;
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      if (obj && typeof obj === 'object' && (obj.prompt_tokens !== undefined || obj.total_tokens !== undefined)) {
        const promptTokens = Number(obj.prompt_tokens) || 0;
        const completionTokens = Number(obj.completion_tokens) || 0;
        let totalTokens = Number(obj.total_tokens) || 0;
        if (!totalTokens) totalTokens = promptTokens + completionTokens;
        const cacheHit = Number(obj.prompt_cache_hit_tokens) || Number(obj.prompt_tokens_details && obj.prompt_tokens_details.cached_tokens) || 0;
        const cacheMiss = Number(obj.prompt_cache_miss_tokens) || Math.max(0, promptTokens - cacheHit);
        if (!best || (obj.total_tokens || 0) > (best.totalTokens || 0)) best = { promptTokens, completionTokens, totalTokens, cacheHit, cacheMiss };
      }
    } catch {}
    searchFrom = usageKey + 8;
  }
  return best;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 按 models.dev 单价估算一次调用的费用（$）。
 *  entry = { model, promptTokens, completionTokens, pricing? }；pricing 为转发时快照的 officialPricing/全局索引。
 *  单价缺失（未同步/未知模型）→ 0（不虚报费用）。
 *  模型名归一化：反代/直连可能带供应商前缀（deepseek/deepseek-v4-flash）→ 去前缀查索引。 */
function estimateCost(entry) {
  const pricing = entry && entry.pricing;
  if (!pricing || typeof pricing !== 'object') return 0;
  let pr = pricing[entry.model];
  if (!pr || typeof pr !== 'object') {
    // 尝试去前缀（deepseek/deepseek-v4-flash → deepseek-v4-flash）
    const slash = String(entry.model || '').indexOf('/');
    const bare = slash > 0 ? String(entry.model).slice(slash + 1) : null;
    if (bare) pr = pricing[bare];
  }
  if (!pr || typeof pr !== 'object') return 0;
  const input = Number(pr.input) || 0;
  const output = Number(pr.output) || 0;
  const pt = Number(entry.promptTokens) || 0;
  const ct = Number(entry.completionTokens) || 0;
  if (!pt && !ct) return 0;
  return (pt / 1e6) * input + (ct / 1e6) * output;
}

/** **实例的唯一解析入口**（P2 修复，2026-09-12）。
 *
 *  ⚠ 为什么需要它：仓内对「账号 → 实例」有**两个事实源**：
 *    · `acc.instance`（账号对象上的内联引用）——
 *      `proxy.js:755` 的注释明确写着「acc.instance 字段已废弃」；
 *    · `prov.instanceOf(acc)`（按 keyId 映射到 instances 列表）。
 *    而 `acc.instance` 曾散落在本文件 **12 处**被读取 ——
 *    （2026-09-12 已全部迁入本函数；此处保留历史说明以便理解为何要有 instOf）。
 *    「同一事实两处表达」正是本仓反复出现问题的形态。
 *
 *    危害（当下未爆发但是定时炸弹）：两条路径维护的是**不同对象**——
 *      `proxy.js` 的停/查路径走 `instances`，而转发/选号路径走 `acc.instance`。
 *      任一侧未来只清一边时，「转发的目标端口」与「对账/端口释放所见的实例」就会不一致
 *      → 转发到已释放端口，或实例泄漏。
 *
 *  修法：本函数统一走 `instanceOf`（它内部 `find(keyId) || acc.instance`，
 *    即**已是两者的安全超集**），故迁移不改变当下行为，只消除分叉风险。
 */
function instOf(prov, acc) {
  if (!acc) return null;
  if (prov && typeof prov.instanceOf === 'function') {
    try { return prov.instanceOf(acc) || null; } catch { /* 回退到内联引用 */ }
  }
  return acc.instance || null;
}

/** 账号/实例目标：返回 { target, prov }（直连=baseUrl，反代=实例端口）。按指定供应商作用域（独立端点不跨池）。 */
function resolveTarget(self, acc, prov) {
  if (!prov) return null;
  if (prov.kind === 'proxy') {
    const inst = instOf(prov, acc);
    if (!inst || !inst.port) return null;
    return { targetBase: 'http://127.0.0.1:' + inst.port, prov };
  }
  // 直连：baseUrl 已含 /v1（如 https://api.test.com/v1）；保持原样，joinUpstream 处理路径去重
  return { targetBase: (prov.baseUrl || '').replace(/\/+$/, ''), prov };
}

const forwardMethods = {
  /** 按指定供应商作用域转发（供应商独立端点核心：各自的 API 地址与账号池，绝不跨池 failover）。 */
  async proxyFor(prov, req, res) {
    const started = Date.now();
    // 独立端点总会带 providerId → prov 必非空；无 provider 直接 502（不存在公用入口回退路径）
    const prov0 = prov ? { prov } : null;
    if (!prov0) { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'no provider' })); }
    const u = new URL(req.url, 'http://127.0.0.1:' + (prov.apiPort || 0));
    let acc = null;
    this.log('REQ method=' + req.method + ' path=' + req.url + ' provider=' + prov0.prov.name);
    let body;
    try { body = await this.readBody(req); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'read body failed' })); }
    let model = 'unknown', streamRequested = false, bodyJson = null;
    try { bodyJson = JSON.parse(body.toString('utf8')); } catch {}
    if (bodyJson) { if (typeof bodyJson.model === 'string') model = bodyJson.model; if (bodyJson.stream === true) streamRequested = true; }
    // 诊断（2026-09 DSH 0.1.2 截断排查）：请求摘要——记录调用方特征（UA/认证头形态，不记敏感值）
    // 与模型/流模式，供对照「DSH 更新前后请求差异」；level=debug 避免刷屏（按需可提 info）
    try {
      if (this.logger && this.logger.debug) {
        const ua = String(req.headers['user-agent'] || '').slice(0, 80);
        const ah = String(req.headers['authorization'] || '');
        const authShape = ah ? (ah.startsWith('Bearer ') ? 'Bearer:' + ah.length : ah.slice(0, 12)) : '(none)';
        const nMsgs = (bodyJson && Array.isArray(bodyJson.messages)) ? bodyJson.messages.length : '?';
        const hasStreamOpts = !!(bodyJson && bodyJson.stream_options);
        this.logger.debug('[req] model=' + model + ' stream=' + streamRequested + ' msgs=' + nMsgs + ' streamOpts=' + hasStreamOpts + ' ua=' + ua + ' auth=' + authShape);
      }
    } catch {}
    let clientAborted = false;
    const onClientCloseEarly = () => { clientAborted = true; };
    res.once('close', onClientCloseEarly);
    const attempts = Math.max((prov0.prov.accounts || []).length, 1);
    let stripInjectionRetried = false, injectedThisAttempt = false;
    const triedKeys = new Set();
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (clientAborted) break;
      acc = this.switcher.pickFor(prov0.prov, { excludeKeys: triedKeys });
      if (!acc || triedKeys.has(acc.key)) break;
      triedKeys.add(acc.key);
      // 关键：按需激活必须在 resolveTarget 之前——实例未启动时 port 为 null，
      // resolveTarget 会返回 null 导致 continue，激活逻辑永远不执行（自动切换死锁）
      const activeProv = prov0.prov;
      const curInst = instOf(activeProv, acc);
      if (activeProv && activeProv.kind === 'proxy' && curInst) {
        activeProv.markUsed(curInst); // 标记使用（闲置回收窗口判断；并发去重由 startInstance 保证）
        if (!curInst.pid) {
          // 按需激活：启动失败/探活超时 → 仅记录并换下一个账号重试，不静默继续转发失败
          const sr = await activeProv.startInstance(curInst).catch((e) => ({ ok: false, error: e && e.message }));
          const ok = sr && sr.ok;
          const healthy = ok ? await activeProv._waitHealthy(curInst).catch(() => false) : false;
          if (!healthy) {
            this.log('INST-START-FAIL key=' + maskKey(acc.key) + ' err=' + ((sr && sr.error) || 'unhealthy'));
            // 启动失败不做任何账号级标记（三态模型）：仅记录，继续换下一个账号重试；
            // 同请求内由 triedKeys 防无限循环；残留进程停掉（资源清理，不算状态）
            if (curInst && curInst.pid) { try { activeProv.stopInstance(curInst); } catch {} }
            continue;
          }
        }
      }
      const rt = resolveTarget(this, acc, prov0.prov);
      if (!rt) continue;
      const attemptTarget = joinUpstream(rt.targetBase, u.pathname, u.search);
      this.log('TRY attempt=' + (attempt + 1) + '/' + attempts + ' key=' + maskKey(acc.key));
      let sendBody = body;
      if (streamRequested && !stripInjectionRetried && bodyJson && !bodyJson.stream_options) {
        try { bodyJson.stream_options = { include_usage: true }; sendBody = Buffer.from(JSON.stringify(bodyJson), 'utf8'); injectedThisAttempt = true; } catch {}
      }
      // 在途计数：真实转发开始 +1（回收/对账据此不全杀在途流）。每个离开路径都配 -1（见下）。
      this._beginInflight(acc);
      const out = await this.forwardOnce(attemptTarget, req.method, req.headers, sendBody, acc.key, res);
      if (clientAborted) { this._endInflight(acc, activeProv); return; }
      if (out.phase === 'net-error') {
        this._endInflight(acc, activeProv);
        const inst = instOf(rt.prov, acc);
        const isTimeout = typeof out.error === 'string' && /timeout/i.test(out.error);
        // P1-2：原为 `rt.prov.markNetFail`（方法不存在 → 恒 no-op）；改用真实方法名。
        if (rt.prov && typeof rt.prov.markInstanceNetFail === 'function') rt.prov.markInstanceNetFail(acc);
        this.log('ERR net fail key=' + maskKey(acc.key) + ' err=' + out.error);
        // 实例级处置【先于清 pid】（2026-09 复检根治：旧序先清 pid 再 markInstanceNetFail → 其内部
        //   `!inst.pid → return` 令请求级熔断成死代码；且上游超时从不重启实例 → 楔死实例每次请求撞上
        //   → 换账号（前端「账号不断切换」实证链路））
        if (activeProv && activeProv.kind === 'proxy' && inst) {
          if (isTimeout && typeof activeProv.restartInstance === 'function') {
            // 连接/响应超时 = 实例疑似卡死（CPU 旋转、completion 挂死而 /health 秒回）：立即实例级重启
            //（restartInstance 带 2min 退避 + kill + 就绪后重拉；本请求继续换账号重试不受阻）
            try { activeProv.restartInstance(inst, 'upstream-timeout'); } catch {}
          } else if (typeof activeProv.markInstanceNetFail === 'function') {
            try { activeProv.markInstanceNetFail(inst); } catch {} // pid 仍在 → 连续 ≥2 次触发重启
          }
        }
        // 连接失败/拒绝（非超时）：实例进程不可达 → 清 pid（残留 pid 阻断按需激活，下次请求冷拉起）；
        // 超时路径由 restartInstance 管理 kill/pid，不在本处清
        if (!isTimeout) {
          try { if (inst && inst.pid) { inst.pid = null; inst.healthy = false; } } catch {}
        }
        if (attempt >= attempts - 1) { this.recordError(); res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'upstream failed', detail: out.error })); }
        continue;
      }
      if (out.phase === 'client-abort') { this._endInflight(acc, activeProv); return; }
      const ur = out.res;
      const status = ur.statusCode;
      if (status === 400 && injectedThisAttempt && !stripInjectionRetried) {
        this._endInflight(acc, activeProv);
        stripInjectionRetried = true; ur.resume(); this.log('RETRY-SANS stream_options key=' + maskKey(acc.key));
        // 关键：循环头「triedKeys.has(acc.key) → break」会拦下本 key，且 pick() 粘滞必选同账号——
        // 不摘除则这次重试永远走不到（死路），对拒绝 stream_options 的上游一律误报 429 耗尽。
        triedKeys.delete(acc.key);
        attempt -= 1; continue;
      }
      // M3：非 2xx 统一交给 SwitchController.reactToFailure —— 唯一「信号→处置→是否重试」编排点。
      // 语义（credits/window/banned/transient/none）由 provider.classifyResponse 判定，
      // 账号副作用由 provider.effect 执行；router 这里只剩运输与重试边界。
      if (status >= 400) {
        this._endInflight(acc, activeProv);
        const text = await readUpstreamBody(ur, 262144);
        const act = this.switcher.reactToFailure(rt.prov, acc, {
          status, headers: ur.headers, body: text, attempt, attempts,
          method: req.method, path: u.pathname, // 取证：上游拒绝响应的请求上下文（无 query，防敏感参数入证据）
          error: status === 401 ? "401 认证失败" : null,
        });
        if (act.action === "retry") {
          if (act.log) this.log(act.log + " key=" + maskKey(acc.key));
          if (attempt >= attempts - 1) {
            if (act.transient) { res.writeHead(status, ur.headers); return res.end(text); }
            continue; // 末次仍 retry（credits/window）→ 循环结束走 EXHAUSTED（保持既有语义）
          }
          await sleep((act.transient ? 150 : 200) + crypto.randomInt(act.transient ? 300 : 600));
          continue;
        }
        if (act.log) this.log(act.log);
        // passthrough（banned/none/unknown）：状态/头/体原样回（effect 已做账号处置）
        res.writeHead(act.status || status, act.headers || ur.headers);
        return res.end(act.body !== undefined ? act.body : text);
      }
      // P1-1 修复（2026-09-12）：**请求确认成功**（2xx 走到这里）才清零失败计数。
      //   此前清零发生在循环头的 markUsed（请求发出**前**），使「连续 ≥2 次失败」
      //   在数学上不可达 —— 请求级熔断是死代码。
      const okInst = instOf(activeProv, acc);
      if (activeProv && activeProv.kind === 'proxy' && okInst
          && typeof activeProv.markRequestOk === 'function') {
        try { activeProv.markRequestOk(okInst); } catch {}
      }
      return this.writeThrough(req, res, out, acc, rt.prov, { started, model, streamRequested, status });
    }
    this.recordError();
    this.log('EXHAUSTED all accounts');
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'all accounts exhausted' }));
  },

  /** 上游→客户端透传：头复制 + 流式转发 + 用量统计（按账号 byKey/byModel，费用按供应商单价快照估算）。 */
  writeThrough(req, res, out, acc, prov, meta) {
    const ur = out.res;
    const status = meta.status;
    const h = { ...ur.headers };
    delete h['transfer-encoding'];
    res.writeHead(status, h);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    let completed = false, bytes = 0, tailText = '';
    // 在途计数：透传阶段持有 inflight（回收/对账不会杀在途流）；完成/中断时释放。
    // 归零 → 若有待停标记则立即补刀（prov 为反代 provider；直连无进程可停，仅记数）。
    const decInflight = () => {
      try {
        if (!acc) return;
        acc.inflight = Math.max(0, (acc.inflight || 0) - 1);
        if (acc.inflight === 0 && acc._stopPendingUntilIdle && prov && typeof prov._retryPendingStop === 'function') prov._retryPendingStop(acc);
      } catch {}
    };
    const destroyUpstream = () => { try { if (out.upstreamReq) out.upstreamReq.destroy(); } catch {} try { ur.destroy(); } catch {} };
    const finishOK = () => {
      if (completed) return;
      completed = true;
      decInflight();
      // 诊断（2026-09 会话中断排查）：流式请求上游正常 end 但流尾缺 [DONE]（DSH 报
      // "Upstream stream ended before terminal chunk"）→ 记录流尾供定位（Command 截断 vs 转发丢失）
      if (meta.streamRequested) {
        try {
          const t = tailText || '';
          const noDone = t.indexOf('[DONE]') < 0;
          const tail = t.slice(-180).replace(/\s+/g, ' ');
          if (noDone && this.logger && this.logger.warn) this.logger.warn('[stream] END-NO-DONE key=' + maskKey(acc.key) + ' bytes=' + bytes + ' tail=...' + tail);
        } catch {}
      }
      const usage = extractUsage(tailText);
      // 诊断（2026-09「输出到一半没了」排查）：请求正常结束但输出 token 极少（<100）——
      // Command 上游可能截断输出但正常 [DONE] 收尾（长请求被软限制到几十 token）。
      // 记录流尾内容以区分：reasoning 空转（只有 reasoning_content）/ 被截断 / 上游返回了什么。
      try {
        const comp = usage ? usage.completionTokens : null;
        const reasoningOnly = comp !== null && comp < 100;
        if (meta.streamRequested && reasoningOnly && this.logger && this.logger.warn) {
          const t = (tailText || '').replace(/\s+/g, ' ').slice(-300);
          this.logger.warn('[stream] SHORT-OUTPUT key=' + maskKey(acc.key) + ' completionTokens=' + comp + ' bytes=' + bytes + ' tail=...' + t);
        }
      } catch {}
      this.recordUsage({ ts: new Date().toISOString(), model: meta.model, key: acc.key, promptTokens: usage ? usage.promptTokens : 0, completionTokens: usage ? usage.completionTokens : 0, totalTokens: usage ? usage.totalTokens : 0, cacheMiss: usage ? usage.cacheMiss : 0, cacheHit: usage ? usage.cacheHit : 0, durationMs: Date.now() - meta.started, status, streamed: meta.streamRequested, usageMissing: !usage, pricing: (prov && prov.kind === 'direct') ? ((prov.officialPricing || null)) : (this.modelPriceIndex || null) });
    };
    const finishAborted = () => {
      if (completed) return;
      completed = true;
      decInflight();
      this.log('STREAM_ABORTED key=' + maskKey(acc.key) + ' bytes=' + bytes);
      // 2026-09 二次修正：上游流中断（aborted/error/close）做【实例级】自愈但【不】做账号级处置。
      //   - markInstanceNetFail → markInstanceProblem 只累加 _unhealthyCount → 连续 ≥2 次断流
      //     才 restartInstance 重启该实例（清坏状态，2min 退避防风暴）——它【不冻结账号/不切走】；
      //   - 曾误删此调用（把"账号级不过度介入"误做成连实例自愈也去掉）→ 断流实例坏状态残留不重启
      //     （如 Kbobt7 health 200 但请求处理卡死，monitor 探活也抓不到）→ 反复 400 的根因之一。
      //
      // ⚠ P1-2 修复（2026-09-12）：此处原调用 `prov.markNetFail(acc)` —— **该方法全仓不存在**，
      //   `typeof ... === 'function'` 恒为 false，故这段自愈**从未执行过**。
      //   与 P1-1 叠加后，断流路径的实例级熔断此前**完全失效**。
      //   现改用真实存在的方法名（proxy.js 提供 markInstanceNetFail，其内部即 markInstanceProblem）。
      if (prov && typeof prov.markInstanceNetFail === 'function') { try { prov.markInstanceNetFail(acc); } catch {} }
      if (this.events) this.events.append('router_stream_aborted', { key: maskKey(acc.key), model: meta.model, bytes });
      // 上游中断仍须通知客户端：res.destroy() 关闭客户端连接（读到截断→客户端自己决定重试，
      // 而不是让 socket 悬空等待（此前缺陷：长会话中断后客户端不提示、无限等待）。
      try { res.destroy(); } catch {}
    };
    ur.on('data', (c) => { bytes += c.length; tailText += c.toString('utf8'); if (tailText.length > 131072) tailText = tailText.slice(-65536); const okToWrite = res.write(c); if (!okToWrite) ur.pause(); });
    res.on('drain', () => ur.resume());
    ur.on('end', () => { finishOK(); res.end(); });
    ur.on('aborted', () => finishAborted());
    ur.on('error', () => finishAborted());
    ur.on('close', () => { if (!ur.readableEnded && !completed) finishAborted(); });
    // 客户端关闭：仅当上游尚未正常结束时视为中断；否则（已 end）跳过，避免抢先置 completed 丢用量
    res.on('close', () => {
      if (completed) return;
      if (ur.readableEnded) return; // 上游已正常结束（finishOK 已触发或即将触发）
      completed = true;
      decInflight();
      // 诊断（2026-09 会话中断排查）：记录客户端(DSH)主动断开——此前完全静默，无法区分中断源
      if (this.logger && this.logger.warn) this.logger.warn('[stream] CLIENT-ABORT key=' + maskKey(acc.key) + ' bytesSent=' + bytes + ' upstreamReadableEnded=' + !!ur.readableEnded + ' content=' + JSON.stringify((tailText || '').slice(0, 400)));
      destroyUpstream();
    });
    return undefined;
  },

  /** 账号请求在途计数（proxyFor 对每次实际转发尝试 +1；对应 writeThrough/错误路径 -1）。
   *  供回收/对账判定「实例在途不回收」——此前 inflight 只读不写（死代码），
   *  实例可能被回收杀在途流。 */
  _beginInflight(acc) { try { if (acc) acc.inflight = (acc.inflight || 0) + 1; } catch {} },
  _endInflight(acc, prov) {
    try {
      if (!acc) return;
      acc.inflight = Math.max(0, (acc.inflight || 0) - 1);
      // 在途归零 → 若有待停标记则立即补刀（取代旧一次性 2.5s timer：命中在途即空放泄漏）
      if (acc.inflight === 0 && acc._stopPendingUntilIdle && prov && typeof prov._retryPendingStop === 'function') {
        prov._retryPendingStop(acc);
      }
      // 在途归零 → 补做「被延后的实例重启」（P1-3 修复的消费点）。
      //   与上面的待停补刀同构：都是「在途期间不能动实例，故记下意图、空闲后执行」。
      //   旧实现只写 `_restartPending` 而**无任何读取点** → 「延后」实为「丢弃」。
      const pendInst = instOf(prov, acc);
      if (acc.inflight === 0 && pendInst && prov && typeof prov.flushRestartPending === 'function') {
        prov.flushRestartPending(pendInst);
      }
    } catch {}
  },

  forwardOnce(target, method, srcHeaders, bodyBuf, key, clientRes) {
    return new Promise((resolve) => {
      const startedAtRef = Date.now();
      let settled = false;
      let connectGuard = null;
      let responseGuard = null;
      const settle = (v) => {
        if (settled) return;
        settled = true;
        if (connectGuard) clearTimeout(connectGuard);
        if (responseGuard) clearTimeout(responseGuard);
        resolve(v);
      };
      const headers = {};
      for (const [k, v] of Object.entries(srcHeaders)) {
        const lk = k.toLowerCase();
        if (HOP_HEADERS.has(lk) || lk === 'host' || lk === 'authorization' || lk === 'content-length') continue;
        headers[lk] = v;
      }
      headers.authorization = 'Bearer ' + key;
      const tu = new URL(target);
      headers.host = tu.host;
      if (!headers['accept-encoding']) headers['accept-encoding'] = 'identity';
      headers['content-length'] = String(bodyBuf.length);
      const agent = tu.protocol === 'https:' ? this._agentHttps : this._agentHttp;
      const mod = tu.protocol === 'https:' ? require('node:https') : require('node:http');
      // 请求级追踪（2026-09 卡死定位）：记录发出时刻 + 响应头到达时刻——下次复现时看请求卡在
      // 「发出后无响应」（上游/实例 stall）还是「根本没发出」（连接失败）。
      if (this.logger && this.logger.debug) this.logger.debug('[fw] send ' + maskKey(key) + ' -> ' + String(target).slice(0, 60));
      const req = mod.request(target, { method, headers, agent }, (ur) => { if (this.logger && this.logger.debug) this.logger.debug('[fw] hdrs ' + maskKey(key) + ' status=' + ur.statusCode + ' after ' + (Date.now() - startedAtRef) + 'ms'); settle({ phase: 'ok', res: ur, upstreamReq: req }); });
      req.setTimeout(0);
      // 连接级守卫（2026-09 恢复——曾误删导致反复 400）：TCP 建连/握手 15s 上限（防黑洞）。
      //   CHANGELOG 0.9.2：15s 防 TCP 黑洞/握手挂死；0.10.0：30s 响应头防「已连接静默」挂死。
      //   响应头到达即由 settle 解除——长流（SSE）不受限（CHANGELOG 明示"长流不限时长"）。
      //   曾误以为守卫会掐超长上下文（首 token>30s）而删除 → 上游/实例黑洞时请求无限挂 → 400。
      connectGuard = setTimeout(() => { const err = new Error('connect timeout after 15s'); req.destroy(err); settle({ phase: 'net-error', error: err.message }); }, 15000);
      // 响应头守卫：180s（放宽自 30s——超长上下文/慢推理首 token 需要更久；仍防「已连接但静默」挂死）
      responseGuard = setTimeout(() => { const err = new Error('response timeout after 180s'); req.destroy(err); settle({ phase: 'net-error', error: err.message }); }, 180000);
      req.on('socket', (s) => { s.setNoDelay(true); s.setKeepAlive(true, 15000); });
      req.on('error', (e) => settle({ phase: 'net-error', error: e.message }));
      const onClientClose = () => settle({ phase: 'client-abort' });
      if (clientRes && typeof clientRes.once === 'function') clientRes.once('close', onClientClose);
      req.on('response', () => clientRes.removeListener('close', onClientClose));
      req.end(bodyBuf);
    });
  },

  recordUsage(entry) {
    const t = this.totals || (this.totals = this._loadTotals());
    t.requests += 1;
    t.promptTokens += entry.promptTokens;
    t.completionTokens += entry.completionTokens;
    t.totalTokens += entry.totalTokens;
    const bm = t.byModel[entry.model] || (t.byModel[entry.model] = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 });
    bm.requests += 1; bm.promptTokens += entry.promptTokens; bm.completionTokens += entry.completionTokens; bm.totalTokens += entry.totalTokens;
    // 费用估算：按本次实际使用供应商的官方单价（models.dev，$/M tokens）累计。
    // entry.pricing 由 proxy() 在转发时快照（账号/供应商可能因 failover 变化，不能用当前 active 反推）。
    const cost = estimateCost(entry);
    if (cost > 0) {
      t.costUsd = (t.costUsd || 0) + cost;
      bm.costUsd = (bm.costUsd || 0) + cost;
    }
    // 按 key 累计（账号维度）：keyFingerprint 为稳定标识，与账号 keyId 一致
    if (entry.key) {
      const kf = keyFingerprint(entry.key);
      const bk = t.byKey[kf] || (t.byKey[kf] = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 });
      bk.requests += 1; bk.promptTokens += entry.promptTokens; bk.completionTokens += entry.completionTokens; bk.totalTokens += entry.totalTokens;
      if (cost > 0) bk.costUsd = (bk.costUsd || 0) + cost; // cost 复用外层单算（estimateCost 同 entry 只算一次）
    }
    this._writeTotals();
    if (this.events) this.events.append('router_usage', { model: entry.model, tokens: entry.totalTokens });
  },

  /** 用量统计原子落盘（工业级：tmp+rename 防崩溃/断电损坏高频用量文件）。 */
  _writeTotals() {
    try {
      const t = this.totals;
      if (!t) return;
      const file = this.usageTotalsFile;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {}
  },

  recordError() {
    const t = this.totals || (this.totals = this._loadTotals());
    t.errors = (t.errors || 0) + 1;
    this._writeTotals();
  },

  _loadTotals() {
    let t;
    try { t = JSON.parse(fs.readFileSync(this.usageTotalsFile, 'utf8')); } catch {}
    if (!t || typeof t !== 'object') t = {};
    // 兼容旧格式（无 byKey/byModel）：补默认字段，防 recordUsage 写入 undefined 崩溃
    t.requests = t.requests || 0;
    t.promptTokens = t.promptTokens || 0;
    t.completionTokens = t.completionTokens || 0;
    t.totalTokens = t.totalTokens || 0;
    t.costUsd = t.costUsd || 0;
    t.errors = t.errors || 0;
    if (!t.byModel || typeof t.byModel !== 'object') t.byModel = {};
    if (!t.byKey || typeof t.byKey !== 'object') t.byKey = {};
    return t;
  },

  getUsage() {
    const t = this.totals || (this.totals = this._loadTotals());
    const byModel = Object.entries(t.byModel || {}).map(([model, v]) => ({ model, ...v })).sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 12);
    return { requests: t.requests, promptTokens: t.promptTokens, completionTokens: t.completionTokens, totalTokens: t.totalTokens, costUsd: t.costUsd, errors: t.errors || 0, byModel, byKey: t.byKey || {} };
  },
};

module.exports = { forwardMethods, maskKey, joinUpstream };