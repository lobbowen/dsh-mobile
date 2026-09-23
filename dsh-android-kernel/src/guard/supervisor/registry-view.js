'use strict';

// §7.6 拆分自 supervisor.js：registry-view（原型 mixin）。
// 仅经 this 协作，导出「原型属性描述符」由 supervisor.js 注入 Supervisor.prototype——
// 行为与拆分前逐字一致（含 getter/setter 语义；class 体方法无需逗号）。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os'); // 拆分携带：_managedMainSpec 用 os.homedir() 作数据根

class RegistryView {
  // ══ 原生 DSH = 守卫核心服务：main 元数据自足（2026-09-06 概念清分）══
  // main 不再登记为沙箱实例（instances.json 只含沙箱）；其元数据（只有守护开关 guardian）
  // 落守卫核心存储 <stateDir>/dsh-main.json。进程生命周期事实源 = config.targetPort(守卫 spawn/观测)。
  // 已删字段（远程控制域与公网暴露随 relay/frpc 一并下架，勿回潮）：
  // remoteEnabled / remoteToken / frpEnabled / frpRemotePort / wanPort 及其事件 dsh_remote_changed、dsh_frp_changed。
  _dshMainFile() {
    try { return path.join(path.dirname(this.config.stateFile), 'dsh-main.json'); } catch { return null; }
  }

  /** 受管对象目录持久化文件名（按守卫 stateFile 派生，隔离同目录多守卫；生产 state.json → managed-objects.json）。 */
  _registryFileName() {
    try {
      const b = path.basename(this.config.stateFile || 'state.json', '.json');
      return b === 'state' ? 'managed-objects.json' : (b + '.managed-objects.json');
    } catch { return 'managed-objects.json'; }
  }

  /** 读 main 元数据(无文件则默认：守护关、远程关)。结果缓存到 _dshMainLive（LanManager 等修改后经 _persistDshMainLive 回写）。 */
  _readDshMain() {
    if (this._dshMainLive) return this._dshMainLive;
    this._dshMainLive = this._readDshMainFile();
    return this._dshMainLive;
  }

  _readDshMainFile() {
    try {
      const f = this._dshMainFile();
      if (f && fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        return { guardian: j.guardian === true };
      }
    } catch {}
    return { guardian: false };
  }

  /** 写 main 元数据(白名单字段，原子写 0600)。更新 live 缓存。 */
  _writeDshMain(meta) {
    // live 稳定引用原地修改（LanManager mainOf 持有同一对象；替换引用会使其失效）
    if (!this._dshMainLive) this._dshMainLive = this._readDshMainFile();
    Object.assign(this._dshMainLive, meta || {});
    const f = this._dshMainFile();
    if (!f) return;
    try {
      const cur = this._readDshMain();
      const merged = Object.assign({}, cur, meta || {});
      const dir = path.dirname(f);
      fs.mkdirSync(dir, { recursive: true });
      const body = JSON.stringify({ guardian: merged.guardian === true }, null, 2);
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, f);
    } catch (e) { this.logger && this.logger.warn && this.logger.warn('_writeDshMain: ' + (e && e.message)); }
  }

  /** main 的统一只读视图（守卫核心服务；端口事实源 = config.targetPort）。 */
  dshMainView() {
    const m = this._readDshMain();
    const cmd = Array.isArray(this.config.command) ? this.config.command.slice() : [];
    return {
      id: 'main',
      name: '主实例',
      port: Number(this.config.targetPort || 3080),
      command: cmd,
      domain: 'native',
      kind: 'native',
      guardian: m.guardian,
      // unitName（系统服务管理器单元名）已删：安卓内核无系统服务管理器，main 由守卫 spawn/观测
      // 实时运行态：native 条目带 state（UI 与 /status 消费）
      state: {
        running: Boolean(this._mChild() || this._mAdoptPid()),
        phase: typeof this._mPhase === 'function' ? this._mPhase() : undefined,
        pid: this._mChild() ? this._mChild().pid : this._mAdoptPid(),
      },
    };
  }

  /** main 元数据补丁（白名单只有 guardian：守护自动拉起开关）。
   * 远程控制/公网暴露（remoteEnabled/remoteToken/frpEnabled/frpRemotePort/wanPort）已随
   * relay/frpc 域整体删除，body 里出现这些键一律**忽略**（不做兼容、不报错）。 */
  patchDshMain(patch) {
    const p = patch || {};
    const meta = this._readDshMain();
    const prev = { ...meta };
    if (p.guardian !== undefined) meta.guardian = !!p.guardian;
    this._writeDshMain(meta);
    // 开关变更事件（所有 main 开关记录进事件日志，可审计回放）
    try {
      if (p.guardian !== undefined && prev.guardian !== meta.guardian) {
        this.events.append('dsh_guardian_changed', { id: 'main', name: '原生 DSH', enabled: meta.guardian === true });
      }
    } catch (e) { this.logger && this.logger.warn && this.logger.warn('patchDshMain event: ' + ((e && e.message) || e)); }
    return { ok: true, main: this.dshMainView() };
  }

  // ══ 控制平面 v3：受管对象申报（R1 影子阶段；注册机只登记应然+所有权，不驱动）══
  /** main(dsh) 申报为管家注册项。 */
  _managedMainSpec() {
    const m = this._readDshMain();
    return {
      kind: 'dsh', id: 'main', name: '主实例',
      desired: this._mDesired() === 'stopped' ? 'stopped' : 'running',
      guardian: m.guardian === true,
      ownership: {
        ports: [{ role: 'dsh-main', port: Number(this.config.targetPort || 3080) }],
        rootPath: path.join(os.homedir(), '.dsh'),
        processMode: 'spawn', // main 由守卫 spawn/adopt（无系统服务管理器托管）
      },
    };
  }

  /** 启动对齐：main + daemon 申报入册（幂等：已注册则 update 应然）。
   * 沙箱实例申报已随实例域删除（安卓内核 multiInstance=false，无受管沙箱）。 */
  _syncManagedRegistry() {
    const reg = this.managedObjects;
    if (!reg) return;
    try {
      this._upsertManaged(this._managedMainSpec());
      // daemon 类申报（影子阶段；进程独立，目录只登记应然/所有权，不驱动）
      this._upsertManaged({
        kind: 'router-daemon', id: 'router-daemon', name: '智能路由 daemon',
        desired: this.config.routerAutostart === true ? 'running' : 'stopped',
        guardian: true,
        ownership: {
          daemonScript: require('../../platform/srcpath').daemonScript('router'),
          ports: [{ role: 'ctl', port: this._routerCtlPort() }],
          processMode: 'daemon',
        },
      });
      if (this.logger && this.logger.info) this.logger.info('[registry] 受管对象已申报: ' + reg.list().map((o) => o.kind + ':' + o.id).join(','));
    } catch (e) { this.logger && this.logger.warn && this.logger.warn('_syncManagedRegistry: ' + (e && e.message)); }
  }

  /** 申报或更新（存在→update 应然；否则 register）。 */
  _upsertManaged(spec) {
    const reg = this.managedObjects;
    if (!reg || !spec) return;
    try {
      const existing = reg.get(spec.id);
      if (existing) reg.update(spec.id, { desired: spec.desired, guardian: spec.guardian, name: spec.name, ownership: spec.ownership });
      else reg.register(spec);
    } catch (e) { this.logger && this.logger.warn && this.logger.warn('_upsertManaged(' + (spec && spec.id) + '): ' + (e && e.message)); }
  }

  _unregisterManaged(id) {
    const reg = this.managedObjects;
    if (!reg || !id) return;
    try { reg.unregister(id); } catch (e) { this.logger && this.logger.warn && this.logger.warn('_unregisterManaged(' + id + '): ' + (e && e.message)); }
  }

  // ══ C3-3b G4：main(dsh) 状态唯一存储 = 目录 main entry（this.* 并行字段已删除）══
  // 存储图（C3-3b G4）：
  // phase → entry.phase（唯一词表小写；OBSERVED 由 process.observedOnly/adopted 位合成呈现）
  // desired → entry.desired（registry.update 持久化，managed-objects.json 与 state.json 一致）
  // child/adoptedPid/adopted/observedOnly/startDeadline/restartAt/spawnBlockedUntil/missingNotified
  // /failStreak/lastProbe*/lastFailure/lastRestartAt → entry.process（句柄/瞬态，不持久化）
  // crashWindow*/backoff*/restartCount → entry 退避字段（registry 持久化 + state.json 双份恢复）
  // 读写口：守卫内一律经 _m*/_mSet*（本组 helper 是全部读写口，无 this.<字段> 残留）；
  // 类上另保留 get/set phase|desired|child|adoptedPid|adopted|observedOnly|restartCount|
  // spawnBlockedUntil|missingNotified 兼容访问器（外部/测试经统一状态读写口）。

  /** B2 归一：随目录持久化的崩溃/退避字段变化后，落盘目录（once 防抖避免每 tick 全量写）。 */
  _persistCrashField() {
    try {
      if (this.managedObjects && typeof this.managedObjects.persistCrashState === 'function') this.managedObjects.persistCrashState();
      else if (this.managedObjects && typeof this.managedObjects._save === 'function') this.managedObjects._save();
    } catch (e) { this.logger && this.logger.warn && this.logger.warn('persistCrashField: ' + ((e && e.message) || e)); }
  }

  /** 目录 main 项（未初始化/异常 → null）。 */
  _dshEntry() {
    if (!this.managedObjects || typeof this.managedObjects.get !== 'function') return null;
    try { return this.managedObjects.get('main') || null; } catch { return null; }
  }

  /** 构造期 fallback 存储（目录初始化前/异常时的统一读写口；目录就绪后不再使用）。 */
  _mainFallbackEntry() {
    if (!this._fallbackEntry) {
      this._fallbackEntry = {
        kind: 'dsh', id: 'main', name: '主实例',
        desired: 'running', guardian: true,
        ownership: { ports: [], rootPath: null, daemonScript: null, processMode: 'spawn', meta: null },
        phase: 'stopped', lastObserved: null,
        backoffLevel: 0, backoffUntil: null, crashWindowStart: null, crashWindowRestarts: 0,
        restartCount: 0, startedAt: null, lastTransitionAt: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        process: null,
      };
    }
    return this._fallbackEntry;
  }
}

const _desc = Object.getOwnPropertyDescriptors(RegistryView.prototype);
delete _desc.constructor; // 不覆盖 Supervisor.prototype.constructor

module.exports = _desc;
