'use strict';

// 系统级统一端口管理（v2 持久化）：
//  - 全系统所有端口（固定/实例/动态分配段）统一登记为「端口记录」，单一来源；
//  - 端口记录持久化到 ports.json（0600）：守卫重启后固定/实例/已分配绑定全量恢复，不丢、不重复分配；
//  - 每条记录含 owner（归属对象）：删除对象即释放端口（实例删除→释放、relay 关闭→释放、反代实例停止→释放）；
//  - 所有监听/分配逻辑统一从 registry 取端口 + 对应关系（port/role/owner），杜绝散落与冲突。
// 记录结构：{ port, role, owner, createdAt }

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const probe = require('../monitor/probe'); // 同层依赖（infra/probe），不依赖上层 domain/monitor（消除越界）

// ═══════════════════════════════════════════════════════════════════════════
// 动态端口池（2026-09 工业标准重构）
//
// 设计依据（避免打补丁，对齐标准实现）：
//   - RFC 6335 §6：端口三段制（System 0-1023 / User 1024-49151 / Dynamic 49152-65535）。
//     动态池是共享空间而非「每业务固定一小块」；边界值保留以便将来延伸。
//   - Kubernetes NodePort 分配器（工业事实标准）：少数可配置范围 + 容量指标 +
//     池满显式 ErrFull；「宁可泄漏端口，绝不双分配」（分配即生效、释放延迟）。
//   - 选址必须避开 OS 动态端口范围（Linux 默认 net.ipv4.ip_local_port_range=32768-60999）：
//     监听池若落入该区间，会与内核 connect() 临时源端口竞争——原 40000-43199 正落其中。
//
// 模型：少数「物理池」+「逻辑段→池」映射。逻辑段名（role）保留为端口记录上的业务标签，
//   端口统一直共享池取号：proxyInstance/oauthCallback 共用 managed 池（K8s 单一范围
//   思想，杜绝段碎片化「这个段空那个段满」）；providerApi 独立池（供应商规模可弹性扩）。
// 可配置：config.portPools 覆盖（大规模部署按需调大 base/count），不写死在编译期。
// ═══════════════════════════════════════════════════════════════════════════
const DEFAULT_POOLS = {
  managed: { base: 20000, count: 4000 },      // proxyInstance + oauthCallback 共享（20000-23999）
  providerApi: { base: 24000, count: 2000 },  // 智能路由每供应商独立 API 端点（24000-25999，可容 2000 供应商）
};

// 逻辑段（role）→ 物理池。role 仍是端口记录上的业务标签，仅决定从哪个池取号。
const SEGMENT_POOL = {
  proxyInstance: 'managed',
  oauthCallback: 'managed',
  providerApi: 'providerApi',
};


class PortRegistry {
  constructor(opts) {
    // ⚠ 2026-09-11 修复（K7）：原为 `process.env.HOME || '/tmp'` ——
    //   早期曾先读 process.env.HOME：无 HOME 的环境（如服务化启动）会落到 /tmp 等盘根临时目录，
    //   与其它状态文件**不在同一目录**：state.json 在 %USERPROFILE%\.dsh\supervisor\，
    //   ports.json 却在 \tmp\。后果：端口记录与守卫状态分裂，卸载/迁移时残留。
    //   os.homedir() 才是正确来源（统一处理 HOME / USERPROFILE 等差异）。
    this._file = (opts && opts.file) || path.join(require('../../platform/state-root').supervisorDir(), 'ports.json');
    this._records = new Map();   // port -> { port, role, owner, createdAt }
    this._allocLock = false;     // 分配互斥：isTaken(await) 窗口内并发调用必须串行
    // 物理池（可配置）：opts.pools 覆盖默认（config.portPools 注入）；键缺失回退默认。
    this._pools = Object.assign({}, DEFAULT_POOLS, (opts && opts.pools) || {});
    this._load();
  }

  /** 设置/覆盖物理池定义（config 注入）。 */
  configurePools(pools) {
    if (pools && typeof pools === 'object') this._pools = Object.assign({}, DEFAULT_POOLS, pools);
    return this._pools;
  }

  /** 逻辑段 → 池定义（未注册段名回退 managed 池，保持前向兼容）。 */
  rangeOf(segment) {
    const pool = SEGMENT_POOL[segment] || 'managed';
    return this._pools[pool] || DEFAULT_POOLS[pool] || DEFAULT_POOLS.managed;
  }

  /** 逻辑段在其所属池内的锚点偏移：同一池内各段有稳定起点（按池内段序 × 1000），
   *  保证确定性最小空闲分配仍可预测；池空间不足时经取模回绕扩展（不越池）。
   *  注意：偏移必须按「同池段序」而非全局段序计算，否则跨池段会锚到池外。 */
  _anchorOffset(segment) {
    const pool = SEGMENT_POOL[segment] || 'managed';
    const samePool = Object.keys(SEGMENT_POOL).filter((s) => (SEGMENT_POOL[s] || 'managed') === pool);
    const idx = samePool.indexOf(segment);
    const range = this.rangeOf(segment);
    const offset = (idx > 0 ? idx * 1000 : 0);
    return offset < range.count ? offset : 0; // 偏移不得超出池容量（否则回退池首）
  }

  /** 重设持久化文件（守卫构造时注入：与 stateFile 同域；测试可指向临时目录，避免污染生产记录）。
   *  重新加载新文件内容；旧内存记录废弃（不写回旧文件——测试进程绝不触碰生产 ports.json）。 */
  configureFile(file) {
    if (typeof file !== 'string' || !file) return;
    this._file = file;
    this._records = new Map();
    this._allocLock = false;
    this._load();
  }

  /* ═══════ 持久化 ═══════ */
  _load() {
    try {
      const doc = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      for (const r of (Array.isArray(doc.records) ? doc.records : [])) {
        if (r && Number.isInteger(r.port) && r.role) this._records.set(r.port, { port: r.port, role: r.role, owner: r.owner || null, createdAt: r.createdAt || Date.now() });
      }
    } catch {}
  }

  /** 迁移S2：把 router 自治端口段（owner 前缀 proxy:/providerApi:）从共享 oldFile 迁出到 newFile 并清旧段。幂等；失败抛错由调用方保留旧文件。 */
  migrateRouterSegment(oldFile, newFile) {
    const isRouterRec = (r) => String((r && r.owner) || "").startsWith("proxy:") || String((r && r.owner) || "").startsWith("providerApi:");
    if (!fs.existsSync(oldFile)) return 0;
    const doc = JSON.parse(fs.readFileSync(oldFile, "utf8"));
    const routerRecs = (doc.records || []).filter(isRouterRec);
    if (!routerRecs.length) return 0;
    let target = { records: [] };
    try { if (fs.existsSync(newFile)) target = JSON.parse(fs.readFileSync(newFile, "utf8")); } catch {}
    const seen = new Set((target.records || []).map((r) => r.port));
    let moved = 0;
    for (const r of routerRecs) { if (!seen.has(r.port)) { target.records.push(r); moved += 1; } }
    fs.mkdirSync(path.dirname(newFile), { recursive: true });
    const tmpN = newFile + ".tmp";
    fs.writeFileSync(tmpN, JSON.stringify(target, null, 2), { mode: 0o600 });
    fs.renameSync(tmpN, newFile);
    const keep = (doc.records || []).filter((r) => !isRouterRec(r));
    const tmpO = oldFile + ".tmp";
    fs.writeFileSync(tmpO, JSON.stringify({ records: keep }, null, 2), { mode: 0o600 });
    fs.renameSync(tmpO, oldFile);
    return moved;
  }

  /** 重新从文件加载（阶段三：守卫读路径先 reload，以权威文件为准，防跨进程陈旧内存快照）。 */
  reload() {
    this._records = new Map();
    this._allocLock = false;
    this._load();
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      const tmp = this._file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ records: [...this._records.values()] }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this._file);
    } catch (e) { /* 持久化失败不阻塞运行（内存态仍准确） */ }
  }

  /* ═══════ 登记（固定 / 用户 / 动态）═══════ */
  /** 登记固定端口（主DSH/API/中转等）。同端口已被其他固定角色占用 → 报错；
   *  user/动态记录（如实例 main 端口 = 主 DSH 端口）→ 固定端口权威覆盖。 */
  register(role, port) {
    const p = Number(port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) throw new Error('ports.register: 非法端口 ' + port);
    const existing = this._records.get(p);
    if (existing) {
      const existingFixed = String(existing.owner || '').startsWith('system:');
      if (existingFixed && existing.role !== role) throw new Error('端口 ' + p + ' 已被 [' + existing.role + '] 占用，无法登记为 [' + role + ']');
      // 覆盖 user/动态记录（固定端口权威；main 实例端口 = dsh-main 同一端口）
      if (existing.owner && !existingFixed) this._records.delete(p);
    }
    this._records.set(p, { port: p, role, owner: 'system:' + role, createdAt: Date.now() });
    this._save();
    return p;
  }

  /** 登记用户配置端口（实例内部端口等）。冲突（固定/保留段/已占用）抛错。 */
  registerUser(port, owner) {
    const p = Number(port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) throw new Error('ports.registerUser: 非法端口 ' + port);
    if (this._records.has(p)) throw new Error('端口 ' + p + ' 已被 [' + this._records.get(p).role + '] 占用');
    // 实例端口不得落入任何动态物理池（去重：共享池只报一次，避免重复报错文案）
    const seenPools = new Set();
    for (const key of Object.keys(this._pools)) {
      const rng = this._pools[key];
      if (!rng || seenPools.has(rng.base + ':' + rng.count)) continue;
      seenPools.add(rng.base + ':' + rng.count);
      if (p >= rng.base && p < rng.base + rng.count) throw new Error('端口 ' + p + ' 位于动态保留池 [' + key + ']，实例端口不可占用');
    }
    this._records.set(p, { port: p, role: 'user', owner: owner || 'user', createdAt: Date.now() });
    this._save();
    return p;
  }

  /** 按 owner 释放端口（对象删除/关闭时调用：实例删除、relay 关闭、反代实例停止、oauth 用完）。 */
  unregister(owner) {
    let removed = false;
    for (const [p, r] of this._records) {
      if (r.owner === owner) { this._records.delete(p); removed = true; }
    }
    if (removed) this._save();
  }

  /** 释放端口。
   *
   *  ⚠ 2026-09-12（P2）：新增可选的 `ownerId` 校验 —— 此前第二参被**静默忽略**。
   *
   *    缺陷：`guard/lifecycle/objects.js:264` 以 owner 意图调用
   *    `this.ports.release(port, ownerId)`（失败才回退 `release(port)`），
   *    但本函数的签名只有 `(port)` —— ownerId 被丢掉，**任何持有端口号的调用方
   *    都能删掉别人 owner 的登记记录**。
   *
   *    危害：若某 managed 对象的 port 已被回收并**重新分配给另一 owner**，
   *    旧对象迟到的 release 会误删新记录 → 新 owner 的端口失去登记（泄漏/被重复分配）。
   *
   *  现语义：
   *    · 不传 `ownerId`（既有调用方）→ 保持原「按端口号释放」语义（向后兼容）；
   *    · 传了 `ownerId` → **仅当登记 owner 匹配才释放**（不匹配即 no-op，并返回 false）。
   *
   *  @returns {boolean} 是否真的释放了一条记录
   */
  release(port, ownerId) {
    const p = Number(port);
    const rec = this._records.get(p);
    // ⚠ P2 修复（2026-09-13，失效模式 a）：**空值检查必须在 owner 比较之前**。
    //
    //   缺陷：原顺序是「先比对 rec.owner，再判 !rec」——
    //     而 rec 为 undefined 时读 rec.owner 会**抛 TypeError**
    //     （Cannot read properties of undefined (reading 'owner')）。
    //     实测：release(未登记端口, 任意ownerId) → TypeError。
    //   后果：本函数文档明确写「传了 ownerId → 仅当登记 owner 匹配才释放（不匹配即 no-op，
    //     并返回 false）」—— 而「端口尚未登记/已被别处释放」恰恰是**良构调用方最常见的场景**
    //     （ownerId 参数的存在意义就是让「如果归我再释放」安全），本该 no-op 返回 false，
    //     却抛异常。包裹了 try/catch 的调用方会把它静默吞掉 → 契约无声失效；
    //     未包裹的调用方直接崩。
    //   修法：先判空返回 false，再做 owner 比较。
    if (!rec) return false;
    // ownerId 为 undefined/null = 调用方未声明归属（既有语义：无条件按端口号释放）。
    if (ownerId !== undefined && ownerId !== null && rec.owner !== ownerId) return false;

    this._records.delete(p);
    this._save();
    return true;
  }

  /* ═══════ 查询 ═══════ */
  /** 按 role 取端口（固定端口）。 */
  get(role) {
    for (const r of this._records.values()) if (r.role === role) return r.port;
    return null;
  }

  /** 端口是否已登记（任意来源）。 */
  isRegistered(port) {
    return this._records.has(Number(port));
  }

  /** 端口登记记录（含 owner/role）；未登记返回 null。 */
  recordOf(port) {
    return this._records.get(Number(port)) || null;
  }

  /** 按 owner 查端口（业务对象从 registry 取自己的端口——端口唯一活在 registry，业务侧不持久化）。 */
  byOwner(owner) {
    for (const r of this._records.values()) if (r.owner === owner) return r.port;
    return null;
  }

  /** 端口是否被占用：已登记 ∪ 本机实际监听。
   *  @param excludeOwner 若提供：该 owner 自己的登记不算占用（可复用自己绑定的端口）。 */
  async isTaken(port, excludeOwner) {
    const rec = this._records.get(Number(port));
    if (rec && (!excludeOwner || rec.owner !== excludeOwner)) return true;
    return probe.portListening('127.0.0.1', Number(port), 300);
  }

  /** 全部端口清单（端口/角色/归属，供审计展示）。 */
  list() {
    return [...this._records.values()].sort((a, b) => a.port - b.port);
  }

  /* ═══════ 确定性槽位仲裁（2026-09 架构定稿）═══════
   * claimSlot(rangeKey, owner, opts)：统一「绑定持久 + 确定性分配 + 孤儿回收 + main 回迁」。
   *   期望槽位 = ① byOwner 既有绑定（绑定永久，重启复用）→ ② opts.preferred（如 main=40000）→
   *              ③ 段内最小空闲（按加入顺序补位，删除即释放补位）。
   *   期望被占（登记为异 owner / 本机监听）→ 先按 opts.reclaim 特征（cmdline pgrep，YAMA 免疫）
   *   回收「本工程旧代」→ 等释放（opts.waitMs）→ 重试；仍被外部占用 → 返回显式冲突（绝不静默跳号）。 */
  async claimSlot(rangeKey, owner, opts) {
    const o = opts || {};
    const range = o.range || this.rangeOf(rangeKey);
    if (!range) throw new Error('ports.claimSlot: 未知端口段 ' + rangeKey);
    // 整个「探测→登记」决策置于单一分配互斥下（含 tryClaim 的 async isTaken 探测窗口）：
    // 防止两个并发 claimSlot（异 owner）都读到端口空闲 → 双分配。原 _allocLock 只保护 _allocFree，
    // 未覆盖 tryClaim 路径（本文件自身『绝不双分配』不变量的破口）。
    await this._acquireAlloc();
    try {
      return await this._claimSlotLocked(rangeKey, owner, range, o);
    } finally {
      this._allocLock = false;
    }
  }

  /** 获取分配互斥（自旋等待）；调用方必须在 finally 释放 _allocLock。 */
  async _acquireAlloc() {
    while (this._allocLock) { await new Promise((r) => setTimeout(r, 10)); }
    this._allocLock = true;
  }

  /** claimSlot 主体（调用方已持锁；内部不得再次获取 _allocLock）。 */
  async _claimSlotLocked(rangeKey, owner, range, o) {
    const reclaim = async (port) => {
      if (!o.reclaimCmdMark) return 0;
      let killed = 0;
      try {
        const pidlook = require('../../platform/os/pidlookup');
        const cfg = o.reclaimCfg || '';
        for (const m of pidlook.pgrepList(o.reclaimCmdMark)) {
          const pid = m.pid;
          if (pid === process.pid) continue;
          const cmd = m.cmdline;
          if (cfg && cmd.indexOf(cfg) < 0) continue;
          try { process.kill(pid, 'SIGTERM'); killed++; } catch {}
        }
      } catch {}
      return killed;
    };
    const waitFree = async (port, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (!(await this.isTaken(port, owner))) return true; await new Promise((r) => setTimeout(r, 200)); }
      return !(await this.isTaken(port, owner));
    };
    const register = (port) => {
      if (!this._records.has(port)) { this._records.set(port, { port, role: rangeKey, owner, createdAt: Date.now() }); this._save(); }
    };
    const tryClaim = async (port) => {
      if (!port) return null;
      const rec = this._records.get(port);
      const selfListener = (() => { try { const pidlook = require('../../platform/os/pidlookup'); return pidlook.findListeningPid(port) === process.pid; } catch { return false; } })();
      if (selfListener) { register(port); return { port, mode: 'self-listening' }; }
      if (rec && rec.owner !== owner) return null;
      const reused = !!(rec && rec.owner === owner);
      const taken = await this.isTaken(port, owner);
      if (!taken) { register(port); return { port, mode: reused ? 'reuse' : 'claim' }; }
      const killed = await reclaim(port);
      if (killed > 0 && (await waitFree(port, o.waitMs || 6000))) { register(port); return { port, mode: 'reclaimed' }; }
      return null;
    };
    const bound = this.byOwner(owner);
    if (bound) {
      const r = await tryClaim(bound);
      if (r) return Object.assign({ owner, segment: rangeKey, binding: true }, r);
      const alt = await this._allocFreeCore(rangeKey, range, owner, o);
      if (alt) {
        if (o.onBindingLost) { try { o.onBindingLost({ owner, from: bound, to: alt.port }); } catch {} }
        return Object.assign({ owner, segment: rangeKey, binding: true, bindingLost: true, from: bound }, alt);
      }
      return Object.assign({ owner, segment: rangeKey, conflict: true, reason: 'binding-occupied-and-pool-full', error: 'port-pool-exhausted', capacity: this.capacity()[SEGMENT_POOL[rangeKey] || 'managed'] || null, port: bound });
    }
    if (o.preferred) {
      const r = await tryClaim(o.preferred);
      if (r) return Object.assign({ owner, segment: rangeKey, preferred: true, bindingPreferred: !!o.bindingPreferred }, r);
      if (o.bindingPreferred) {
        const alt = await this._allocFreeCore(rangeKey, range, owner, o);
        if (alt) {
          if (o.onBindingLost) { try { o.onBindingLost({ owner, from: o.preferred, to: alt.port }); } catch {} }
          return Object.assign({ owner, segment: rangeKey, preferred: true, bindingPreferred: true, bindingLost: true, from: o.preferred }, alt);
        }
        return Object.assign({ owner, segment: rangeKey, conflict: true, reason: 'binding-preferred-occupied-and-pool-full', error: 'port-pool-exhausted', capacity: this.capacity()[SEGMENT_POOL[rangeKey] || 'managed'] || null, port: o.preferred });
      }
    }
    const free = await this._allocFreeCore(rangeKey, range, owner, o);
    if (free) return Object.assign({ owner, segment: rangeKey }, free);
    const cap = this.capacity()[SEGMENT_POOL[rangeKey] || 'managed'] || null;
    return Object.assign({ owner, segment: rangeKey, conflict: true, reason: 'pool-full', error: 'port-pool-exhausted', capacity: cap });
  }

  /** 池内最小空闲分配（不获取锁；调用方已持 _allocLock）。 */
  async _allocFreeCore(rangeKey, range, owner, o) {
    const offset = (o && o.range) ? 0 : this._anchorOffset(rangeKey);
    for (let n = 0; n < range.count; n++) {
      const p = range.base + ((offset + n) % range.count);
      if (this._records.has(p)) continue;
      if (await this.isTaken(p)) {
        if (o.reclaimCmdMark) {
          try {
            const pidlook = require('../../platform/os/pidlookup');
            const cfg = o.reclaimCfg || '';
            for (const m of pidlook.pgrepList(o.reclaimCmdMark)) {
              const pid = m.pid;
              if (pid === process.pid) continue;
              const cmd = m.cmdline;
              if (cfg && cmd.indexOf(cfg) < 0) continue;
              try { process.kill(pid, 'SIGTERM'); } catch {}
            }
          } catch {}
          await new Promise((r2) => setTimeout(r2, o.waitMs || 2500));
        }
        if (await this.isTaken(p)) continue;
      }
      if (!(await this._canBind(p))) continue;
      this._records.set(p, { port: p, role: rangeKey, owner, createdAt: Date.now() });
      this._save();
      return { port: p, mode: 'allocated' };
    }
    return null;
  }

  // ── 注：此处原有 `_allocFree()`（自持锁的池内最小空闲分配包装）已删除（2026-09-12）──
  //   全仓无任何调用点（`claimSlot` 用的是 `_allocFreeCore`），是死代码。
  //   保留它反而危险：一个「看起来可公开调用」的入口会诱使后来者绕过 claimSlot 的
  //   owner 判定与 mode 语义，直接拿到端口。

  /* ═══════ 动态分配 ═══════ */
  /** bind 探测：尝试在本机 127.0.0.1 绑定端口。能绑定 → 可分配；任何 bind 错误（典型
   *  EADDRINUSE）→ 视为已占用。TCP connect 探测看不见“不监听但占 bind”的残留
   *  （如对已停止反代实例端口的空闲 keep-alive 连接——connect 失败但后续 spawn bind 会撞
   *  EADDRINUSE），本探测与真实 spawn 的绑定语义一致，能兜住这类隐藏占用。 */
  _canBind(port) {
    // 延迟 require：避免顶层依赖 net（本模块其余部分与网络无关）
    const net = require('node:net');
    return new Promise((resolve) => {
      let done = false;
      const srv = net.createServer();
      const finish = (ok) => { if (done) return; done = true; try { srv.close(); } catch {} resolve(ok); };
      srv.once('error', () => finish(false)); // EADDRINUSE / EACCES 等均视为不可绑
      srv.listen(port, '127.0.0.1', () => finish(true));
    });
  }

  /** 在指定逻辑段分配空闲端口并登记（owner 绑定）。互斥防并发同端口。
   *  候选判占 = 端口登记 ∪ TCP connect 探测 ∪ bind 探测（三重，防隐藏占用）。
   *  工业标准：返回「最小空闲」确定性端口；池满返回 null（调用方应转显式满错误 + 告警）。
   *  opts.skipFirst 保留兼容（跳过池内首个候选，供特殊场景）。 */
  async allocate(rangeKey, owner, opts) {
    const range = this.rangeOf(rangeKey);
    if (!range) throw new Error('ports.allocate: 未知端口段 ' + rangeKey);
    const o = opts || {};
    const anchor = (o.range) ? 0 : this._anchorOffset(rangeKey);
    const start = anchor + ((o.skipFirst) ? 1 : 0);
    // ⚠ 2026-09-12（P2）：此处原**内联**了一遍与 `_acquireAlloc()` 完全相同的自旋等待 ——
    //   「同一事实两处实现」，任一处将来加超时/加日志都会分叉。已统一经该 helper。
    await this._acquireAlloc();
    try {
      for (let n = 0; n < range.count; n++) {
        const p = range.base + ((start + n) % range.count);
        if (this._records.has(p)) continue;      // 已登记（含持久化恢复的绑定）
        if (await this.isTaken(p)) continue;
        if (!(await this._canBind(p))) continue; // 残留/隐藏占用：connect 探测不可见但 bind 会失败
        this._records.set(p, { port: p, role: rangeKey, owner: owner || 'dynamic:' + rangeKey, createdAt: Date.now() });
        this._save();
        return p;
      }
      return null;
    } finally {
      this._allocLock = false;
    }
  }

  /** 显式登记已分配端口（复用持久化端口时调用：端口记录恢复/回迁）。 */
  allocateMark(port, role, owner) {
    const p = Number(port);
    if (!this._records.has(p)) {
      this._records.set(p, { port: p, role: role || 'dynamic', owner: owner || 'dynamic', createdAt: Date.now() });
      this._save();
    }
  }

  /** 池容量视图（工业标准：可观测性）。每个物理池返回 { base, size, used, free, utilization }。 */
  capacity() {
    const out = {};
    for (const [pool, rng] of Object.entries(this._pools)) {
      let used = 0;
      for (const r of this._records.values()) {
        if (r.port >= rng.base && r.port < rng.base + rng.count) used += 1;
      }
      const free = Math.max(0, rng.count - used);
      out[pool] = {
        base: rng.base, size: rng.count, used, free,
        utilization: rng.count > 0 ? Number((used / rng.count).toFixed(4)) : 0,
      };
    }
    return out;
  }

  /** 逻辑段当前可用量（调用方分配前判断/告警）。 */
  available(segment) {
    const pool = SEGMENT_POOL[segment] || 'managed';
    const cap = this.capacity()[pool];
    return cap ? cap.free : this.rangeOf(segment).count;
  }

  /** 明确判断某逻辑段是否已满（供调用方给出显式错误而非静默 null）。 */
  isFull(segment) {
    return this.available(segment) <= 0;
  }

  /** 全部端口快照（固定/用户/分配，供审计）。 */
  snapshotAll() {
    const byRole = (fn) => [...this._records.values()].filter(fn).map((r) => r.port).sort((a, b) => a - b);
    return {
      fixed: Object.fromEntries([...this._records.values()].filter((r) => String(r.owner || '').startsWith('system:')).map((r) => [r.role, r.port])),
      user: byRole((r) => r.role === 'user'),
      allocated: byRole((r) => r.role !== 'user' && !String(r.role).startsWith('system:')),
    };
  }
}

// 单例：全系统共享（supervisor 构造时注入 file 路径）
const shared = new PortRegistry();

module.exports = { PortRegistry, shared, DEFAULT_POOLS, SEGMENT_POOL };