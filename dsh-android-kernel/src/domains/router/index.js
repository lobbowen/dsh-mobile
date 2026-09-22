'use strict';

// 智能路由底座（RouterService）：中转服务整体生命周期 + 对外 API + 状态监控。
//  - 无公用/默认入口：每个已激活供应商持有自己独立的 API 端点（端口/账号池隔离）；
//  - 供应商集合管理（直连/反代，各自独立隔离）；
//  - 账号生命周期（注册/检测/入池/作废/冻结/释放）转发到对应 provider；
//  - 公用切换引擎（SwitchEngine）驱动自动切换；统一持久化（RouterStore）。

const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { DirectProvider } = require('./providers/direct');
const { ProxyProvider } = require('./providers/proxy');
const { SwitchEngine } = require('./switch');
const { RouterStore } = require('./store');
const { quotaOverallStatus } = require('./providers/base');
const { PROXY_APPS } = require('./proxy-apps');
const { UpstreamEvidence } = require('./evidence');
const { semverCompare } = require('../dist/index');
const ports = require('../../guard/lifecycle/ports').shared;

class RouterService {
  constructor(opts) {
    this.config = opts.config;
    this.dist = opts.dist || null;
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.tasks = opts.tasks || null; // 统一安装/更新任务注册表（反代应用更新接入）
    this.providerFile = opts.providerFile;
    this.usageTotalsFile = opts.usageTotalsFile || null; // 账号统计持久化文件（byKey/请求/Token 累计）
    // 自动取证（2026-09）：上游限流/拒绝响应证据 JSONL（与 providers.json 同目录，测试经 providerFile 天然隔离）
    this.evidenceFile = opts.evidenceFile || (this.providerFile ? path.join(path.dirname(this.providerFile), 'router-upstream-evidence.jsonl') : null);
    // ⚠ 2026-09-12（P1-3）：取证改为**显式 opt-in**（默认关）。
    //
    //   此前它**无条件启用**，但整条链路**零消费点**：
    //     · 产出：本文件 onEvidence → switch._capture（对上游 >=400）→ evidence.append；
    //     · 读取：evidenceTail/evidenceStats **全仓无调用方**，surface.js 未登记任何路由，
    //       前端 grep evidence = 0。
    //   即：持续按 4MB 轮转写 JSONL，却没有任何出口可读回 ——
    //     而 append 每次做 statSync + appendFileSync，**同步执行在转发主路径上**（4xx/5xx）。
    //
    //   模块自身头部也写着「（2026-09，下一步）」—— 它是**为后续工作预留的脚手架**，
    //   尚未接线。故不删除（设计已完成且有测试），但不再让它对主路径征税：
    //     需要者显式传 `evidenceEnabled: true`（或后续补上读取出口时默认开）。
    this.evidenceEnabled = opts.evidenceEnabled === true;
    this.evidence = (this.evidenceFile && this.evidenceEnabled) ? new UpstreamEvidence({ file: this.evidenceFile }) : null;
    // 端口注册表隔离：直接构造 RouterService（测试/嵌入）注入 portsFile → 使用独立记录文件，
    // 绝不触碰生产 ports.json（守卫路径已由 Supervisor.configureFile 指向同域文件，此处跳过）
    if (opts && opts.portsFile) ports.configureFile(opts.portsFile);
    this._stopped = false; // 服务停止闸门：仅 stop() 置 true；start()/直接维护调用不受限（_stopped=true 时异步 ensure/探测不得再拉起实例，防孤儿占端口）
    this._persistEnabled = true; // 状态文件写开关：router-daemon 独占写 providers.json 时（守卫监督模式）置 false 防双写覆盖
    this._providerServers = {}; // 供应商独立端点：id -> http.Server（激活供应商监听自己的 providerApi 端口）
    this.store = new RouterStore({ file: this.providerFile });
    this.providers = [];
    this._running = false; // 中转服务逻辑开关；每供应商独立端点由 activated 控制（无公用/默认入口）
    this.ring = [];
    this.ringMax = 800;
    this.proxyUpdateCache = {};
    this.modelPriceIndex = null; // 全局模型定价索引（models.dev，反代模型按名查价；refreshOfficialPricingAll 填充）
    this._maintTimer = null;
    this._pricingTimer = null;
    this._agentHttp = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 128 });
    this._agentHttps = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 128 });
    this._load();
    this.switcher = new SwitchEngine({
      logger: this.logger,
      events: this.events,
      // ⚠ 2026-09-12：原 `getProviders: () => this.providers` 已删除 ——
      //   `SwitchEngine` 构造函数接收它但**从不读取**（switch.js 内零引用），
      //   属「声明了能力但零消费」。删除以免读者以为 switch 会回查 provider 列表
      //   （它实际只经 pickFor 的回调拿数据，不持有该引用）。
      onPersist: () => this._save(),
      onEvidence: this.evidence ? (rec) => { if (!this.evidence.append(rec) && this.logger && this.logger.debug) this.logger.debug('[evidence] append failed'); } : null,
    });
  }

  /* ---- 持久化 ---- */
  _load() {
    const doc = this.store.load();
    this.providers = (doc.providers || []).map((p) => this._deserializeProvider(p));
    // 恢复持久化 apiPort 的占用登记（owner=providerApi:<id>；防同端口重复分配）。
    // 无公用入口/默认入口逻辑：每个供应商是否提供独立端点完全由持久化的 activated 决定。
    for (const p of this.providers) {
      if (p.apiPort) { try { if (!ports.isRegistered(p.apiPort)) ports.registerUser(p.apiPort, 'providerApi:' + p.id); } catch {} }
    }
  }

  _deserializeProvider(p) {
    // stateDir：数据目录（由 config.stateFile 派生）—— 供 provider 落盘/落日志，**不得**各自 os.homedir()（D7）。
    const common = { id: p.id, name: p.name, logger: this.logger, events: this.events, dist: this.dist, onPersist: () => this._save(), stateDir: this.config && this.config.stateFile ? path.dirname(this.config.stateFile) : null, apiPort: p.apiPort || null, activated: p.activated === true };
    let prov;
    if (p.kind === 'proxy') {
      prov = new ProxyProvider({ ...common, kind: 'proxy', proxyAppId: p.proxyAppId, app: PROXY_APPS[p.proxyAppId] || null });
      prov.proxyRunning = !!p.proxyRunning;
      const { ProxyInstance } = require('./instances/proxy-instance');
      prov.instances = (p.instances || []).map((i) => {
        const inst = ProxyInstance.fromJSON(i);
        inst.app = PROXY_APPS[p.proxyAppId] || null;
        inst.logger = this.logger;
        inst.events = this.events;
        return inst;
      });
    } else {
      prov = new DirectProvider({ ...common, kind: 'direct', baseUrl: p.baseUrl || '', plan: p.plan || null, pricing: p.pricing || {}, adapter: p.adapter || null, presetId: p.presetId || null });
    }
    // 统一恢复持久化锁定（直连/反代共用；反代旧数据 selectedProxyKeyId 兼容迁移）
    prov.selectedAccountKeyId = p.selectedAccountKeyId || p.selectedProxyKeyId || null;
    // ★ 统一状态机恢复（account-state-rework）：恢复「当前在用账号」与每账号使用状态
    //   ——旧数据无 activeAccountKeyId/usage 时安全降级（active 待首个请求重新标；usage 默认 idle），
    //   账号 key/配额等字段逐项恢复，绝不丢弃。
    const restoredActiveId = p.activeAccountKeyId || null;
    prov.accounts = (p.accounts || []).map((a) => {
      const acc = {
        key: a.key || null,
        keyId: a.keyId,
        maskedKey: a.maskedKey,
        // ★ 单事实源（2026-09 架构收敛）：只读 status——旧 validity 字段删除（曾 status+validity 双写分叉）；
        //   usage 不反序列化（纯派生，由 usageOf 从 activeAccount/实例实况算）。
        status: a.status || a.validity || 'registered',
        quota: a.quota || null,
        registeredAt: a.registeredAt || Date.now(),
        detectError: a.detectError || null,
        nextResetAt: a.nextResetAt || null,
        limit: a.limit || null, // M2：limitKind 恢复（window/credits/banned + recovery）
        lastProbeAt: a.lastProbeAt || null,
        lastProbeError: a.lastProbeError || null,
        instance: prov.kind === 'proxy' ? (prov.instances.find((i) => i.keyId === a.keyId) || null) : null,
      };
      // 恢复在用指向：持久化的 active 账号若存在 → 恢复 activeAccount（粘滞 + 前端锁定显示）
      if (restoredActiveId && a.keyId === restoredActiveId) prov.activeAccount = acc;
      return acc;
    });
    // 锁收敛（2026-09 A）：加载不复活对不可用账号的死锁（残留 selected 指向冻结账号 → 丢弃，下次落盘清除）
    if (typeof prov._reconcileLock === 'function') { try { prov._reconcileLock(); } catch {} }
    return prov;
  }

  _save() {
    if (this._persistEnabled === false) return; // L3：状态文件由 router-daemon 独占写（守卫监督模式不写，防双写覆盖）
    // ⚠ P2/P3 修复（2026-09-13）：providers.json 解析失败后**禁止回写**。
    //   缺陷：store.load() 曾把「解析失败」与「本来就是空」混为一谈（静默返回空列表），
    //     而本类在启动维护阶段会立刻 _save()，把「空」覆盖回文件 →
    //     一次外部损坏/半写即让**全部供应商与账号配置（含 API Key）静默清零且不可恢复**。
    //   现 store 在解析失败时置 loadedOk=false 并保留 .corrupt-<ts> 现场；
    //   本处在 loadedOk=false 时跳过写盘，给人修复/恢复的机会（并已由 store 记 error 日志）。
    if (this.store && typeof this.store.canPersist === 'function' && !this.store.canPersist()) {
      if (this.logger && this.logger.warn) {
        this.logger.warn('router save skipped：providers.json 读取异常（已保留现场），拒绝用空态覆盖');
      }
      return;
    }
    try { this.store.save(this.providers); }
    catch (e) { this.logger.warn && this.logger.warn('router save failed: ' + e.message); }
  }

  /** L3：设置状态文件写开关（true=本实例写；false=只读，由外部 router-daemon 独占写）。 */
  setPersistEnabled(v) { this._persistEnabled = v !== false; }

  /* ---- 中转服务生命周期（已无公用入口：仅管理维护与供应商独立端点） ---- */
  get running() { return this._running; }

  start() {
    if (this._running) return Promise.resolve({ ok: true, already: true });
    this._running = true;
    this._stopped = false;
    for (const p of this.providers) { if (p && p.kind === 'proxy') p._stopping = false; }
    this._startMaintenance();
    return this._startActivatedProviders().then(() => {
      if (this.events) this.events.append('router_started', { providers: this.providers.length });
      return { ok: true };
    }).catch((e) => ({ ok: false, error: e.message }));
  }

  _stopAll() {
    this._running = false;
    this._stopped = true; // 先置闸：在途/后续的 ensure/预热/探测不得再拉起实例
    for (const p of this.providers) { if (p && p.kind === 'proxy') p._stopping = true; } // 预启动拒绝 + spawn 完成即自清
    this._stopMaintenance();
    this.stopAllInstances(); // 服务停止 = 实例一并停止（防孤儿进程残留占用动态端口段）
    for (const id of Object.keys(this._providerServers)) this._stopProviderServer(id); // 供应商独立端点一并关闭
    if (this.events) this.events.append('router_stopped', {});
    return { ok: true };
  }

  stop() { return this._stopAll(); }

  /** 优雅退出（router-daemon shutdown 专用，2026-09 根治停服孤儿化）：停实例并【确认子进程已死】
   *  再返回——stopInstance 的 SIGKILL 兜底是 unref 1.5s 定时器，daemon 随即 process.exit 会令其随
   *  进程消亡永不触发 → 子进程孤儿化、stdio 管道死（426880/677630 两次实锤，adopt 复用即楔死/EPIPE）。
   *  经各反代 provider.waitAllStopped 轮询 _terminatingPids，未退即 SIGKILL 兜底。 */
  async stopAndWait(timeoutMs) {
    this._stopAll();
    for (const p of this.providers) {
      if (p && p.kind === 'proxy' && typeof p.waitAllStopped === 'function') {
        try { await p.waitAllStopped(timeoutMs || 3000); } catch {}
      }
    }
    return { ok: true };
  }

  /** 停止全部反代实例进程（测试收尾 / 守卫优雅退出用）：防止子进程残留占用
   *  41000+ 动态端口段（历史上 ensure-instance / p2p-api 泄漏过 verproxy / dry-run 子进程）。
   *  进程态不落盘，重启后由 _ensureProxyInstances 按需重建；账号端口绑定（persisted）保留。 */
  stopAllInstances() {
    // force=true：服务停服/优雅退出，无视在用/在途仲裁强制停——否则在用账号实例被 defer 逃脱关停
    // → daemon 退出即孤儿（停服孤儿化根因①：426880/677630/795363 三次实锤）
    for (const p of this.providers) {
      if (p.kind !== 'proxy') continue;
      for (const i of (p.instances || [])) { try { p.stopInstance(i, true); } catch {} }
    }
  }

  /* ---- 周期维护：反代自动更新检测 / 官方配额与单价同步 / 冻结实例到点释放 ----
   *  旧 KeyPool 时代 5min 定时检查 npm 版本 + 同步官方 /usage + models.dev 单价；
   *  重分层到 RouterService 后这些定时器曾丢失，此处恢复（启动拉一次 + 周期循环）。 */
  _startMaintenance() {
    // 启动即拉一次：反代版本检查（内部自带 6h TTL）+ 官方配额 + 官方单价
    this.refreshProxyUpdateInfo().catch(() => {});
    this.refreshOfficialUsageAll().catch(() => {});
    this.refreshOfficialPricingAll().catch(() => {});
    // 进程态不落盘 → 重启后自动拉起全部非冻结反代实例（拉起后探活拿版本，驱动版本徽标/自动更新）
    this._ensureProxyInstances().catch(() => {});
    if (this._maintTimer) clearInterval(this._maintTimer);
    this._maintTimer = setInterval(() => {
      this.refreshProxyUpdateInfo().catch(() => {});
      this._probeAccountStatesIfDue(); // 账号状态轮询（1h + 临近精确触发）+ 闲置实例回收
      this._ensureProxyInstances().catch(() => {});
    }, 5 * 60 * 1000);
    // 实例生命周期监控（30s 轻量：纯进程/端口检查，无 HTTP——及时清死进程 pid，adopt 实例无 exit 事件）
    if (this._lifecycleTimer) clearInterval(this._lifecycleTimer);
    this._lifecycleTimer = setInterval(() => { this._monitorProxyInstancesHealth().catch(() => {}); }, 30 * 1000);
    // 启动 10s 后再做账号状态轮询（避开启动瞬间与实例保障并发拉进程）
    setTimeout(() => { this._probeAccountStatesIfDue(); }, 10 * 1000);
    if (this._pricingTimer) clearInterval(this._pricingTimer);
    this._pricingTimer = setInterval(() => this.refreshOfficialPricingAll().catch(() => {}), 6 * 3600 * 1000);
  }

  _stopMaintenance() {
    if (this._maintTimer) { clearInterval(this._maintTimer); this._maintTimer = null; }
    if (this._pricingTimer) { clearInterval(this._pricingTimer); this._pricingTimer = null; }
    if (this._lifecycleTimer) { clearInterval(this._lifecycleTimer); this._lifecycleTimer = null; }
  }

  /** 实例生命周期监控（2026-09 分层原则）：只查进程/端口（生命周期层），不探业务。
   *  发现实例进程死/端口消失 → 清 pid（adopt 实例无 exit 事件，需周期发现），由请求按需激活重建。 */
  async _monitorProxyInstancesHealth() {
    for (const p of this.providers) {
      if (p.kind === 'proxy' && typeof p.monitorLifecycle === 'function') {
        try { await p.monitorLifecycle(); } catch (e) { this.logger.warn && this.logger.warn('monitorLifecycle: ' + (e && e.message)); }
      }
    }
  }

  /** 单个供应商实例对账（幂等 reconcile）：
   *  期望运行集 = 常驻 1（resident，ready+usable）＋ 至多 1 备胎（仅当有可用账号额度将耗尽 ≥80%）。
   *  取代旧 _ensureProviderInstances（只保 primary，不与回收对账）与旧 _stopIdleProxyInstances
   *  （独立回收，与预热相向打架）——启停现在只有一个决策者（见 providers/proxy.js reconcile 注释）。 */
  async _ensureProviderInstances(p) {
    if (!p || p.kind !== 'proxy') return;
    if (typeof p.reconcileInstances === 'function') {
      await p.reconcileInstances().catch(() => {});
    }
  }

  /** 反代实例对账（周期/启动/激活）：只对「已激活」供应商执行（未激活不提供服务）。 */
  async _ensureProxyInstances() {
    if (this._stopped) return; // 服务停止闸门：禁止异步对账复活实例
    for (const p of this.providers) {
      if (p.kind !== 'proxy' || p.activated !== true) continue;
      await this._ensureProviderInstances(p);
    }
  }

  /** 账号状态轮询（状态机核心）：每小时全量 + nextResetAt 临近精确触发。
   *  对每个账号调官方检测（直连 usage API / 反代 commandcode billing）→ applyDetection：
   *  恢复自动解冻、仍限额保持冻结并更新精确恢复时间、401/禁用标 banned、报错记 lastProbeError。
   *  反代检测：临时激活实例 → 查真实状态 → 检测完停用（非活跃账号），资源消耗最低。 */
  _probeAccountStates() {
    // in-flight 去重：单轮探测可能超过 5min 周期与下一轮重叠（并发探测同一账号，违背自身防风控目标）
    if (this._probeRunning) return Promise.resolve();
    this._probeRunning = true;
    return this._probeAccountStatesInner().catch((e) => { if (this.logger && this.logger.warn) this.logger.warn('probeAccountStates: ' + e.message); }).finally(() => { this._probeRunning = false; });
  }

  async _probeAccountStatesInner() {
    if (this._stopped) return; // 服务停止闸门
    for (const p of this.providers) {
      if (p.kind === 'proxy' && p.activated !== true) continue; // 未激活供应商不探测/不临时起实例
      for (const acc of (p.accounts || [])) {
        if (acc.status === 'registering' || acc.status === 'review' || acc.status === 'discarded') continue;
        try {
          let det;
          if (p.kind === 'proxy') {
            const inst = acc.instance || (p.instances || []).find((i) => i.keyId === acc.keyId);
            if (!inst) continue;
            // 是否期望运行账号（常驻/备胎，由 reconcile 期望集同源判定——取代旧 primary 概念）
            const isDesired = (typeof p.isDesiredAccount === 'function') ? p.isDesiredAccount(acc) : false;
            // 探测最小化（倒计时机制，防风控）：非活跃账号不临时激活——
            // 仅当 ① 稳定活跃（实例常驻/期望集）② 实例已在跑（请求激活中）
            // ③ 冻结且 nextResetAt 到点/临近（≤ now+5min，倒计时结束才探测一次确认释放）
            // 未到点的冻结账号一律不探测（避免高频调 billing/usage 触发风控封号）
            // 【2026-09 修复】nextResetAt 缺失的冻结账号：立即探测一次确认真实额度——
            // 曾补默认 5h + continue（永不探测）→ quota 早已恢复的账号被永久错冻
            // （2NVZWA 实测：quota 正常但 frozen+at:null+nextResetAt:null 卡死，手动 refresh 才解冻）。
            // 立即探测能正确解冻（额度恢复）或带真实恢复点重冻；探测失败才补兜底倒计时。
            const nearReset = acc.nextResetAt && acc.nextResetAt <= Date.now() + 5 * 60 * 1000;
            // missingReset：frozen 且无 nextResetAt → 也需立即探测（确认真实额度，见上修复注释）
            const missingReset = acc.status === 'frozen' && !acc.nextResetAt;
            const needProbe = acc.status === 'frozen' && (nearReset || missingReset);
            if (!isDesired && !inst.pid && !needProbe) continue;
            const wasRunning = !!inst.pid;
            if (!inst.pid) await p.startInstance(inst).catch(() => {});
            det = await p.detectInstanceQuota(inst).catch((e) => ({ ok: false, error: e.message }));
            // 检测完停用：仅期望运行账号保持运行（临时激活的检测实例即停）
            if (!wasRunning && !isDesired) p.stopInstance(inst);
          } else {
            det = await p.detectAccount(acc).catch((e) => ({ ok: false, error: e.message }));
          }
          p.applyDetection(acc, det);
        } catch {}
      }
    }
  }

  /** 是否有 frozen/limited 账号临近解冻（nextResetAt ≤ now+5min）→ 需提前精确触发检测。 */
  _hasImminentReset() {
    const now = Date.now() + 5 * 60 * 1000;
    for (const p of this.providers) {
      for (const a of (p.accounts || [])) {
        if ((a.status === 'frozen' || a.status === 'limited') && a.nextResetAt && a.nextResetAt <= now) return true;
        // 2026-09 修复：frozen 且无恢复点 → 视为 imminent（5min tick 即触发探测，无 1h 闸）——
        // 立即确认真实额度，避免「quota 已恢复但无恢复点」的账号被永久错冻（2NVZWA 实测）
        if ((a.status === 'frozen' || a.status === 'limited') && !a.nextResetAt) return true;
      }
    }
    return false;
  }

  /** 实例对账（2026-09 架构收敛：启停唯一决策者）：
   *  期望运行集 = 常驻 1（resident，ready+usable）＋ 至多 1 备胎（仅当任一可用账号额度将耗尽 ≥80%）。
   *  对账 = 期望集实例拉起（幂等）＋ 其余无在途实例停止（幂等）。
   *  取代旧「回收（_stopIdleProxyInstances）+ 预热（_prewarmByQuota）两条相向路径」——
   *  旧预热只看 percent≥80 不看可用性 → 预热已限额账号 → 回收同 tick 停掉 → 5min 启停死循环（实况 41012）。 */
  _stopIdleProxyInstances() {
    for (const p of this.providers) {
      if (p.kind !== 'proxy' || p.activated !== true) continue;
      try { p.reconcileInstances().catch(() => {}); } catch {}
    }
  }

  /** 维护周期入口：每 5min 触发。
   *  倒计时机制（防风控——不周期全量探测供应商 API）：
   *  - 精确触发：任一 frozen/limited 账号 nextResetAt ≤ now+5min（到点/临近）→ 探测该批账号；
   *  - 低频兜底：1h 一次，仅探测 nextResetAt 已过但未恢复的账号（防倒计时计算失误漏恢复）。
   *  其余账号一律不探测（避免高频调用 billing/usage 触发风控封号）。 */
  _probeAccountStatesIfDue() {
    const now = Date.now();
    // 本地倒计时计算（不探测 API）：frozen 账号从 quota.resetsAt 推算 nextResetAt——
    // 历史冻结/重启后倒计时缺失的账号在此补齐，到点后精确触发探测
    for (const p of this.providers) {
      for (const a of (p.accounts || [])) {
        if (a.status === 'frozen' && !a.nextResetAt && typeof p._nextResetAt === 'function') {
          const nr = p._nextResetAt(a.quota);
          if (nr.t) a.nextResetAt = nr.t; // 补齐倒计时（缺失时兜底；有既有值不覆写）
        }
      }
    }
    // 使用中账号每 10 分钟刷新（信息化管理）：ready 账号定期检测额度——
    // ① 跟踪额度消耗（80% 预热信号）② 额度耗尽及时标记。冻结账号不周期探测（倒计时）。
    if (!this._lastRefreshAt || now - this._lastRefreshAt >= 10 * 60 * 1000) {
      this._lastRefreshAt = now;
      this._refreshReadyAccounts().catch(() => {});
    }
    const due = this._hasImminentReset(); // 到点/临近精确触发
    const overdue = this._hasOverdueReset(); // 1h 兜底：已过未恢复
    if (due || (!this._lastProbeAt || now - this._lastProbeAt >= 3600 * 1000) && overdue) {
      this._lastProbeAt = now;
      this._probeAccountStates().catch(() => {});
    }
    this._stopIdleProxyInstances();
  }

  /** 刷新 ready（使用中）账号额度：检测 + 80% 预热信号（未冻结账号预热实例）。 */
  _refreshReadyAccounts() {
    if (this._refreshRunning) return Promise.resolve();
    this._refreshRunning = true;
    return this._refreshReadyAccountsInner().catch(() => {}).finally(() => { this._refreshRunning = false; });
  }

  async _refreshReadyAccountsInner() {
    if (this._stopped) return; // 服务停止闸门
    for (const p of this.providers) {
      if (p.kind === 'proxy' && p.activated !== true) continue; // 未激活供应商不轮询/不预热实例
      for (const acc of (p.accounts || [])) {
        if (acc.status !== 'ready') continue;
        try {
          let det;
          if (p.kind === 'proxy') {
            const inst = acc.instance || (p.instances || []).find((i) => i.keyId === acc.keyId);
            if (!inst) continue;
            // 10min 刷新只探测「已在运行」的账号（常驻/备胎/在用）——
            // 不临时拉起全部 ready 账号做额度检测（2026-09 审计修复：原实现每 10min 批量
            // 临时启动所有未跑 ready 账号 → 探测 → 停止，形成周期性进程启停风暴 + EADDRINUSE 窗口）。
            // 未跑账号的额度在按需启动 / 切换时即时检测；备胎由 reconcile（期望集）在刷新后统一收敛。
            if (!inst.pid) continue;
            det = await p.detectInstanceQuota(inst).catch((e) => ({ ok: false, error: e.message }));
          } else {
            det = await p.detectAccount(acc).catch((e) => ({ ok: false, error: e.message }));
          }
          p.applyDetection(acc, det);
        } catch {}
      }
    }
    // 不在此处单独触发 reconcile——_probeAccountStatesIfDue 周期末尾的 _stopIdleProxyInstances()
    // 已统一对账（含补起+回收）；此处只做额度探测/状态机更新，避免同 tick 内重复 reconcile。
    // 不再在单账号循环里触发预热（旧 _prewarmByQuota 只看 percent 不看可用性 → 预热-回收死循环根因）。
  }

  /** 是否存在 nextResetAt 已过但未恢复的 frozen/limited 账号（1h 低频兜底触发）。 */
  _hasOverdueReset() {
    const now = Date.now();
    for (const p of this.providers) {
      for (const a of (p.accounts || [])) {
        if ((a.status === 'frozen' || a.status === 'limited') && a.nextResetAt && a.nextResetAt <= now) return true;
        // 2026-09 修复：frozen 但恢复点缺失（nextResetAt=null）→ 视为需立即确认真实额度
        // （曾永久错冻：quota 已恢复但无恢复点永不探测，2NVZWA 实测卡死）
        if ((a.status === 'frozen' || a.status === 'limited') && !a.nextResetAt) return true;
      }
    }
    return false;
  }

  /* ---- 请求处理：仅供应商独立端点（不存在公用/默认入口） ---- */
  /** 供应商独立端点请求处理：按 providerId 作用域转发（该供应商自己的账号池）。 */
  handleForProvider(providerId, req, res) {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    const prov = this.getProvider(providerId);
    if (!prov) { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'provider not found' })); }
    this.proxyFor(prov, req, res).catch(() => { try { res.end(); } catch {} });
  }

  _newServer(handler) {
    const server = http.createServer(handler);
    server.requestTimeout = 0;
    server.headersTimeout = 30000;
    server.keepAliveTimeout = 65000;
    server.on('connection', (socket) => { socket.setNoDelay(true); socket.setKeepAlive(true, 15000); });
    return server;
  }

  /** 激活供应商：启动其独立 API 端点（未激活不提供服务）。 */
  async activateProvider(id) {
    const p = this.getProvider(id);
    if (!p) return { ok: false, error: '供应商不存在' };
    if (!p.activated) {
      p.activated = true;
      // 独立 API 端口：激活时分配（绑定一次防漂移；停用保留，再激活复用）
      if (!p.apiPort) {
        try { p.apiPort = await ports.allocate('providerApi', 'providerApi:' + id); } catch (e) { p.apiPort = null; }
        if (p.apiPort) { try { if (!ports.isRegistered(p.apiPort)) ports.registerUser(p.apiPort, 'providerApi:' + id); } catch {} }
      }
      // 工业标准（2026-09 池重构）：池满必须显式失败——绝不静默「激活了但无端点」。
      // p.apiPort 为空 = providerApi 池耗尽；回滚 activated 位并返回显式 ErrFull（含容量）。
      if (!p.apiPort) {
        p.activated = false;
        const cap = (ports.capacity && ports.capacity().providerApi) || null;
        if (this.events) { try { this.events.append('router_provider_activation_failed', { id, name: p.name, error: 'providerApi 端口池耗尽', capacity: cap }); } catch {} }
        return { ok: false, error: 'providerApi 端口池耗尽（' + (cap ? cap.free + ' 空闲 / ' + cap.size + ' 总量' : '满') + '），请扩 portPools.providerApi 或停用部分供应商', poolFull: true, capacity: cap };
      }
      if (p.kind === 'proxy') this._ensureProviderInstances(p).catch(() => {});
      this._startProviderServer(id);
      if (this.events) this.events.append('router_provider_activated', { id, name: p.name, port: p.apiPort });
      this._save();
    }
    return { ok: true, id, activated: true, apiPort: p.apiPort };
  }

  /** 停用供应商：关闭独立端点 + 停止其反代实例（资源回收）；apiPort 保留，再激活复用。 */
  deactivateProvider(id) {
    const p = this.getProvider(id);
    if (!p) return { ok: false, error: '供应商不存在' };
    if (p.activated) {
      p.activated = false;
      this._stopProviderServer(id);
      if (p.kind === 'proxy') { for (const i of (p.instances || [])) { try { p.stopInstance(i); } catch {} } }
      if (this.events) this.events.append('router_provider_deactivated', { id, name: p.name });
      this._save();
    }
    return { ok: true, id, activated: false };
  }

  _startProviderServer(id) {
    const p = this.getProvider(id);
    if (!p || p.activated !== true || !p.apiPort) return;
    if (this._providerServers[id]) return;
    const server = this._newServer((req, res) => this.handleForProvider(id, req, res));
    server.on('error', (err) => { this.log('provider endpoint ' + p.name + ' error: ' + err.message); delete this._providerServers[id]; });
    server.listen(p.apiPort, '127.0.0.1', () => {
      this._providerServers[id] = server;
      if (this.events) this.events.append('router_provider_endpoint', { id, name: p.name, port: p.apiPort });
      this.log('provider endpoint ' + p.name + ' on ' + p.apiPort);
    });
  }

  _stopProviderServer(id) {
    const s = this._providerServers[id];
    if (!s) return;
    delete this._providerServers[id];
    try { s.close(() => {}); if (typeof s.closeAllConnections === 'function') s.closeAllConnections(); } catch {}
  }

  /** 守卫/路由器启动恢复：已激活供应商端点 + 反代主实例常驻（幂等）。
   *  兼容迁移：旧激活供应商可能尚无 apiPort → 启动时补分配（此后持久化，重启复用）。 */
  async _startActivatedProviders() {
    for (const p of this.providers) {
      if (p.activated !== true) continue;
      if (!p.apiPort) {
        try {
          p.apiPort = await ports.allocate('providerApi', 'providerApi:' + p.id);
          if (p.apiPort && !ports.isRegistered(p.apiPort)) ports.registerUser(p.apiPort, 'providerApi:' + p.id);
        } catch (e) { p.apiPort = null; }
        if (p.apiPort) this._save();
      }
      this._startProviderServer(p.id);
      if (p.kind === 'proxy') await this._ensureProviderInstances(p).catch(() => {});
    }
  }

  log(line) {
    this.ring.push(line);
    if (this.ring.length > this.ringMax) this.ring.splice(0, this.ring.length - this.ringMax);
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 104857600) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  /* ---- 状态/查询 ---- */
  status() {
    const t = this.totals || (this.totals = this._loadTotals());
    let keysTotal = 0;
    const provs = this.providers.map((p) => {
      const accounts = (p.accounts || []);
      keysTotal += accounts.length;
      return { id: p.id, name: p.name, kind: p.kind, proxyAppId: p.proxyAppId || null, accounts: accounts.map((a) => ({ maskedKey: a.maskedKey, keyId: a.keyId, status: a.status, quota: a.quota || null, nextResetAt: a.nextResetAt || null })), proxyRunning: p.proxyRunning || false };
    });
    return {
      running: this._running === true, // 中转服务逻辑开关（无公用入口；启用即提供已激活供应商的独立端点）
      activatedProviders: this.providers.filter((x) => x.activated).length, // 已激活供应商数（独立端点在线数）
      providers: provs,
      keysTotal,
      usage: this.getUsage(),
    };
  }

  /** 域摘要（R4：router-daemon 黑盒经 ctl 向守卫目录呈报的紧凑摘要，目录只存引用）。
   *  内容：运行态 / providers 数 / 已激活独立端点数 / 账号数 / 反代实例数 / 自治资源端口记录数。
   *  守卫侧每监督拍(≈30s)拉取并写 router-daemon 目录项 domainSummary（只读缓存，不持久化）；
   *  不在摘要内暴露账号明细/令牌/额度——黑盒内部数据仍只经既有 /router/* 实时 API。 */
  domainSummary() {
    let providers = 0;
    let activatedProviders = 0;
    let accounts = 0;
    let proxyInstances = 0;
    for (const p of this.providers || []) {
      providers += 1;
      if (p.activated === true) activatedProviders += 1;
      accounts += (p.accounts || []).length;
      proxyInstances += (p.instances || []).length;
    }
    let resourcePorts = 0;
    try {
      resourcePorts = (ports.list() || []).filter((r) => String(r.owner || '').startsWith('proxy:') || String(r.owner || '').startsWith('providerApi:')).length;
    } catch {}
    return {
      runState: this._running === true ? 'running' : 'stopped',
      providers,
      activatedProviders,
      accounts,
      proxyInstances,
      resourcePorts,
    };
  }

  /** 资源端口视图（阶段迁移 S1，2026-09）：router 自治资源的端口段（proxyInstance+providerApi），
   *  由 router 自供并经 ctl 暴露——守卫不经手、不自建视图（黑盒边界）。
   *  按 owner 前缀筛；附 TCP active 探测（实时监听态）。 */
  async portsView() {
    const probe = require('../../guard/monitor/probe');
    const recs = ports.list().filter((r) => String(r.owner || '').startsWith('proxy:') || String(r.owner || '').startsWith('providerApi:'));
    const active = await Promise.all(recs.map((r) => probe.portListening('127.0.0.1', r.port, 300)));
    return { records: recs.map((r, i) => ({ port: r.port, role: r.role, owner: r.owner, createdAt: r.createdAt, active: !!active[i] })) };
  }

  listProviders() {
    // 配额总览标签单源（2026-09 债务清理）：与 proxy 检测端同一 quotaOverallStatus（修复视图/检测措辞分叉）
    const t = this.totals || (this.totals = this._loadTotals());
    const byKey = (t && t.byKey) || {};
    return this.providers.map((p) => {
      // 当前在用/锁定账号（统一派生：显式锁定 selectedAccountKeyId 优先，否则自动在用 activeAccount）——
      // 保证账号行 selected、头部 activeKeyId、实例行 selected 完全同源（此前口径分裂导致列表不亮当前账号）
      const activeKeyId = (p.selectedKeyId ? p.selectedKeyId() : (p.selectedAccountKeyId || (p.activeAccount && p.activeAccount.keyId))) || null;
      const accounts = (p.accounts || []).map((a) => {
        const ku = byKey[a.keyId];
        const usageOf = (typeof p.usageOf === 'function') ? p.usageOf(a) : 'idle';
        return {
          keyId: a.keyId,
          maskedKey: a.maskedKey,
          status: a.status,                       // ★ 单事实源（validity 字段已删除）
          validity: a.status,                     // 兼容字段（=status，避免旧前端读 undefined）
          usage: usageOf,                          // ★ 纯派生（activeAccount/实例实况）
          quota: a.quota || null,
          limit: (p._ensureLimit ? p._ensureLimit(a) : a.limit) || null, // M2：limitKind+recovery（旧数据即时归一，前端展示受限原因与恢复方式）
          nextResetAt: a.nextResetAt || null, // 恢复倒计时目标（前端可显示「X 后恢复」）
          registeredAt: a.registeredAt,
          detectError: a.detectError || null,
          selected: activeKeyId === a.keyId,
          locked: !!p.selectedAccountKeyId && p.selectedAccountKeyId === a.keyId,
          inUse: usageOf === 'in-use' || (p.activeAccount && p.activeAccount.keyId === a.keyId), // ★ 在用（无论显式锁/自动）
          requests: (ku && ku.requests) || 0,
          totalTokens: (ku && ku.totalTokens) || 0,
          usable: p.isAccountUsable ? p.isAccountUsable(a) : false,
          quotaStatus: quotaOverallStatus(a && a.quota),
        };
      });
      const view = {
        id: p.id,
        name: p.name,
        kind: p.kind,
        activated: p.activated === true, // 供应商独立端点是否激活（未激活不提供服务）
        apiPort: p.apiPort || null,       // 独立 API 端点端口（内部绑定保留，停用后不提供地址）
        apiBase: (p.activated && p.apiPort) ? ('http://127.0.0.1:' + p.apiPort + '/v1') : null, // 仅激活时下沉该供应商的独立 API 地址
        accounts,
        exhausted: accounts.length > 0 && !accounts.some((a) => a.usable),
      };
      if (p.kind === 'proxy') {
        view.proxyAppId = p.proxyAppId || null;
        view.proxyRunning = p.proxyRunning || false;
        view.selectedAccountKeyId = p.selectedAccountKeyId; // 持久化锁定（null=未手动锁）
        view.locked = !!p.selectedAccountKeyId;             // 区分「显式锁定」vs「自动在用」
        // 账号视图附加实例态（一账号一实例：账号行展示实例健康/版本/端口）
        const instByKey = {};
        for (const i of p.instances || []) instByKey[i.keyId] = i;
        const appVer = (this.proxyUpdateCache && this.proxyUpdateCache[p.proxyAppId] && this.proxyUpdateCache[p.proxyAppId].latest) || null;
        for (const a of view.accounts) {
          const inst = instByKey[a.keyId];
          if (inst) {
            a.instanceStatus = inst.status;
            a.healthy = !!inst.healthy;
            a.version = inst.version || null;
            a.updateAvailable = !!(appVer && inst.version && semverCompare(appVer, inst.version) > 0);
          }
        }
        view.instances = (p.instances || []).map((i) => ({
          keyId: i.keyId,
          maskedKey: i.maskedKey,
          status: i.status,
          healthy: i.healthy,
          quota: i.quota || null,
          version: i.version || null,
          selected: activeKeyId === i.keyId,
        }));
      } else {
        view.baseUrl = p.baseUrl || '';
        view.plan = p.plan || null;
        view.pricing = p.pricing || {};
        view.activeAccountKeyId = p.activeAccount ? p.activeAccount.keyId : null;
        view.activeAccountMasked = p.activeAccount ? p.activeAccount.maskedKey : null;
        view.locked = !!p.selectedAccountKeyId;
      }
      view.activeKeyId = activeKeyId; // 当前在用/锁定账号 keyId（前后端同源锚点）
      return view;
    });
  }

  /* ---- 供应商 CRUD ---- */
  addDirectProvider(opts) {
    const { PROVIDER_PRESETS } = require('./providers/base');
    const preset = (opts && opts.presetId) ? (PROVIDER_PRESETS.find((x) => x.id === opts.presetId) || null) : null;
    const baseUrl = (opts && opts.baseUrl) || (preset ? preset.baseUrl : '') || '';
    let existing = this.providers.find((p) => p.kind === 'direct' && p.baseUrl === baseUrl);
    if (!existing && preset) existing = this.providers.find((p) => p.kind === 'direct' && p.presetId === preset.id);
    if (existing) {
      for (const k of (opts && opts.keys) || []) { const t = String(k).trim(); if (t && !existing.accounts.some((a) => a.key === t)) existing.addAccount(t).then(() => this._save()).catch(() => {}); }
      this._save();
      return { ok: true, id: existing.id, already: true };
    }
    const p = new DirectProvider({ id: 'prov-' + Date.now() + '-' + Math.floor(Math.random() * 1000), name: opts.name || (preset ? preset.name : '供应商'), kind: 'direct', baseUrl, plan: preset ? { ...preset.plan } : null, pricing: preset ? { ...preset.pricing } : {}, adapter: preset ? preset.adapter : null, presetId: preset ? preset.id : null, logger: this.logger, events: this.events, dist: this.dist, onPersist: () => this._save() });
    this.providers.push(p);
    for (const k of (opts && opts.keys) || []) { const t = String(k).trim(); if (t && !p.accounts.some((a) => a.key === t)) p.addAccount(t).then(() => this._save()).catch(() => {}); }
    this._save();
    return { ok: true, id: p.id };
  }

  addProxyProvider(opts) {
    const app = PROXY_APPS[opts && opts.appId];
    if (!app) return { ok: false, error: '未知反代应用 ' + (opts && opts.appId) };
    let p = this.providers.find((x) => x.kind === 'proxy' && x.proxyAppId === app.id);
    let created = false;
    if (!p) {
      p = new ProxyProvider({ id: 'prov-' + Date.now() + '-' + Math.floor(Math.random() * 1000), name: opts.name || app.name, kind: 'proxy', proxyAppId: app.id, app, logger: this.logger, events: this.events, dist: this.dist, onPersist: () => this._save() });
      p.proxyRunning = true;
      this.providers.push(p);
      created = true;
    }
    for (const k of (opts && opts.keys) || []) { const t = String(k).trim(); if (t && !p.accounts.some((a) => a.key === t)) p.addAccount(t).then(() => this._save()).catch(() => {}); }
    this._save();
    return { ok: true, id: p.id, created, added: (opts && opts.keys) ? opts.keys.length : 0 };
  }

  removeProvider(id) {
    const idx = this.providers.findIndex((p) => p.id === id);
    if (idx < 0) return { ok: false, error: '供应商不存在' };
    const removed = this.providers.splice(idx, 1)[0];
    this._stopProviderServer(id); // 删除即停用：关闭其独立端点
    // ⚠ P1 修复（2026-09-13，失效模式 g）：**删除路径必须 force 停实例**。
    //   缺陷：stopInstance(inst) 不带 force 时，若账号 ready+可用且被 selected/activeAccount
    //     指向（正是在用的最常见态），proxy.js:374 只置 _stopPendingUntilIdle 就 return，**不 kill**；
    //     而本函数紧接着把整个 provider 从 this.providers 摘除 ——
    //     延迟标记所在对象随即**不可达**，reconcile/monitor 再也看不到该实例，
    //     补刀路径（_retryPendingStop / 周期停循环）也无从触发。
    //   后果：正在服务、持用户 API Key 并占用端口的反代实例进程**永不被回收**（端口登记已释放，
    //     注册表视图还显示空闲）。对照 index.js:196（停服）是传 force=true 的。
    //   修法：删除语义统一 force=true —— 与「删除即回收」的契约一致。
    if (removed.kind === 'proxy') { for (const i of removed.instances || []) { try { removed.stopInstance(i, true); } catch {} } }
    // 端口登记级联释放（「删除对象即释放端口」契约，ports.js）：删供应商必须释放其
    // providerApi 端点 + 各反代实例（proxy:<keyId>）记录，否则 owner 永久累积、池最终耗尽。
    try { this._releaseProviderPorts(removed); } catch (e) { this.logger.warn && this.logger.warn('release provider ports ' + id + ': ' + (e && e.message)); }
    this._save();
    return { ok: true };
  }

  /** 释放某供应商在端口注册表中的全部记录（providerApi:<id> 与各 proxy:<keyId>）。 */
  _releaseProviderPorts(p) {
    if (!p) return;
    const { shared: ports } = require('../../guard/lifecycle/ports');
    try { ports.unregister('providerApi:' + p.id); } catch {}
    for (const i of (p.instances || [])) {
      if (i && i.keyId) { try { ports.unregister('proxy:' + i.keyId); } catch {} }
    }
  }

  getProvider(id) { return this.providers.find((p) => p.id === id) || null; }

  /** 取证查询：最近 n 条上游拒绝/限额证据（router-daemon ctl / API 可用）。 */
  evidenceTail(n) { return this.evidence ? this.evidence.readTail(n) : []; }

  /** 取证统计：证据文件路径/大小/轮转次数。 */
  evidenceStats() { return this.evidence ? this.evidence.stats() : { enabled: false }; }
}

Object.assign(RouterService.prototype, require('./forward-core').forwardMethods);
Object.assign(RouterService.prototype, require('./router-ops').auxMethods);

RouterService.presets = () => require('./providers/base').PROVIDER_PRESETS || [];

module.exports = { RouterService };