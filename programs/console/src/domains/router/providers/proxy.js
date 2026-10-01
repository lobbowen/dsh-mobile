'use strict';

// 反代供应商：重——账号=代理实例（进程），每账号一个实例（硬规则）。
// 生命周期：注册时启动实例 → 检测配额 → ready/frozen/discarded（受限即冻结带恢复点，到点由
// 调度器自动探测释放回池；与运行中同一 applyDetection 状态机）；进程态不落盘。

const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { ProviderBase, keyFingerprint, maskKey, quotaOverallStatus } = require('./base');
const { getQuotaStrategy } = require('./quota-strategies');
const { ProxyInstance } = require('../instances/proxy-instance');
const ports = require('../../../guard/lifecycle/ports').shared;
const pidlook = require('../../../platform/os/pidlookup');
// npx 的统一解析入口（经 platform/os/exec-path，避免硬编码 'npx'）。
const { npxBin } = require('../../../platform/os/exec-path');

// Command billing/订阅解析与策略注册见 ./quota-strategies.js（模式类不携带供应商解析词）。

/** 实例回收闲置宽限期（ms）：非期望集实例若在宽限期内被使用过（lastUsedAt 新鲜），
 * 本轮 reconcile 不回收——吸收交替/突发请求（刚用完的账号不被立刻杀，避免启停追逐），
 * 宽限期后仍未再用 → 下轮回收（资源收敛仍成立：常驻 1 + 至多 1 备胎的稳态不受影响）。 */
const IDLE_RECLAIM_GRACE_MS = 90 * 1000;

class ProxyProvider extends ProviderBase {
  constructor(opts) {
    super(opts);
    this.kind = 'proxy';
    this.proxyAppId = opts.proxyAppId;
    this.app = opts.app || null;
    // 数据目录（config.stateFile 派生）：日志落这里；未提供才回退默认（D7：不得各自 os.homedir()）。
    this.stateDir = opts.stateDir || null;
    this.proxyRunning = false;
    this.instances = [];
    this.selectedAccountKeyId = null;
    this._startLock = false; // 实例启动互斥：一次只 spawn 一个 npx（防 npm 缓存锁/资源风暴）
    this._stopping = false; // 关停标记：stop() 前置真，期间不预启动；spawn 完成即自清理（防孤儿进程）
    this._terminatingPids = new Set(); // 停服台账：stopInstance 已发 SIGTERM 的子进程 pid（waitAllStopped 轮询确认退出，防停服孤儿化）
  }

  accountOf(inst) { return this.accounts.find((a) => a.key === inst.key) || null; }

  /** 账号 → 实例映射（一账号一实例）：usageOf 派生 warming 的依据（实例在跑且非在用）。 */
  instanceOf(acc) {
    if (!acc) return null;
    return (this.instances || []).find((i) => i.keyId === acc.keyId) || acc.instance || null;
  }

  async ensureInstance(key) {
    let inst = this.instances.find((i) => i.key === key);
    if (inst) return inst;
    inst = new ProxyInstance({ key, keyId: keyFingerprint(key), maskedKey: maskKey(key), app: this.app, logger: this.logger, events: this.events });
    this.instances.push(inst);
    return inst;
  }

  /** 启动实例（底层治理）：
   * - 并发去重：inst.startingPromise —— 并发调用（请求按需激活 + 调度器保障）只 spawn 一次；
   * - 全局串行：this._startLock —— 同一供应商一次只启动一个 npx（防 npm 缓存锁/资源风暴）；
   * - spawn 后立即设 pid，close/error 清理。 */
  async startInstance(inst) {
    if (inst.pid) return { ok: true, already: true };
    if (inst.startingPromise) return inst.startingPromise; // 启动中：复用同一 Promise
    inst.startingPromise = (async () => {
      try {
        // 等待前一个启动完成（防死锁：30s 超时放弃——避免某次启动卡住锁导致
        // 所有后续账号实例永远无法启动，正是「添加账号后实例不能用」的根因）
        const lockWaitStart = Date.now();
        while (this._startLock && Date.now() - lockWaitStart < 30000) { await new Promise((r) => setTimeout(r, 250)); }
        if (this._startLock) return { ok: false, error: '实例启动互斥锁超时（前一次启动未完成）' };
        this._startLock = true;
        try {
          return await this._doStart(inst);
        } finally {
          this._startLock = false;
        }
      } finally {
        inst.startingPromise = null;
      }
    })();
    return inst.startingPromise;
  }

  /** 解析启动命令（缓存优先 + fallback npx）：
   * - 定位 ~/.npm/_npx/<hash>/node_modules/<pkg> 已缓存包 → 直接 node <bin>（零解析/零下载/秒起）；
   * - 缓存未命中 → npx --yes（首次下载安装）。
   * 返回 { ok, cmd, registry }。 */
  async _resolveLaunchCommand(app, port, key) {
    const regOrigin = this.dist ? await this.dist.selectRegistry(false).catch(() => null) : null;
    const binEntry = this._cachedPkgBin(app.pkg);
    if (binEntry) {
      // 标准参数统一注入（host/port）——api-key 绝不写入 cmdline（/proc/<pid>/cmdline 同用户可读），
      // 只经 env 传递（env 名由 app.keyEnv 声明，默认 CC_API_KEY；_doStart 注入）
      const args = ['--host', '127.0.0.1', '--port', String(port)];
      // 自定义额外 flag（非标准参数，如上游 URL/超时等自定义项）——排除标准参数/模板/app 包名
      const STANDARD = new Set(['--host', '--port', '--api-key', 'npx', '--yes']);
      const extra = [];
      const cmdList = app.command || [];
      for (let i = 0; i < cmdList.length; i++) {
        const t = String(cmdList[i]);
        if (STANDARD.has(t) || t.includes('{{') || (app && app.pkg && t === app.pkg)) continue;
        if (t === '127.0.0.1' || t === String(port) || t === key) continue;
        if (String(t).startsWith('--registry') || t === '--registry') continue;
        // 参数值也跳过（紧跟标准 flag 的）
        if (i > 0 && STANDARD.has(String(cmdList[i - 1]))) continue;
        extra.push(t);
      }
      return { ok: true, cmd: [process.execPath, binEntry, ...extra, ...args], registry: regOrigin };
    }
    // fallback：npx --yes（首次安装/缓存丢失）
    // api-key 不上 cmdline：剔除 --api-key 与 {{key}} 占位（key 经 env 传递，env 名由 app.keyEnv 声明）
    const mapped = app.command.map((t) => String(t).replace('{{port}}', String(port)).replace('{{key}}', ''));
    const filtered = [];
    for (let i = 0; i < mapped.length; i++) {
      const t = mapped[i];
      if (t === '--api-key' || t === '') { if (t === '--api-key') i = Math.min(i + 1, mapped.length - 1); continue; }
      filtered.push(t);
    }
    const cmd = filtered;
    const args = [...cmd.slice(1)];
    if (cmd[0] === 'npx' && regOrigin) {
      const ri = args.findIndex((a) => a === '--registry');
      if (ri >= 0) { args[ri + 1] = regOrigin; } else { args.unshift(regOrigin); args.unshift('--registry'); }
    }
    // P1-4 修复（2026-09-12）：`cmd[0]` 来自 app.command（'npx'）——
    // 必须经统一解析入口，否则绕过解析（npm 的同一问题已有 npmBin）。
    // 仅当它确实是逻辑名 'npx' 时才替换（保持模板可注入绝对路径的能力）。
    const bin = (cmd[0] === 'npx') ? npxBin() : cmd[0];
    return { ok: true, cmd: [bin, ...args], registry: regOrigin };
  }

  /** 定位已缓存的包 bin（~/.npm/_npx/<hash>/node_modules/<pkg>，取最新）。无则 null。 */
  _cachedPkgBin(pkg) {
    if (!pkg) return null;
    try {
      const npxDir = path.join(os.homedir(), '.npm', '_npx');
      if (!fs.existsSync(npxDir)) return null;
      const dirs = fs.readdirSync(npxDir).filter((d) => /^[0-9a-f]{8,}$/i.test(d));
      // 最新优先（mtime 排序）
      dirs.sort((a, b) => { try { return fs.statSync(path.join(npxDir, b)).mtimeMs - fs.statSync(path.join(npxDir, a)).mtimeMs; } catch { return 0; } });
      for (const d of dirs) {
        const pkgDir = path.join(npxDir, d, 'node_modules', pkg);
        if (!fs.existsSync(pkgDir)) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
          const bin = j.bin;
          let rel = null;
          if (typeof bin === 'string') rel = bin;
          else if (bin && typeof bin === 'object') { const k = Object.keys(bin)[0]; rel = bin[k]; }
          if (rel) return path.join(pkgDir, rel);
        } catch {}
      }
    } catch {}
    return null;
  }

  /** 确保包已缓存（下载预取）：缓存未命中 → npx --yes 预下载（首次安装），
   * 避免首次请求时冷启动下载导致启动/探活超时。返回 { ok }。 */
  async _ensurePkgCached(app) {
    if (!app || !app.pkg) return { ok: true };
    if (this._cachedPkgBin(app.pkg)) return { ok: true, cached: true };
    try {
      const regOrigin = this.dist ? await this.dist.selectRegistry(false).catch(() => null) : null;
      const { execFile } = require('node:child_process');
      await new Promise((resolve) => {
        const env = Object.assign({}, process.env);
        if (regOrigin) { env.npm_config_registry = regOrigin; env.NPM_CONFIG_REGISTRY = regOrigin; }
        // 经统一解析入口：原为裸 'npx'（绕过解析）。
        const child = execFile(npxBin(), ['--yes', app.pkg, '--help'], { env, timeout: 120000 }, () => resolve());
        child.on('error', () => resolve());
      });
      return { ok: !!this._cachedPkgBin(app.pkg) };
    } catch { return { ok: false }; }
  }

  async _doStart(inst) {
    const app = this.app;
    if (!app) return { ok: false, error: '未知反代应用' };
    // 防残留：同账号只保留一条 proxyInstance 端口记录（旧实例残留清理）
    if (inst.keyId) {
      const owner = 'proxy:' + inst.keyId;
      // 2026-09-13（失效模式 g）：释放时**带上该记录的 owner** ——
      // list() 快照与 release 之间存在 TOCTOU：期间若该端口被他人重新登记，
      // 不带 ownerId 的 release 会误删**他人**记录（与实例域 P1-3 同一类缺陷）。
      for (const rec of ports.list()) if (rec.owner === owner && rec.port !== inst.port) { try { ports.release(rec.port, rec.owner); } catch {} }
    }
    // ── 认领前置：绑定端口上的本账号幸存进程（2026-09 复检根治：一律弃用重拉，禁 adopt）──
    // 进程态不落盘，daemon 重启后只恢复 port 绑定；若该绑定端口仍被一个 cmdline 匹配本 app pkg
    // 的进程监听（上一代 daemon spawn 的残留，重启后 reparent 到 init 继续服务），必须在
    // 端口分配【之前】处置——原逻辑在 claimSlot 之后只检查新分端口：绑定端口被占时 claimSlot 先
    // bindingLost 迁移 → adopt 永不触发 → 残留幽灵 + 漂移；后补认领前置但「健康→认领复用」仍不安全：
    // 幸存进程 stdio 管道读端属于已死 daemon → 首个请求写日志即 EPIPE 楔死（实测 677630：CPU 110%
    // 旋转、completion 全挂而 /health 秒回——健康监控盲区），且 adopt 后其请求日志永久丢失。
    // 语义（定稿）：同 pkg 幸存进程【一律 SIGKILL 弃用】→ 等端口释放 → claimSlot 复用绑定全新拉起
    // ——实例 stdio/env 必归当前 daemon，杜绝楔死与漂移（健康与否不再作为判据：/health 检测不到
    // 「completion 挂死 + CPU 旋转」类病态；停服孤儿源头另由 stopAndWait 根治，见 index.js/daemon）。
    if (!inst.pid && inst.port) {
      const boundPid = pidlook.findListeningPid(inst.port);
      if (boundPid) {
        const cmd = pidlook.readCmdline(boundPid) || '';
        const pkgMarker = (app && app.pkg) || '';
        if (pkgMarker && cmd.indexOf(pkgMarker) >= 0) {
          if (this.logger && this.logger.warn) this.logger.warn('[proxy-instance] 重启幸存者弃用重拉 pid=' + boundPid + ' port=' + inst.port + '（stdio 归属旧代，禁 adopt）');
          if (this.events) this.events.append('proxy_instance_survivor_reclaimed', { app: this.proxyAppId, port: inst.port, pid: boundPid, reason: 'restart-survivor-stdio-unsafe' });
          try { process.kill(boundPid, 'SIGKILL'); } catch {}
          // SIGKILL 后内核回收端口需瞬时：等待释放，避免 claimSlot 复判占用再次迁移
          const dl = Date.now() + 3000;
          while (Date.now() < dl && (await ports.isTaken(inst.port, 'proxy:' + (inst.keyId || 'unknown')).catch(() => false))) {
            await new Promise((r) => setTimeout(r, 150));
          }
          inst.pid = null;
          inst.status = 'stopped';
          inst.healthy = false;
          inst._unhealthyCount = 0;
          this._persist();
        }
      }
    }
    // 端口分配唯一入口 = claimSlot（2026-09 架构单写收敛）：byOwner 绑定复用（端口唯一活在 registry，
    // 对齐 relay 语义）→ preferred(inst.port 持久化记忆) → 段内最小空闲。self-listening 由 claimSlot
    // 自动 register 认领（adopt 前置）。不传 reclaimCmdMark：反代实例无 TERM 回收路径（幸存者一律上方弃用重拉，防误杀其它进程）。
    const owner = 'proxy:' + (inst.keyId || 'unknown');
    const slot = await ports.claimSlot('proxyInstance', owner, {
      preferred: inst.port || undefined,
    });
    if (!slot || slot.conflict) return { ok: false, error: '反代端口段已满/冲突' };
    const port = slot.port;
    // 新分配/换绑 → 持久化绑定（toJSON 落盘）
    if (inst.port !== port) { inst.port = port; this._persist(); }
    // （2026-09 复检：原「新分端口幸存者 adopt」块已删除——绑定端口幸存者由上方认领前置一律
    // 弃用重拉；claimSlot 分配的是空闲端口，spawn 前由下方端口释放等待兜底残留。）
    // 端口释放等待（2026-09 审计修复：EADDRINUSE 启停风暴根因）：
    // stopInstance 对旧进程 SIGTERM 后立即置 pid=null，SIGKILL 兜底在 1.5s 后——
    // 若新 startInstance 在旧进程真正退出前复用同端口 spawn，上游 listen 即 EADDRINUSE
    // 秒退 → 请求/预热/保障/检测多路径并发下形成「启动失败 → 重试 → 再失败」风暴。
    // 这里在 spawn 前短轮询端口释放（≤3s），仍占用且非本账号健康进程则明确报错。
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (await ports.isTaken(port, owner).catch(() => false))) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (await ports.isTaken(port, owner).catch(() => false)) {
      const msg = '端口 ' + port + ' 仍被占用（非本账号健康进程未退出），本次启动放弃';
      if (this.events) this.events.append('proxy_instance_start_port_busy', { app: this.proxyAppId, port });
      if (this.logger && this.logger.warn) this.logger.warn('[proxy-instance] ' + msg);
      inst.status = 'stopped'; inst.healthy = false; this._persist();
      return { ok: false, error: msg };
    }
    // 启动命令：优先直连已缓存的包（零解析/零下载/秒起），缓存未命中才 npx --yes（首次下载）
    const launch = await this._resolveLaunchCommand(app, port, inst.key);
    if (!launch.ok) return launch;
    // 实例环境 = app 契约（见 proxy-apps.js），模式类不内联供应商 env（2026-09 用户定稿）：
    // - 账号密钥只经 env 传递、绝不进 cmdline——env 名由 app.keyEnv 声明
    // （默认 CC_API_KEY：commandcode 生态历史名，测试 mock 应用沿用）；
    // - app.env 提供应用级 env（含 {{key}}/{{port}} 占位）。commandcode 不注入任何超时/日志 env——
    // 跑代理完全默认（见下方注释）。
    const keyEnv = (app && app.keyEnv) || 'CC_API_KEY';
    const envVars = Object.assign({}, process.env);
    // 2026-09 回归最早纯净态：只注账号密钥，【不】注入任何 CC_IDLE/CC_UPSTREAM/LOG_LEVEL——
    // 第三方代理跑完全默认配置（idle 120s / upstream 600s，作者设计值）。git 证据：最早 8867942
    // 只传 CC_API_KEY、78 万 token 顺畅；c138e85 起注入 CC_IDLE_TIMEOUT_MS=0（禁 idle）等才是
    // 「后来出问题」起点（stall 永不掐→实例挂死）。第三方默认已正确，不自我干预。
    envVars[keyEnv] = inst.key;
    if (app && app.env && typeof app.env === 'object') {
      for (const [k, v] of Object.entries(app.env)) {
        if (k === keyEnv) continue; // 密钥入口统一为 keyEnv，防双写不一致
        envVars[k] = String(v).replace('{{key}}', inst.key).replace('{{port}}', String(port));
      }
    }
    if (launch.registry) { envVars.npm_config_registry = launch.registry; envVars.NPM_CONFIG_REGISTRY = launch.registry; }
    let child;
    try { child = spawn(launch.cmd[0], launch.cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: envVars, detached: true }); }
    catch (e) { return { ok: false, error: 'spawn 失败: ' + e.message }; }
    // 捕获反代实例 stdout/stderr（2026-09 诊断增强）：
    // - 全量落盘：stdout/stderr 写独立文件 ~/.dsh/supervisor/logs/proxy-instance-<app>-<port>.log——
    // 反代内部完整处理（收到请求→转上游→上游 chunk→错误）可见，卡死/400 时定位根因（曾因只滤
    // 关键词落事件丢失 info/debug → 每次异常只能外部猜 CPU/连接/时间线）；
    // - 关键词行仍落事件（保留既有诊断摘要）。
    const logFilter = /error|streaming|idle|timeout|ECONN|abort|socket|finish|truncat/i;
    let logStream = null;
    try {
      // D7：优先用注入的数据目录（config.stateFile 派生），杜绝测试/多实例写进真实 ~/.dsh。
      const baseDir = this.stateDir || require('../../platform/state-root').supervisorDir();
      const logDir = require('node:path').join(baseDir, 'logs');
      require('node:fs').mkdirSync(logDir, { recursive: true });
      logStream = require('node:fs').createWriteStream(require('node:path').join(logDir, 'proxy-instance-' + this.proxyAppId + '-' + port + '.log'), { flags: 'a' });
    } catch {}
    const pushLog = (buf, src) => {
      if (logStream) { try { logStream.write('[' + new Date().toISOString() + '][' + src + '] ' + String(buf)); } catch {} }
      for (const raw of String(buf).split(/\r?\n/)) {
        const l = raw.trim();
        if (!l || !logFilter.test(l)) continue;
        if (this.events) this.events.append('proxy_instance_log', { app: this.proxyAppId, port, src, line: l.slice(0, 400) });
        if (this.logger && this.logger.warn) this.logger.warn('[proxy-instance] ' + src + ': ' + l.slice(0, 400));
      }
    };
    child.stdout.on('data', (c) => pushLog(c, 'out'));
    child.stderr.on('data', (c) => pushLog(c, 'err'));
    child.on('close', () => { if (logStream) { try { logStream.end(); } catch {} } });
    inst.pid = child.pid;
    inst.port = port;
    inst.status = 'starting';
    inst.healthy = false;
    // 关停竞态：stop() 先于本 spawn 完成（预启动在途）→ 一次也不漏，立即自清
    if (this._stopping) {
      try { this.stopInstance(inst); } catch {}
      return { ok: true, port, pid: child.pid, stoppedDuringShutdown: true };
    }
    child.on('close', (code) => {
      inst.pid = null; inst.healthy = false;
      // 端口与实例绑死：进程退出不清 port、不释放 registry 登记——复用绑定端口，防漂移；
      // 仅删除账号（discardAccount/removeProxyKey）才释放。
      if (inst.status !== 'frozen') inst.status = 'stopped';
      if (this.events) this.events.append('proxy_instance_stopped', { app: this.proxyAppId, port, code });
    });
    child.on('error', (err) => { inst.pid = null; inst.status = 'failed'; if (this.events) this.events.append('proxy_instance_failed', { app: this.proxyAppId, port, error: err.message }); });
    this._persist();
    if (this.events) this.events.append('proxy_instance_started', { app: this.proxyAppId, port, pid: child.pid });
    return { ok: true, port, pid: child.pid };
  }

  /** 标记实例被请求使用（forward-core pick 后调用）：仅记录使用时间。
   *
   * P1-1 修复（2026-09-12）：本函数**不再清零** `_unhealthyCount`。
   *
   * 缺陷：它原先在**每次 pick 之后、请求发出之前**被调用（forward-core 的循环里），
   * 并**无条件**清零失败计数；而重启阈值在 `markInstanceProblem` 里是「≥2」。
   * 而失败发生在请求**结束**时才 +1 —— 于是「清零 → 失败+1 → 清零 → 失败+1 …」，
   * 计数**数学上永远到不了 2**，请求级熔断（连续 ≥2 次失败即重启实例）是死代码。
   *
   * 注释原本写「请求成功 = 实例可用」，但实现执行在成功**之前** ——
   * 这是「注释声称的语义」与「代码实际时机」分叉的典型。
   *
   * 现：清零改由 `markRequestOk`（**请求成功后**调用）负责；
   * `markUsed` 只管 lastUsedAt（诊断/闲置宽限判断）。
   *
   * 注：prewarmed 标志已随「预热池目标态」废除——实例存留完全由 reconcile 期望集 + 闲置宽限期决定。 */
  markUsed(inst) {
    if (!inst) return;
    inst.lastUsedAt = Date.now();
  }

  /** **请求成功**后清零失败计数（P1-1 修复的配套）。
   *
   * 为什么必须独立成一个方法：清零的**时机**是这条缺陷的全部要害 ——
   * 「请求发出前清零」使熔断不可达；只有「请求确认成功后清零」才既保留
   * 「成功即健康」的语义，又让连续失败能真正累计。
   *
   * 健康监测的 `_monitorFails` 是**独立**计数器（见 healthInstance 的注释），
   * 本方法不得触碰它（跨界耦合曾被显式修过）。
   */
  markRequestOk(inst) {
    if (!inst) return;
    inst._unhealthyCount = 0;
  }

  /** 实例停止仲裁：仅当账号不再需要实例时才允许停止。
   * ① inflight>0（请求在途）→ 不停止（防杀在途流）；
   * ② 付费侧在用（selected/粘滞 activeAccount）→ 保留。 */
  _canStopInstance(acc) {
    if (!acc) return true;
    if ((acc.inflight || 0) > 0) return false;
    if (acc.status === 'ready' && this.isAccountUsable(acc)) {
      if (this.selectedAccountKeyId === acc.keyId || (this.activeAccount && this.activeAccount.keyId === acc.keyId)) return false;
    }
    return true;
  }

  /** 实例停止（幂等）：
   * 在途/在用仲裁 → 仅标记 _stopPendingUntilIdle（不设一次性补刀 timer——旧 timer 在命中
   * 在途时直接 return 永不重排 → 实例泄漏；现由「请求结束补刀（_retryPendingStop）＋ reconcile
   * 周期停循环」两条路径收敛）。
   * force=true（服务停服/守卫优雅退出专用）：跳过在用/在途仲裁强制 TERM——否则在用账号实例被 defer
   * 逃脱关停 → daemon 退出即成孤儿（426880/677630/795363 三次实锤，停服孤儿化根因①）；停服即服务下线，
   * 在途流本就随 daemon 退出而断，不存在「不可中断」。
   * 孤儿（无对应账号）直接停（acc=null 空安全，供 reconcile 对 orphan 实例收敛）。
   * 不释放端口（端口与实例绑死，复用绑定防漂移）；仅删除账号时释放。 */
  stopInstance(inst, force) {
    if (!inst) return;
    const acc = this.accounts.find((a) => a.keyId === inst.keyId) || null;
    if (acc && !force && !this._canStopInstance(acc)) {
      // 在途/在用：标记待停，由请求结束或 reconcile 周期补刀（不中断在途流）
      acc._stopPendingUntilIdle = true;
      return;
    }
    if (acc) acc._stopPendingUntilIdle = false;
    if (!inst.pid) {
      if (inst.status !== 'frozen') inst.status = 'stopped';
      inst.healthy = false;
      this._persist();
      return;
    }
    // pid 快照：必须在置 null 前保存，否则定时器回调里 inst.pid 为 null →
    // process.kill(-null) = kill(-0) 会向【当前进程组（守卫自己）】发 SIGKILL，导致守卫自杀
    const pid = inst.pid;
    // 台账维护：加入前剪除已死旧条目（防只增不减）；台账条目的删除只由 waitAllStopped 的
    // 观察式 sweep 执行（进程实际死亡/zombie 后）——定时器不得提前 delete（否则 waitAllStopped 见空
    // 即返回，进程尚未死透 → 停服残留竞态，实测全量链 R12j）。
    if (this._terminatingPids && this._terminatingPids.size) {
      for (const q of [...this._terminatingPids]) {
        let al = true;
        try { al = pidlook.isAlive ? pidlook.isAlive(q) : true; } catch { al = false; }
        if (!al) this._terminatingPids.delete(q);
      }
    }
    try { this._terminatingPids.add(pid); } catch {}
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
    // SIGKILL 兜底 1.5s（unref：运行期不阻塞退出）。 daemon 优雅退出绝不能只靠它——unref 定时器随
    // process.exit 消亡 → 子进程孤儿化（stdio 死 → adopt 复用即楔死）；退出路径必须经 waitAllStopped
    // 确认子进程已死再 exit（RouterService.stopAndWait，见 index.js / router-daemon.js）。
    setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }, 1500).unref();
    inst.pid = null;
    if (inst.status !== 'frozen') inst.status = 'stopped';
    inst.healthy = false;
    this._persist();
  }

  /** 请求结束补刀（forward-core 在途计数归零时调用）：该账号若标记待停且已无在途 → 立即停。
   * 取代旧一次性 2.5s timer（命中在途即空放、永不重排的泄漏根因）。 */
  _retryPendingStop(acc) {
    if (!acc || !acc._stopPendingUntilIdle) return;
    if ((acc.inflight || 0) > 0) return; // 仍有在途：等最后一次请求结束再补
    const inst = this.instanceOf(acc);
    if (inst && inst.pid) { this.stopInstance(inst); }
    else acc._stopPendingUntilIdle = false;
  }

  /** 等待全部 SIGTERM 在途子进程真正退出（优雅退出专用，2026-09 根治停服孤儿化）：
   * stopInstance 只发 SIGTERM + unref SIGKILL(1.5s)——若 daemon 随即 process.exit，定时器随进程
   * 消亡永不触发 → 子进程孤儿化、stdio 管道死（426880/677630 两次实锤，adopt 复用即 EPIPE 楔死）。
   * 本方法轮询 _terminatingPids：超时兜底 SIGKILL 进程组，返回时无残留（或确认已清）。 */
  async waitAllStopped(timeoutMs) {
    const dl = Date.now() + (timeoutMs || 3000);
    // zombie 判定：SIGKILL 已投递但父进程尚未回收的进程 kill(0) 仍为 true——其端口/stdio 已释放，
    // 对「防停服孤儿化」而言即已死（否则等待会被回收延迟拉长/误判）。Linux 读 /proc/<pid>/stat 状态位。
    const isZombie = (pid) => {
      try {
        const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
        const idx = st.lastIndexOf(') ');
        return idx >= 0 && st[idx + 2] === 'Z';
      } catch { return false; }
    };
    const sweep = () => {
      if (!this._terminatingPids || !this._terminatingPids.size) return;
      for (const pid of [...this._terminatingPids]) {
        let alive = true;
        try { alive = pidlook.isAlive ? pidlook.isAlive(pid) : true; } catch { alive = false; }
        if (!alive || isZombie(pid)) this._terminatingPids.delete(pid);
      }
    };
    while (Date.now() < dl && this._terminatingPids.size) {
      sweep();
      if (!this._terminatingPids.size) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this._terminatingPids.size) {
      // 兜底：SIGTERM 未退（如忽略 TERM 的进程）→ SIGKILL 进程组
      for (const pid of [...this._terminatingPids]) {
        try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
      const dl2 = Date.now() + 2000;
      while (Date.now() < dl2 && this._terminatingPids.size) {
        sweep();
        if (!this._terminatingPids.size) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this._terminatingPids && this._terminatingPids.size) this._terminatingPids.clear();
    }
    return true;
  }

  /** 实例探活（2026-09 分层隔离）：纯 HTTP 探测并回报 inst.healthy——【不持有任何计数】。
   * 分层：请求级连续失败计数 _unhealthyCount（net-fail≥2 重启）由 markInstanceProblem 自管；
   * 健康监测连续失败计数 _monitorFails（≥3 kill 重拉）由 monitorLifecycle 自管。
   * 曾在此混写 _unhealthyCount（健康清零/失败累加）→ 探活结果污染请求熔断计数（跨界耦合）。 */
  async healthInstance(inst) {
    if (!inst || !inst.port) return;
    const app = this.app;
    if (!app) return;
    try {
      const res = await fetch('http://127.0.0.1:' + inst.port + app.healthPath, { signal: AbortSignal.timeout(3000) });
      inst.healthy = res.ok;
      if (res.ok) {
        if (inst.status !== 'frozen' && inst.status !== 'stopped') inst.status = 'running';
        try { const j = await res.json(); if (j.version) inst.version = j.version; } catch {}
      } else {
        if (inst.status !== 'frozen' && inst.status !== 'stopped') inst.status = 'unhealthy';
      }
    } catch {
      inst.healthy = false;
      if (inst.status !== 'frozen' && inst.status !== 'stopped') inst.status = 'unhealthy';
    }
  }

  /** 实例生命周期监控（2026-09 分层原则 + 卡死检测补齐）：
   * 分层：业务健康（400/5xx/额度）由智能路由判账号状态，不在此判定；此处管「实例自身是否可用」：
   * ① 进程存活 + 端口监听（adopt 实例无 exit 事件 → pid 残留阻断按需激活，周期清 pid）
   * ② 【2026-09 卡死检测】HTTP 探活（healthPath，3s 超时）——进程活着但事件循环被占满/假死
   * （如 41012 卡死：CPU 90% 请求全挂）时，进程/端口检查都通过但 health 不响应。
   * 连续 _monitorFails >= 3（约 90s）→ 判定卡死 → kill + 清 pid → 按需激活全新拉起（自愈）。
   * 不误杀：healthPath 是独立轻量端点；实例正常服务长流时也应能即时响应（fetch 3s 超时即弃）。 */
  async monitorLifecycle() {
    if (this._stopping || this.activated !== true) return;
    for (const inst of (this.instances || [])) {
      if (!inst || !inst.pid || !inst.port) continue;
      if (inst.status === 'frozen' || inst.status === 'stopped') continue;
      // ① 进程存活检查
      let alive = false;
      try { alive = pidlook.isAlive ? pidlook.isAlive(inst.pid) : true; } catch {}
      if (!alive) {
        // 进程死了：清 pid（生命周期故障）——账号 ready 的实例由下次请求按需激活拉起
        if (this.logger && this.logger.warn) this.logger.warn('[proxy-instance] 生命周期监控：进程死亡 key=' + inst.maskedKey + ' pid=' + inst.pid);
        inst.pid = null;
        inst.healthy = false;
        inst._monitorFails = 0;
        if (inst.status !== 'frozen') inst.status = 'stopped';
        continue;
      }
      // 端口监听检查（进程在但端口可能已释放——异常态）
      if (typeof pidlook.findListeningPid === 'function') {
        const listening = pidlook.findListeningPid(inst.port);
        const selfListening = listening === inst.pid;
        if (!selfListening) {
          if (this.logger && this.logger.warn) this.logger.warn('[proxy-instance] 生命周期监控：端口异常 key=' + inst.maskedKey + ' port=' + inst.port + ' pid=' + inst.pid + ' listener=' + (listening || '无'));
          // 端口不再归本实例（进程可能假死/端口被占）：清 pid 待按需激活重建
          inst.pid = null;
          inst.healthy = false;
          inst._monitorFails = 0;
          if (inst.status !== 'frozen') inst.status = 'stopped';
          continue;
        }
      }
      // ② HTTP 卡死检测（所有实例统一；healthPath 由 app 声明，如 commandcode=/health）
      if (this.app && this.app.healthPath && typeof this.healthInstance === 'function') {
        await this.healthInstance(inst); // 3s 超时；只回报 healthy，计数归 _monitorFails 自管
        if (inst.healthy) {
          inst._monitorFails = 0;
        } else {
          inst._monitorFails = (inst._monitorFails || 0) + 1;
          if (inst._monitorFails >= 3) {
            // 进程活着但连续 ~90s 不响应 health → 卡死/假死：kill + 清 pid（按需激活全新拉起自愈）
            if (this.logger && this.logger.warn) this.logger.warn('[proxy-instance] 生命周期监控：实例无响应（疑似卡死）key=' + inst.maskedKey + ' port=' + inst.port + ' pid=' + inst.pid + ' fails=' + inst._monitorFails + '，kill 重拉');
            if (this.events) this.events.append('proxy_instance_hang_restart', { app: this.proxyAppId, port: inst.port, pid: inst.pid, fails: inst._monitorFails });
            try { process.kill(inst.pid, 'SIGKILL'); } catch {}
            inst.pid = null;
            inst.healthy = false;
            inst._monitorFails = 0;
            if (inst.status !== 'frozen') inst.status = 'stopped';
          }
        }
      }
    }
  }

  /** 实例重启执行（事件驱动，2026-09 用户定稿）：报错触发时 kill 当前实例进程并重新拉起。
   * 不做全量周期探活——实例是按需调用机制，只在「具体报错」时介入重启（400/连接失败/5xx）。
   * 带单实例退避 _restartAt 防风暴（重启后 2min 内不重复重启同一实例）。 */
  restartInstance(inst, reason) {
    if (!inst || this._stopping) return;
    if (!inst.pid && !inst.port) return;
    if (Date.now() < (inst._restartAt || 0)) return; // 退避中
    const acc = this.accountOf(inst);
    if (acc && (acc.inflight || 0) > 0) {
      // P1-3 修复（2026-09-12）：两处缺陷合并修。
      //
      // 缺陷一（时序）：旧实现把 `_restartAt = now + 120s` 写在**本分支之前** ——
      // 即在途请求触发的重启，**退避已置位**却什么都没做：随后 2 分钟内所有重启
      // 尝试都被 `Date.now() < _restartAt` 拦下 → 坏实例至少卡死 2 分钟。
      // 现改为：**只有真正执行重启时才置退避**。
      //
      // 缺陷二（死字段）：`_restartPending` 只写不读（全仓无消费点），
      // 注释称「空闲后由下次报错/调用触发」并不成立 —— 下次报错要重新累积失败，
      // 且会被已置位的退避拦下。
      // 现改为**真正的延迟执行**：记下待重启原因，并在实例空闲（inflight 归 0）时
      // 由 `_flushRestartPending` 补做。
      inst._restartPending = reason || 'deferred';
      if (this.logger && this.logger.info) {
        this.logger.info('[proxy-instance] 在途请求中，重启延后 key=' + inst.maskedKey + ' reason=' + inst._restartPending);
      }
      return;
    }
    inst._restartAt = Date.now() + 120000; // 仅在**真正执行**时置退避
    inst._restartPending = null;
    if (this.logger && this.logger.warn) this.logger.warn('[proxy-instance] 实例重启 key=' + inst.maskedKey + ' port=' + inst.port + ' reason=' + reason);
    const hadPid = !!inst.pid;
    // P2 修复（2026-09-13，失效模式 e/g）：**重启必须真正停掉进程**，且失败不得静默。
    //
    // 缺陷：原为 `this.stopInstance(inst)`（不带 force）。而 stopInstance 的仲裁
    // `_canStopInstance`(:353-360) 在「账号 ready + 可用 + 被 selected/activeAccount 指向」时
    // 为 false —— 这正是**正在服务的实例**（也恰恰是最需要重启的那类）。
    // 于是：stopInstance 只置 _stopPendingUntilIdle 就 return，**不 kill**；
    // 而上一行已把 `inst._restartPending = null` → flushRestartPending 无内容可补做；
    // 调用它的 _endInflight 也不会再来（此处 inflight 本就为 0）。
    // 同时 `_restartAt = now + 120s` 已置位 → 之后 2 分钟内所有重启尝试都被退避拦下。
    //
    // 后果：upstream-timeout → 实例级重启这条自愈链对该账号**彻底失效至少 2 分钟**，
    // 且没有任何事件/日志表明「重启被丢弃」。触发它的正是「health 秒回但 completion 挂死」
    // 这类生命周期探活看不出的病态 → 坏实例持续吃流量。
    //
    // 修法：本函数**已自行处理**在途情形（上方 inflight>0 分支延后并记 _restartPending），
    // 故此处到达即代表「可以停」→ 用 force 语义跳过在用仲裁（重启的语义就是要杀掉它）。
    // 并做**失败可观测**：若 stop 后进程仍活，重新武装 _restartPending 并清退避，
    // 让 reconcile/flush 能再试，而不是静默黑洞 2 分钟。
    try { this.stopInstance(inst, true); } catch (e) { this.logger.warn && this.logger.warn('[proxy-instance] 重启 stop 异常: ' + (e && e.message)); }
    if (inst.pid) {
      let stillAlive = true;
      try { stillAlive = (typeof pidlook !== 'undefined' && pidlook.isAlive) ? pidlook.isAlive(inst.pid) : true; } catch {}
      if (stillAlive) {
        // 未能真正停掉 → 退避清零并重新记待重启（避免「静默丢弃 + 黑名单 2 分钟」）
        inst._restartAt = 0;
        inst._restartPending = reason || 'restart-stop-failed';
        if (this.logger && this.logger.warn) {
          this.logger.warn('[proxy-instance] 重启未能停止进程 pid=' + inst.pid + ' key=' + inst.maskedKey + '，已重新记待重启（不静默）');
        }
        return;
      }
    }
    if (acc && acc.status === 'ready') {
      // kill 后重拉：短延迟（端口释放）后启动；失败必须记录并保持 pid=null——
      // 后续请求按需激活路径（forward-core 见 !acc.instance.pid → startInstance）自动兜底重拉，
      // 绝不留「实例真空 + net fail 死循环」。
      setTimeout(() => {
        this.logger.warn && this.logger.warn('[proxy-instance] 重启回调触发 key=' + inst.maskedKey + ' accStatus=' + (acc && acc.status) + ' stopping=' + this._stopping + ' pid=' + inst.pid);
        if (this._stopping || acc.status !== 'ready') return;
        // 已恢复判定：pid 存在且进程真活（adopt 实例可能 pid 残留但进程已死——仅看 pid 会误判已恢复 → 实例真空）
        if (inst.pid) {
          const alive = (typeof pidlook !== 'undefined' && pidlook.isAlive ? pidlook.isAlive(inst.pid) : true);
          if (alive) return;
          inst.pid = null; // 进程已死：清残留，走下方重拉
        }
        const attempt = () => this.startInstance(inst).then((sr) => {
          if (sr && sr.ok) { return this._waitHealthy(inst).then((ok) => { if (!ok) this.logger.warn && this.logger.warn('[proxy-instance] 重启后不健康 key=' + inst.maskedKey); }); }
          this.logger.warn && this.logger.warn('[proxy-instance] 重启拉起失败 key=' + inst.maskedKey + ' err=' + (sr && sr.error));
          return null;
        }).catch((e) => { this.logger.warn && this.logger.warn('[proxy-instance] 重启拉起异常 key=' + inst.maskedKey + ' ' + (e && e.message)); });
        attempt();
      }, hadPid ? 1200 : 100);
    } else {
      // 账号非 ready（已冻结等）：不重拉，实例保持 stopped（由账号状态机管理）
      if (this.logger && this.logger.debug) this.logger.debug('[proxy-instance] 重启跳过（账号非 ready）key=' + inst.maskedKey + ' accStatus=' + (acc && acc.status));
    }
  }

  /** 请求级熔断（事件驱动）：请求报错（连接失败/400/5xx）时标记实例。
   * 实例是「按需调用」——只在具体报错时介入：连续 ≥2 次报错 → 重启实例恢复。
   * 实例为 null 或已无 pid 时忽略（无进程对象可标；由账号切换/按需拉起兜底）。 */
  markInstanceProblem(instOrAcc, reason) {
    try {
      const inst = instOrAcc && instOrAcc.pid ? instOrAcc : null;
      if (!inst) return;
      inst._unhealthyCount = (inst._unhealthyCount || 0) + 1; // 请求级连续失败（与健康监测 _monitorFails 独立）
      inst.healthy = false;
      inst._lastProblem = reason || 'unknown';
      const failN = inst._unhealthyCount;
      if (failN >= 2) {
        inst._unhealthyCount = 0; // 触发重启即重新计数（防旧计数残留 → 无限重启）
        this.restartInstance(inst, 'req-' + (reason || 'unknown') + ' x' + failN);
      }
    } catch {}
  }

  /** 兼容旧名（保持对外调用不破）。 */
  markInstanceNetFail(instOrAcc) { this.markInstanceProblem(instOrAcc, 'net-error'); }

  /** 实例空闲后补做「被延后的重启」（P1-3 修复的配套消费点）。
   *
   * 为什么需要它：`restartInstance` 在**在途请求**期间不能 kill（会切断流），
   * 故只能记 `_restartPending` 并返回。旧实现到此为止 —— 该字段**没有任何读取点**，
   * 于是「延后」变成了「丢弃」，且当时退避已置位 → 坏实例至少卡死 2 分钟。
   *
   * 现由 `_endInflight` 在 inflight 归零时调用本方法：真正的延迟执行。
   * - 仍有在途（并发请求）→ 继续等，不清标记；
   * - 已空闲 → 清标记并执行重启（`restartInstance` 会重新判退避）。
   */
  flushRestartPending(inst) {
    if (!inst || !inst._restartPending) return;
    const acc = this.accountOf(inst);
    if (acc && (acc.inflight || 0) > 0) return; // 仍有在途，继续延后
    const why = inst._restartPending;
    inst._restartPending = null;
    if (this.logger && this.logger.info) {
      this.logger.info('[proxy-instance] 实例已空闲，补做延后的重启 key=' + inst.maskedKey + ' reason=' + why);
    }
    try { this.restartInstance(inst, why); } catch (e) {
      this.logger.warn && this.logger.warn('[proxy-instance] 补做重启异常: ' + (e && e.message));
    }
  }

  /** 模式级配额检测（模式类零供应商词，2026-09 用户定稿）：
   * 按 app.quota.type 查配额策略注册表（quota-strategies.js）执行取数与解析：
   * - official-billing（commandcode-billing）：直连官方 API（credits+subscriptions），无需实例运行；
   * - window-usage（含历史 alias opencode-usage/proxy-usage）：读本地实例 usagePath 的 usage 面。
   * 无 type 但有 usagePath → 按 window-usage（旧通用分支语义）。overallStatus 措辞由本模式统一填充。 */
  async detectInstanceQuota(inst) {
    const app = this.app;
    if (!app || !app.quota) { inst.quota = null; return { ok: true, quota: null }; }
    const q = app.quota;
    // 兼容历史注册：显式 type 优先；无 type 但有 usagePath → window-usage（旧通用 usage 分支语义）
    let strategy = getQuotaStrategy(q.type);
    if (!strategy && q.usagePath) strategy = getQuotaStrategy('window-usage');
    if (!strategy) { inst.quota = null; return { ok: true, quota: null }; }
    try {
      let det;
      if (strategy.kind === 'official-billing') {
        // creditFrozen：账号当前因月额度（credits 信号）冻结——订阅面 periodEnd 拉取条件随之放宽
        // （冻结期间必须拿到精确恢复时刻；≤0 旧条件覆盖不了灰区冻结，2026-09 月额度语义定稿）
        const acc = this.accountOf(inst);
        const creditFrozen = !!(acc && acc.limit && acc.limit.kind === 'credits');
        det = await strategy.detect({ key: inst.key, quota: q, cache: inst, prevQuota: inst.quota, creditFrozen }).catch((e) => ({ ok: false, error: e.message }));
      } else {
        if (!q.usagePath) { inst.quota = null; return { ok: true, quota: null }; }
        det = await strategy.detect({ url: 'http://127.0.0.1:' + inst.port + q.usagePath, key: null, timeout: 3000, roundPercent: true }).catch((e) => ({ ok: false, error: e.message }));
      }
      if (!det.ok || !det.quota) { inst.quota = null; return { ok: false, error: (det && det.error) || '无法获取配额' }; }
      inst.quota = det.quota;
      inst.quota.overallStatus = quotaOverallStatus(inst.quota);
      return { ok: true, quota: inst.quota };
    } catch (e) { inst.quota = null; return { ok: false, error: e.message }; }
  }


  async addAccount(key, extra) {
    const existing = this.accounts.find((a) => a.key === key);
    if (existing) return { ok: true, account: existing, already: true };
    const inst = await this.ensureInstance(key);
    const acc = { key, keyId: inst.keyId, maskedKey: inst.maskedKey, status: 'registering', quota: null, registeredAt: Date.now(), instance: inst, ...(extra || {}) };
    this.accounts.push(acc);
    this._persist();
    // 下载预取：确保反代包已缓存（避免首次启动冷下载导致启动/探活超时）
    try { await this._ensurePkgCached(this.app); } catch {}
    const r = await this.startInstance(inst);
    if (!r.ok) {
      acc.status = 'discarded';
      acc.detectError = r.error;
      this._persist();
      return { ok: false, error: r.error, account: acc };
    }
    const healthy = await this._waitHealthy(inst);
    if (!healthy) {
      acc.status = 'discarded';
      acc.detectError = '实例启动失败（探活超时）';
      this._persist();
      return { ok: false, error: acc.detectError, account: acc };
    }
    const det = await this.detectInstanceQuota(inst);
    if (!det.ok && !det.quota) {
      acc.status = 'discarded';
      acc.detectError = det.error || '无法获取配额';
      this._persist();
      return { ok: false, error: acc.detectError, account: acc };
    }
    acc.quota = det.quota || null;
    inst.quota = det.quota || null;
    const summary = this.accountQuotaSummary(acc);
    // 统一入库（2026-09 用户定稿）：与 base 同一 applyDetection 状态机、与运行中同一条处置路径——
    // 受限（月额度用尽 / 时间窗满）→ frozen + limit + recovery（到点自动探测解冻），正常 → ready。
    // 无 review 闸门（时间窗满同样是自动检测、自动解；不存在两套待遇）。
    this.applyDetection(acc, { ok: true, quota: det.quota || null });
    // 受限入库即停掉刚用于检测的实例（不再空转；ready 常驻由保障/请求按需激活决定，与旧行为一致）
    if (acc.status === 'frozen' && acc.instance && acc.instance.pid) { try { this.stopInstance(acc.instance); } catch {} }
    if (acc.status === 'ready' && this.events) this.events.append('account_ready', { provider: this.name, key: acc.maskedKey });
    const limited = (acc.limit && acc.limit.kind) || null;
    return { ok: true, account: acc, review: false, ...(limited ? { limited } : {}), quota: summary };
  }

  async _waitHealthy(inst, tries = 6) {
    // 探活窗口 9s（6×1.5s）：缓存直连秒起；慢环境（CI/沙箱）spawn 延迟大，
    // 6s 曾致 dry-run 探活偶发超时；首轮即健康时无额外等待。仍限时避免请求挂起（无感切换关键）
    for (let i = 0; i < tries; i++) {
      await this.healthInstance(inst);
      if (inst.healthy) return true;
      if (inst.status === 'stopped' || inst.status === 'failed') return false;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  }

  isAccountUsable(acc, opts) {
    if (!acc || acc.status !== 'ready') return false;
    if (this._isCreditsLow(acc)) return false; // 预付 credits 余额不足不参与挑选
    const inst = acc.instance || (this.instances || []).find((i) => i.keyId === acc.keyId);
    if (!inst) return false;
    if (opts && opts.checkWindows === false) return true;
    return !this._windowExhausted(acc); // 与 base 同一窗口判定（M4，删除重复实现）
  }


  /** 429/403 配额触发冻结：第一时间停掉实例（资源最低），再更新状态机。
   * 无感切换：冻结后异步预热下一个可用账号的实例（后台启动），
   * 使下一个请求到达时实例已就绪（秒响应，不阻塞在激活等待）。 */
  /** 停掉账号实例（统一经 instanceOf 按 keyId 映射——账号与实例经 keyId 关联，acc.instance 字段已废弃）。 */
  _stopInstanceIfAny(acc) {
    if (!acc) return;
    const inst = this.instanceOf(acc);
    if (inst) { try { this.stopInstance(inst); } catch {} }
  }

  markQuotaExhausted(acc, cooldownMs) {
    this._stopInstanceIfAny(acc);
    super.markQuotaExhausted(acc, cooldownMs);
    this.reconcileNow(); // 冻结后即时对账：停旧、按「将耗尽」规则补备胎（只备可用账号）
    this._probeAfterResponseFreeze(acc); // 2026-09-05 修复 B：冻结即补探，刷新 quota（消除 stale 快照）
  }

  /** credits 余额不足（上游 400/402/429/403 insufficient credits 驱动）：与窗口额度同一处置——
   * 停实例 + 冻结（按周期回探）+ 对账补备胎。 */
  markCreditsExhausted(acc) {
    this._stopInstanceIfAny(acc);
    super.markCreditsExhausted(acc);
    this.reconcileNow();
    this._probeAfterResponseFreeze(acc);
  }

  /** 响应驱动冻结后的异步补探测（2026-09-05 修复 B）：429/400 冻结原本不触发探测 → quota 停留冻结前快照。
   * 冻结后立即异步重探并走 applyDetection：真实超限 → quota 刷新为真实态；误判 → 自动解冻。
   * 仅 official-billing 策略（直连官方 API，实例已停不影响探测）。 */
  _probeAfterResponseFreeze(acc) {
    if (!acc || acc.status === 'banned' || acc.status === 'discarded') return;
    const app = this.app;
    if (!app || !app.quota || !app.quota.type) return;
    const strategy = getQuotaStrategy(app.quota.type);
    if (!strategy || strategy.kind !== 'official-billing') return;
    const inst = this.instanceOf(acc);
    if (!inst) return;
    const self = this;
    setTimeout(async () => {
      try {
        if (self._stopping) return;
        const det = await self.detectInstanceQuota(inst);
        if (!det.ok || !det.quota) return;
        inst.quota = det.quota;
        acc.quota = det.quota;
        acc.quota.overallStatus = quotaOverallStatus(acc.quota);
        self.applyDetection(acc, { ok: true, quota: det.quota });
        self._persist && self._persist();
      } catch (e) {
        if (self.logger && self.logger.debug) self.logger.debug('[proxy] 冻结后补探测失败: ' + ((e && e.message) || e));
      }
    }, 300);
  }

  /* ═══════ 实例对账（2026-09 架构收敛：启停唯一决策者）═══════
   * 目标：把「启/停」从 7 条各自写 if 的路径收敛为一条幂等 reconciliation 回路——
   * 期望运行集 = 常驻 1（resident）+ 至多 1 备胎（spare，仅当有可用账号「将耗尽」才产生）。
   * 常驻（resident）：路由当前应服务的账号（selected/锁定 → activeAccount → 首个可用），
   * 必须 ready+usable（与 switch.pickFor 同一事实源 isAccountUsable）——若旧 primary 已冻结
   * /限额，resident 自动落到实际可用账号（不再为不可用账号保活实例）。
   * 备胎（spare）：当「主力将耗尽」（任一可用账号 _quotaPercent≥80，即额度接近上限很快会冻结）
   * 或「刚冻结需无感切换」时，额外保活一个 ready+usable 的非 resident 账号做 failover；
   * 否则不产生备胎（省资源）。备胎也必须是 usable —— 绝不为不可用账号预热
   * （旧 _prewarmByQuota 只看 percent≥80 不看可用性 → 预热即回收死循环的根因）。
   * 对账动作：ensure desired 集实例 running（幂等 start）；停掉其余无在途请求实例（幂等 stop）。
   * 触发：周期 tick（index 5min/启动）+ 事件（冻结 mark* 后即时补备胎）。 */

  /** 账号额度使用百分比（各窗口最大百分比）——「将耗尽」信号（≥80 时需备胎）。 */
  _quotaPercent(acc) {
    const q = (acc && acc.quota) || {};
    let max = 0;
    for (const w of [q.rolling, q.weekly, q.monthly]) {
      if (w && Number.isFinite(Number(w.percent))) max = Math.max(max, Number(w.percent));
    }
    return max;
  }

  /** 常驻账号（应保活实例）——服务跟随 + sticky 兜底（2026-09 架构修正）：
   * 优先级 = ① selected/锁定（若可用）→ ② activeAccount（实际在用/服务中，若可用）→
   * ③ 既有稳定常驻 _residentKeyId（若仍可用）→ ④ 首个可用账号。
   * 关键：② 必须优先于 ③ —— activeAccount 是 switch 粘滞指向、请求实际流经的账号；
   * 若 resident 不跟随它，reconcile 会停掉正在服务的实例（服务中断）。
   * ③ 仅在无在用（空闲/activeAccount 被冻结清空）时兜底，避免每次空闲后重新轮换到不同账号。
   * 真实 switch 粘滞下 activeAccount 稳定（pickFor 只在其不可用/冻结时才换），故不产生启停追逐；
   * 追逐只源于外部强制交替切换（用户显式切号），此时跟随 activeAccount 才是正确语义。
   * 迁移后更新 _residentKeyId（内存态，不落盘）。 */
  residentAccount() {
    const usable = (this.accounts || []).filter((a) => this.isAccountUsable(a));
    let res = null;
    if (this.selectedAccountKeyId) {
      const sel = usable.find((a) => a.keyId === this.selectedAccountKeyId);
      if (sel) res = sel;
    }
    if (!res && this.activeAccount) {
      const cur = usable.find((a) => a.keyId === this.activeAccount.keyId);
      if (cur) res = cur;
    }
    if (!res && this._residentKeyId) {
      const stable = usable.find((a) => a.keyId === this._residentKeyId);
      if (stable) res = stable;
    }
    if (!res) res = usable[0] || null;
    if (res) this._residentKeyId = res.keyId; // 内存 sticky：空闲后回到同一账号，避免轮换漂移
    return res;
  }

  /** 是否需要备胎：常驻（在用）账号额度将耗尽（≥80%——很快会被冻结，需无感切换备胎）。
   * 不用「任一可用账号」判定——非在用的高占用账号不影响当前服务（也绝不适合当备胎，
   * 备胎选号只看最低占用可用账号）；旧实现「任一 ready≥80 即预热」正是预热-回收死循环的触发。 */
  _needSpare() {
    const res = this.residentAccount();
    return !!(res && this._quotaPercent(res) >= 80);
  }

  /** 期望运行账号集：{ resident 必选, spare 至多 1（仅当 resident 将耗尽且存在更低占用可用账号） }。 */
  desiredRunningAccounts() {
    const res = this.residentAccount();
    const desired = [];
    if (res) desired.push(res);
    if (this._needSpare()) {
      const spare = (this.accounts || [])
        .filter((a) => this.isAccountUsable(a) && (!res || a.keyId !== res.keyId))
        .sort((a, b) => this._quotaPercent(a) - this._quotaPercent(b))[0]; // 最低占用者最适合作备胎（不选将耗尽的）
      if (spare) desired.push(spare);
    }
    return desired;
  }

  /** 实例对账核心（幂等单轮）：拉起 desired 缺口 + （可选）回收非期望集实例。
   * 由 reconcileInstances 在单飞锁内调用（幂等：start/stop 均具去重）。 */
  async _runReconcile(allowStop) {
    const out = { started: [], stopped: [], desired: [] };
    const desired = this.desiredRunningAccounts();
    out.desired = desired.map((a) => a.keyId);
    const desiredIds = new Set(desired.map((a) => a.keyId));
    for (const acc of desired) {
      const inst = this.instanceOf(acc);
      if (!inst || inst.pid || inst.startingPromise) continue; // 已在跑/启动中跳过（幂等）
      try {
        const r = await this.startInstance(inst);
        if (r && r.ok) {
          await this._waitHealthy(inst).catch(() => {});
          out.started.push(acc.keyId);
          const res = this.residentAccount();
          if (this.logger && this.logger.info) this.logger.info('[reconcile] 拉起实例 key=' + acc.maskedKey + (res && acc.keyId === res.keyId ? '（常驻）' : '（备胎）'));
        }
      } catch {}
    }
    if (!allowStop) return out;
    // 周期对账：停止不在期望集且有实例在跑的。
    // - 在途/在用 → stopInstance 内部仲裁（待停标记，请求结束补刀 / 下轮续停）；
    // - 闲置宽限（lastUsedAt 在 IDLE_RECLAIM_GRACE_MS 内）→ 本轮不回收（吸收交替/突发请求，
    // 防启停追逐）；宽限过期仍未再用 → 下轮回收；
    // - 孤儿（无账号实例）→ stopInstance 空安全直接停（不泄漏）。
    const graceCut = Date.now() - IDLE_RECLAIM_GRACE_MS;
    for (const inst of (this.instances || [])) {
      if (!inst.pid) continue;
      const acc = this.accountOf(inst);
      if (acc && desiredIds.has(acc.keyId)) continue;
      if (acc && inst.lastUsedAt && inst.lastUsedAt > graceCut) continue; // 刚用过：给闲置宽限
      try {
        this.stopInstance(inst);
        if (acc) out.stopped.push(acc.keyId);
        else out.stopped.push(inst.keyId || 'orphan'); // 孤儿：stopInstance 已空安全直接停
      } catch {}
    }
    return out;
  }

  /** 实例对账（幂等收敛，启停唯一决策者）——单飞互斥：
   * 同 provider 同时只跑一轮（_reconcileBusy）——30s 生命周期 tick / 5min 维护 tick /
   * 冻结事件多源并发触发，无互斥会让多轮 reconcile 交错（start 与 stop 相杀）。
   * busy 时的语义：
   * - 周期对账（allowStop=true）：等当前轮结束后【自己再跑一轮完整（start+stop）】——
   * 绝不并入在跑轮：若在跑的是 stop:false 事件轮（只补起不停），并入会漏掉回收（实例泄漏）；
   * - 事件补起（allowStop=false）：撞 busy 直接跳过（补起尽力而为，周期轮会覆盖补起+回收）。
   * @param opts { stop?:boolean } 周期对账默认 stop=true（补停闲置）；事件对账传 false
   * （仅补起 desired 缺口——不在请求处理中途杀可能刚被 pick 的实例，停交由下个周期 tick）。 */
  async reconcileInstances(opts) {
    if (!this.activated || this._stopping) return { started: [], stopped: [], desired: [] };
    const allowStop = !(opts && opts.stop === false);
    if (this._reconcileBusy) {
      if (!allowStop) return { started: [], stopped: [], desired: [] }; // 事件补起撞 busy：跳过
      // 周期对账撞 busy：等当前轮结束后自己完整跑一轮（含停循环）——不并入（防 stop:false 轮漏停）
      try { await this._reconcileBusy; } catch {}
    }
    if (this._reconcileBusy) return this._reconcileBusy; // 双保险：等完仍 busy（理论不可达）→ 并入
    const p = this._runReconcile(allowStop);
    this._reconcileBusy = p;
    try { return await p; } finally { if (this._reconcileBusy === p) this._reconcileBusy = null; }
  }

  /** 事件驱动的即时对账（冻结 mark* 后调用——保「无感切换」语义）：仅补起 desired 缺口，
   * 不在请求处理中途杀实例（停由周期对账收敛）。async 不阻塞请求。 */
  reconcileNow() {
    if (this._stopping) return;
    this.reconcileInstances({ stop: false }).catch(() => {});
  }

  /** 账号是否属于期望运行集（常驻/备胎）——供探测等「检测完是否保留实例」判定同源。 */
  isDesiredAccount(acc) {
    if (!acc) return false;
    return this.desiredRunningAccounts().some((d) => d.keyId === acc.keyId);
  }

  /** 封号：停掉实例（不再消耗资源），再更新状态机。 */
  markBanned(acc, error) {
    this._stopInstanceIfAny(acc);
    super.markBanned(acc, error);
  }
}

module.exports = { ProxyProvider };