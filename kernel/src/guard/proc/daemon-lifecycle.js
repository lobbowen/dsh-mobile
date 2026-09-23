'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 受管进程生命周期核心（2026-09-04 架构定稿）
//
// 统一不变量（router-daemon 与未来一切受管常驻进程共用）：
// 1) 一个逻辑服务 = 一个受管进程（单实例）；
// 2) 服务与绑定端口持久（注册表 truth；本层不碰端口分配，只保证换代期间「端口先释放后复用」）；
// 3) 换代（replace）必须：TERM 旧代 → 验证旧进程已死 → 验证端口已释放 → 才 spawn 新代；
// 旧没死透/端口没放 → 绝不起新（此前双代并存→端口漂移的根因在此被硬性杜绝）；
// 4) spawn 一次性：spawn 后 latch 窗口内任何入口（启动/监督/手动）不得再 spawn；
// 5) 守卫重启 ≠ 服务重启：身份文件（{guardPid, daemonPid, startedAt}）让新守卫「接管」既有进程，
// owner 连续，绝不另起一个；身份丢失/异主不接管（由上层门禁把关）。
//
// 与端口注册表的分工：注册表记录 owner→固定端口（由被管进程维护）；本层只对进程负责，
// 两者拼成完整链条 =「端口持久化成立的前提：进程换代先无后有」。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const pidlook = require('../../platform/os/pidlookup');

/** 轮询等待：某 pid 进程真正消失（/proc 确认）。 */
async function waitProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let alive = false;
    try { alive = pidlook.isAlive ? pidlook.isAlive(pid) : true; } catch { alive = false; }
    if (!alive) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** 轮询等待：端口可绑（无监听者）——用 bind 探测（与真实监听语义一致，见 infra/ports）。 */
async function portFree(port) {
  return new Promise((resolve) => {
    const net = require('node:net');
    let done = false;
    const s = net.createServer();
    const finish = (ok) => { if (done) return; done = true; try { s.close(); } catch {} resolve(ok); };
    s.once('error', () => finish(false));
    s.listen(port, '127.0.0.1', () => finish(true));
  });
}

async function waitPortFree(port, timeoutMs) {
  if (!port) return true;
  const deadline = Date.now() + (timeoutMs || 5000);
  while (Date.now() < deadline) {
    if (await portFree(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

class DaemonLifecycle {
  /**
   * @param {object} o
   * - name: 标识（'router' | 'lan'）
   * - script / args: spawn 命令
   * - ctlPort: 就绪/换代仲裁端口
   * - cmdMark: cmdline 识别子串（防误接管异主）
   * - identityFile: JSON {guardPid, daemonPid, startedAt}
   * - spawnEnv(extra) / logger / events
   * - readyTimeoutMs / stopGraceMs / portReleaseTimeoutMs / spawnWindowMs
   */
  constructor(o) {
    this.name = o.name;
    this.script = o.script;
    this.args = o.args || [];
    this.ctlPort = o.ctlPort;
    this.cmdMark = o.cmdMark;
    // P0-2 修复（2026-09-12）：`cmdMark` 与实际命令行**永不匹配**。
    //
    // 缺陷：daemon 由 `spawn(process.execPath, [this.script, ...this.args])` 拉起，
    // 故真实 cmdline 形如 `node <pkg>/src/domains/router/daemon.js -c <cfg>`；
    // 而调用方传的 `cmdMark` 是 `'router-daemon'` —— 该子串**不在** cmdline 里
    // （实测 indexOf = -1）。于是 `_ctlOwnerPid()` 恒 null：
    // · 换代分支（旧代占 ctl 时 TERM + 等端口释放）**永不执行**；
    // · `classify()` 的 external / reclaiming 状态**永不可达**
    // →「ctl 被外部进程占用，不接管不拉起」这条红线形同不存在。
    //
    // 对照：同仓另两处反查监听者（supervise-view.js、control-view.js）**都**额外
    // 匹配 `/domains/router/daemon.js` 路径形态 —— 只有本核心这一条路径失明，
    // 属「同一纪律在多条路径中只在一处执行」的反面（此处是唯一漏的那处）。
    //
    // 修法：**从 `script` 派生权威标记**（它就是 spawn 时真正写进 cmdline 的那个路径），
    // 与调用方给的语义标记**并列**匹配。这样不依赖调用方记住传路径，
    // 且脚本位置演进（src/ 移动）时自动跟随。
    const path = require('node:path');
    const norm = (s) => String(s || '').replace(/\\/g, '/');
    this._cmdMarks = [];
    if (o.cmdMark) this._cmdMarks.push(String(o.cmdMark));
    if (this.script) {
      // ① 绝对路径原样（spawn 用的就是它）
      this._cmdMarks.push(norm(this.script));
      // ② 相对包根的尾段（处理 cwd/相对调用差异）
      const m = /[/\\](src[/\\][^\s]+|domains[/\\][^\s]+)$/.exec(norm(this.script));
      if (m) this._cmdMarks.push(m[1]);
    }
    this.identityFile = o.identityFile;
    this.spawnEnv = o.spawnEnv || (() => ({}));
    this.logger = o.logger || console;
    this.events = o.events || null;
    this.readyTimeoutMs = o.readyTimeoutMs || 10000;
    this.stopGraceMs = o.stopGraceMs || 4000;
    this.portReleaseTimeoutMs = o.portReleaseTimeoutMs || 5000;
    this.spawnWindowMs = o.spawnWindowMs || 25000;
    this._spawnWindowUntil = 0; // spawn latch
    this._stopping = false;
  }

  /* ── 身份文件（owner 连续的关键）── */
  _readIdentity() {
    try { return JSON.parse(fs.readFileSync(this.identityFile, 'utf8')); } catch { return null; }
  }
  _writeIdentity(daemonPid) {
    try {
      const dir = path.dirname(this.identityFile);
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      const tmp = this.identityFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ guardPid: process.pid, daemonPid, startedAt: Date.now() }), { mode: 0o600 });
      fs.renameSync(tmp, this.identityFile);
    } catch {}
  }
  _clearIdentity() { try { fs.unlinkSync(this.identityFile); } catch {} }

  _pidAlive(pid) {
    if (!pid) return false;
    try { return pidlook.isAlive ? !!pidlook.isAlive(pid) : true; } catch { return true; }
  }

  /** ctl 端口的监听者是否就是本服务进程（cmdline 匹配）。 */
  _ctlOwnerPid() {
    try {
      const pid = pidlook.findListeningPid(this.ctlPort);
      if (!pid) return null;
      // 2026-09-13 修复（P1）：**两侧都要归一化**。
      // _cmdMarks 已被构造器 norm() 成 "/"，而 readCmdline 返回**原生**分隔符 ——
      // 路径分隔符不一致时直接 indexOf 永远 -1 → 认不出自己的 daemon。
      const cmd = pidlook.normCmdline(pidlook.readCmdline(pid) || '');
      // P0-2：按**全部**标记匹配（含从 script 派生的路径形态）——见构造器说明。
      return this._cmdMarks.some((mk) => mk && cmd.indexOf(mk) >= 0) ? pid : null;
    } catch { return null; }
  }

  /** 当前「期望进程」= 身份文件里的 daemonPid（若还活着）。 */
  expectedPid() { const id = this._readIdentity(); return id && id.daemonPid ? id.daemonPid : null; }

  /** 回收非当前受管代际的旧代进程（2026-09 架构补齐：YAMA 下 /proc fd 对非祖先不可读，
   * socket→pid 无法映射；改用 pgrep -af 读 cmdline（同 frpmgr 范式，跨平台/YAMA 免疫）——
   * 凡 cmdline 命中本 daemon（script+configPath 特征）且 pid ≠ 当前身份 pid/≠自己/≠ctl 属主，
   * 一律视为旧代残留，TERM 回收。任何上下文（含不可见命名空间）拉起的同 cmdline 旧代都会被清掉，
   * 「固定端口被看不见的旧代占用」从此不可能存活。@returns 回收数 */
  reclaimOrphans() {
    // cfg = args 中 -c/--config 的值（生产 daemon 为 configPath，用于精确匹配防误杀其它实例/用户）；
    // 无 -c（如测试夹具/简化调用）→ cfg 为空 → 仅按 cmdMark 匹配（仍排除自己/受管代/ctl 属主）
    const args = this.args || [];
    let cfg = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' || args[i] === '--config') { cfg = String(args[i + 1] || ''); break; }
    }
    // P0-2：pgrepList 每次只接受一个 pattern，故对**每个**标记各查一遍并按 pid 去重。
    // 此前只用语义标记（'router-daemon'）→ 匹配 0 个 → 孤儿回收恒空跑。
    const marks = this._cmdMarks.length ? this._cmdMarks : [this.cmdMark];
    const seen = new Set();
    const candidates = [];
    for (const mk of marks) {
      if (!mk) continue;
      let list = [];
      try { list = pidlook.pgrepList(mk) || []; } catch { list = []; }
      for (const m of list) { if (m && !seen.has(m.pid)) { seen.add(m.pid); candidates.push(m); } }
    }
    let killed = 0;
    try {
      const mine = this.expectedPid();
      const ctlOwner = this._ctlOwnerPid();
      for (const m of candidates) {
        const pid = m.pid;
        const cmd = m.cmdline;
        if (pid === process.pid) continue;
        if (pid === mine) continue;             // 当前受管代际
        if (pid === ctlOwner) continue;         // ctl 属主（就是当前在管进程）
        if (cfg && cmd.indexOf(cfg) < 0) continue; // 必须同配置（防误杀其它用户/实例的同名 daemon）
        try { process.kill(pid, 'SIGTERM'); killed++; this.logger.warn && this.logger.warn('[' + this.name + '] 回收旧代孤儿 pid=' + pid + ' ' + cmd.slice(0, 90)); } catch {}
      }
    } catch (e) { /* pgrep 无匹配/不可用：忽略 */ }
    return killed;
  }

  /** 换代/启动仲裁总入口：
   * - 期望 pid 活且 ctl 就绪 → {mode:'adopted', pid}
   * - 无进程 → spawn（latch）→ {mode:'started', pid}
   * - 期望 pid 死或失联 → replace（停残留→等死→等端口→spawn）→ {mode:'replaced', pid}
   * - spawn latch 窗口内 → {mode:'barrier'} */
  ensureRunning() {
    if (this._stopping) return { mode: 'stopping' };
    try { this.reclaimOrphans(); } catch {}
    const exp = this.expectedPid();
    if (exp && this._pidAlive(exp)) {
      // 期望进程在：等就绪（首次可能 ctl 未起）；直接认为在管（监督层再按 ctl 判 ready）
      return { mode: 'adopted', pid: exp };
    }
    if (Date.now() < this._spawnWindowUntil) return { mode: 'barrier' };
    // 换代前：ctl 若仍被「本 cmdMark 的残留」占着 → TERM，等死 + 等端口释放；绝不起新
    const stale = this._ctlOwnerPid();
    if (stale) {
      this._stopPid(stale);
      this._spawnWindowUntil = Date.now() + 3000; // 短暂 latch：等旧代退出，下一轮仲裁走 spawn
      this.logger.warn && this.logger.warn('[' + this.name + '] 换代：旧代 pid=' + stale + ' 仍在 ' + this.ctlPort + '，已 TERM，稍后启新');
      return { mode: 'reclaiming', stale };
    }
    return this._spawn();
  }

  _stopPid(pid) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch {} }, this.stopGraceMs).unref();
  }

  _spawn() {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [this.script, ...this.args], {
      stdio: 'ignore', detached: true, env: { ...process.env, ...(this.spawnEnv() || {}) },
    });
    // P1-3 修复（2026-09-12）：**必须接住异步 'error'，且不得在未确认时写入身份**。
    //
    // 缺陷：原实现 spawn 后直接 `_writeIdentity(child.pid)` 并返回 `{mode:'started'}`。
    // 而 spawn 对 ENOENT/EPERM **不抛同步错**，只发异步 'error'（同 shell/index.js 的 P0-1，
    // 实测 pid=undefined + uncaught ENOENT）。于是：
    // · 无 'error' 监听 → 异常逃逸为守卫 uncaughtException（60s 内 3 次即自杀）；
    // · 身份文件被写成 `daemonPid: undefined` → `expectedPid()` 恒 null、
    // `_pidAlive(undefined)` 恒 false → **每轮监督都 spawn**（仅 25s latch 压制），
    // 表现为「每 25~30s 拉起一次、面板永远不 ready」。
    //
    // 修法：① 接住 'error'（记事件，不再逃逸）；
    // ② 用同步可判的 `child.pid` 决定是否写身份 —— 未定义即失败，**不写**，
    // 并如实返回 `{mode:'failed'}` 让调用方（superviseOnce/control-view）可见。
    child.on('error', (e) => {
      if (this.logger && this.logger.warn) this.logger.warn('[' + this.name + '] daemon spawn error: ' + ((e && e.message) || e));
      try { if (this.events && this.events.append) this.events.append('daemon_spawn_error', { name: this.name, error: (e && e.message) || String(e), script: this.script }); } catch {}
    });
    child.unref();
    this._spawnWindowUntil = Date.now() + this.spawnWindowMs;
    if (!child.pid) {
      // 未启动：**不写身份**（写了会让后续监督永久误判「期望进程存在」）。
      this.logger.warn && this.logger.warn('[' + this.name + '] daemon 未启动（' + this.script + ' 不存在或不可执行）');
      return { mode: 'failed', error: 'daemon 未启动（脚本不可执行或 Node 不可用）', script: this.script };
    }
    this._writeIdentity(child.pid);
    if (this.logger && this.logger.info) this.logger.info('[' + this.name + '] 已拉起独立 daemon pid=' + child.pid + '（spawn 窗口至 ' + new Date(this._spawnWindowUntil).toISOString() + '）');
    return { mode: 'started', pid: child.pid };
  }

  /** 无副作用分类（供监督/审计共用）：当前受管代际与 ctl 属主的真实状态。**绝不 spawn/stop**。
   * @returns {{mode:'running'|'external'|'reclaiming'|'barrier'|'absent'|'stopping', pid?, owner?, stale?}}
   * - running : 期望代际存活（ctl 属主=期望 pid，或 ctl 尚未起）
   * - external : ctl 被「异 cmdMark/异代际」进程占用（外部抢占，绝不接管）
   * - reclaiming : 期望代际已死但同 cmdMark 残留仍占 ctl（需换代）
   * - barrier : spawn latch 窗口内（等旧代退出）
   * - absent : 无进程、无残留（可 spawn）
   * - stopping : 已进入停止流程
   * 这是生产监督路径（_orphanAudit / _daemonSuperviseOnce）识别「异主 daemon」的唯一判据——
   * ensureRunning 只按 cmdline 判 active，无法区分「本守卫的 daemon」与「外部同名 daemon」。 */
  classify() {
    if (this._stopping) return { mode: 'stopping' };
    const exp = this.expectedPid();
    if (exp && this._pidAlive(exp)) {
      const owner = this._ctlOwnerPid();
      if (owner && owner !== exp) return { mode: 'external', owner, pid: exp };
      return { mode: 'running', pid: exp };
    }
    if (Date.now() < this._spawnWindowUntil) return { mode: 'barrier' };
    const stale = this._ctlOwnerPid();
    if (stale) return { mode: 'reclaiming', stale };
    return { mode: 'absent' };
  }

  /** 周期监督：期望进程失联 → 先验证死透再 replace（死透由 ensureRunning 的 stale/死pid 分支处理）。
   * 基于 classify() 分类后施加副作用（reclaim/spawn）；分类能力本身无副作用、供审计复用。 */
  async superviseOnce() {
    if (!this.expectedPid()) { try { this.reclaimOrphans(); } catch {} }
    const c = this.classify();
    if (c.mode === 'running' || c.mode === 'external' || c.mode === 'barrier' || c.mode === 'stopping') return c;
    if (c.mode === 'reclaiming') {
      // 期望 pid 已死但 ctl 仍被同 cmdMark 残留占着：停残留并等释放（换代）
      this._stopPid(c.stale);
      this._spawnWindowUntil = Date.now() + 3000;
      return c;
    }
    // absent：无进程无残留 → spawn
    return this._spawn();
  }

  /** 停服：TERM → 等死 → 等 ctl 端口释放 → 清身份（绑定注册表由被管进程侧语义保留）。 */
  async stop() {
    this._stopping = true;
    const exp = this.expectedPid();
    let stopped = null;
    if (exp && this._pidAlive(exp)) { this._stopPid(exp); stopped = exp; }
    else {
      const owner = this._ctlOwnerPid();
      if (owner) { this._stopPid(owner); stopped = owner; }
    }
    // P2-2 修复（2026-09-12）：**停止失败必须如实回报**，且不得清身份。
    //
    // 缺陷：原实现超时只 `warn`，随后**无条件** `_clearIdentity()` 并 `return {ok:true}` ——
    // 对 SIGTERM 无响应（D 状态/被停住/忽略信号）的 daemon，守卫宣告「已停」并抹掉身份，
    // 此后**没有任何人再知道这个 pid**：孤儿继续占 ctl 端口与 relay 端口，
    // 而「按身份找 pid」的路径已因身份丢失而失效（只剩 cmdMark 扫描兜底）。
    // 「门禁恒真」的又一例：超时是**唯一**的失败信号，却被丢弃。
    //
    // 修法：超时 → `ok:false` 且**保留身份**（让下一轮 hasPendingStop/监督仍能找到它重试），
    // 并记事件供面板可见；端口未释放同理降级为部分成功。
    let dead = true;
    if (stopped) {
      dead = await waitProcessExit(stopped, this.stopGraceMs + 1500);
      if (!dead) this.logger.warn && this.logger.warn('[' + this.name + '] 停止超时 pid=' + stopped);
    }
    const portFree = await waitPortFree(this.ctlPort, this.portReleaseTimeoutMs);
    if (!portFree) this.logger.warn && this.logger.warn('[' + this.name + '] 停止后端口 ' + this.ctlPort + ' 未释放');
    // 复位停止闸门：实例在被 stop 后可再次 ensureRunning（原实现置 true 后永不复位 → 实例被复用则
    // 永远返回 {mode:'stopping'}，不可恢复的死状态）。2026-09 审计修正。
    this._stopping = false;
    this._spawnWindowUntil = 0; // 清 latch，允许下轮直接裁决（不留陈旧 spawn 窗口）
    if (!dead) {
      // 进程未死：**不清身份**（否则孤儿再无人可寻），如实上报。
      try { if (this.events && this.events.append) this.events.append('daemon_stop_timeout', { name: this.name, pid: stopped, port: this.ctlPort }); } catch {}
      return { ok: false, stopped, error: 'daemon 未在超时内退出（pid=' + stopped + ' 可能已忽略 SIGTERM）', portFree };
    }
    this._clearIdentity();
    return { ok: true, stopped, portFree };
  }

  status() {
    const id = this._readIdentity();
    const exp = (id && id.daemonPid) || null;
    return {
      name: this.name,
      pid: exp,
      alive: exp ? this._pidAlive(exp) : false,
      ctlUp: !!this._ctlOwnerPid(),
      since: (id && id.startedAt) || null,
      guardPid: (id && id.guardPid) || null,
      spawnWindow: this._spawnWindowUntil > Date.now(),
    };
  }
}

module.exports = { DaemonLifecycle };
