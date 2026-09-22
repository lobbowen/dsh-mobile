'use strict';

// §7.6 拆分自 supervisor.js：main-process（原型 mixin）。
// 仅经 this 协作；导出「原型属性描述符」由 supervisor.js 注入 Supervisor.prototype。
// 行为与拆分前逐字一致（含 getter/setter；class 体方法无需逗号）。
// 依赖由拆分脚本按块内实际使用自动携带（遗漏会导致运行期 ReferenceError）。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const pidlook = require('../../platform/os/pidlookup');
const { LineBuffer } = require('../../platform/log');
const platform = require('../../platform/os/index');
const native = require('../../guard/native/index');
const ports = require('../../guard/lifecycle/ports').shared;
const { extractPortFromCommand } = require('../../platform/config');
const guardian = require('../../guard/guardian/index');
const runtimeContract = require('../../platform/runtime-contract');

class MainProcess {
  spawnCommand() {
    return native.nativeCommand(this.config, this.pluginManager);
  }

  /** 回收 dsh 状态目录里持锁进程已死的孤儿锁文件（详见 _startProcess 调用点注释）。
   *  安全边界：锁内容非纯数字 pid、或 pid 仍存活（含 EPERM）一律不动；单文件异常只跳过。 */
  _reapOrphanDshLocks() {
    const envHome = process.env.DSH_HOME && process.env.DSH_HOME.trim();
    const root = envHome ? envHome.trim() : path.join(process.env.HOME || os.homedir(), '.dsh');
    const reaped = [];
    const walk = (dir, depth) => {
      if (depth > 3) return;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        try {
          if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, depth + 1); continue; }
          if (!e.isFile() || !e.name.endsWith('.lock')) continue;
          const txt = fs.readFileSync(p, 'utf8').trim();
          // 空锁无可见主人（写入方 create 与写 pid 间隙即死）；数字锁仅在持锁 pid 已死时回收。
          if (txt && !/^\d+$/.test(txt)) continue;
          if (txt && pidlook.isAlive(Number(txt))) continue;
          fs.rmSync(p, { force: true });
          reaped.push({ file: p, pid: txt ? Number(txt) : null });
        } catch { /* 单个文件失败不影响其余回收 */ }
      }
    };
    walk(root, 0);
    for (const r of reaped) this.events.append('orphan_lock_reaped', r);
    if (reaped.length) this.logger.warn('reaped orphan dsh locks: ' + reaped.map((r) => r.file + '(pid=' + r.pid + ')').join(' '));
    return reaped;
  }

  // ---- 生命周期动作 ----
  async _startProcess() {
    this._actNote('start', 'spawn'); // C3-3b G1 影子 actual 记账
    this._crashHalted = false; // 主动拉起 = 清除崩溃停靠（进入运行流程）
    // 前置条件：原生 DSH 必须已安装才尝试启动。未安装 → 进入「未安装」状态：
    // 不启动、不重试、不计数崩溃；一次性通知引导安装（与"启动失败"严格区分）。
    const nst = this.nativeManager ? this.nativeManager.status() : { installed: true };
    if (!nst.installed) {
      this.events.append('dsh_not_installed', { bin: nst.binPath });
      if (!this._mMissingNotified()) {
        this._mSetMissingNotified(true);
        this.notify('未检测到 DeepSeek Harness', '可在 dsh-supervisor 面板一键安装');
      }
      this._mSetSpawnBlockedUntil(Date.now() + 60000); // 冷静期：装好前不再无谓重试
      this._mSetPhase('STOPPED');
      this._mSetFailStreak(0);
      this.writeState();
      return;
    }
    // 孤儿锁回收：此刻无存活 dsh（spawn 路径），SIGKILL 残留的 <$HOME>/.dsh/**.lock
    // 会让 dsh 启动在 30s 锁等待后崩溃（"plugin tree failed to load"），守卫再判启动失败
    // kill 重启 → 永不就绪的重启死循环。dsh 文档定义孤儿锁清理为 operator 动作——守卫即 operator。
    this._reapOrphanDshLocks();
    this.events.append('spawn', { command: this.spawnCommand() });
    const [cmd, ...args] = this.spawnCommand();
    let child;
    try {
      // detached：独立进程组，便于按组发信号（DSH 派生的子进程一并收到）。
      // 插件 --patch 覆盖层由 spawnCommand()/native.nativeCommand() 统一附加（顶层位置），此处不再重复拼接。
      // env 注入契约 PATH：DSH 自身（及其派生的 npm 操作）必须与守卫同源找到 node。
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: runtimeContract.withPath(process.env), detached: true });
    } catch (err) {
      this.events.append('spawn_failed', { message: err.message });
      this.logger.error('spawn failed: ' + err.message);
      this._beginRestart('spawn_error', { countCrash: true });
      return;
    }
    this.logger.info('spawn pid=' + child.pid + ' cmd=' + this.spawnCommand().join(' '));
    this._mSetChild(child);
    this._mSetAdopted(false);
    this._mSetAdoptPid(null);
    this._mSetPhase('STARTING');
    this._mSetStartDeadline(Date.now() + this.config.startTimeoutMs);
    // DSH 输出落盘专用日志（行缓冲还原完整行），同时镜像 stderr 供 journald 收敛
    // 先捕获令牌（原文），落盘前对启动 URL 的 ?token= 段脱敏——dsh.log/journald 不复留会话令牌明文
    const sanitizeToken = (l) => String(l).replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1***');
    const outBuf = new LineBuffer((line) => {
      this.tokenService.feedLine('main', line); // 唯一令牌节点：stdout 源逐行推送（最新行优先）

      const clean = sanitizeToken(line);
      this.dshWriter.write(clean);
      // 实时镜像同样走脱敏后的完整行——日志不再残留 token 明文
      // （原 raw chunk 镜像会把 ?token= 明文写进 journald）
      process.stdout.write('[dsh] ' + clean + '\n');
    });
    const errBuf = new LineBuffer((line) => {
      const clean = sanitizeToken('[stderr] ' + line);
      this.dshWriter.write(clean);
      process.stderr.write(clean + '\n');
    });
    child.stdout.on('data', (d) => { outBuf.push(d); });
    child.stderr.on('data', (d) => { errBuf.push(d); });
    child.on('error', (err) => {
      this.events.append('spawn_error', { message: err.message });
      if (this._mChild() === child && this._mPhase() === 'STARTING') {
        this._mSetChild(null);
        if (err.code === 'ENOENT') {
          // 命令不存在（如 DSH 未安装）：进入冷静期，等面板一键安装，不刷崩溃
          this.events.append('dsh_command_missing', { command: this.config.command[0] });
          this.logger.warn('command missing: ' + this.config.command.join(' ') + ' — 60s 冷静期内不再尝试');
          if (!this._mMissingNotified()) {
            this._mSetMissingNotified(true);
            this.notify('未检测到 DeepSeek Harness', '可在 dsh-supervisor 面板一键安装');
          }
          this._mSetSpawnBlockedUntil(Date.now() + 60000);
          this._mSetPhase('STOPPED');
          this.writeState();
          return;
        }
        this._beginRestart('spawn_error:' + (err.code || 'unknown'), { countCrash: true });
      }
    });
    child.on('exit', (code, signal) => {
      outBuf.flush();
      errBuf.flush();
      if (this._mChild() !== child) return; // 已被 stopProcess 接管
      this.events.append('dsh_exited', { code, signal, phase: this._mPhase() });
      this._mSetChild(null);
      if (this._stopping) return;
      if (this._mDesired() !== 'running') return;
      if (this._mPhase() === 'RUNNING' || this._mPhase() === 'STARTING') {
        const why = code !== null ? String(code) : 'sig' + signal;
        // 守护语义（2026-09 收敛，与 RUNNING 收敛分支同 gate）：RUNNING 崩溃看守护开关——
        // guardian=false 不自动拉起（转 STOPPED 等用户手动）；STARTING(用户启动流程)保留重试。
        if (this._mPhase() === 'STARTING' || this._mGuardian()) {
          this._beginRestart('exit:' + why, { countCrash: true });
        } else {
          this._crashHalted = true; // 未守护崩溃：停靠等待显式启动（阶段 2 意图单源）
          this.events.append('guardian_off_exit', { reason: 'child_exit:' + why + ' 未守护，保持停止' });
          this._mSetPhase('STOPPED');
        }
      }
    });
    this.events.append('spawned', { pid: child.pid });
    this.writeState();
  }

  _enterRunning() {
    this._actNote('enterRunning', 'healthy'); // C3-3b G1 影子 actual 记账
    const wasRunning = this._mPhase() === 'RUNNING';
    this._mSetPhase('RUNNING');
    this._mSetAdopted(false);
    // 只在真正「进入/恢复到运行中」时重置崩溃窗口/退避并记一次事件；稳态(RUNNING)不再每探测周期重置/刷屏
    if (!wasRunning) {
      this._mSetFailStreak(0);
      this._mSetBackoffLevel(0);
      this._mSetBackoffUntil(null);
      this._mSetCrashWindowStart(null);
      this._mSetCrashWindowRestarts(0);
      const pid = this._mChild() ? this._mChild().pid : null;
      this.events.append('running', { pid });
      this.logger.info('RUNNING pid=' + pid);
      // 进入运行：统一令牌服务按源（spawn=stdout）退避重试捕获最新令牌，
      // 有变化即经 onChange 下发 relay 热换 cookie（覆盖重启后令牌轮换/旧令牌未清空的边界）。
      this.tokenService.scheduleCapture('main');
    }
    this.writeState();
  }

  /** 原生 DSH 端口运行时再推导（2026-09 架构补齐）：
   *  DSH 端口由用户可改（config 默认 3080 只是默认）——进程真实端口以 cmdline --port 为准。
   *  在配置端口无监听但 DSH 进程在跑时，找出受管 DSH 进程的真实端口并更正注册（dsh-main /
   *  main 实例 / relay 目标 / healthUrl / 状态），让系统跟随用户改动而非卡死在旧配置。 */
  _findManagedDshPort() {
    // 候选：配置 bin 精确匹配（config.command[1]）优先；兼容手动标准 DSH（isDshCmdline）
    const bins = [];
    const cmd = this.config.command || [];
    if (typeof cmd[1] === 'string' && cmd[1]) bins.push(cmd[1]);
    const candidates = [];
    const matches = pidlook.pgrepList('dsh');
    for (const m of matches) {
      const pid = m.pid;
      if (pid === process.pid) continue;
      const c = m.cmdline;
      if (c.indexOf('/instances/') >= 0) continue; // 排除沙箱实例 dsh-web@inst-*
      // 精确归属：cmdline 必须含本守卫配置的启动 bin；isDshCmdline 兜底仅用于
      // "config bin 缺失（手动标准安装）"且 cmdline 带 ' web' 子命令特征的场景——
      // 绝不把同机其它 dsh 实例误认作受管目标（宽匹配曾把监管端口劫持到生产实例端口）。
      const binMatch = bins.some((b) => b && c.indexOf(b) >= 0);
      const genericDsh = !bins.length && pidlook.isDshCmdline(pid) && /(^|\s)web(\s|$)/.test(c);
      const owned = binMatch || genericDsh;
      if (!owned) continue;
      // 复用 config.extractPortFromCommand（同一解析实现，消除 config/supervisor 双份）
      const port = extractPortFromCommand(c.split(' '));
      if (port) candidates.push({ pid, port, cmdline: c.slice(0, 120) });
    }
    // 多个候选：选正在监听其端口者（真在跑的实例），否则取第一个
    for (const c of candidates) { try { if (pidlook.findListeningPid(c.port) === c.pid) return c; } catch {} }
    return candidates[0] || null;
  }

  /** 应用原生 DSH 真实端口：更正 dsh-main 注册 / main 实例 / relay 目标 / healthUrl（五处跟随）。 */
  _applyMainPort(newPort, pid) {
    const oldPort = this.config.targetPort;
    if (!Number.isInteger(newPort) || newPort <= 0 || newPort === oldPort) return false;
    // dsh-main 固定注册：register 新成功后再 release 旧（避免「旧已释放、新被拒」使注册表无 dsh-main
    // 而 config.targetPort 已改 → 注册表与配置分叉）。register 失败 → 不改配置、返回 false。
    try {
      ports.register('dsh-main', newPort);
    } catch (e) {
      this.logger.warn && this.logger.warn('register dsh-main ' + newPort + ' 失败，保留旧端口 ' + oldPort + ': ' + ((e && e.message) || e));
      return false;
    }
    // ⚠ 2026-09-13（失效模式 g）：**带 ownerId** —— 与实例域 P1-3 的修法同规。
    //   按端口号无条件释放可能删掉**他人**的记录（若 oldPort 期间被别的 owner 重新登记）。
    //   ⚠ owner 必须与 ports.register('dsh-main', p) 写入的**完全一致**：那是 'system:' + role
    //     （ports.js:156），不是 'dsh-main'。写错会让释放变 no-op → 旧端口残留
    //     （由 test/main-port-rederive-test.js 捕获）。
    try { if (oldPort !== newPort) ports.release(oldPort, 'system:dsh-main'); } catch {}
    this.config.targetPort = newPort;
    try { this.config.healthUrl = 'http://' + this.config.targetHost + ':' + newPort + '/'; } catch {}
    // 概念清分(2026-09-06)：main 不再登记于沙箱 instances——端口唯一事实源 = config.targetPort，
    // 无 per-instance 记录可跟随；dshMain 端口由 dshMainView() 动态读 config.targetPort。
    this.events.append('main_port_adopted', { from: oldPort, to: newPort, pid });
    this.logger.warn && this.logger.warn('[main] DSH 真实端口 ' + newPort + '（原配置 ' + oldPort + '），已更正注册与 relay 目标');
    return true;
  }

  /** 期望停止下发现无主健康实例：仅观测（拿 pid、如实展示），不强杀不拉起。 */
  _adoptObserved() {
    this._actNote('adoptObserved', 'observe'); // C3-3b G1 影子 actual 记账
    this._mSetPhase('OBSERVED');
    this._mSetAdopted(true);
    this._mSetObservedOnly(true);
    this._mSetChild(null);
    this._mSetFailStreak(0);
    this._mSetAdoptPid(pidlook.findListeningPid(this.config.targetPort));
    if (this._mAdoptPid() === null) {
      const found = this._findManagedDshPort();
      if (found && found.port && found.port !== this.config.targetPort && this._applyMainPort(found.port, found.pid)) {
        this.config.targetPort = found.port;
        this._mSetAdoptPid(found.pid);
      }
    }
    this.events.append('adopted_observed', { pid: this._mAdoptPid() });
    this.logger.info('observed unmanaged instance pid=' + this._mAdoptPid() + ' (desired=stopped)');
    this.writeState();
  }

  _adopt() {
    this._actNote('adopt', 'adopt'); // C3-3b G1 影子 actual 记账
    this._mSetPhase('RUNNING');
    this._mSetAdopted(true);
    this._mSetObservedOnly(false);
    this._mSetChild(null);
    this._mSetFailStreak(0);
    this._mSetBackoffLevel(0);
    this._mSetBackoffUntil(null);
    // 发现接管目标的 pid：使 stop/升级/存活观测对既有实例同样生效
    this._mSetAdoptPid(pidlook.findListeningPid(this.config.targetPort));
    // 原生 DSH 端口可被用户改动（config 默认只是默认）→ 配置端口无监听时，从受管 DSH 进程
    // 推导真实端口并更正注册（2026-09 架构补齐），再以其 pid 接管。
    if (this._mAdoptPid() === null) {
      const found = this._findManagedDshPort();
      if (found && found.port && found.port !== this.config.targetPort) {
        if (this._applyMainPort(found.port, found.pid)) {
          this.config.targetPort = found.port;
          this._mSetAdoptPid(found.pid);
        }
      }
    }
    // 校验：接管目标必须是我们管理的进程（启动命令匹配），否则不接管、只告警
    if (this._mAdoptPid() === null || !this._isManagedProcess(this._mAdoptPid())) {
      this._mSetAdoptPid(null);
      this._mSetPhase('STOPPED');
      this._warnOccupied();
      this.writeState();
      return;
    }
    this.events.append('adopted', { pid: this._mAdoptPid() });
    this.logger.info('adopted existing instance pid=' + this._mAdoptPid());
    // 接管既有实例：统一令牌服务从已登记源（journald / stdout 行缓冲）取最新令牌并下发
    this.tokenService.scheduleCapture('main');
    this.writeState();
  }

  /** 校验 pid 进程是否属于本守卫管理：cmdline 含配置的启动 bin，或符合 DSH 特征（兼容外部手动起的标准 DSH）。
   *  精确匹配避免"路径碰巧含 dsh 就误接管"与"安装路径不含 dsh 就漏接管"。 */
  _isManagedProcess(pid) {
    const cmd = pidlook.readCmdline(pid);
    if (!cmd) return false;
    const bin = this.config.command && this.config.command[1];
    if (typeof bin === 'string' && bin && cmd.includes(bin)) return true;
    return pidlook.isDshCmdline(pid);
  }

  _beginRestart(reason, opts) {
    const countCrash = !!(opts && opts.countCrash);
    this._mSetLastFailure(reason);
    this._mSetLastRestartAt(new Date().toISOString());
    this.events.append('restart_triggered', { reason });
    this.logger.warn('restart triggered: ' + reason);
    // 实例重启 = DSH 启动令牌轮换：清空已捕获令牌，使进入运行后统一令牌服务重新捕获新令牌
    // （旧令牌随旧进程失效，relay 若继续持有只会换取失败；先清空避免「新旧令牌混淆」）
    this.tokenService.clear('main');
    if (countCrash) {
      this._mSetRestartCount(this._mRestartCount() + 1);
      this._bumpCrashWindow();
    }
    this._mSetPhase('RESTARTING');
    this._mSetFailStreak(0);
    this._mSetRestartAt(Date.now() + this.config.portReleaseWaitMs);
    const child = this._mChild();
    if (child && child.exitCode === null) this._killSequence(child);
    // 重启前停掉仍运行中的目标，保证 RESTARTING → 重拉路径畅通：
    //  - spawn 托管下被接管的存活实例（如假死触发 http_unhealthy 时进程还活着）→ 杀其 pid；
    //  （adopted_exit 场景 adopted 已死，此处 isAlive 为 false 自然跳过，不误杀。）
    if (this._mAdoptPid() && pidlook.isAlive(this._mAdoptPid())) {
      try { this._killAdopted(this._mAdoptPid()); } catch (e) { this.logger.warn('adopt kill during restart: ' + e.message); }
    }
    this._actNote('restart', reason); // C3-3b G1 影子 actual 记账（bump 退避记账不改变 restart 动作）
    this.writeState();
  }

  _bumpCrashWindow() {
    const now = Date.now();
    // 崩溃窗口 + 退避决策统一交 domain/guardian（对原生与实例共用）
    const d = guardian.bumpCrashWindow(
      { start: this._mCrashWindowStart(), restarts: this._mCrashWindowRestarts() },
      now,
      { crashWindowMs: this.config.crashWindowMs, crashBurst: this.config.crashBurst, backoff: this.config.backoff, backoffLevel: this._mBackoffLevel() }
    );
    this._mSetCrashWindowStart(d.start);
    this._mSetCrashWindowRestarts(d.restarts);
    this._mSetBackoffLevel(d.backoffLevel);
    if (d.backoffEntered) {
      this._mSetBackoffUntil(d.backoffUntil);
      this._mSetPhase('BACKOFF');
      this.events.append('crash_loop_entered', {
        level: d.backoffLevel,
        waitMs: this.config.backoff[d.backoffLevel],
      });
      this.logger.error('crash loop entered: level=' + d.backoffLevel + ' waitMs=' + this.config.backoff[d.backoffLevel]);
      this.notify('DSH 反复崩溃', '已进入第 ' + d.backoffLevel + ' 级退避（' + Math.round(this.config.backoff[d.backoffLevel] / 1000) + 's），请查看 dsh-supervisor 面板');
    }
  }

  /** 向进程组发信号（detached spawn 的子进程是组长）；组信号失败退回单进程
   *  （安卓 = POSIX 组信号，树语义由平台层 `killTree` 提供）。 */
  _signalChild(child, sig) {
    platform.processControl.signalProcess(child.pid, sig);
  }

  /** **整树**终止（P1-G 修复）。
   *
   *  ⚠ 为什么必须单独有这个方法：
   *   平台层早已提供 `killTree`（安卓/POSIX = 进程组信号）**且已导出**，
   *   但历史代码里**零调用点** —— 实际停止路径只用 `signalProcess`（单进程语义），
   *   于是停止 DSH 只杀父进程：其派生的子进程（node / 子命令）成为**孤儿**，
   *   继续占端口、持文件锁；守卫重启后 adopt 复用即被楔死。
   *
   *   这与 `capabilityProfile().processTreeKill` 的**声明相反** ——
   *   该字段曾只由 `hasTool('taskkill')` 覆写，只证明「命令存在」，不证明「被使用」。
   *   正是本仓不变量「声明必须由实现产物支撑」被违反的一例（PC 遗留，安卓已恒 false）。
   */
  _killTree(child, sig) {
    const pc = platform.processControl;
    if (pc && typeof pc.killTree === 'function') {
      pc.killTree(child.pid, sig || 'SIGKILL', () => {});
      return;
    }
    // 兜底：平台层未提供时退回单进程信号（不因能力缺失而完全不杀）
    this._signalChild(child, sig || 'SIGKILL');
  }

  _killSequence(child) {
    this.events.append('sigterm_sent', { pid: child.pid });
    // 优雅期先发 SIGTERM（组信号，给目标自行收尾的机会），
    // 超时后的 SIGKILL 才升级为**整树**（孤儿才是真问题，见 _killTree 说明）。
    this._signalChild(child, 'SIGTERM');
    this._killTimer = setTimeout(() => {
      this._killTimer = null;
      if (child.exitCode === null && child.signalCode === null) {
        this._killTree(child, 'SIGKILL');
        this.events.append('sigkill_sent', { pid: child.pid, tree: true });
      }
    }, this.config.stopGraceMs);
  }

  /** 杀无句柄的接管实例（仅知 pid）。 */
  _killAdopted(pid) {
    this.events.append('sigterm_sent', { pid, adopted: true });
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
    this._adoptKillTimer = setTimeout(() => {
      this._adoptKillTimer = null;
      if (pidlook.isAlive(pid)) {
        // P1-G：接管实例同样可能有子进程 —— 升级为整树（进程组信号）。
        //   旧实现只 process.kill(pid)，会留下孤儿子进程占端口。
        const pc = platform.processControl;
        if (pc && typeof pc.killTree === 'function') {
          pc.killTree(pid, 'SIGKILL', () => {});
        } else {
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
        this.events.append('sigkill_sent', { pid, adopted: true, tree: true });
      }
    }, this.config.stopGraceMs);
  }

  stopProcess(reason) {
    this._actNote('stop', reason); // C3-3b G1 影子 actual 记账
    this.events.append('stop', { reason });
    this.logger.info('stop: ' + reason);
    const child = this._mChild();
    const adoptedPid = this._mAdoptPid();
    this._mSetPhase('STOPPED');
    this._mSetChild(null);
    this._mSetAdopted(false);
    this._mSetAdoptPid(null);
    this._mSetFailStreak(0);
    if (child && child.exitCode === null) this._killSequence(child);
    else if (adoptedPid) this._killAdopted(adoptedPid);
    this.writeState();
  }
}

const _desc = Object.getOwnPropertyDescriptors(MainProcess.prototype);
delete _desc.constructor; // 不覆盖 Supervisor.prototype.constructor

module.exports = _desc;
