'use strict';

// §7.6 拆分自 supervisor.js：control-view（原型 mixin）。
// 仅经 this 协作；导出「原型属性描述符」由 supervisor.js 注入 Supervisor.prototype。
// 行为与拆分前逐字一致（含 getter/setter；class 体方法无需逗号）。
// 依赖由拆分脚本按块内实际使用自动携带（遗漏会导致运行期 ReferenceError）。
const fs = require('node:fs');
const path = require('node:path');
const pidlook = require('../../platform/os/pidlookup');
const { DaemonLifecycle } = require('../../guard/proc/daemon-lifecycle');
const platform = require('../../platform/os/index');
const monitor = require('../../guard/monitor/index');
const ports = require('../../guard/lifecycle/ports').shared;
const guardian = require('../../guard/guardian/index');

/** 监督拍内拉取 router 域摘要的超时（ms）。
 * 必须远小于心跳拍宽对「阻塞」的容忍度：摘要只是只读缓存，失败即降级。
 * 对照 _ctlCall 的默认 120s —— 那会阻塞整条唯一心跳（见调用点说明）。 */
const ROUTER_SUMMARY_TIMEOUT_MS = 5000;

class ControlView {
  routerProviders() {
    const presets = this.router.constructor.presets();
    // 阶段三：local() 兜底仅限 daemon 全挂应急，标注 stale 来源（正常监督模式前端不消费副本——见 PHASE3 设计）
    const local = () => ({ presets, providers: this.router.listProviders(), proxyApps: this.router.proxyApps(), _stale: true, _staleReason: 'daemon 失联/ctl 失败应急视图（守卫内嵌只读副本）' });
    if (!this.routerDaemonActive()) return local();
    const rt = this.routerApi();
    return Promise.all([Promise.resolve(rt.listProviders()), Promise.resolve(rt.proxyApps())])
      .then(([providers, proxyApps]) => ({ presets, providers, proxyApps }))
      .catch((e) => {
        if (this.logger && this.logger.warn) this.logger.warn('routerProviders 远程取数失败，回退本地视图: ' + e.message);
        return local();
      });
  }

  // ---- L3 监督模式：router 控制通道（daemon 唯一事实源，2026-09）----
  // 守卫 API/视图统一从 routerApi() 取 router 门面：daemon 在跑 → 方法调用转发 ctl
  // （POST /ctl {method,args}，见 src/domains/router/ctl.js）——写即 daemon 生效、
  // 读即 daemon 最新（消除此前「守卫本地副本视图陈旧 / 写不生效」的双脑不一致，HANDOFF #4）；
  // daemon 未跑 → 守卫本地实例（内嵌回退路径，行为不变）。
  routerApi() {
    if (this.routerDaemonActive()) {
      if (!this._routerFacade) this._routerFacade = this._makeRouterFacade();
      return this._routerFacade;
    }
    return this.router;
  }

  routerDaemonActive() {
    // 仅当本守卫「期望 daemon 运行（routerAutostart）」且「管理锁在手（本守卫写过的 lock）」且
    // 43011 监听者为 router-daemon 时，才视为「daemon 监督模式」（routerApi/门面/ctl 生效）。
    // 关键：绝不因全局 43011 被占就把任意 Supervisor 实例（含测试内嵌实例，乃至运行中把
    // routerAutostart 置真的测试/内嵌路径）误判为监督模式——否则测试 api 调用会经 ctl 打到
    // 线上 daemon（2026-09 实测 p2p-api-test 误接生产路由：/router/start 置 autostart=true 后
    // 后续全部 provider 视图/写操作打到生产 daemon）。
    try {
      if (!this.config || this.config.routerAutostart !== true) return false;
      if (!this._daemonManaged()) return false;
      return this._routerDaemonActive();
    } catch { return false; }
  }

  /** 通用 ctl 调用（router 43107 / lan 43108 共用）。
   *
   * 2026-09-12（P2 去重）：实现已收敛到 `platform/loghub.ctlCall` ——
   * 此前这里是**第二份逐行近似**的实现，与 loghub 那份已分叉：
   * 默认超时不同（此处 120s / 那边 3s）、错误对象形状不同。
   * 本包装只负责本层契约：默认 120s（面板写操作可达秒级） + 在 Error 上挂 ok/error。
   */
  _ctlCall(port, method, args, timeoutMs) {
    return require('../../platform/loghub').ctlCall(port, method, args, timeoutMs || 120000, { withErrorFields: true });
  }

  /** router-daemon 控制通道端口（单一来源：config；缺省见 platform/config DEFAULTS）。
   * 历史教训：曾散落硬编码 43011，而该值实际落在 providerApi 动态段（43000+）内，
   * 与供应商独立端点发生注册表双占冲突；ctl 通道必须与动态分配段解耦。 */
  _routerCtlPort() { return Number(this.config && this.config.routerCtlPort) || 43107; }

  _makeRouterFacade() { return this._makeCtlFacade(this._routerCtlPort()); }

  _makeCtlFacade(port) {
    const self = this;
    const cache = new Map();
    const BANNED = new Set(['then', 'constructor', 'toJSON', 'inspect', 'Symbol.toPrimitive', '__proto__', 'prototype', 'defineProperty', 'defineGetter', 'defineSetter', 'apply', 'call', 'bind']);
    return new Proxy({}, {
      get(_t, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (BANNED.has(prop)) return undefined;
        if (cache.has(prop)) return cache.get(prop);
        const fn = (...args) => self._ctlCall(port, prop, args);
        cache.set(prop, fn);
        return fn;
      },
      has() { return true; },
    });
  }

  /** GET /router/status 视图：daemon 监督模式下取 daemon 实时状态（异步），否则本地视图（同步）。 */
  async routerStatusView() {
    if (this.routerDaemonActive()) {
      try {
        const st = await this.routerApi().status();
        return { running: !!(st && st.running), autostart: this.config.routerAutostart === true, ...(st || {}) };
      } catch (e) {
        if (this.logger && this.logger.warn) this.logger.warn('router status 远程失败，回退本地: ' + e.message);
      }
    }
    return this.routerStatus();
  }

  // ---- 端口管理门面：统一端口 registry 清单经 sup 接口暴露（presentation 不直连 infra）----
  // 2026-09 修复：原实现 records 恒缺 active → 前端端口管理「状态」列全部显示停用（接线断裂）。
  // 现为每条记录补 active（端口当前真实监听中）。探测按「端口集合」整批缓存 3s TTL，
  // 避免前端 2s 心跳每次触发全量同步扫 /proc 挤占事件循环。
  async listPorts() {
    // 归一化收拢（2026-09）：系统端口登记分散在注册表文件（同 stateDir）——
    // ports.json（守卫共享：system/oauth/managed-ctl）
    // ports-router.json（router-daemon 独占：proxyInstance 反代 41000+ / providerApi 43000+ —— 智能路由实例）
    // /ports 聚合去重合并，才是「整个系统的运行状态」。安卓内核已剥离远程控制/relay，
    // 此处仅聚合守卫共享段与 router 段（远程控制域已删，无 lan 端口段）。
    try { ports.reload(); } catch (e) { this.logger && this.logger.warn && this.logger.warn('ports reload: ' + (e && e.message)); }
    const swDir = path.dirname(this.config.stateFile);
    const byPort = new Map();
    const adopt = (rec) => {
      if (!rec || !Number.isInteger(rec.port) || !rec.role || byPort.has(rec.port)) return;
      byPort.set(rec.port, {
        port: rec.port, role: rec.role, owner: rec.owner || null,
        createdAt: Number.isInteger(rec.createdAt) ? rec.createdAt : Date.now(),
      });
    };
    for (const r of ports.list()) adopt(r);
    for (const f of ['ports-router.json']) {
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(swDir, f), 'utf8'));
        for (const r of (Array.isArray(doc.records) ? doc.records : [])) adopt(r);
      } catch {}
    }
    // 运行状态视图归一化: oauthCallback 是登录瞬态回调(非服务)不进常驻列表; supervisor-api 历史残留段保留供 active 筛选
    const merged = [...byPort.values()].filter((r) => r.role !== "oauthCallback");
    const activeByPort = await this._portActives(merged.map((r) => r.port));
    const records = merged.map((r) => ({
      port: r.port, role: r.role, owner: r.owner, createdAt: r.createdAt,
      active: !!(activeByPort && activeByPort[r.port]) || false,
    }));
    const snap = ports.snapshotAll();
    // supervisor-api 多端口历史残留(3100/36360/36361): 只保留正在监听者, 废弃端口不占位
    const apiAct = records.filter((r) => r.role === "supervisor-api" && r.active);
    const out = apiAct.length ? records.filter((r) => r.role !== "supervisor-api" || r.active) : records;
    // 池容量可观测（工业标准：运维可见 used/free/utilization，池满前可预警/扩容）
    let capacity = null;
    try { capacity = (typeof ports.capacity === 'function') ? ports.capacity() : null; } catch {}
    return { records: out, snapshot: snap, capacity };
  }

  /** 端口集合激活探测（整批 3s TTL 缓存）。active=true 表示该端口当前有进程在监听。
   * 2026-09 复检根治：改为纯 TCP connect 探测（probe.portListening）——不再依赖 pid 映射。
   * 背景：findListeningPing 需读 /proc/<pid>/fd 反查 socket→pid，对本机「守卫管理树外/孙进程」
   * （router-daemon 的反代子进程）常因读取权限返回 null → 端口明明在监听却恒报 inactive（前端端口
   * 管理「无任何实例激活」失真，实测 41038 在听而 active=false）。TCP connect 与端口是否被监听
   * 直接等价（同 infra/ports 判占用语义），无需任何 /proc 权限，三平台一致。 */
  async _portActives(portsList) {
    const now = Date.now();
    const key = portsList.join(',');
    if (this._portActivesCache && this._portActivesCache.key === key && now - this._portActivesCache.at < 3000) {
      return this._portActivesCache.map;
    }
    // 拆分后相对路径须相对本文件：src/guard/supervisor/ → ../../guard/monitor/probe
    const probe = require('../../guard/monitor/probe');
    const results = await Promise.all((portsList || []).map((port) => probe.portListening('127.0.0.1', Number(port), 300)));
    const map = {};
    for (let i = 0; i < portsList.length; i++) map[portsList[i]] = !!results[i];
    this._portActivesCache = { key, at: now, map };
    return map;
  }

  /** 统一受管进程生命周期实例（懒加载单例；router daemon 专用，2026-09 架构定稿）。
   * 身份文件（owner 连续：守卫重启=接管既有 daemon）+ spawn latch + 换代停旧→等死→等端口释放 全在核心内。 */
  _daemonLifecycle(kind) {
    if (!this.configPath) return null; // 非守卫实例（测试）绝不管理独立 daemon
    if (!this._lc) this._lc = {};
    if (this._lc[kind]) return this._lc[kind];
    const cfgPath = this.configPath;
    // 路径解析必须用**单一真源**（2026-09-11 生产级修复）：
    // srcpath 用「存在性验证」代替脆弱的相对推算法。Android 内核仅保留 router daemon。
    const script = require('../../platform/srcpath').daemonScript('router');
    if (!script) return null;
    const dir = path.dirname(this.config.stateFile);
    this._lc[kind] = new DaemonLifecycle({
      name: kind,
      script,
      args: ['-c', cfgPath],
      ctlPort: this._routerCtlPort(),
      cmdMark: 'router-daemon',
      identityFile: path.join(dir, 'router-daemon.identity.json'),
      spawnEnv: () => ({ DSH_SUPERVISOR_CONFIG: cfgPath }),
      logger: this.logger,
      events: this.events,
    });
    return this._lc[kind];
  }

  /** ensure 结果 → 旧调用方契约翻译（adopted 不带 spawned：避免监督误报“失联重拉”）。 */
  _daemonEnsureResult(lc, writeOwnerLock) {
    const rr = lc.ensureRunning();
    if (rr.mode === 'started' || rr.mode === 'adopted') {
      if (writeOwnerLock) writeOwnerLock();
      return rr.mode === 'started'
        ? { active: true, mode: 'daemon', spawned: rr.pid }
        : { active: true, mode: 'daemon' }; // adopted：既有进程，owner 连续
    }
    if (rr.mode === 'barrier') return { active: false, mode: 'barrier', reason: '生命周期窗口内' };
    if (rr.mode === 'reclaiming') return { active: false, mode: 'reclaiming', stale: rr.stale };
    // P1-3 配套：spawn 未能启动（脚本不可执行等）时如实上报，不再被当作「已 started」。
    if (rr.mode === 'failed') return { active: false, mode: 'error', error: rr.error || ('daemon 未启动: ' + this.name) };
    return { active: false, mode: 'error', error: 'unexpected lifecycle mode: ' + rr.mode };
  }




  /** 唯一心跳驱动的 daemon 监督单拍（v3 R3 C3-2）：
   * router-daemon 的「期望运行 + 失联守护拉起」，由 ManagedRegistry.heartbeat 经 adapter 调用
   * （节流≈30s，与原 L3 监督 tick 等价）。守卫重启不影响 daemon（进程独立）。
   * @returns {ok:boolean} daemon 当前在线（heartbeat 统一写入目录实然）。 */
  async _daemonSuperviseOnce(kind) {
    if (this._stopping) return { ok: false };
    // INV-S1 全域（契约 §3.3）：会话退出中/已退出 → 不再监督拉起 router daemon。
    if (this._sessionHalting()) return { ok: false, error: 'session halting' };
    try {
      if (kind === 'router') {
        const rlc = this.lifecycleManager ? this.lifecycleManager.get('router') : null;
        const wantRunning = this.config.routerAutostart === true || (rlc && rlc.desired === 'running');
        if (!wantRunning) return { ok: this._routerDaemonActive() };
        if (!this._daemonManaged()) return { ok: this._routerDaemonActive() }; // 异主隔离：监督不介入
        // 代际分类（DaemonLifecycle.classify）：识别「ctl 被外部/异代际进程占用」的 external 情形——
        // 原路径只按 cmdline 判 active，无法区分本守卫 daemon 与外部同名 daemon（classify 接线，2026-09）。
        const rlcx = this._daemonLifecycle('router');
        if (rlcx && typeof rlcx.classify === 'function') {
          const c = rlcx.classify();
          if (c && c.mode === 'external') {
            this.logger && this.logger.warn && this.logger.warn('[router] 监督：ctl ' + this._routerCtlPort() + ' 被外部进程占用（pid=' + c.owner + '），不接管不拉起');
            this._guardianEvent('router', 'external', { owner: c.owner });
            return { ok: false };
          }
        }
        if (this._routerDaemonActive()) {
          try { this._syncRouterLifecycleView({ ok: true }); } catch (e) { this.logger && this.logger.warn && this.logger.warn('router view sync: ' + (e && e.message)); }
          // R4 域摘要入目录（黑盒摘要引用，只读缓存；拉取失败仅降级——不影响监督）
          try {
            if (this.routerDaemonActive() && this.managedObjects) {
              // P2 修复（2026-09-13）：**必须给这一处显式短超时**。
              // domainSummary 经 ctl 转发，而 _ctlCall 的默认超时是 **120s**（见本文件 :67-69）。
              // 本 await 位于心跳的**串行** for 循环内 → 会把同拍后续的 router/主实例
              // 全部阻塞，并与「心跳是唯一周期驱动」复合：一拍最长 120s，
              // 期间 main 收敛、沙箱自愈、daemon 监督全部停摆（且只有 debug 级日志）。
              // 摘要只是**只读缓存**，失败可降级，不值得阻塞监督 → 5s 上限。
              // 必须直接走 _ctlCall 的 timeoutMs 形参：门面 proxy 的签名是
              // fn=(...args)=>_ctlCall(port,prop,args)，把 {timeoutMs} 当**方法参数**传
              // 会被送到 daemon 的 domainSummary 而不是当超时用（我第一版就写错了）。
              const s = await this._ctlCall(this._routerCtlPort(), 'domainSummary', [], ROUTER_SUMMARY_TIMEOUT_MS);
              const e = this.managedObjects.get('router-daemon');
              if (e && s && typeof s === 'object') {
                e.domainSummary = Object.assign({ fetchedAt: Date.now() }, s);
              }
            }
          } catch (e2) { this.logger && this.logger.debug && this.logger.debug('router 域摘要拉取失败: ' + ((e2 && e2.message) || e2)); }
          return { ok: true };
        }
        if (rlc && rlc.guardian !== true) {
          if (this.logger && this.logger.warn) this.logger.warn('[router] 监督：router-daemon 失联但守护开关关闭，不自动拉起（仅观测）');
          this._guardianEvent('router', 'skip-guardian-off');
          return { ok: false };
        }
        if (rlc) rlc.restartCount = (rlc.restartCount || 0) + 1;
        const rt = this._ensureRouterRuntime(true);
        if (rt.mode === 'daemon' && rt.spawned) {
          this.events.append('router_daemon_supervised', { pid: rt.spawned });
          this._guardianEvent('router', 'pull', { pid: rt.spawned });
          if (this.logger && this.logger.warn) this.logger.warn('[router] 监督：router-daemon 失联，已重新拉起 pid=' + rt.spawned);
          if (rlc) { rlc._setPhase('starting'); }
          setTimeout(() => {
            const up = pidlook.findListeningPid(this._routerCtlPort());
            try { this._syncRouterLifecycleView({ ok: !!up, error: up ? null : 'router-daemon 拉起后未就绪' }); } catch (e) { this.logger && this.logger.warn && this.logger.warn('router view sync: ' + (e && e.message)); }
          }, 3000);
        } else if (rt.mode === 'error') {
          if (this.logger && this.logger.warn) this.logger.warn('[router] 监督拉起失败: ' + (rt.error || '未知'));
        }
        return { ok: false };
      }
    } catch (e) {
      if (this.logger && this.logger.warn) this.logger.warn('[' + kind + '] 监督异常: ' + (e && e.message));
      return { ok: false };
    }
  }


  // ---- 智能路由开关管理 ----
  async setRouterRunning(on) {
    // 统一生命周期视图同步：router 启停状态镜像到 lifecycleManager（归一化：启停路径收敛）
    const rlc = this.lifecycleManager ? this.lifecycleManager.get('router') : null;
    if (on) {
      // L3：优先独立 router-daemon（detached，守卫重启不影响）；daemon 不可用退回内嵌
      const rt = this._ensureRouterRuntime(true);
      if (rt.mode === 'daemon') {
        this.config.routerAutostart = true;
        this.persistConfigPatch({ routerAutostart: true });
        if (rlc) { rlc.wantRunning(); rlc._monitoring = true; rlc.startedAt = rlc.startedAt || new Date().toISOString(); if (!rt.active) rlc._setPhase('starting'); /* healthy 由 _supervise mirror 观测置位 */ }
        return { ok: true, mode: rt.mode, ...this.routerStatus() };
      }
      const r = await this.router.start();
      this.config.routerAutostart = true;
      this.persistConfigPatch({ routerAutostart: true });
      if (rlc) { rlc.wantRunning(); rlc._monitoring = true; rlc.startedAt = rlc.startedAt || new Date().toISOString(); if (r.ok === false) { rlc._setPhase('stopped'); rlc.error = r.error; } /* healthy 由 _supervise mirror 观测置位 */ }
      return { ok: r.ok !== false, error: r.error, mode: rt.mode, ...this.routerStatus() };
    }
    // 停止：若 daemon 在跑 → 停 daemon；否则停内嵌 router
    const rt = this._ensureRouterRuntime(false);
    if (rt.mode === 'daemon' && rt.stopping) {
      this.config.routerAutostart = false;
      this.persistConfigPatch({ routerAutostart: false });
      if (rlc) { rlc.desired = 'stopped'; rlc._monitoring = false; rlc._setPhase('stopped'); rlc.healthy = false; }
      return { ok: true, mode: 'daemon', ...this.routerStatus() };
    }
    const r = this.router.stop();
    this.config.routerAutostart = false;
    this.persistConfigPatch({ routerAutostart: false });
    if (rlc) { rlc.desired = 'stopped'; rlc._monitoring = false; rlc._setPhase('stopped'); rlc.healthy = false; }
    return { ok: r.ok !== false, already: !!r.already, mode: 'embedded', ...this.routerStatus() };
  }

  routerStatus() {
    const st = this.router.status();
    return { running: !!st.running, autostart: this.config.routerAutostart === true, ...st };
  }

  /** R4 域摘要（目录合成视图）：daemon 监督模式 → 目录 router-daemon 项 domainSummary
   * （监督拍经 ctl 拉取的只读缓存，目录只存引用）；内嵌模式 → 本地 RouterService 实时摘要。 */
  routerDomainSummary() {
    if (this.routerDaemonActive()) {
      try {
        const e = this.managedObjects && typeof this.managedObjects.get === 'function' ? this.managedObjects.get('router-daemon') : null;
        const s = e && e.domainSummary;
        if (s) return { ok: true, source: 'directory', summary: s };
        return { ok: false, source: 'directory', error: '目录尚无 router 域摘要（等待首个监督拍）' };
      } catch (e2) {
        return { ok: false, source: 'directory', error: (e2 && e2.message) || String(e2) };
      }
    }
    try {
      const s = this.router && typeof this.router.domainSummary === 'function' ? this.router.domainSummary() : null;
      return { ok: true, source: 'embedded', summary: s };
    } catch (e2) {
      return { ok: false, source: 'embedded', error: (e2 && e2.message) || String(e2) };
    }
  }

  /** router 生命周期视图同步（C3-5b：取代旧观测镜像层——视图数据并入目录/本拍实然）。
   * 契约：desired 只表达「应运行」（由启停动作设置）；healthy/error/lastProbeAt 只由真实观测写入；
   * phase 收敛为守卫视角期望视图（desired=running→running；stopped→stopped）。
   * 红线：不读取/不写入 router 业务状态（回收/切换/预热/冻结仍归资源自治）。
   * @param o { ok?:boolean, error?:string } 本拍实然（缺省回退目录 router-daemon lastObserved） */
  _syncRouterLifecycleView(o) {
    const lc = this.lifecycleManager ? this.lifecycleManager.get('router') : null;
    if (!lc) return;
    const e = (this.managedObjects && typeof this.managedObjects.get === 'function') ? this.managedObjects.get('router-daemon') : null;
    const ob = (e && e.lastObserved) || null;
    const ok = !!(o && o.ok !== undefined) ? !!(o && o.ok) : !!(ob && ob.ok);
    const err = (o && o.error !== undefined) ? o.error : ((ob && ob.error) || 'router-daemon 未就绪');
    const at = (o && o.at) || (ob && ob.at) || new Date().toISOString();
    const wantRunning = lc.desired === 'running' || lc._monitoring === true;
    lc.lastProbeAt = at;
    if (!wantRunning) {
      // 期望停止：phase=stopped、healthy=false（观测无意义）
      if (lc.phase !== 'stopped') lc._setPhase('stopped');
      lc.healthy = false;
      return;
    }
    // phase 必须反映**观测到的 ok**，不能无条件置 running（2026-09-11 修复，与 K4 同族）：
    // 旧实现无论 ok 与否都 _setPhase('running') ——
    // 于是 daemon 还没就绪时面板显示「运行中」，与 healthy=false 自相矛盾。
    // 现：ok → running；未 ok 且从未 running 过 → starting（拉起中，不谎报）；
    // 曾 running 则保持 running 相位（进程可能仍在，只是探活失败）。
    if (ok) {
      if (lc.phase !== 'running') lc._setPhase('running');
      lc.error = null;
    } else if (lc.phase !== 'running') {
      if (lc.phase !== 'starting') lc._setPhase('starting');
      lc.error = err;
    } else {
      lc.error = err;
    }
    lc.healthy = ok;
  }

  /** 守护动作事件（阶段四，事件脊）：统一记录守护决策/动作，带资源关联键，供审计回放。
   * action: pull(拉起) | skip-guardian-off(守护关闭仅观测)。只读统一状态机 restartCount，不碰业务。 */
  _guardianEvent(resource, action, extra) {
    const lc = this.lifecycleManager ? this.lifecycleManager.get(resource) : null;
    const e = Object.assign({ resource, action }, extra || {});
    if (lc) e.restartCount = lc.restartCount || 0;
    if (this.events && this.events.append) { try { this.events.append('guardian_action', e); } catch (err) { this.logger && this.logger.warn && this.logger.warn('guardian_action event: ' + (err && err.message)); } }
    return e;
  }



}

const _desc = Object.getOwnPropertyDescriptors(ControlView.prototype);
delete _desc.constructor; // 不覆盖 Supervisor.prototype.constructor

module.exports = _desc;
