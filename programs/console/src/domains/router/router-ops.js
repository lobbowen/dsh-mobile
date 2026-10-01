'use strict';

// 辅助能力（适配新 provider 结构）：OAuth 登录 / 反代应用更新 / 官方配额与价格同步。
// 以 RouterService 方法集形式混入（this 绑定 RouterService）。

const ports = require('../../guard/lifecycle/ports').shared;
const { PROXY_APPS } = require('./proxy-apps');
const { semverCompare } = require('../dist/index');
// P2-5：脱敏 Key 供「已丢弃」提示（复用 base 的同一实现，不重写第二份）。
const { maskKey } = require('./providers/base');

/**
 * 拉起浏览器完成 OAuth 一键登录（安卓：能力在 HostBridge 侧）。
 *
 * 已删除的 PC 遗留（勿回潮）：
 * · 「隔离 profile + 无痕 + 反指纹参数」（--incognito / --window-size / --lang / TZ·LANG 随机池）
 * —— 安卓容器内没有桌面浏览器二进制，这些参数无处可施；
 * · X11 / Wayland / D-Bus 图形环境变量注入（systemd --user 无桌面会话拉起浏览器）
 * —— 安卓内核没有 systemd、没有显示服务。
 * 浏览器调起由 HostBridge 的 Intent(ACTION_VIEW) 承担；打通前恒定失败，
 * 调用方走「无可用浏览器」分支**明确报错**，绝不静默假装成功。
 *
 * @param {function} [onExit] 浏览器进程退出回调（用户关闭浏览器 → 调用方取消登录、复位状态）。
 * @returns {string|null} 成功返回浏览器 profile 路径（供登录后清理）；失败返回 null。
 */
function openInBrowser(url, onExit) {
  try {
    const platform = require('../../platform/os/index');
    const r = platform.browser.launchIsolated(url, { onExit });
    return r && r.ok ? (r.profileDir || null) : null;
  } catch { return null; }
}

const auxMethods = {
  /* ---- Command Code OAuth 一键登录 ---- */
  async commandcodeLoginStart() {
    const { createServer } = require('node:http');
    const crypto = require('node:crypto');
    const STUDIO_BASE = 'https://commandcode.ai';
    const state = crypto.randomBytes(32).toString('base64url');
    if (this._ccLogin && this._ccLogin.server) {
      const oldState = this._ccLogin.state;
      try { this._ccLogin.server.close(); } catch {}
      if (oldState) { try { ports.unregister('oauth:' + oldState); } catch {} } // 释放旧登录端口
      this._ccLogin = null;
    }
    // 兜底：若上一轮登录 promise 仍 pending（如上次超时/浏览器关闭未及时复位），先取消之
    if (this._ccLoginReject) { try { this._ccLoginReject(new Error('登录已取消（重新发起）')); } catch {} }
    this._ccLoginPromise = null;
    this._ccLoginResolve = null;
    this._ccLoginReject = null;
    let port = null;
    let server = null;
    let base = await ports.allocate('oauthCallback', 'oauth:' + state);
    for (let i = 0; i < 5 && !server && base !== null; i++) {
      port = base + i;
      try {
        const callbackJson = (obj) => JSON.stringify(obj);
        const corsOrigin = (origin) => { const allowed = ['http://localhost:3000', 'https://staging.commandcode.ai', 'https://commandcode.ai']; return allowed.includes(origin) ? origin : allowed[0]; };
        const s = createServer((req, res) => {
          res.setHeader('Access-Control-Allow-Origin', corsOrigin(req.headers.origin));
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          res.setHeader('Content-Type', 'application/json');
          if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
          // 回调路径按 pathname 匹配（兼容合法回调携带 ?state=… / #… 等 query/片段）；
          // 旧实现 req.url !== '/callback' 会把带参回调误判 404（本地回环服务器，必要防御保留）
          const cbPath = String(req.url || '').split('?')[0].split('#')[0];
          if (cbPath !== '/callback') { res.writeHead(404); res.end(callbackJson({ success: false, error: 'Not found' })); return; }
          if (req.method !== 'POST') { res.writeHead(405); res.end(callbackJson({ success: false, error: 'Method not allowed. Use POST.' })); return; }
          let b = '';
          req.on('data', (c) => { b += c; if (b.length > 10000) req.destroy(); });
          req.on('end', () => {
            try {
              const j = JSON.parse(b || '{}');
              if (j && typeof j === 'object' && 'error' in j) {
                res.writeHead(200); res.end(callbackJson({ success: true }));
                if (this._ccLoginReject) { this._ccLoginReject(new Error(j.error_description || j.error || 'Authorization denied')); this._ccLoginReject = null; }
                return;
              }
              const valid = j && typeof j.apiKey === 'string' && typeof j.state === 'string' && typeof j.userId === 'string' && typeof j.userName === 'string' && typeof j.keyName === 'string';
              if (!valid) { res.writeHead(400); res.end(callbackJson({ success: false, error: 'Missing required fields' })); return; }
              if (j.state !== state) { res.writeHead(400); res.end(callbackJson({ success: false, error: 'Invalid state parameter' })); if (this._ccLoginReject) { this._ccLoginReject(new Error('Invalid state parameter')); this._ccLoginReject = null; } return; }
              res.writeHead(200); res.end(callbackJson({ success: true }));
              if (this._ccLoginResolve) { this._ccLoginResolve({ apiKey: j.apiKey, userId: j.userId, userName: j.userName, keyName: j.keyName }); this._ccLoginResolve = null; }
            } catch (e) { res.writeHead(400); res.end(callbackJson({ success: false, error: 'bad request' })); }
          });
        });
        await new Promise((resolve, reject) => {
          const onErr = (err) => { try { s.removeListener('listening', onOk); } catch {}; reject(err); };
          const onOk = () => { try { s.removeListener('error', onErr); } catch {}; resolve(); };
          s.once('error', onErr);
          s.once('listening', onOk);
          s.listen(port, '127.0.0.1');
        });
        server = s;
      } catch {}
    }
    if (!server) {
      // 分配失败必须回滚登记（「分配即登记」配对释放），否则 oauth:<state> 记录永久泄漏、池耗尽。
      try { ports.unregister('oauth:' + state); } catch {}
      return { ok: false, error: '无法启动本地回调端口（oauthCallback 段已满）' };
    }
    // 回退候选（base+i, i>0）实际绑定端口须与登记一致：更正登记到真实 port，避免视图/释放错位。
    if (port !== base) {
      try { ports.unregister('oauth:' + state); } catch {}
      try { ports.allocateMark(port, 'oauthCallback', 'oauth:' + state); } catch {}
    }
    const callbackUrl = 'http://localhost:' + port + '/callback';
    const authUrl = STUDIO_BASE + '/studio/auth/cli?callback=' + encodeURIComponent(callbackUrl) + '&state=' + encodeURIComponent(state);
    // 先建立登录 promise（浏览器 exit 回调需要 Resolve/Reject 就绪）
    const promise = new Promise((resolve, reject) => { this._ccLoginResolve = resolve; this._ccLoginReject = reject; });
    this._ccLoginPromise = promise;
    // 调起浏览器并监测其进程退出：浏览器被关闭 → 立即取消登录（而非干等 180s 超时），
    // 前端随即收到「浏览器已关闭」，按钮恢复，可重新发起一键登录。
    const tmpProfile = openInBrowser(authUrl, () => {
      if (this._ccLoginReject) {
        const r = this._ccLoginReject;
        this._ccLoginReject = null;
        this._ccLoginResolve = null;
        try { r(new Error('浏览器已关闭，登录已取消')); } catch {}
      }
    });
    if (!tmpProfile) {
      // 无可用浏览器：清理回调服务与 promise，明确报错（安卓内核的回调地址是回环地址，
      // 只能由容器/宿主侧 HostBridge 打开，故不再提示"手动打开"）
      this._ccLoginPromise = null;
      this._ccLoginResolve = null;
      this._ccLoginReject = null;
      try { server.close(); } catch {}
      try { ports.unregister('oauth:' + state); } catch {} // 释放本轮登录端口
      this._ccLogin = null;
      return { ok: false, error: '无法调起浏览器（安卓内核需 HostBridge 打开浏览器）: ' + authUrl };
    }
    this._ccLogin = { state, port, server, tmpProfile };
    return { ok: true, authUrl, state, port, waitMs: 180000 };
  },

  async commandcodeLoginWait(timeoutMs) {
    const p = this._ccLoginPromise;
    if (!p) return { ok: false, error: '未在登录中' };
    // 提前保存临时 profile（后续 _ccLogin 会被置 null，finally 需要它做清理）
    const tmpProfile = this._ccLogin ? this._ccLogin.tmpProfile : null;
    const timeout = timeoutMs || 180000;
    try {
      const cred = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('登录超时')), timeout))]);
      if (this._ccLogin && this._ccLogin.server) { const s = this._ccLogin.state; try { this._ccLogin.server.close(); } catch {} if (s) { try { ports.unregister('oauth:' + s); } catch {} } this._ccLogin = null; }
      this._ccLoginPromise = null;
      this._ccLoginResolve = this._ccLoginReject = null;
      return { ok: true, apiKey: cred && cred.apiKey, userId: cred && cred.userId, userName: cred && cred.userName, keyName: cred && cred.keyName };
    } catch (e) {
      if (this._ccLogin && this._ccLogin.server) { const s = this._ccLogin.state; try { this._ccLogin.server.close(); } catch {} if (s) { try { ports.unregister('oauth:' + s); } catch {} } this._ccLogin = null; }
      this._ccLoginPromise = null;
      // P2-6 修复（2026-09-12）：超时/异常分支也必须清理 resolve/reject ——
      // 成功分支清了两者，本分支此前**只清 promise**，`_ccLoginReject` 残留。
      // 而浏览器退出回调读的是**当前** `this._ccLoginReject`（不绑定是哪一轮）：
      // 上一轮超时 → 残留旧 reject → 用户再次发起登录（装入新 reject）→
      // 上一轮的浏览器进程此时退出 → 旧回调取到**新** login 的 reject
      // → 「浏览器已关闭，登录已取消」**误杀新登录**。
      // 清掉后，旧轮次的退出回调找不到 reject，自然 no-op。
      this._ccLoginResolve = this._ccLoginReject = null;
      return { ok: false, error: e.message };
    } finally {
      // 登录结束（成功/失败/超时）：60s 后清理本次登录的临时 profile（浏览器可能仍开着，延迟清理）
      if (tmpProfile) {
        // 2026-09-12：同样加 unref（60s 清理不应拖住进程退出）。
        const t60 = setTimeout(() => { try { require('node:fs').rmSync(tmpProfile, { recursive: true, force: true }); } catch {} }, 60 * 1000);
        if (t60.unref) t60.unref();
      }
    }
  },

  /* ---- 反代应用注册表与更新 ---- */
  proxyApps() {
    return Object.values(PROXY_APPS).map((a) => {
      const c = this.proxyUpdateCache[a.id] || {};
      // 实例已装版本：取所有该 app 实例探活到的最高版本（semver 比较，非字符串）
      const instVers = [];
      for (const p of this.providers || []) {
        if (p.kind === 'proxy' && p.proxyAppId === a.id) {
          for (const inst of (p.instances || [])) if (inst.version) instVers.push(inst.version);
        }
      }
      let installed = null;
      for (const v of instVers) if (!installed || semverCompare(v, installed) > 0) installed = v;
      // 更新判断：semver 严格比较（修复字符串比较误判 0.10.0<0.3.1 等）
      const updateAvailable = !!(c.latest && installed && semverCompare(c.latest, installed) > 0);
      return { id: a.id, name: a.name, pkg: a.pkg, healthPath: a.healthPath, modelPath: a.modelPath, real: !!a.real, upstream: a.upstream, repo: a.repo, registry: a.registry || null, latest: c.latest || null, installed: installed || null, updateAvailable, checkedAt: c.checkedAt || null, error: c.error || null };
    });
  },

  async refreshProxyUpdateInfo(force) {
    const results = {};
    for (const a of Object.values(PROXY_APPS)) {
      if (!a.registry) { results[a.id] = null; continue; }
      const cache = this.proxyUpdateCache[a.id] || {};
      const now = Date.now();
      if (!force && cache.latest && cache.checkedAt && (now - cache.checkedAt) < (a.versionRefreshMs || 6 * 3600 * 1000)) { results[a.id] = cache.latest; continue; }
      let ver = null;
      try { if (this.dist) ver = await this.dist.fetchNpmLatest(a.registry); } catch {}
      const prev = cache.latest || null;
      this.proxyUpdateCache[a.id] = { pkg: a.registry, latest: ver, checkedAt: Date.now(), error: ver ? null : 'query failed' };
      // 仅当存在旧基线且版本真实变化才发事件：prev=null（守卫重启后缓存冷启动首查）
      // 不视为「新版本」（此前每次守卫重启都误报一条 from:null→latest 的假更新）
      if (ver && prev && ver !== prev && this.events) this.events.append('proxy_update_available', { appId: a.id, pkg: a.registry, from: prev, to: ver });
      results[a.id] = ver;
    }
    return results;
  },

  /** 反代更新（job 模型，有状态跟踪）：立即返回 jobId，异步执行 stop→start 各实例，
   * 前端经 proxyUpdateStatus(appId) 轮询进度——消除「黑盒等待」。
   * job = { state: running|done|failed, steps: [{name, state, ts}], restarted, errors, startedAt, finishedAt } */
  async applyProxyUpdate(appId) {
    const a = PROXY_APPS[appId];
    if (!a) return { ok: false, error: 'unknown app ' + appId };
    const targets = this.providers.filter((p) => p.kind === 'proxy' && p.proxyAppId === appId && (p.instances || []).length);
    if (!targets.length) return { ok: false, error: 'no running ' + a.name + ' instances' };
    // 并发去重：同一 app 更新中则复用
    if (this._proxyUpdateJobs && this._proxyUpdateJobs[appId] && this._proxyUpdateJobs[appId].state === 'running') {
      return { ok: true, jobId: appId, already: true };
    }
    const insts = targets.flatMap((provider) => (provider.instances || []).map((i) => ({ provider, inst: i })));
    const job = {
      state: 'running', startedAt: Date.now(), finishedAt: null, restarted: 0, errors: 0,
      steps: insts.map(({ inst }) => ({ name: inst.maskedKey, state: 'pending', ts: null })),
    };
    this._proxyUpdateJobs = this._proxyUpdateJobs || {};
    this._proxyUpdateJobs[appId] = job;
    // 统一任务：proxy-app/update
    let task = null;
    if (this.tasks) {
      task = this.tasks.begin('proxy-app', 'update', { id: appId, name: a.name }, { to: a.registry, createdBy: 'user' });
      this.tasks.start(task.id);
      this.tasks.log(task.id, '更新 ' + a.name + '（' + a.registry + '）');
      // P2-1 修复（2026-09-12）：**把逐实例步骤登记进 task**。
      //
      // 缺陷：此前只维护 `job.steps`，**从未调用 `tasks.step()`** ——
      // 而 `proxyUpdateStatus` 优先读 task 分支（只要 tasks 已注入就必然命中），
      // 于是返回的 steps 恒为空数组、restarted（= task.steps 中 done 的个数）恒 0。
      // 前端「逐实例进度」名为实现、实为死数据；只有 `this.tasks` 未注入时才走 job 分支 ——
      // 同一事实两处实现且已分叉。
      //
      // 现：每个实例在 task 里登记一个 step，进度按 index 同步推进；
      // 仍保留 `job.steps`（job 分支与既有测试依赖），但两者由同一处更新，不再分叉。
      for (const { inst } of insts) this.tasks.step(task.id, inst.maskedKey);
      job.taskId = task.id;
    }
    (async () => {
      // 0) 清除该 app 的 npx 缓存——强制重新拉取最新版（否则 startInstance 用旧缓存版本，更新无效）
      try {
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const npxDir = path.join(os.homedir(), '.npm', '_npx');
        if (fs.existsSync(npxDir)) {
          for (const d of fs.readdirSync(npxDir)) {
            if (!/^[0-9a-f]{8,}$/i.test(d)) continue;
            const pkgDir = path.join(npxDir, d, 'node_modules', a.pkg);
            if (fs.existsSync(pkgDir)) {
              try { fs.rmSync(path.join(npxDir, d), { recursive: true, force: true }); } catch {}
            }
          }
        }
        // 同步清 ProxyProvider 的缓存定位（其 _cachedPkgBin 读磁盘，删除后自然失效）
      } catch {}
      // 步骤状态同步辅助（P2-1）：job.steps（供 job 分支/测试）与 task.steps（供前端）同源更新。
      const setStep = (i, state) => {
        job.steps[i].state = state; job.steps[i].ts = Date.now();
        if (task) { try { this.tasks.stepState(task.id, i, state); } catch {} }
      };
      // 1) 停止全部实例
      for (let i = 0; i < insts.length; i++) {
        const { provider, inst } = insts[i];
        setStep(i, 'stopping');
        try { provider.stopInstance(inst); } catch (e) { job.errors++; setStep(i, 'failed'); }
      }
      await new Promise((r) => setTimeout(r, 600));
      // 2) 逐个启动
      for (let i = 0; i < insts.length; i++) {
        const { provider, inst } = insts[i];
        if (!inst.key) { job.errors++; setStep(i, 'failed'); continue; }
        setStep(i, 'starting');
        const r = await provider.startInstance(inst);
        if (r.ok) {
          job.restarted++;
          // 探活拿新版本（刷新 version，避免前端显示旧版本误报「需更新」）
          await provider._waitHealthy(inst).catch(() => false);
          setStep(i, 'done');
        }
        else { job.errors++; setStep(i, 'failed'); }
      }
      for (const provider of targets) provider.proxyRunning = true;
      this._save();
      job.state = job.errors === 0 ? 'done' : 'failed';
      job.finishedAt = Date.now();
      if (this.events) this.events.append('proxy_update_applied', { appId, restarted: job.restarted, errors: job.errors });
      this.proxyUpdateCache[appId] = Object.assign({}, this.proxyUpdateCache[appId], { appliedAt: Date.now() });
      if (task && this.tasks) {
        if (job.state === 'done') { this.tasks.log(task.id, '更新完成，重启 ' + job.restarted + ' 个实例'); this.tasks.succeed(task.id); }
        else this.tasks.fail(task.id, '更新失败（' + job.errors + ' 个实例错误）');
      }
    })().catch((e) => {
      // 兜底：意外 rejection 不得让 job 永卡 running（否则该 app 后续更新被并发去重永久挡死）
      job.state = 'failed'; job.finishedAt = Date.now(); job.errors++;
      if (this.logger && this.logger.warn) this.logger.warn('applyProxyUpdate 异常: ' + e.message);
      if (task && this.tasks) this.tasks.fail(task.id, '更新异常: ' + (e && e.message));
    });
    return { ok: true, jobId: appId };
  },

  /** 反代更新进度查询（前端轮询；兼容视图，优先读统一任务）。
   * 优先返回该 appId 最近一次任务（含已完成），保证前端完成态可见；
   * 无历史任务时回退 _proxyUpdateJobs。 */
  proxyUpdateStatus(appId) {
    const t = this.tasks ? this.tasks.list('proxy-app').find((x) => x.target.id === appId) : null;
    if (t) {
      return {
        // 任务状态→前端契约映射：前端判定 done/failed（succeeded/skipped→done，failed/canceled→failed）
        state: (t.state === 'succeeded' || t.state === 'skipped') ? 'done' : (t.state === 'failed' || t.state === 'canceled') ? 'failed' : 'running',
        restarted: (t.steps.filter((s) => s.state === 'done')).length,
        errors: t.state === 'failed' ? 1 : 0,
        startedAt: t.startedAt, finishedAt: t.finishedAt,
        steps: t.steps.map((s) => ({ name: s.name, state: s.state })),
        taskId: t.id,
      };
    }
    const job = this._proxyUpdateJobs && this._proxyUpdateJobs[appId];
    if (!job) return { error: 'no update job for ' + appId };
    return {
      state: job.state, restarted: job.restarted, errors: job.errors,
      startedAt: job.startedAt, finishedAt: job.finishedAt,
      steps: job.steps.map((s) => ({ name: s.name, state: s.state })),
    };
  },

  /* ---- 官方配额与价格同步（直连供应商）---- */
  async refreshOfficialUsageAll() {
    for (const p of this.providers) {
      if (p.kind !== 'direct') continue;
      for (const acc of p.accounts || []) {
        if (!acc.key) continue;
        try { const det = await p.detectAccount(acc); p.applyDetection(acc, det); } catch {}
      }
    }
  },

  async refreshProviderQuota(providerId) {
    const p = this.getProvider(providerId);
    if (!p) return { ok: false, error: '供应商不存在' };
    if (p.kind === 'direct') {
      for (const acc of p.accounts || []) { if (!acc.key) continue; try { const det = await p.detectAccount(acc); p.applyDetection(acc, det); } catch {} }
    } else {
      for (const inst of p.instances || []) {
        try { const det = await p.detectInstanceQuota(inst); const acc = p.accountOf(inst); if (acc) p.applyDetection(acc, det); } catch {}
      }
    }
    this._save();
    if (this.events) this.events.append('provider_quota_refreshed', { provider: providerId });
    return { ok: true };
  },

  /* ---- 官方单价同步（models.dev）：直连供应商按 adapter.pricing 源抓权威单价 + 全局模型定价索引（反代模型计费）----
   * 反代供应商（如 Command Code 反代）暴露的模型均为官方模型（Claude/GPT 系）——
   * 按模型名从 models.dev 的 anthropic/openai 等索引精确取价，供费用估算。 */
  async refreshOfficialPricingAll() {
    const sources = new Map(); // 直连供应商的 models.dev provider
    for (const pr of this.providers) {
      if (pr.kind !== 'direct') continue;
      const ps = pr.adapter && pr.adapter.pricing;
      if (ps && ps.type === 'models-dev' && ps.provider) sources.set(ps.provider, ps.provider);
    }
    try {
      const j = await (await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(20000) })).json();
      // 直连：按 provider 抓官方价
      let directModels = 0;
      for (const provKey of sources.values()) {
        const go = j[provKey];
        const models = (go && go.models) ? go.models : (go || {});
        const pricing = {};
        for (const [mk, mv] of Object.entries(models)) {
          const c = mv && (mv.cost || mv.pricing);
          if (c && typeof c === 'object') {
            pricing[mk] = { input: (c.input !== undefined) ? Number(c.input) : 0, output: (c.output !== undefined) ? Number(c.output) : 0, cache_read: (c.cache_read !== undefined) ? Number(c.cache_read) : 0 };
            directModels++;
          }
        }
        for (const pr of this.providers) {
          if (pr.kind !== 'direct') continue;
          const ps = pr.adapter && pr.adapter.pricing;
          if (ps && ps.type === 'models-dev' && ps.provider === provKey) pr.officialPricing = pricing;
        }
      }
      // 全局模型定价索引：全量抓取 models.dev 所有供应商（207 provider / 7482 模型）——
      // 反代/直连转发的任意官方模型（deepseek/claude/gpt 系）按模型名查价
      const index = {};
      for (const [provKey, go] of Object.entries(j || {})) {
        const models = (go && go.models) ? go.models : (go || {});
        for (const [mk, mv] of Object.entries(models)) {
          if (index[mk]) continue; // 已收录（首个命中为准）
          const c = mv && (mv.cost || mv.pricing);
          if (c && typeof c === 'object') {
            const input = (c.input !== undefined) ? Number(c.input) : 0;
            const output = (c.output !== undefined) ? Number(c.output) : 0;
            if (input > 0 || output > 0) index[mk] = { input, output };
          }
        }
      }
      this.modelPriceIndex = index;
      this._save();
      return { ok: true, models: directModels, indexModels: Object.keys(index).length };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  /* ---- 账号/供应商管理辅助 ---- */
  // P2-5：改为 async —— `added` 需 await 每个 addAccount 的真实结果（见函数内说明）。
  async setProviderKeys(id, opts) {
    const p = this.getProvider(id);
    if (!p) return { ok: false, error: '供应商不存在' };
    const rm = new Set((opts && opts.removeMasked) || []);
    const before = (p.accounts || []).length;
    // P2-4 修复（2026-09-12）：删除反代账号时**必须做与 removeProxyKey 同等的收尾**。
    //
    // 缺陷：本函数此前只 `filter(accounts)` —— 对 **proxy 类**供应商而言，
    // `stopInstance` / `ports.unregister('proxy:'+keyId)` / `p.instances` 同步**全都没做**，
    // 而 `removeProxyKey`（下方）三者齐备。同一事实两处实现且已分叉。
    //
    // 后果：经公开 API `POST /router/providers/keys/set {removeMasked:[...]}`
    // （api/router.js 只校验 id、**不校验 kind**）删掉反代账号 → 实例进程继续跑、
    // `proxy:<keyId>` 端口记录永久残留；而该 keyId 已不在 accounts，
    // `accountOf` 恒 null → orphan 实例/端口**再无释放路径**，最终耗尽代理池。
    //
    // 修法：对将被移除的 proxy 账号逐个执行与 removeProxyKey 相同的收尾。
    const doomed = (p.accounts || []).filter((a) => rm.has(a.maskedKey));
    if (p.kind === 'proxy') {
      for (const a of doomed) {
        if (a.instance) {
          // P1 修复（2026-09-13）：删除路径必须 force（见 index.js removeProvider 说明）——
          // 下面紧接就已把账号从 accounts 摘除，延迟停标记将变为不可达 → 进程永久泄漏。
          try { p.stopInstance(a.instance, true); } catch {}
          try { ports.unregister('proxy:' + a.keyId); } catch {}
          a.instance.port = null;
        }
      }
    }
    p.accounts = (p.accounts || []).filter((a) => !rm.has(a.maskedKey));
    if (p.kind === 'proxy') {
      const gone = new Set(doomed.map((a) => a.keyId));
      p.instances = (p.instances || []).filter((i) => !gone.has(i.keyId));
    }
    const removed = before - p.accounts.length;
    // P2-5 修复（2026-09-12）：`added` 必须反映**真实结果**，不是「发起了几次尝试」。
    //
    // 缺陷：此前的 `p.addAccount(t).catch(() => {}); added++;` **不 await** ——
    // `addAccount` 内部要 await `detectAccount`，失败时会把账号置 `discarded`
    // （base.js:245-249）。于是返回的 `added: N` 可能对应「N 个全被 discarded」，
    // 而 UI 直接把它读成「已添加 N 个 Key」（client.ts 的 `added?: number`）——
    // 提示与视图不一致，用户以为加成功了。
    //
    // 修法：逐个 await，按真实结果分类返回：
    // · added —— 注册成功（含 ready / frozen-limited 等合规状态）；
    // · discarded —— 检测失败被丢弃（带原因，供 UI 如实提示）。
    // 本函数因此变为 async；调用方（api/router.js）已用 Promise.resolve(...).then() 包装，
    // 故无需改动路由。
    // 并发**保持**原语义：每个 addAccount 都要起实例 + 探活 + 取配额（秒级），
    // 逐个 await 会让 N 个 Key 串行等 N 倍时间。故用 Promise.all 并发，
    // 只是**等齐结果**再统计（这正是原实现缺的那一步）。
    const candidates = ((opts && opts.add) || [])
      .map((k) => String(k).trim())
      .filter((t) => t && !p.accounts.some((a) => a.key === t));
    const settled = await Promise.all(candidates.map((t) =>
      Promise.resolve()
        .then(() => p.addAccount(t))
        .catch((e) => ({ ok: false, error: (e && e.message) || String(e) }))
        .then((res) => ({ t, res }))
    ));
    const addedList = [];
    const discardedList = [];
    for (const { t, res } of settled) {
      if (res && res.ok) addedList.push(res.account ? res.account.maskedKey : maskKey(t));
      else discardedList.push({ key: maskKey(t), error: (res && res.error) || '未知错误' });
    }
    this._save();
    return {
      ok: true,
      keys: p.accounts.length,
      added: addedList.length,
      removed,
      // 新增字段（向后兼容）：被丢弃的 Key 及原因 —— 让 UI 能如实告知「N 个里 M 个失败」。
      discarded: discardedList.length,
      discardedKeys: discardedList,
    };
  },

  async setSelectedProxyKey(providerId, keyId) {
    const p = this.getProvider(providerId);
    if (!p) return { ok: false, error: '供应商不存在' };
    const acc = (p.accounts || []).find((a) => a.keyId === keyId);
    if (!acc) return { ok: false, error: '账号不存在' };
    // 锁收敛（2026-09 A）：锁只对可用账号有意义——冻结/额度用尽账号拒绝锁定（防死锁落盘/UI 死锁徽标）
    if (acc.status !== 'ready' || (typeof p.isAccountUsable === 'function' && !p.isAccountUsable(acc))) {
      return { ok: false, error: '账号当前不可用（' + (acc.status === 'ready' ? '额度用尽' : acc.status) + '），无法锁定' };
    }
    // 记录原状态：激活失败时回滚（避免「提交后失败 → 坏账号粘滞 → 本供应商 429 循环」）
    const prevSelected = p.selectedAccountKeyId || null;
    // 账号选定是供应商内语义（独立端点按各自供应商账号池选号，无全局激活供应商概念）
    p.selectedAccountKeyId = keyId;
    this._save();
    // 切换即确保目标实例拉起（即时反馈，避免「切到未就绪实例 → 502 循环」）：
    // 实例未运行 → 异步激活；启动/探活失败 → 返回明确错误（不改选中，可换账号）
    if (p.kind === 'proxy' && acc.instance && !acc.instance.pid) {
      const sr = await p.startInstance(acc.instance).catch((e) => ({ ok: false, error: e && e.message }));
      const ok = sr && sr.ok;
      const healthy = ok ? await p._waitHealthy(acc.instance).catch(() => false) : false;
      if (!healthy) {
        if (acc.instance.pid) { try { p.stopInstance(acc.instance); } catch {} }
        // 回滚已提交的 selected（保持状态一致；文案同步为真实语义）
        p.selectedAccountKeyId = prevSelected;
        this._save();
        const errMsg = '实例启动失败（' + ((sr && sr.error) || '探活超时') + '），已取消切换并回滚';
        if (this.logger && this.logger.warn) this.logger.warn('[select] ' + errMsg + ' key=' + (acc.maskedKey || keyId) + ' sr=' + JSON.stringify(sr));
        return { ok: false, error: errMsg };
      }
    }
    return { ok: true, selected: keyId };
  },

  async switchToKey(providerId, keyId) {
    // 临时切换也确保实例拉起（激活失败 → 明确错误，避免 502 循环）
    return this.setSelectedProxyKey(providerId, keyId);
  },

  removeProxyKey(providerId, keyId) {
    const p = this.getProvider(providerId);
    if (!p) return { ok: false, error: '供应商不存在' };
    const idx = (p.accounts || []).findIndex((a) => a.keyId === keyId);
    if (idx < 0) return { ok: false, error: '账号不存在' };
    if (p.kind === 'proxy' && p.accounts[idx].instance) {
      // P1 修复（2026-09-13）：删除路径必须 force（见 index.js removeProvider 说明）。
      try { p.stopInstance(p.accounts[idx].instance, true); } catch {}
      // 删除账号：释放持久化端口绑定（registry 登记 + inst.port）
      try { ports.unregister('proxy:' + keyId); } catch {}
      p.accounts[idx].instance.port = null;
    }
    p.accounts.splice(idx, 1);
    if (p.kind === 'proxy') p.instances = (p.instances || []).filter((i) => i.keyId !== keyId);
    this._save();
    return { ok: true };
  },

  addProxyKey(providerId, key) {
    const p = this.getProvider(providerId);
    if (!p || p.kind !== 'proxy') return { ok: false, error: '供应商不存在或非反代' };
    return p.addAccount(key);
  },

  /* ---- review 账号人工裁决：入池 / 作废（状态前置原则的收口） ---- */
  confirmAccount(providerId, keyId) {
    const p = this.getProvider(providerId);
    if (!p) return { ok: false, error: '供应商不存在' };
    return p.confirmAccount(keyId);
  },

  discardAccount(providerId, keyId) {
    const p = this.getProvider(providerId);
    if (!p) return { ok: false, error: '供应商不存在' };
    return p.discardAccount(keyId);
  },
};

module.exports = { auxMethods };