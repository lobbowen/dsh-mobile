'use strict';

// §7.6 拆分自 supervisor.js：supervise-view（原型 mixin）。
// 仅经 this 协作；导出「原型属性描述符」由 supervisor.js 注入 Supervisor.prototype。
// 行为与拆分前逐字一致（含 getter/setter；class 体方法无需逗号）。
// 依赖由拆分脚本按块内实际使用自动携带（遗漏会导致运行期 ReferenceError）。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const pidlook = require('../../platform/os/pidlookup');
const { DaemonLifecycle } = require('../../guard/proc/daemon-lifecycle');
const monitor = require('../../guard/monitor/index');
const ports = require('../../guard/lifecycle/ports').shared;
const guardian = require('../../guard/guardian/index');

class SuperviseView {
  async _dshSuperviseOnce() {
    try {
      if (this._stopping) return { ok: false, error: 'guard stopping' };
      if (this._sessionHalting()) return { ok: false, error: 'session halting' }; // INV-S1 全域
      await this._dshConverge(); // 唯一心跳驱动 main 收敛
    } catch (e) {
      this.logger && this.logger.warn && this.logger.warn('[dsh] supervise 异常: ' + ((e && e.message) || e));
    }
    this._shadowHeartbeatBeat(); // 影子聚合（每拍对新 tick 记录记账/事件）
    // R5 游离对象自检（低频 ~60s，只告警）：目录/期望之外的受管族进程与端口
    try {
      const now = Date.now();
      if (!this._lastOrphanAuditAt || now - this._lastOrphanAuditAt > 60000) {
        this._lastOrphanAuditAt = now;
        this._orphanAudit();
      }
    } catch (e) { this.logger && this.logger.debug && this.logger.debug('orphan audit: ' + ((e && e.message) || e)); }
    // 系统日志框架（P1b）：守卫 EventHub 每拍聚合 guard + daemon(ctl 拉尾, 节流 ~6 拍) 事件
    if (this.eventHub) { try { await this.eventHub.sync(); } catch (e) { this.logger && this.logger.debug && this.logger.debug('eventHub sync: ' + ((e && e.message) || e)); } }
    // C3-3a 观测语义保留：ok 与 tick 探测同源（lastProbeOk = L1 端口在线）
    return {
      ok: this._mLastProbeOk() === true,
      error: this._mLastProbeOk() ? null : (this._mPhase() === 'STOPPED' ? '未运行' : '端口未监听/不健康'),
    };
  }

  /** main(dsh) 当前状态快照（tick 探测后采样；纯读零副作用）。
   *  probeOk/probeHttpOk 即本拍真实探测（与旧 tick 决策同源）——影子与 actual 用同一输入。 */
  // ── 本节已拆分 → guard/supervisor/converge-view.js（§7.6 结构性重构）──

  /** 把守卫对 DSH 的观测状态合成到 lifecycleManager 的 dsh 项（C3-3b G5：仅视图，不驱动守卫逻辑）。
   *  数据源 = registry.get('main') 目录项：desired/phase 取应然与受管相位；
   *  healthy/error/lastProbeAt 由观测合成（收敛探测镜像 process.lastProbe* 优先——与心跳
   *  lastObserved 同源同义：L1 端口在线 + L2 HTTP 健康），不再经观测镜像喂入。 */
  _syncDshLifecycleView() {
    if (!this.lifecycleManager) return;
    const dsh = this.lifecycleManager.get('dsh');
    if (!dsh) return;
    const e = this._dshEntry();
    const ph = String(this._mPhase() || '');
    const desiredRunning = this._mDesired() === 'running';
    const ob = (e && e.lastObserved) || null;
    const proc = (e && e.process) || null;
    const portUp = !!(proc && proc.lastProbeOk) || !!(ob && ob.ok);
    const httpOk = !(proc && proc.lastProbeHttpOk === false);
    const healthy = portUp && httpOk;
    const errText = !portUp ? '端口未监听' : (httpOk ? null : 'HTTP 不健康');
    const at = (proc && proc.lastProbeAt) || (ob && ob.at) || null;
    if (desiredRunning) {
      dsh.wantRunning();
      dsh._monitoring = true;
      if (at) dsh.lastProbeAt = at;
      if (ph === 'RUNNING') {
        dsh._setPhase('running');
        dsh.startedAt = dsh.startedAt || new Date().toISOString();
        dsh.healthy = healthy;
        dsh.error = errText;
      } else if (ph === 'STARTING' || ph === 'RESTARTING') {
        dsh._setPhase('starting');
        dsh.healthy = healthy;
        dsh.error = errText;
      } else if (ph === 'BACKOFF') {
        dsh._setPhase('starting');
        dsh.error = '启动退避中';
      } else {
        dsh._setPhase('stopped');
        dsh.healthy = false;
        dsh.error = errText;
      }
    } else {
      dsh.desired = 'stopped';
      dsh._monitoring = false;
      dsh._setPhase('stopped');
      dsh.healthy = false;
    }
    // guardian 唯一来源 = A 平面(dsh-main.json)：B 平面只读同步，不持有独立守护策略（2026-09 收敛）
    dsh.guardian = this._mGuardian();
  }

  /** 独立 router-daemon 是否在运行（探测 ctl 端口监听者 cmdline 是否 router-daemon，2026-09 L3）。
   *  守卫与 router-daemon 解耦后：守卫探测到 daemon 在跑 → 不再内嵌启动 router（避免双占 ctl 口），
   *  只做监督（lifecycleManager 周期探活 ctl 口，异常时拉起 daemon）。 */
  _routerDaemonActive() {
    try {
      const pid = pidlook.findListeningPid(this._routerCtlPort());
      if (!pid) return false;
      // 2026-09-13 修复（P1）：路径字面量是 "/"，而 Windows 的 cmdline 是反斜杠
      //   → 直接 indexOf 永远 -1 → 认不出 daemon 已在跑（可能重复拉起）。
      const cmd = pidlook.normCmdline(pidlook.readCmdline(pid) || '');
      return cmd.indexOf('router-daemon') >= 0 || cmd.indexOf('service-daemon') >= 0 || cmd.indexOf('/domains/router/daemon.js') >= 0;
    } catch { return false; }
  }

  /** R5 游离对象自检（低频只告警，不自动处理；异主隔离红线：绝不强杀/释放）。
   *   覆盖：① daemon 族(43107/router ctl) 被监听但本守卫期望停止且无管理锁（异主/残留）；
   *   ② 端口登记 owner=inst:* 但实例已不存在（正常应被 _syncInstancePorts 即时清理的残留）；
   *   ③ 目录项期望 running/starting 但观测长期失联（幽灵/死登记——监督介入前的观测线索）。
   *   结果只写日志 + orphan_audit 事件（同指纹 10min 抑制），供审计排查。 */
  _orphanAudit() {
    if (this._stopping) return;
    const now = Date.now();
    const reg = this.managedObjects;
    const issues = [];
    try {
      // ① daemon 族：在监听但目录/期望不认可（异主 daemon 或残留进程）
      const daemons = [
        { kind: 'router-daemon', port: this._routerCtlPort(), active: () => this._routerDaemonActive(), managed: () => this._daemonManaged(), want: () => this.config.routerAutostart === true || !!(reg && reg.get('router-daemon') && reg.get('router-daemon').desired === 'running') },
      ];
      for (const d of daemons) {
        if (!d.active()) continue;
        if (!d.want() && !d.managed()) {
          issues.push({ kind: d.kind, port: d.port, why: '端口被监听但本守卫期望停止且无管理锁（异主/残留 daemon）' });
        }
      }
      // ② 端口登记残留（owner=inst:* → 实例已不存在）
      try {
        const ids = new Set();
        for (const rec of ports.list()) {
          if (!String(rec.owner || '').startsWith('inst:')) continue;
          const id = String(rec.owner).slice(5);
          if (!ids.has(id)) issues.push({ kind: 'port-registration', owner: rec.owner, port: rec.port, why: '端口登记 owner 指向已不存在的实例（残留登记）' });
        }
      } catch {}
      // ③ 幽灵登记观测线索：期望运行但实然长期失联（main 由收敛接管，跳过避免噪声）
      try {
        const staleMs = Math.max(3 * (this.config.probeIntervalMs || 5000), 30000);
        for (const e of (reg && typeof reg.list === 'function') ? reg.list() : []) {
          if (e.id === 'main') continue;
          if (e.phase !== 'running' && e.phase !== 'starting') continue;
          const ob = e.lastObserved;
          if (ob && ob.ok === false && ob.at && now - new Date(ob.at).getTime() > staleMs) {
            issues.push({ kind: e.kind, id: e.id, why: '期望运行但观测长期失联（幽灵登记）' });
          }
        }
      } catch {}
      if (issues.length === 0) return;
      const key = issues.map((i) => i.kind + ':' + (i.id || i.port || i.owner)).join('|');
      if (this._lastOrphanKey === key && this._lastOrphanAt && now - this._lastOrphanAt < 10 * 60 * 1000) return; // 同指纹抑制
      this._lastOrphanKey = key;
      this._lastOrphanAt = now;
      if (this.events && this.events.append) { try { this.events.append('orphan_audit', { issues, at: new Date().toISOString() }); } catch {} }
      const detail = issues.map((i) => i.kind + (i.id ? ':' + i.id : '') + (i.port ? ':' + i.port : '') + (i.owner ? ':' + i.owner : '') + ' ' + i.why).join(' | ');
      this.logger && this.logger.warn && this.logger.warn('[orphan] 游离对象自检: ' + detail);
    } catch (e) {
      this.logger && this.logger.warn && this.logger.warn('[orphan] 自检异常: ' + ((e && e.message) || e));
    }
  }

  // ── router-daemon 管理权锁（2026-09 L3 监督）──
  // 关键语义：只有「本守卫目录写过管理锁」的 Supervisor 实例才可接管/停止/拉起独立 router-daemon。
  // 防止任意 Supervisor 实例（尤其测试内嵌实例与线上守卫并存于同一主机）经全局 43011 探测
  // 误接管/误杀生产 daemon（2026-09 实测 p2p-api-test 曾把测试调用经 ctl 打到线上路由）。
  _routerDaemonLockPath() {
    try { return path.join(path.dirname(this.config.stateFile), 'router-daemon.lock'); } catch { return null; }
  }

  _daemonManaged() {
    try { const p = this._routerDaemonLockPath(); return !!p && fs.existsSync(p); } catch { return false; }
  }

  _writeRouterDaemonLock() {
    try { const p = this._routerDaemonLockPath(); if (p) fs.writeFileSync(p, String(process.pid)); } catch {}
  }

  _clearRouterDaemonLock() {
    try { const p = this._routerDaemonLockPath(); if (p) { try { fs.unlinkSync(p); } catch {} } } catch {}
  }

  /** 拉起独立 router-daemon（detached 子进程——守卫退出不影响它；幂等：ctl 口已被占则不重复拉起）。
   *  @returns { active:boolean, mode:'daemon'|'embedded'|'error', error? } */
  _ensureRouterRuntime(desiredRunning) {
    try {
      const daemonActive = this._routerDaemonActive();
      const managed = this._daemonManaged();
      // ⚠ 2026-09-12（P2）：**把「daemon 模式下守卫不得写状态文件」收敛到本函数**。
      //
      //   缺陷：该纪律此前只在 supervisor.js 的一处 daemon 分支里执行
      //     （`setPersistEnabled(false)`），而本函数**还有另外两个**会返回
      //     `mode:'daemon'` 的路径（下面的「已在跑」与本段）—— 经它们进入 daemon 模式时
      //     _persistEnabled 仍为 true，守卫会与 daemon **双写 providers.json**，
      //     后写者覆盖前者（正是该纪律要防的事）。
      //   现统一在此处置：任何返回 daemon 模式的路径都已关闭写权。
      if (desiredRunning !== false && daemonActive && managed) {
        // daemon 已在跑且为本守卫管理：监督模式（守卫不再内嵌启动）
        this._disableRouterPersist();
        return { active: true, mode: 'daemon' };
      }
      if (desiredRunning !== false && daemonActive && !managed) {
        // 有 daemon 在跑但非本守卫管理（异主/测试环境）：绝不接管，退回内嵌语义
        // （测试内嵌 RouterService 用独立 TMP 状态，不触碰 43011/ctl）
        return { active: false, mode: 'embedded' };
      }
      if (desiredRunning === false) {
        // 停止语义：仅停「本守卫管理」的 daemon；异主 daemon 不碰；否则由调用方停内嵌 router
        if (daemonActive && managed) {
          const pid = pidlook.findListeningPid(this._routerCtlPort());
          if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
          this._clearRouterDaemonLock();
          const lcS = this._daemonLifecycle('router');
          if (lcS) { lcS._clearIdentity(); lcS._spawnWindowUntil = 0; }
          return { active: false, mode: 'daemon', stopping: true };
        }
        return { active: false, mode: 'embedded' };
      }
      // 非守卫实例（测试 Supervisor 等无配置文件构造）绝不拉起/接管独立 daemon——纯内嵌语义，
      // 防测试进程在探测不可见宿主 daemon 的环境下把 router-daemon 拉出一堆 stray。
      if (!this.configPath) {
        return { active: false, mode: 'embedded', reason: 'non-guard' };
      }
      // ══ 统一进程生命周期（2026-09 架构定稿）：见 DaemonLifecycle ══
      const lc = this._daemonLifecycle('router');
      if (!lc) return { active: false, mode: 'embedded' };
      const res = this._daemonEnsureResult(lc, () => this._writeRouterDaemonLock());
      // 本路径也可能返回 daemon 模式（拉起/接管成功）→ 同样关闭守卫写权（见函数顶部说明）。
      if (res && res.mode === 'daemon') this._disableRouterPersist();
      return res;
    } catch (e) {
      return { active: false, mode: 'error', error: e.message };
    }
  }

  /** daemon 模式下关闭守卫对 providers.json 的写权（防双写覆盖）。
   *
   *  为什么抽成方法：`_ensureRouterRuntime` 有**三条**会返回 daemon 模式的路径，
   *  该纪律必须在**每条**上执行 —— 集中一处，避免将来新增路径时再漏（本缺陷即由此产生）。
   *  幂等：重复调用无副作用。
   */
  _disableRouterPersist() {
    if (this.router && typeof this.router.setPersistEnabled === 'function') {
      try { this.router.setPersistEnabled(false); } catch {}
    }
  }

  /** L3 监督（30s tick，见 start()）：router 期望运行但 daemon 失联 → 重新拉起（幂等）。
   *  纯进程/端口检查（无业务探活）。守卫退出不影响 daemon；本方法只补「期望运行时的异常拉起」。 */

  /** adopt 令牌接管（2026-09 第四轮修复，见 CHANGELOG「adopt 令牌接管」；曾因工作区回滚丢失，2026-09-04 依回归测试重建）：
   *  守卫重启后新守卫 _adopt() 接管的是旧守卫 spawn 的主 DSH——被接管进程非本守卫 spawn，
   *  其启动令牌只打印在旧守卫已断开的 stdout 管道里（令牌服务不落盘）→ 主令牌永久不可达 →
   *  relay 无法用令牌向回环 DSH 换 dsh-auth cookie → 远程控制 401。
   *  语义（RUNNING tick 每周期调用，幂等）：
   *   - 非「被接管且主令牌空置」→ 复位观察并返回（本守卫 spawn 有 child 管道 / 令牌已就绪）
   *   - 观察窗（config.tokenReclaimGraceMs，默认 20s）内令牌迟到（journald/补获）→ 复位观察不干预
   *   - 窗口过仍空置 → 受控重建一次（_beginRestart('adopt_token_reclaim', {countCrash:false})：
   *     杀 adopt 进程 → RESTARTING → 自 spawn 建新 stdout 管道 → 令牌必然可捕获）
   *   - _tokenReclaimTried 保证每次接管仅重建一次，防重启循环 */
  _maybeReclaimAdoptToken() {
    try {
      const tokenOk = !!(this.tokenService && this.tokenService.get('main'));
      const adoptedUnmanaged = this._mAdopted() === true && !!this._mAdoptPid() && !this._mChild();
      if (this._mPhase() !== 'RUNNING' || !adoptedUnmanaged || tokenOk) {
        // 令牌已就绪 / 自 spawn / 非 RUNNING：复位观察（若曾启动）并清重建标记
        if (this._tokenReclaimAt !== null || this._tokenReclaimTried) {
          this._tokenReclaimAt = null;
          this._tokenReclaimTried = false;
        }
        return;
      }
      if (this._tokenReclaimTried) return; // 本次接管已重建过：防循环
      const grace = Number((this.config && this.config.tokenReclaimGraceMs)) || 20000;
      if (this._tokenReclaimAt === null) {
        this._tokenReclaimAt = Date.now() + grace; // 启动观察窗
        return;
      }
      if (Date.now() < this._tokenReclaimAt) return; // 窗口未满：继续观察
      // 窗口已过且主令牌仍空置：受控重建一次
      this._tokenReclaimAt = null;
      this._tokenReclaimTried = true;
      if (this.events && this.events.append) this.events.append('adopt_token_reclaim_started', { pid: this._mAdoptPid() });
      if (this.logger && this.logger.warn) this.logger.warn('[token] adopt 主令牌观察窗过期仍空置，受控重建接管进程（一次）');
      this._beginRestart('adopt_token_reclaim', { countCrash: false });
    } catch (e) {
      if (this.logger && this.logger.warn) this.logger.warn('_maybeReclaimAdoptToken: ' + ((e && e.message) || e));
    }
  }

  _warnOccupied() {
    const now = Date.now();
    if (now - this._lastOccupiedWarn > 60000) {
      this._lastOccupiedWarn = now;
      this.events.append('port_occupied_unhealthy', { host: this.config.targetHost, port: this.config.targetPort });
    }
  }

  /** 假死识别（健康维度判定）：进程/端口在但 HTTP 不健康 → 连续 failThreshold 次判故障重启。
   *  单次抖动不清零（failStreak 单调累积直到达到阈值或恢复健康），达到阈值即触发。
   *  httpProbeEnabled=false 时 healthOk 恒为 true（monitor.probe 已退化），此处天然不触发。 */
  _applyHealthCheck(healthOk) {
    if (healthOk) {
      this._mSetFailStreak(0);
      return;
    }
    this._mSetFailStreak(this._mFailStreak() + 1);
    const threshold = this.config.failThreshold || 2;
    if (this._mFailStreak() >= threshold) {
      this.events.append('unhealthy', { reason: 'http_unhealthy', streak: this._mFailStreak() });
      this._beginRestart('http_unhealthy', { countCrash: true });
    }
  }
}

const _desc = Object.getOwnPropertyDescriptors(SuperviseView.prototype);
delete _desc.constructor; // 不覆盖 Supervisor.prototype.constructor

module.exports = _desc;
