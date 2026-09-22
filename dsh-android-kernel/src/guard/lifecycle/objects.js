'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 管家注册机（ManagedRegistry）—— 控制平面 v3 的声明目录（2026-09-06 定稿）。
//
// 定位：守卫核心层 = 大管家。本目录记录「管家直接负责」的受管对象的应然声明与所有权：
//   - 身份（kind/id/name）
//   - 应然（desired：用户意图 / guardian：自动拉起策略）——持久，由业务申报
//   - 所有权（端口 owner 引用 / root 路径 / unit 或 daemon 声明 / 进程模式）——持久
//   - 类型适配器引用（observe/apply 实现留在类型模块，经 registerAdapter 挂接，不持久化）
//
// 铁律（v3 设计公理落地）：
//   1) 实然（pid/占用/健康）只来自观测，绝不写回目录；
//   2) 注册即存在、注销即不存在（限管家直接负责的对象）；域自治对象不入簿（经 ctl 摘要）；
//   3) 目录不是第二状态源：phase 由调谐循环驱动（R3 挂接），业务不得直接改目录 phase；
//   4) 路径由 root 派生，不登记路径清单；端口只登记所有权引用（联动统一端口注册表）。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');

/** 进程生命周期唯一词表（控制平面 v3）。操作态（安装/升级/卸载）在 TaskRegistry，不在 phase。 */
const PHASES = ['stopped', 'installing', 'starting', 'running', 'draining', 'backoff', 'failed', 'restarting'];

/** 单对象监督的超时上限（拍宽的倍数）。见 ManagedRegistry._withTimeout。 */
const ADAPTER_TIMEOUT_TICKS = 6;

/** desired 唯一取值：用户意图（running=应保持运行 / stopped=应停止）。与 guardian（自动拉起策略）正交。 */
const DESIRED = ['running', 'stopped'];

/** 受管对象类型表（显式、稳定；不造通用 CRD）。future 扩展经 registerKind 声明能力。 */
/** ⚠ 已删除的类型（勿回潮）：'sandbox-instance'（沙箱实例域已整体移除，内核 Android-only 单主干）。 */
const MANAGED_KINDS = {
  dsh:              { label: '原生 DSH',       startable: true, guardable: true },
  'router-daemon':  { label: '智能路由 daemon', startable: true, guardable: true },
  plugin:           { label: '插件（聚合）',    startable: false, guardable: false },
};

let _customKinds = {};

function kindMeta(kind) {
  return MANAGED_KINDS[kind] || _customKinds[kind] || null;
}

/**
 * 受管对象目录项（应然 + 所有权；phase 由调谐驱动，观测不入册）。
 * @param {object} o { kind, id, name, ownership? }
 */
function createEntry(o) {
  const meta = kindMeta(o.kind);
  if (!meta) throw new Error('未知受管对象类型: ' + o.kind + '（先 registerKind 声明）');
  if (!o.id || typeof o.id !== 'string') throw new Error('注册项缺少 id');
  return {
    kind: o.kind,
    id: o.id,
    name: String(o.name || o.id),
    // 应然（业务申报 / 用户操作；唯一持久意图）
    desired: (o.desired === 'stopped') ? 'stopped' : 'running',
    guardian: o.guardian === true,
    // 所有权（注册时申报；持久）
    ownership: normalizeOwnership(o.ownership),
    // phase（调谐循环 R3 驱动；初始 stopped。业务不得直接改）
    phase: 'stopped',
    // 观测缓存（实然；不持久化，由 heartbeat/adapter 写入）
    lastObserved: null, // { ok, error, at }
    // 进程句柄/运行期引用（C3-3b G2：main 状态机句柄挂目录，不持久化——
    // 形如 { child?, adoptedPid?, adopted, observedOnly, startDeadline?, spawnBlockedUntil? }）
    process: null,
    // 域摘要引用（R4：daemon 类黑盒经 ctl 向目录呈报的紧凑摘要，只存引用/只读缓存，不持久化；
    // 形如 { runState, providers, accounts, proxyInstances, resourcePorts, fetchedAt }）
    domainSummary: null,
    // 退避（R3 调谐用；崩溃窗口）——随目录持久化（B2 归一，见 _load/_save）
    backoffLevel: 0,
    backoffUntil: null,
    crashWindowStart: null,
    crashWindowRestarts: 0,
    restartCount: 0,
    startedAt: null,
    lastTransitionAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeOwnership(own) {
  const o = own || {};
  const ports = Array.isArray(o.ports) ? o.ports
    .filter((p) => p && Number.isInteger(Number(p.port)) && p.port > 0)
    .map((p) => ({ role: String(p.role || 'default'), port: Number(p.port) })) : [];
  return {
    ports,
    rootPath: o.rootPath ? String(o.rootPath) : null,
    daemonScript: o.daemonScript ? String(o.daemonScript) : null,
    // ⚠ 'systemd' 已随实例/沙箱域与系统服务管理器托管模式删除（安卓无 systemd）。
    processMode: ['spawn', 'daemon', 'adopted'].includes(o.processMode) ? o.processMode : null,
    meta: (o.meta && typeof o.meta === 'object') ? Object.assign({}, o.meta) : null, // 域备注（只读参考）
  };
}

/** 类型适配器：observe/apply 实现（类型模块注册；不进持久化）。 */
class ManagedRegistry {
  /**
   * @param {object} opts { file?: string(managed-objects.json), logger?, events?, ports? }
   */
  constructor(opts) {
    this.file = opts && opts.file;
    this.logger = (opts && opts.logger) || null;
    this.events = (opts && opts.events) || null;
    this.ports = (opts && opts.ports) || null; // 统一端口注册表（owner 释放联动；可选）
    this._objects = [];           // 内存目录（顺序 = 注册序）
    this._byId = new Map();
    this._adapters = {};          // kind -> { observe, apply }
    this._loaded = false;
    // 是否「从既有磁盘文件加载」（阶段 2 状态单源迁移判定）：
    //   true  = 历史库已有权威目录 → 以目录 desired 为准，state.json 不回灌（纯投影）；
    //   false = 目录文件原不存在（首启/老库迁移）→ 允许 state.json 的 desired 作一次性种子。
    // 注意：必须记录「构造前是否存在」，而非 _save 之后——构造函数随后会创建文件（否则判定失真）。
    this._loadedFromDisk = false;
    if (this.file) {
      try { this._loadedFromDisk = fs.existsSync(this.file); } catch { this._loadedFromDisk = false; }
      this._load();
    }
  }

  /* ── 持久化（应然+所有权；实然与适配器不入册） ── */
  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const arr = (raw && Array.isArray(raw.objects)) ? raw.objects : [];
      for (const o of arr) {
        if (!o || !kindMeta(o.kind)) continue; // 未知类型/损坏条目：跳过（不阻断启动）
        const e = createEntry({ kind: o.kind, id: o.id, name: o.name, desired: o.desired, guardian: o.guardian, ownership: o.ownership });
        // 恢复持久化的受管阶段(仅合法值;观测不恢复)
        if (PHASES.includes(o.phase)) e.phase = o.phase;
        if (Number.isInteger(o.backoffLevel)) e.backoffLevel = o.backoffLevel;
        if (typeof o.backoffUntil === 'number' && o.backoffUntil > Date.now()) e.backoffUntil = o.backoffUntil;
        // 崩溃窗/重启计数随目录持久化（B2 归一：与 state.json 不再双副本——main 崩溃保护跨重启保持）。
        if (Number.isInteger(o.restartCount) && o.restartCount >= 0) e.restartCount = o.restartCount;
        if (o.crashWindowStart === null || typeof o.crashWindowStart === 'number') e.crashWindowStart = o.crashWindowStart;
        if (Number.isInteger(o.crashWindowRestarts) && o.crashWindowRestarts >= 0) e.crashWindowRestarts = o.crashWindowRestarts;
        if (typeof o.startedAt === 'string') e.startedAt = o.startedAt;
        e.lastTransitionAt = null;
        this._index(e);
      }
      this._loaded = true;
    } catch { /* 首次启动/文件缺失：空目录 */ }
  }

  _save() {
    if (!this.file) return;
    try {
      const dir = path.dirname(this.file);
      fs.mkdirSync(dir, { recursive: true });
      const body = JSON.stringify({
        schema: 'managed-objects@1',
        objects: this._objects.map((o) => ({
          kind: o.kind, id: o.id, name: o.name,
          desired: o.desired, guardian: o.guardian,
          ownership: o.ownership,
          phase: o.phase, backoffLevel: o.backoffLevel,
          backoffUntil: (o.backoffUntil && o.backoffUntil > Date.now()) ? o.backoffUntil : null,
          // B2 归一：崩溃保护字段随目录持久化（主 DSH 崩溃计数/窗跨守卫重启保持），不再只落 state.json
          restartCount: Number.isInteger(o.restartCount) ? o.restartCount : 0,
          crashWindowStart: o.crashWindowStart || null,
          crashWindowRestarts: Number.isInteger(o.crashWindowRestarts) ? o.crashWindowRestarts : 0,
          startedAt: o.startedAt, createdAt: o.createdAt, updatedAt: o.updatedAt,
        })),
      }, null, 2);
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) { this._log('warn', 'managed-objects 持久化失败: ' + (e && e.message)); }
  }

  /** B2 归一：崩溃/退避字段变化时的持久化入口（防抖 50ms 合并同拍多次变更，避免写放大）。
   *  仅落盘目录文件；由 supervisor._persistCrashField 在 _mField 变更后调用。 */
  persistCrashState() {
    if (this._crashSaveTimer) return; // 已排期，合并
    this._crashSaveTimer = setTimeout(() => {
      this._crashSaveTimer = null;
      this._save();
    }, 50);
    if (this._crashSaveTimer.unref) this._crashSaveTimer.unref(); // 不阻塞进程退出
  }

  _log(lv, msg) {
    if (this.logger && this.logger[lv]) this.logger[lv](msg);
  }
  _event(type, data) {
    if (this.events && this.events.append) { try { this.events.append(type, data || {}); } catch {} }
  }

  /* ── 目录操作 ── */
  _index(e) { this._byId.set(e.id, e); this._objects.push(e); }
  _drop(e) {
    this._byId.delete(e.id);
    const i = this._objects.indexOf(e);
    if (i >= 0) this._objects.splice(i, 1);
  }

  /** 注册新类型能力（未来扩展；显式声明，非 CRD）。 */
  registerKind(kind, meta) {
    _customKinds[kind] = Object.assign({ label: kind, startable: false, guardable: false }, meta || {});
    return this;
  }

  /** 类型模块挂接适配器（observe/apply 实现留在类型层）。 */
  registerAdapter(kind, adapter) {
    if (!kindMeta(kind)) throw new Error('未知类型，先 registerKind: ' + kind);
    this._adapters[kind] = adapter || {};
    return this;
  }
  adapter(kind) { return this._adapters[kind] || null; }

  /** 业务创建对象时申报入册。 */
  register(spec) {
    const e = createEntry(spec);
    if (this._byId.has(e.id)) throw new Error('重复注册（id 已存在）: ' + e.id);
    this._index(e);
    this._syncPortsOwner(e, true);
    this._save();
    this._event('managed_object_registered', { kind: e.kind, id: e.id, name: e.name });
    return e;
  }

  /** 对象变更申报（desired/guardian/ownership/name）。 */
  update(id, patch) {
    const e = this.get(id);
    if (!e) return { ok: false, error: '未注册: ' + id };
    const p = patch || {};
    if (p.desired !== undefined) {
      if (!DESIRED.includes(p.desired)) return { ok: false, error: '非法 desired: ' + p.desired };
      e.desired = p.desired;
    }
    if (p.guardian !== undefined) e.guardian = p.guardian === true;
    if (p.name !== undefined) e.name = String(p.name || e.id);
    if (p.ownership !== undefined) {
      const old = e.ownership.ports;
      e.ownership = normalizeOwnership(p.ownership);
      this._syncPortsOwner(e, true);
      for (const op of old) { if (!e.ownership.ports.some((np) => np.port === op.port)) this._releasePort(op.port, e.id); }
    }
    e.updatedAt = new Date().toISOString();
    this._save();
    this._event('managed_object_updated', { kind: e.kind, id: e.id });
    return { ok: true, object: e };
  }

  /** 注销（销毁时调用）。级联：按所有权释放端口（owner 语义）→ 移出目录 → 持久化。 */
  unregister(id, opts) {
    const e = this.get(id);
    if (!e) return { ok: false, error: '未注册: ' + id };
    const o = opts || {};
    // ⚠ P3 修复（2026-09-13）：**清掉节流游标**。
    //   _nextTickAt 原先只写不读其它、且**没有任何清除路径**（全仓仅 heartbeat 内一处读写）。
    //   对象注销后若同 id 重新注册，旧游标不会跟着新对象走（新对象是新 entry，天然无游标），
    //   故注销本身影响有限；真正的缺口是「守卫重启才自然丢失」——
    //   在 unregister 处显式清除，使生命周期边界上的语义完整、可测。
    e._nextTickAt = null;
    // 级联停/清理由调用方决定（域业务保留最终权力）；这里只做目录应做的：
    // 1) 释放所有权端口（若注入统一端口注册表，按 owner=本对象释放）
    for (const op of e.ownership.ports) this._releasePort(op.port, e.id);
    if (o.onBeforeRemove) { try { o.onBeforeRemove(e); } catch (err) { this._log('warn', 'onBeforeRemove(' + e.id + '): ' + (err && err.message)); } }
    this._drop(e);
    this._save();
    this._event('managed_object_removed', { kind: e.kind, id: e.id });
    return { ok: true };
  }

  /** 释放本对象持有的端口（按 owner）。
   *
   *  ⚠ 2026-09-12（P2-2 配套）：`PortRegistry.release()` 现已**真正支持** `ownerId` 校验
   *    （此前第二参被静默忽略，故这里曾有 `catch { release(port) }` 的回退）。
   *    回退现已删除 —— 保留它会绕过 owner 判定，正是 P2-2 要堵的「误删他人端口登记」。
   *    记录返回值仅用于日志（不匹配即 no-op 是期望行为，不是错误）。
   */
  _releasePort(port, ownerId) {
    if (!this.ports || typeof this.ports.release !== 'function') return;
    try { this.ports.release(port, ownerId); } catch (err) {
      this._log('warn', 'releasePort(' + port + '/' + ownerId + '): ' + (err && err.message));
    }
  }
  _syncPortsOwner(e, ensure) {
    if (!this.ports || typeof this.ports.allocateMark !== 'function') return;
    for (const op of e.ownership.ports) {
      try {
        if (ensure && !this.ports.isRegistered(op.port)) this.ports.allocateMark(op.port, 'managed:' + e.id, e.id);
      } catch {}
    }
  }

  /* ── 查询（唯一全系统视图入口） ── */
  list() { return this._objects.slice(); }
  get(id) { return this._byId.get(id) || null; }
  byKind(kind) { return this._objects.filter((o) => o.kind === kind); }
  count() { return this._objects.length; }

  /**
   * 唯一心跳（R3 C3-1 基础设施）：遍历目录项，对已挂 adapter 的对象执行 observe() 并写入实然。
   * 本层只做「观测收集」（实然→lastObserved）；收敛/启停(apply/stop/退避)由各类型 adapter 的驱动
   * 开关逐步启用（daemon→dsh→sandbox，见 REDESIGN-R3-execution-plan）。节流经 ownership.meta.tickEvery
   * （1=每拍；6≈30s daemon 语义）。单对象异常隔离。
   * @param {number} [intervalMs] 心跳拍宽（默认 5000）
   * @returns {{ observed: string[], errors: string[] }}
   */
  /** 单对象 supervise/observe 的**超时上限**（拍宽的倍数）。
   *  6 倍拍宽 ≈ 30s（默认拍宽 5s）：远大于任何正常监督耗时，又保证有界 ——
   *  任一 adapter 卡死时心跳在 ~30s 内恢复推进，而不是永久停摆。 */
  _adapterTimeoutMs(iv) { return Math.max(1000, (iv || 5000) * ADAPTER_TIMEOUT_TICKS); }

  /** 给单对象的监督 promise 加超时（超时即按失败处理，绝不无限等待）。 */
  _withTimeout(p, ms, id) {
    let t = null;
    const timeout = new Promise((resolve) => {
      t = setTimeout(() => resolve({ __timedOut: true, ok: false, error: '监督超时(' + ms + 'ms)' }), ms);
      // 不拖住进程退出（守卫优雅停机不被这些计时器拦）
      if (t && typeof t.unref === 'function') t.unref();
    });
    return Promise.race([Promise.resolve(p).finally(() => { if (t) clearTimeout(t); }), timeout])
      .catch((e) => ({ ok: false, error: (e && e.message) || String(e) }))
      .then((res) => {
        if (res && res.__timedOut) {
          this._log('warn', 'heartbeat 监督超时(' + id + ')：已跳过本拍（防心跳停摆）');
        }
        return res;
      });
  }

  async heartbeat(intervalMs) {
    const iv = intervalMs || 5000;
    const now = Date.now();
    const observed = [];
    const errors = [];
    for (const e of this._objects) {
      const ad = this._adapters[e.kind];
      if (!ad) continue; // 未挂 adapter：不观测（不驱动）
      // 两形态：supervise = 监督单拍(守卫门控的守护逻辑,如 daemon)；observe = 纯观测
      const fn = (typeof ad.supervise === 'function') ? ad.supervise : ((typeof ad.observe === 'function') ? ad.observe : null);
      if (!fn) continue;
      const tickEvery = ad.tickEvery || (e.ownership && e.ownership.meta && e.ownership.meta.tickEvery) || 1;
      if (tickEvery > 1) {
        if (e._nextTickAt && now < e._nextTickAt) continue; // 节流(daemon 类≈6拍30s)
        // ⚠ 用**本次实际执行时刻**前推（而非 heartbeat 入口的 now）：
        //   本循环是串行的，前面的对象耗时会让 now 变陈旧 → 节流窗被系统性拉长。
        e._nextTickAt = Date.now() + tickEvery * iv;
      }
      try {
        // ⚠ P1 修复（2026-09-13）：**单个 adapter 不得拖死整条心跳**。
        //
        //   缺陷：此处 `await fn(e)` 没有任何超时。心跳是 main 收敛 / 沙箱监督 /
        //     daemon 监督的**唯一周期驱动**（supervisor.js:452-455 在 managedObjects 存在时
        //     不创建 tick 定时器）。只要任一 adapter 的 promise 永不 settle（ctl 卡死、
        //     子进程无响应、await 了一个不会 resolve 的 I/O），本循环就永久停在这一拍；
        //     而 supervisor 侧以 _heartbeatBusy 防重叠 → **心跳永停**，
        //     表现为「面板开着、服务全死、却没有任何事件」。
        //   修法：每对象加超时（上限 = 拍宽 × ADAPTER_TIMEOUT_TICKS）。超时按**异常**处理
        //     （记 errors + warn，并落一条 {ok:false} 观测），使循环继续推进到下一个对象。
        //     超时值取「拍宽的 6 倍」：远大于正常监督耗时，又保证有界。
        const res = await this._withTimeout(fn(e), iv * ADAPTER_TIMEOUT_TICKS, e.id);
        // 超时必须进 errors 汇总（否则调用方只看 errors/observed 会以为一切正常）
        if (res && res.__timedOut) errors.push(e.id + ':' + (res.error || '监督超时'));
        if (res && typeof res.ok === 'boolean') {
          this.applyObservation(e.id, res);
          // derivePhase（daemon 类）：phase 由 应然×观测 收敛——desired running∧在线→running；
          // 失联/期望停止→stopped。消除「daemon desired=running 但 phase 恒 stopped」的目录误导。
          if (ad.derivePhase === true) {
            const want = e.desired === 'running';
            const p = (want && res.ok) ? 'running' : 'stopped';
            if (e.phase !== p) this.setPhase(e.id, p);
          }
        }
        observed.push(e.id);
      } catch (err) {
        errors.push(e.id + ':' + ((err && err.message) || err));
        this._log('warn', 'heartbeat ' + (ad.supervise ? 'supervise' : 'observe') + '(' + e.kind + ':' + e.id + '): ' + ((err && err.message) || err));
      }
    }
    return { observed, errors };
  }

  /** 观测写入（仅由 heartbeat/类型 observe 调用；实然不进持久化）。 */
  applyObservation(id, obs) {
    const e = this.get(id);
    if (!e) return null;
    e.lastObserved = {
      ok: !!(obs && obs.ok),
      error: (obs && obs.error) || null,
      at: new Date().toISOString(),
    };
    return e;
  }

  /** 调谐循环对目录项的 phase 写入（R3 由 heartbeat 调用；业务不得直接改）。 */
  setPhase(id, p) {
    const e = this.get(id);
    if (!e) return null;
    if (!PHASES.includes(p)) return e;
    if (e.phase !== p) {
      e.phase = p;
      e.lastTransitionAt = new Date().toISOString();
      this._event('managed_object_phase', { kind: e.kind, id: e.id, phase: p });
      this._save(); // 受管阶段随目录持久化（重启恢复；观测不入册）
    }
    return e;
  }
}

module.exports = { ManagedRegistry, createEntry, PHASES, DESIRED, MANAGED_KINDS, kindMeta, normalizeOwnership };
