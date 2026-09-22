'use strict';

// §7.6 拆分自 supervisor.js：converge-view（原型 mixin）。
// 仅经 this 协作；导出「原型属性描述符」由 supervisor.js 注入 Supervisor.prototype。
// 行为与拆分前逐字一致（含 getter/setter；class 体方法无需逗号）。
// 依赖由拆分脚本按块内实际使用自动携带（遗漏会导致运行期 ReferenceError）。
const { spawn } = require('node:child_process');
const pidlook = require('../../platform/os/pidlookup');
const monitor = require('../../guard/monitor/index');
const guardian = require('../../guard/guardian/index');

class ConvergeView {
  _mainStateSnapshot() {
    const now = Date.now();
    return {
      phase: this._mPhase(),
      desired: this._mDesired(),
      probeOk: this._mLastProbeOk() === true,
      probeHttpOk: this._mLastProbeHttpOk() === true,
      childAlive: !!(this._mChild() && this._mChild().exitCode === null && this._mChild().signalCode === null),
      adoptedAlive: !!(this._mAdoptPid() !== null && pidlook.isAlive(this._mAdoptPid())),
      adoptedPidSet: this._mAdoptPid() !== null,
      childPresent: this._mChild() !== null,
      adopted: this._mAdopted() === true,
      observedOnly: this._mObservedOnly() === true,
      upgradeHold: this._upgradeHold === true,
      manualRestart: this.manualRestart === true,
      spawnBlocked: !!(this._mSpawnBlockedUntil() && now < this._mSpawnBlockedUntil()),
      startDeadlinePassed: !!(this._mStartDeadline() && now > this._mStartDeadline()),
      restartDue: this._mRestartAt() === null || now >= this._mRestartAt(),
      backoffDue: this._mBackoffUntil() === null || now >= this._mBackoffUntil(),
      // K5 修复（2026-09-11）：`_shouldRun()` 有两个否决位，快照此前**都没建模** ——
      //   于是影子每拍算出的「应然」与真实 tick 不一致，`[shadow] 不一致` 长期刷屏，
      //   G3 切换门槛（连续零 diff）**永久不可达**。
      crashHalted: this._crashHalted === true, // guardian=false 崩溃后停靠：等显式启动
      sessionHalting: this._sessionHalting() === true, // 退出流程中：抑制一切自动拉起
      crashWindowStart: this._mCrashWindowStart(),
      crashWindowRestarts: this._mCrashWindowRestarts(),
      backoffLevel: this._mBackoffLevel(),
    };
  }

  /** 纯决策：按现有 tick 语义计算「应然下一步」。action 词表：
   *  none/start/stop/adopt/adoptObserved/enterRunning/restart/backoff。
   *  只读快照，零副作用（G1 影子 → G3 收敛复用同一决策源）。 */
  _decideMainAction(s) {
    if (!s) return { action: 'none', reason: 'no-snapshot' };
    const targetAlive = s.childAlive || s.adoptedAlive;
    // ── desired=stopped（正交于守护开关；显式用户意图永远生效）──
    if (s.desired === 'stopped') {
      const managedAlive = s.childAlive || (s.adoptedAlive && !s.observedOnly);
      if (managedAlive) return { action: 'stop', reason: 'desired_stopped' };
      if (s.adoptedAlive && s.observedOnly) return { action: 'none', reason: 'observe_steady' };
      if (s.probeOk) return { action: 'adoptObserved', reason: 'desired_stopped_observe' };
      return { action: 'none', reason: 'stopped_idle' };
    }
    // ── 升级 hold：安装期间不拉起（超时自愈是业务钩子）──
    if (s.upgradeHold) {
      if (targetAlive) return { action: 'stop', reason: 'upgrade_hold' };
      return { action: 'none', reason: 'upgrade_hold_wait' };
    }
    // ── 手动重启请求（守卫业务标志，本拍消费）──
    if (s.manualRestart) {
      if (s.phase === 'RUNNING' || s.phase === 'STARTING') return { action: 'restart', reason: 'manual', countCrash: false };
      if (s.phase === 'RESTARTING' || s.phase === 'BACKOFF') {
        // tick 语义：先清 backoff/restartAt 再立即拉起（!targetAlive）
        if (!targetAlive) return { action: 'start', reason: 'manual_retry' };
        // targetAlive → 落 switch（端口占用检查统一生效）
      }
      // phase===STOPPED → 落 switch
    }
    switch (s.phase) {
      case 'STOPPED': {
        // ⚠ 顺序与 `_shouldRun()` 一致（K5 修复）：两个否决位必须**先于**拉起判断，
        //   否则影子会算出 start 而真实 tick 拒绝 → 永久 diff。
        if (s.sessionHalting) return { action: 'none', reason: 'session_halting' };
        if (s.crashHalted) return { action: 'none', reason: 'crash_halted_await_explicit_start' };
        if (s.probeOk) return { action: 'adopt', reason: 'adopt' };
        if (s.spawnBlocked) return { action: 'none', reason: 'command_missing_cooloff' };
        return { action: 'start', reason: 'spawn' }; // 端口占用复查在执行期（isPortListening）
      }
      case 'STARTING': {
        if (s.probeOk && s.probeHttpOk) return { action: 'enterRunning', reason: 'healthy' };
        if (s.startDeadlinePassed) return this._decideCrashRestart('start_timeout');
        return { action: 'none', reason: 'starting_wait' };
      }
      case 'RUNNING': {
        // adopt 令牌重建/假死识别是守卫业务钩子（adapter 外，G3 由 _dshConverge 保留）——纯决策不含
        if (s.adoptedPidSet && !s.adoptedAlive) return this._decideCrashRestart('adopted_exit');
        if (s.childPresent && !s.childAlive) return this._decideCrashRestart('child_exit');
        return { action: 'none', reason: 'running_steady' };
      }
      case 'RESTARTING': {
        if (s.probeOk && s.probeHttpOk && !s.childAlive && !s.adoptedAlive) return { action: 'adopt', reason: 'restart_adopt' };
        if (!targetAlive && s.restartDue) return { action: 'start', reason: 'restart_spawn' };
        return { action: 'none', reason: 'restart_wait' };
      }
      case 'BACKOFF': {
        if (s.probeOk && s.probeHttpOk && !s.childAlive && !s.adoptedAlive) return { action: 'adopt', reason: 'backoff_adopt' };
        if (!targetAlive && s.backoffDue) return { action: 'start', reason: 'backoff_spawn' };
        return { action: 'none', reason: 'backoff_wait' };
      }
      case 'OBSERVED': return { action: 'none', reason: 'observed_steady' };
    }
    return { action: 'none', reason: 'unknown_phase:' + s.phase };
  }

  /** 崩溃类 restart 决策：与 _beginRestart(countCrash=true) 语义一致——动作统一 restart
   *  （_beginRestart 内部 _bumpCrashWindow 的退避记账/crash_loop_entered 属守卫业务，不改变动作词）。 */
  _decideCrashRestart(reason) {
    return { action: 'restart', reason, countCrash: true };
  }

  /** 实际执行动作记账（拍窗口内）。仅在 tick 收敛窗口内生效（_actWindow）；
   *  窗口外的外部动作（child exit / 升级钩子）不记账——其迁移由后续拍相位对分类覆盖。 */
  _actNote(action, reason) {
    if (!this._actWindow) return;
    if (!this._mainTickActs) this._mainTickActs = [];
    this._mainTickActs.push({ action, reason });
  }

  /** 本拍实际执行的迁移动作：优先拍内执行器记录（最精确含 reason），否则按相位对分类。 */
  _mainActualAction(t0) {
    const acts = this._mainTickActs || [];
    if (acts.length > 0) return acts[acts.length - 1];
    const from = t0.phase;
    const to = this._mPhase();
    if (from === to) return { action: 'none', reason: 'steady' };
    const p = from + '>' + to;
    if (p === 'STOPPED>STARTING') return { action: 'start', reason: 'spawn' };
    if (p === 'STOPPED>RUNNING') return this._mAdopted() === true ? { action: 'adopt', reason: 'adopt' } : { action: 'start', reason: 'spawn+enterRunning' };
    if (p === 'STOPPED>OBSERVED') return { action: 'adoptObserved', reason: 'observe' };
    if (p === 'STARTING>RUNNING') return { action: 'enterRunning', reason: 'healthy' };
    if (p === 'STARTING>RESTARTING') return { action: 'restart', reason: 'start_timeout' };
    if (p === 'STARTING>BACKOFF') return { action: 'restart', reason: 'start_crash' };
    if (p === 'RUNNING>RESTARTING') return { action: 'restart', reason: 'in_tick_restart' };
    if (p === 'RUNNING>BACKOFF') return { action: 'restart', reason: 'crash_loop' };
    if (p === 'RESTARTING>STARTING') return { action: 'start', reason: 'restart_spawn' };
    if (p === 'RESTARTING>RUNNING') return this._mAdopted() === true ? { action: 'adopt', reason: 'restart_adopt' } : { action: 'enterRunning', reason: 'restart_enter' };
    if (p === 'RESTARTING>BACKOFF') return { action: 'restart', reason: 'crash_loop' };
    if (p === 'BACKOFF>STARTING') return { action: 'start', reason: 'backoff_spawn' };
    if (p === 'BACKOFF>RUNNING') return this._mAdopted() === true ? { action: 'adopt', reason: 'backoff_adopt' } : { action: 'enterRunning', reason: 'backoff_enter' };
    if (p === 'OBSERVED>RUNNING') return { action: 'adopt', reason: 'observed_promote' };
    // desired=stopped / 升级 hold 的收敛停止迁移
    if (this._mDesired() === 'stopped' || this._upgradeHold) {
      return { action: 'stop', reason: this._upgradeHold ? 'upgrade_hold' : 'desired_stopped' };
    }
    return { action: 'none', reason: 'unclassified:' + p };
  }

  /** 影子 diff 排除集：异步事件/守卫业务钩子触发（非主循环收敛决策可比范畴），
   *  不计入 diff 与零 diff 门槛。升级钩子 / child exit / spawn error / 假死 / adopt 令牌重建。 */
  _shadowExcluded(reason) {
    if (!reason) return false;
    const r = String(reason);
    return /^(exit:|spawn_error|http_unhealthy|adopt_token_reclaim|upgrade|upgrade_hold|port_occupied)/.test(r);
  }

  /** 拍末影子记账（tick finally 调用：本拍实际迁移已收敛完成）。 */
  _shadowTickNote(t0) {
    try {
      if (this._stopping) return;
      const actual = this._mainActualAction(t0);
      const shadow = this._decideMainAction(t0);
      const exActual = this._shadowExcluded(actual && actual.reason);
      const diff = !!(actual && shadow) && (actual.action !== shadow.action) && !exActual;
      const rec = {
        seq: ++this._shadowSeq,
        t0phase: t0.phase,
        phase: this._mPhase(),
        shadow: shadow.action + (shadow.reason ? ':' + shadow.reason : ''),
        actual: actual.action + (actual.reason ? ':' + actual.reason : ''),
        diff: !!diff,
        excluded: !!exActual,
      };
      this._shadowLast = rec;
      if (diff && this.logger && this.logger.warn) {
        this.logger.warn('[shadow] dsh 影子 vs 实际不一致: shadow=' + rec.shadow + ' actual=' + rec.actual + '（phase ' + rec.t0phase + '→' + rec.phase + '）');
      }
    } catch (e) {
      this.logger && this.logger.warn && this.logger.warn('[shadow] 拍末记账异常: ' + ((e && e.message) || e));
    }
  }

  /** 心跳拍聚合（dsh adapter supervise 调用）：有新 tick 记录才记账/发事件；无则不刷。
   *  连续 5 拍零 diff 记 info（G3 切换门槛观测）。 */
  _shadowHeartbeatBeat() {
    try {
      const rec = this._shadowLast;
      if (!rec) return;
      if (this._shadowLoggedSeq === rec.seq) return; // 已记账
      this._shadowLoggedSeq = rec.seq;
      if (rec.excluded) {
        if (this.logger && this.logger.debug) this.logger.debug('[shadow] 拍#' + rec.seq + ' 业务钩子迁移(不计 diff): ' + rec.actual);
        return;
      }
      if (rec.diff) {
        this._shadowConsistentBeats = 0;
        this._shadowDiffBeats += 1;
      } else {
        this._shadowConsistentBeats += 1;
      }
      const ev = {
        seq: rec.seq,
        phase: rec.t0phase + '>' + rec.phase,
        shadow: rec.shadow,
        actual: rec.actual,
        diff: rec.diff,
        consistentBeats: this._shadowConsistentBeats,
        diffBeats: this._shadowDiffBeats,
      };
      if (this.events && this.events.append) { try { this.events.append('shadow_dsh_action', ev); } catch {} }
      if (!rec.diff && this._shadowConsistentBeats > 0 && this._shadowConsistentBeats % 5 === 0 && this.logger && this.logger.info) {
        this.logger.info('[shadow] dsh 影子与实际迁移连续 ' + this._shadowConsistentBeats + ' 拍零 diff——满足 G3 切换门槛');
      }
    } catch (e) {
      this.logger && this.logger.warn && this.logger.warn('[shadow] 心跳记账异常: ' + ((e && e.message) || e));
    }
  }

  // ---- 主循环收敛段（C3-3b G3 起由唯一心跳驱动；外部操作仍可即时触发）----
  // 单一状态机：STOPPED/STARTING/RUNNING/RESTARTING/BACKOFF。
  // 系统服务管理器托管已废弃——main 由守卫 spawn/观测统一管理。
  async _dshConverge() {
    if (this._ticking || this._stopping) return;
    // INV-S1（契约 §3.3）：会话退出中/已退出 → 抑制一切自动拉起，不再驱动 main 收敛。
    // 这是「退出管家」不再依赖翻 desired 防重拉的结构保证（停止由会话态而非意图态表达）。
    if (this._sessionHalting()) return;
    this._ticking = true;
    // C3-3b G1 影子拍：收敛窗口打开（拍内实际执行动作记账，供影子对比 actual）
    this._actWindow = true;
    this._mainTickActs = [];
    let t0 = null; // C3-3b G1 影子起点快照（try 内探测后赋值；finally 100% 可见）
    try {
      // 统一健康探测（domain/monitor）：L1 端口在线（up）+ L2 HTTP 健康（httpOk）。
      // up 维持状态机的「在线/离线」收敛语义（desired/升级 hold/接管均以端口为准，不破坏原语义）；
      // httpOk 是新增的健康维度：端口在但 HTTP 挂（事件循环卡死/假死）→ 连续 failThreshold 次判故障。
      const probeRes = await monitor.probe(this.config.targetHost, this.config.targetPort, {
        httpProbeEnabled: this.config.httpProbeEnabled !== false,
        healthUrl: this.config.healthUrl,
        httpTimeoutMs: this.config.probeTimeoutMs || 3000,
      });
      const portUp = probeRes.up;
      const healthOk = probeRes.httpOk;
      this._mSetLastProbeAt(new Date().toISOString());
      this._mSetLastProbeOk(portUp);
      // C3-3b G1 影子：HTTP 健康维度同源快照（startDeadline/健康收敛决策用）
      this._mSetLastProbeHttpOk(healthOk);
      // C3-3b G1 影子：拍起点快照（探测后、收敛前——与旧 tick 决策同输入同源）
      t0 = this._mainStateSnapshot();
      // C3-3b G5：dsh 健康面改由 _syncDshLifecycleView 从目录 main entry 合成（不再经观测镜像喂入）
      // 系统服务管理器托管已废弃（托管死分支整体移除）：main 由守卫 spawn/adopt 统一管理。
      const host = this.config.targetHost;
      const port = this.config.targetPort;
      // spawn 托管：目标在线 = 自有 child 或接管 pid 存活。
      const childAlive = this._mChild() !== null && this._mChild().exitCode === null && this._mChild().signalCode === null;
      const adoptedAlive = this._mAdoptPid() !== null && pidlook.isAlive(this._mAdoptPid());
      const targetAlive = childAlive || adoptedAlive;

      // 原生 DSH 端口运行时再推导兜底（2026-09）：期望运行/观测中，配置端口无监听但受管 DSH
      // 进程在跑（用户改了端口等）→ 从进程真实 --port 更正（30s 节流，防 churn）。
      if (!portUp && this._mDesired() !== 'stopped' && (childAlive || adoptedAlive || this._mObservedOnly())) {
        if (!this._lastMainPortRederive || Date.now() - this._lastMainPortRederive > 30000) {
          this._lastMainPortRederive = Date.now();
          const found = this._findManagedDshPort();
          if (found && found.port && found.port !== this.config.targetPort) {
            this._applyMainPort(found.port, found.pid);
            // 更正后本 tick 重探一次，让状态机立即看到新端口在线
            this.config.targetPort = found.port;
          }
        }
      }

      // 观测模式下记录观测到的 pid（展示用 + 停止路径的目标识别）。
      // 必须早于 desired=stopped 分支执行：否则停止时 adoptedPid 尚未填充，
      // stopProcess 会因「无单元可停、无 adoptedPid 可杀」而静默无效。
      // ── 期望状态调和优先于「进程守护」开关（desired 是正交轴）──
      // 显式 start/stop 是用户意图，必须永远生效：守护开关只约束「崩溃后自动拉起」，
      // 绝不约束用户主动点「启动 DSH / 停止 DSH」。此分支置于守护短路之前。
      if (this._mDesired() === 'stopped') {
        const managedAlive = childAlive || (adoptedAlive && !this._mObservedOnly());
        if (managedAlive) {
          this.stopProcess('desired_stopped');
        } else if (adoptedAlive && this._mObservedOnly()) {
          if (this._mPhase() !== 'OBSERVED') {
            this._mSetPhase('OBSERVED');
            this.writeState();
          }
        } else if (portUp) {
          this._adoptObserved();
        } else {
          if (this._mAdoptPid() !== null && !adoptedAlive) {
            this.events.append('dsh_exited', { code: null, signal: null, adopted: true, observed: true });
            this._mSetAdoptPid(null);
            this._mSetObservedOnly(false);
          }
          if (this._mPhase() !== 'STOPPED') this._mSetPhase('STOPPED');
        }
        this.writeState();
        return;
      }

      // 升级 hold：安装期间不拉起；兜底超时自愈防止 hold 卡死导致服务永久下线
      // （托管专属的进程守护开关 gate 已随死分支移除——spawn 托管守卫天然负责拉起）
      if (this._upgradeHold) {
        if (targetAlive) {
          this.stopProcess('upgrade_hold');
        } else {
          if (this._mPhase() !== 'STOPPED') this._mSetPhase('STOPPED');
          const maxHold = (this.config.upgradeTimeoutMs || 600000) + 120000;
          if (this._upgradeHoldSince && Date.now() - this._upgradeHoldSince > maxHold) {
            this.events.append('upgrade_hold_timeout', {});
            this.notify('升级流程异常', '升级 hold 超时已自动释放，请检查升级状态');
            this._upgradeHold = false;
            this._upgradeHoldSince = null;
          }
        }
        this.writeState();
        return;
      }

      // 手动重启请求
      if (this.manualRestart) {
        this.manualRestart = false;
        if (this._mPhase() === 'RUNNING' || this._mPhase() === 'STARTING') {
          this._beginRestart('manual', { countCrash: false }); // _beginRestart 内部会停运行中的目标（杀接管 pid），避免重复停
        } else if (this._mPhase() === 'RESTARTING' || this._mPhase() === 'BACKOFF') {
          this._mSetBackoffUntil(null);
          this._mSetRestartAt(Date.now());
          if (!targetAlive) await this._startProcess();
        }
        // phase === 'STOPPED' 时落到下方 switch，让端口占用检查统一生效
      }

      switch (this._mPhase()) {
        case 'STOPPED': {
          if (portUp) {
            // 接管既有实例（校验 DSH cmdline；spawn 托管）
            this._adopt();
            this._mSetSpawnBlockedUntil(null);
            this._mSetMissingNotified(false);
          } else if (this._mSpawnBlockedUntil() && Date.now() < this._mSpawnBlockedUntil()) {
            // 命令缺失冷静期：等待安装，不做无谓重试
          } else if (await monitor.isPortListening(host, port, 1000)) {
            // 端口被不健康进程占用：不硬抢，只告警
            this._warnOccupied();
          } else if (this._shouldRun()) {
            // 拉起条件（阶段 2 意图单源，契约 §6 判定规则）：
            //   是否应运行 = (desired == running) && sessionState 允许
            // desired 是**持久用户意图**（重启后据此恢复）——只要 desired=running 就无条件拉起，
            // 不再要求 guardian 或内存意图解锁（旧门 `guardian || intents.any()` 导致「退出后
            // 重开壳 desired=running 却不拉起」）。guardian 只约束「崩溃后是否自动重启」（见 RUNNING/exit 分支）。
            this.intents.consume('start'); this.intents.consume('restart'); this.intents.consume('upgrade-resume'); // 意图一次性消费（加速器，非门槛）
            await this._startProcess();
          } else {
            // desired=stopped（用户期望停止）：保持停止（adopt 已有进程已在上方处理）
            if (this._mPhase() !== 'STOPPED') this._mSetPhase('STOPPED');
          }
          break;
        }
        case 'STARTING': {
          if (portUp && healthOk) this._enterRunning();
          else if (Date.now() > this._mStartDeadline()) {
            // start_timeout 分层取证（真机 2026-09-23：SELinux 禁 /proc/net/tcp 反查，
            // 健康的 dsh 被误判超时杀循环）：不分层上屏就无法区分
            // 「没监听 / pid 不可见 / HTTP 不健康」三种死法。
            this.logger.warn('start_timeout probe detail: listening=' + probeRes.listening
              + ' pid=' + probeRes.pid + ' httpOk=' + probeRes.httpOk + ' httpStatus=' + probeRes.httpStatus);
            this._beginRestart('start_timeout', { countCrash: true });
          }
          break;
        }
        case 'RUNNING': {
          // adopt 令牌接管（2026-09 第四轮）：被接管主 DSH 令牌不可达 → 观察窗后受控重建一次
          try { this._maybeReclaimAdoptToken(); } catch {}
          // spawn：只按进程存活判断，进程死了才重启，不因端口探测失败而误判
          // 守护语义（2026-09 收敛定稿，与沙箱对齐）：崩溃是否自动接管拉起看守护开关 guardian——
          // 开=自动拉起（退避自愈）；关=回到停止态（DSH 是什么状态就什么状态，等用户手动启动，不做过度设计）。
          const guarded = this._mGuardian();
          if (this._mAdoptPid() !== null && adoptedAlive === false) {
            this.events.append('dsh_exited', { code: null, signal: null, phase: this._mPhase(), adopted: true });
            this._mSetAdoptPid(null);
            if (guarded) this._beginRestart('adopted_exit', { countCrash: true });
            else { this._crashHalted = true; this.events.append('guardian_off_exit', { reason: 'adopted_exit 未守护，保持停止' }); this._mSetPhase('STOPPED'); }
          } else if (!childAlive && this._mChild()) {
            if (guarded) this._beginRestart('child_exit', { countCrash: true }); // exit 事件兜底
            else { this._crashHalted = true; this.events.append('guardian_off_exit', { reason: 'child_exit 未守护，保持停止' }); this._mSetPhase('STOPPED'); }
          } else {
            this._applyHealthCheck(healthOk); // 假死识别：进程在但 HTTP 挂 → 连续失败判故障
          }
          break;
        }
        case 'RESTARTING': {
          if (portUp && healthOk && (!this._mChild() && !adoptedAlive)) {
            this._adopt();
          } else if (!targetAlive && Date.now() >= this._mRestartAt()) {
            // 重启前复查端口：避免对"占着端口的不健康外来进程"反复 spawn 计崩溃
            if (await monitor.isPortListening(host, port, 1000)) {
              this._warnOccupied();
            } else {
              await this._startProcess();
            }
          }
          break;
        }
        case 'BACKOFF': {
          if (portUp && healthOk && (!this._mChild() && !adoptedAlive)) {
            this._adopt();
          } else if (!targetAlive && Date.now() >= this._mBackoffUntil()) {
            if (await monitor.isPortListening(host, port, 1000)) {
              this._warnOccupied();
            } else {
              await this._startProcess();
            }
          }
          break;
        }
      }
      // 注：升级后健康验证已内联到 NativeManager.upgrade（waitPortHealthy），onTick 死亡路径已移除
      this.writeState();
    } catch (e) {
      this.logger.error('tick error: ' + ((e && e.stack) || e));
    } finally {
      this._ticking = false;
      this._actWindow = false; // C3-3b G1：收敛窗口关闭
      // 会话态：首拍收敛完成 → starting 迁移到 running（契约 §3.2）。
      if (this._sessionState === 'starting') this._setSessionState('running');
      // C3-3b G1 影子：拍末记账（actual vs shadow；100% 执行——不受 tick 内提前 return 影响）
      try { this._shadowTickNote(t0); } catch (e) { this.logger.warn && this.logger.warn('shadow note: ' + (e && e.message)); }
      // 统一生命周期视图同步（归一化架构）：finally 100% 执行——不受 tick 内提前 return 影响，
      // 守卫每次调和后把自身（DSH）观测状态镜像到 lifecycleManager。
      try { this._syncDshLifecycleView(); } catch (e) { this.logger.warn && this.logger.warn('sync: ' + (e && e.message)); }
    }
  }

  /** tick 保留为 _dshConverge 别名（C3-3b G3）：外部收敛触发点（start 首拍 / setDesired /
   *  requestRestart / _exitUpgradeHold）调用；shadow 模式下定时器也驱动此别名。
   *  on 模式下 main 每拍收敛由 heartbeat 的 dsh supervise 调用 _dshConverge（无独立 tick 定时器）。 */
  async tick() {
    return this._dshConverge();
  }

}

const _desc = Object.getOwnPropertyDescriptors(ConvergeView.prototype);
delete _desc.constructor; // 不覆盖 Supervisor.prototype.constructor

module.exports = _desc;
