'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const AGENT = require('./platform/agent').load();
// 平台知识唯一事实源（跨平台架构规范）：os/arch→标签映射只在 src/platform/matrix.js。
const matrix = require('./platform/matrix');
// 此处的 `node:child_process` 导入已删除（2026-09-12，P2 死代码清理）：
// 全文件对 `spawn`/`execFileSync` **零调用**（仅注释提及）——
// 它还是 G9 门禁的盲区：G9 只扫**调用**，不扫**导入**，故这一行得以长期存活。
// 子进程一律经统一执行器（platform/exec.js / platform/os/*）。
const pidlook = require('./platform/os/pidlookup');
const { DaemonLifecycle } = require('./guard/proc/daemon-lifecycle');
// 平台抽象层：进程/pid反查/文件路径/通知/浏览器（Android-only，见 platform/os/index.js）。
// 开机自启 / 系统服务 / 桌面通知 一律归 APK 容器与 HostBridge：
// capabilityProfile() 里 autostart=false、hostService='none'、desktopNotify=false。
// 「自启」这个能力本身已从内核删除（guard/host-service.js 与 platform/os/autostart.js 已删）。
const platform = require('./platform/os/index');
const { RouterService } = require('./domains/router/index');
const { TaskRegistry } = require('./platform/tasks');
const { PluginManager } = require('./domains/plugin/plugins');
const { DistributionManager } = require('./domains/dist/index');
const { normalize } = require('./platform/config');
// envCatalogSummary + EnvCatalog 已随「设置面」拆分至 guard/supervisor/settings-view.js（§7.6）
const { guardVersion } = require('./platform/version');
const { Lifecycle } = require('./guard/lifecycle/guard-self');
const { Health } = require('./guard/health');
const monitor = require('./guard/monitor/index');
const guardian = require('./guard/guardian/index');
const native = require('./guard/native/index');
const { DshTokenService } = require('./platform/token');
const { NativeManager } = require('./guard/native/manager');
const { LifecycleManager } = require('./guard/lifecycle/index');
const { ManagedRegistry } = require('./guard/lifecycle/objects');
const { IntentLedger } = require('./guard/intent');
const { registerAll } = require('./guard/lifecycle/adapters');
const ports = require('./guard/lifecycle/ports').shared;


/**
 * 核心状态机（controller 模式）：
 * 期望状态 desired(running|stopped) × 观测（进程存活 + HTTP 健康）→ 调和。
 * 状态：STOPPED / STARTING / RUNNING / RESTARTING / BACKOFF
 */
class Supervisor {
  constructor(rawConfig, configPath) {
    this.config = normalize(rawConfig);
    this.configPath = typeof configPath === 'string' ? configPath : null;
    // P1 跨平台审计修复：数据目录访问保护（目录级一次，覆盖全部新建/既有子文件）。
    // Unix ：chmod 0700（他人无法穿越目录 → 内部文件即使 0644 也不可达）。
    // Windows ：icacls 移除继承 (/inheritance:r) + 仅当前用户 (OI)(CI) ——
    // POSIX mode 在 Windows **被忽略**，而本目录含 config.json(lanToken)、
    // dsh-main-token.log(DSH 访问令牌)、registry.json、frpc.toml 等敏感文件。
    // NTFS 继承是动态的：对父目录设置继承 ACE 会同时作用于既有子项与后续新建子项，
    // 故**无需**对每个热写文件（state.json 每拍）做 icacls——那会造成显著写放大。
    this._fileProtectStatus = null;
    try {
      const fp = require('./platform/os/index').fileProtect;
      const swDir = path.dirname(this.config.stateFile);
      const targets = new Set([swDir]);
      try { targets.add(require('./platform/os/index').supervisorDir()); } catch {}
      const results = [];
      for (const d of targets) {
        const pr = fp.ensurePrivateDir(d);
        results.push({ dir: d, ...pr });
      }
      this._fileProtectStatus = results;
      const bad = results.filter((r) => !r.ok);
      if (bad.length) { try { console.warn('[supervisor] 数据目录保护未完全成功: ' + bad.map((b) => b.dir + '(' + b.mode + ':' + (b.reason || '') + ')').join('; ')); } catch {} }
    } catch (e) { try { console.warn('[supervisor] 数据目录保护异常: ' + (e && e.message)); } catch {} }
    this._mSetChild(null);
    this._mSetAdoptPid(null);     // 接管的既有实例 pid（非本守卫 spawn）
    this._mSetPhase('STOPPED');
    this._mSetDesired('running');
    this._mSetRestartCount(0);
    this._mSetCrashWindowStart(null);
    this._mSetCrashWindowRestarts(0);
    this._mSetBackoffLevel(0);
    this._mSetBackoffUntil(null);
    this._mSetRestartAt(null);      // RESTARTING 状态下最早可重启时刻
    this._mSetStartDeadline(null);  // STARTING 状态下启动门截止
    this._mSetFailStreak(0);
    this._mSetLastProbeAt(null);
    this._mSetLastProbeOk(null);
    this._mSetLastFailure(null);
    this._mSetLastRestartAt(null);
    this._mSetAdopted(false);       // 观测到健康但非本守卫 spawn（接管既有实例）
    this._mSetObservedOnly(false);  // 期望停止下的仅观测接管（不强杀不拉起）
    this._mSetSpawnBlockedUntil(null); // 命令缺失（ENOENT）后的冷静期
    this._mSetMissingNotified(false);
    this.manualRestart = false; // POST /restart 待消费
    this._ticking = false;
    // 显式意图登记簿（RC2）：用户/系统动作发生处 register，收敛循环 consume——
    // 取代旧 _explicitAction 时间窗布尔（漏消费竞态已根治）。词表见 guard/intent.js。
    this.intents = new IntentLedger();
    this._stopping = false;
    // ── 会话生命周期（契约（docs/ANDROID-PLAN.md） §3）：
    // starting → running → stopping → stopped；stopping/stopped 期间抑制一切自动拉起（INV-S1）。
    // 唯一入口 /session/stop；唯一读取口 /session/status（INV-S2/S4）。
    this._sessionState = 'starting';
    // 未守护崩溃停靠标记（阶段 2 意图单源，瞬态不持久）：guardian=false 时进程崩溃 → 置 true，
    // 使「desired=running 无条件拉起」不违背守护语义（崩溃不自救）；任何显式启动/重启/进入运行清除。
    // 不持久化 → 守卫重启后按 desired 恢复运行（desired 是持久用户意图，契约 §5）。
    this._crashHalted = false;
    this._upgradeHold = false;      // 升级"先停后装"期间暂停自动拉起
    this._upgradeHoldSince = null;  // 兜底自愈：hold 卡死超时自动释放
    this._timer = null;
    this._heartbeatBusy = false; // 唯一心跳慢拍防重叠（C3-3b G3：on 模式收敛并入心跳后必防并发）
    this._killTimer = null;
    this._adoptKillTimer = null;
    this._initialCheckTimer = null;
    this._upgradeTimer = null;
    this._lastOccupiedWarn = 0;
    // ── 瞬态字段统一构造初始化（RC2.2 契约）：任何实例字段的首次赋值必须发生在此处。
    // `_maybeReclaimAdoptToken` 曾因 `_tokenReclaimAt` 未初始化（undefined !== null）
    // 绕过观察窗，adopt 后首拍即重建 DSH（审计 P1-1）。──
    this._tokenReclaimAt = null;     // adopt 令牌观察窗截止时刻
    this._tokenReclaimTried = false; // 本次接管是否已受控重建（防循环）
    this._lastMainPortRederive = 0;  // 端口再推导节流
    this._lastOrphanAuditAt = 0;     // 游离对象自检节流
    this._lastOrphanKey = null;
    this._lastOrphanAt = 0;
    this._actWindow = false;         // 收敛窗口（影子记账）
    this._mainTickActs = null;
    this._portActivesCache = null;   // 端口激活探测缓存
    this._lastLanStateJson = null;   // lan-state 内容去重
    this._routerFacade = null;       // router ctl 门面缓存
    this._lc = null;                 // DaemonLifecycle 惰性单例表
    this._dshMainLive = null;        // dsh-main.json live 缓存
    this._fallbackEntry = null;      // 目录 fallback 项
    this._lastStateBody = null;
    // ── C3-3b G1：main(dsh) 影子对比框架（并行不驱动）──
    // 旧 tick 仍为唯一驱动；影子只「纯计算应然下一步」并对比实际迁移，零行为变化。
    // 连续零 diff 拍数/累计 diff 拍数供 G3 切换判定（日志/事件观测，不进任何决策）。
    this._shadowSeq = 0;
    this._shadowConsistentBeats = 0;
    this._shadowDiffBeats = 0;
    this._shadowLast = null;   // 最近一拍影子记录 {seq,phase,shadow,actual,diff}
    this._shadowLoggedSeq = 0; // 已记账的事件拍号（心跳聚合去重）
    // 系统日志框架（历史设计文档）：守卫经每进程唯一 LogCore 取
    // logger/events/dshWriter/EventHub（单例 init；消灭散落 new Events/createLogger/Rotator/EventHub）。
    const logCore = require('./platform/logcore').init({
      process: 'guard',
      logFile: this.config.supervisorLogFile,
      eventFile: this.config.logFile,
      dshLogFile: this.config.dshLogFile,
      upgradeLogFile: this.config.upgradeLogFile,
      logLevel: this.config.logLevel,
      logMaxBytes: this.config.logMaxBytes,
      eventsMaxBytes: this.config.eventsMaxBytes,
      enableHub: true,
      stateDir: path.dirname(this.config.stateFile),
      aggBase: path.basename(this.config.stateFile || 'state.json', '.json'),
      ctlPorts: { router: Number(this.config.routerCtlPort) || 43107 },
      daemonLogs: {
        router: path.join(path.dirname(this.config.stateFile), 'log', 'router-daemon.log'),
      },
    });
    this.events = logCore.events;
    this.logger = logCore.logger;
    this.dshWriter = logCore.dshWriter;
    // 守卫侧聚合读路径（契约 §3.6 统一读路径）：真实 hub 或 EventReader 降级适配器——**永不为 null**，
    // 消费方（api/lifecycle.js）无需再写 if(hub)…else… 双语义分支。
    this.eventHub = logCore.reader || logCore.hub;
    // ── 唯一令牌节点：全系统 DSH 访问令牌的统一获取/存储/分发（原生与沙箱共用同一服务，
    // 安卓内核只有一种源：spawn=stdout 推送 + 本地原文恢复文件）。任何目标的令牌变化统一
    // 经 onChange 下发消费方，不再分散接线。──
    this.tokenService = new DshTokenService({ logger: this.logger, events: this.events });
    // main 统一守卫 spawn（2026-09-06 废弃 systemd 托管）；纯 stdout 源 + 本地原文恢复文件
    // （0600；守卫重启后 token.js 从文件尾恢复令牌→免重建 main 的会话中断，2026-09 修复）
    this.tokenService.attach('main', { file: path.join(path.dirname(this.config.stateFile), 'dsh-main-token.log') });
    this.tokenService.onChange((id, token) => {
      // Android 内核无 relay/lan：令牌仅由内核内部（如生成直连认证 URL）直接消费，无远程代理需热换。
    });
    // OpenCode 中转：多账号 Key 轮换代理（原生实现，替代退役的 opencode-switcher）
    const swDir = path.dirname(this.config.stateFile);
    // 统一「包发布/安装/更新」领域逻辑：全局镜像源配置 + 版本检查 + 安装执行。
    // DSH 自升级与反代子应用共用同一实例，镜像源配置全局一份（registry.json）。
    this.dist = new DistributionManager({
      registries: (this.config.registries && this.config.registries.length) ? this.config.registries : ['https://registry.npmjs.org'],
      registryFile: path.join(swDir, 'registry.json'),
      events: this.events,
      logger: this.logger,
    });
    // 统一安装/更新任务注册表：收敛 native/instance/plugin/router 的全部
    // 安装·升级·卸载·更新操作到同一个有状态任务模型（持久化历史 + 统一 API）。
    this.tasks = new TaskRegistry({
      stateDir: swDir,
      logger: this.logger,
      events: this.events,
    });
    // 智能路由底座：中转服务整体生命周期 + 直连/反代供应商 + 账号状态管理 + 统一切换
    this.router = new RouterService({
      config: this.config,
      providerFile: path.join(swDir, 'providers.json'),
      usageTotalsFile: path.join(swDir, 'router-usage-totals.json'),
      logger: this.logger,
      events: this.events,
      dist: this.dist,
      tasks: this.tasks,
    });
    // 端口注册表持久化与守卫状态同域（默认 ~/.dsh/supervisor/ports.json；自定义 stateFile 时跟随），
    // 测试可经自定义 stateFile 天然隔离，绝不污染生产记录。
    try { ports.configureFile(path.join(path.dirname(this.config.stateFile), 'ports.json')); } catch (e) { this.logger.warn && this.logger.warn('ports configure: ' + e.message); }
    // 端口池规模可配置（工业标准：范围是配置项而非编译期常量）：config.portPools 覆盖默认池。
    try { if (this.config.portPools) ports.configurePools(this.config.portPools); } catch (e) { this.logger.warn && this.logger.warn('ports pools configure: ' + (e && e.message)); }
    // Android 内核：无沙箱实例域（已删除）；main 记录不再寄存在 instances.json，迁移逻辑见 _migrateMainRecord（no-op）。
    // ── 控制平面 v3 R1：管家注册机（声明目录）──
    // 记录「管家直接负责」的受管对象(应然+所有权)；本阶段为影子(不驱动任何循环)，随 add/remove 实时申报。
    try {
      // 目录持久化文件按守卫状态文件派生（C3-3b G4 修测试隔离）：
      // 生产默认 stateFile=state.json → <dir>/managed-objects.json（与部署/文档一致）；
      // 测试用自定义 stateFile(如 state-3900.json) → <dir>/state-3900.managed-objects.json——
      // 同一 TMP 目录多守卫（smoke/upgrade 链）不再互相污染 desired/phase（G4 起目录为权威存储）。
      this.managedObjects = new ManagedRegistry({
        file: path.join(path.dirname(this.config.stateFile), this._registryFileName()),
        logger: this.logger,
        events: this.events,
        ports: ports,
      });
      this._syncManagedRegistry();
      // daemon 监督 adapter（v3 R3 C3-2）：heartbeat 驱动；节流 6 拍≈30s（原 L3 监督 tick 语义）
      if (this.managedObjects && typeof this.managedObjects.registerAdapter === 'function') {
        this.managedObjects.registerAdapter('router-daemon', { supervise: () => this._daemonSuperviseOnce('router'), tickEvery: 6, derivePhase: true });
        // main(dsh) adapter（C3-3a observe → C3-3b G1 supervise）：heartbeat 把 main 实然写入目录
        // (lastObserved)——不驱动（G3 前 tick 仍是唯一驱动）。supervise 内做影子对比（纯计算+日志），
        // 实然与 tick 同源(monitor.probe → lastProbeOk)。影子连续零 diff 后由 G3 切换接管。
        this.managedObjects.registerAdapter('dsh', { supervise: () => this._dshSuperviseOnce(), tickEvery: 1 });
      }
    } catch (e) { this.logger && this.logger.warn && this.logger.warn('managed registry init: ' + (e && e.message)); }
    // Android 内核：无远程控制（relay/frpc）与沙箱实例 —— 删除 PC 端 lan/instance 桥接回调。
    this.pluginMarket = new (require('./domains/plugin/pluginmarket').PluginMarket)({
      stateFile: this.config.stateFile,
      logger: this.logger,
    });
    this.pluginManager = new PluginManager({
      dshBin: 'dsh',
      // dsh CLI 调用形态与主干启动命令同源（安卓容器 = node 代跑绝对入口）。
      // 惰性取用：nativeManager 在本对象之后构造，调用发生在插件操作时。
      resolveDshCli: () => (this.nativeManager ? this.nativeManager.dshCliInvocation() : null),
      profileName: this.config.pluginsProfileName || AGENT.profileName,
      profileDir: path.join(os.homedir(), AGENT.homeDirName, 'profiles', this.config.pluginsProfileName || AGENT.profileName),
      overlayFile: path.join(path.dirname(this.config.stateFile), 'plugin-states.patch.yml'),
      dshPort: this.config.targetPort,
      tasks: this.tasks,
      logger: this.logger,
      events: this.events,
      dist: this.dist, // 插件安装/卸载与 DSH 自升级共用全局镜像源
      // 原生 DSH 运行态探针：插件层据其判断「插件变更要不要触发重启」（不自行探测进程）
      dshRunning: () => !!this.dshPid,
      // 插件变更（卸载/启停）涉及原生目标时：统一走守卫生命周期重启（等价于面板重启按钮）
      onNativeRestart: () => {
        try { return this.requestRestart(); }
        catch (e) { this.logger.warn && this.logger.warn('plugin change → native restart: ' + e.message); return { ok: false, error: e.message }; }
      },
    });
    // 版本管理：单一版本源（package.json），交给 infra/version
    this.guardVersion = guardVersion();
    // 守卫自身生命周期 + 健康 + 遥测（infra：与实例生命周期完全分离）
    this.lifecycle = new Lifecycle();
    // 统一生命周期管理器（2026-09 归一化架构）：全部模块生命周期的唯一注册表与统一启停入口。
    // 守卫持监测权——start/stop/状态统一经此；模块各自独立生命周期，守卫重启不停被管模块。
    this.lifecycleManager = new LifecycleManager({ logger: this.logger, events: this.events });
    this.health = new Health(this.lifecycle);
    this.api = null;
    this.notifyEnabled = this.config.notifyEnabled !== false;
    this.loadState();
    // 原生 DSH 生命周期管理器：安装/卸载/版本检测/升级（原生 DSH 的唯一管理门面，单通道）
    this.nativeManager = new NativeManager({
      config: this.config,
      dist: this.dist,
      events: this.events,
      logger: this.logger,
      stateDir: path.dirname(this.config.stateFile),
      tasks: this.tasks,
      // 启动命令写回落盘（安卓容器）：装完 dsh 后 config.command 转绝对形态并持久化。
      persistCommand: (patch) => this.persistConfigPatch(patch),
      // 守卫生命周期钩子：升级需停/起 DSH 时回调
      hooks: {
        isDshActive: () => ['STARTING', 'RUNNING', 'RESTARTING', 'BACKOFF'].includes(this._mPhase()),
        desiredRunning: () => this._mDesired() === 'running',
        stopForUpgrade: () => this._enterUpgradeHoldAsync(),
        resumeAfterUpgrade: () => this._exitUpgradeHold(true),
        verifyDeadlineMs: () => Math.max(2 * this.config.startTimeoutMs, 120000),
        notify: (t, b) => this.notify(t, b),
      },
    });
    // 概念清分（2026-09-06）：原生 DSH 是主干，软件本体由 NativeManager 独立管理（/native/* + /lifecycle/dsh/*）；
    // 沙箱实例由 InstanceManager 管理（/instances/*）。原生不挂进沙箱实例出口——不注入任何句柄/委托。
    // （EventHub 汇聚已由 LogCore.init 统一装配）；
    // this.eventHub = logCore.hub，聚合文件按 stateFile 派生唯一。）
    // 系统级端口登记：固定端口统一注册，冲突启动即 fail-fast，杜绝各子系统各管各的端口
    this._registerFixedPorts();
  }

  /** 固定端口统一登记：主DSH / 守卫API / 中转服务。冲突即抛错（守卫启动失败，避免带病运行）。
   * 主程序端口动态注册：用户使用场景各异（可能先装 DSH 并自定义端口）——
   * 若配置端口无监听且检测到 DSH 进程，从进程实际参数解析端口并动态覆盖（绝不硬编码 3080）。 */
  _registerFixedPorts() {
    // 端口来源以配置为准（healthUrl / command --port，normalize 已统一）。
    // 注意：不做 pgrep 启发式猜端口——同一 bin 的其它实例/残留进程会劫持监管目标
    // （实测：残留 mock 的 "--port 3901" 让守卫从 3911 被导到 3901，接管错误对象）。
    ports.register('dsh-main', this.config.targetPort);
    ports.register('supervisor-api', this.config.apiPort);
  }

  // Android 内核：无远程控制（relay/frpc），移除 PC 端 lan 惰性访问器（get/set lan）。

  // ---- 启动 / 关闭 ----
  start() {
    this.events.append('guard_started', {
      pid: process.pid,
      version: this.guardVersion,
      healthUrl: this.config.healthUrl,
      api: this.config.apiHost + ':' + this.config.apiPort,
    });
    // 守卫自身生命周期：已启动
    this.lifecycle.markStarted();
    const { createServer } = require('./api/index');
    // 端口自动避让（2026-09-07）：apiPort 为高位段默认(36360)但用户本机可能已占用
    // （3100 常用端口冲突问题的根治——不硬编码常用口）。目标端口被占则顺延 +1 探测
    // 空闲端口（最多 +50），选定后若与配置不同则持久化 config.json，重启沿用。
    const self = this;
    const maxSkew = 50;
    const attempt = (port, skew) => {
      const server = createServer(this);
      server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE' && skew < maxSkew) {
          // 端口占用：顺延下一个
          const next = this.config.apiPort + skew + 1;
          this.events.append('api_port_skew', { from: this.config.apiPort, to: next, reason: err.message });
          this.logger.warn('api port ' + port + ' occupied, trying ' + next + ': ' + err.message);
          return attempt(next, skew + 1);
        }
        this.events.append('api_error', { message: err ? err.message : String(err) });
        this.logger.error('api error: ' + (err ? err.message : String(err)));
      });
      server.listen(port, this.config.apiHost, () => {
        this.api = server;
        const prev = this.config.apiPort;
        // 实际端口 ≠ 配置端口 → 持久化（重启沿用选定端口）
        if (port !== prev) {
          // 释放旧端口的登记：否则 ports.json 会同时留旧/新两条 supervisor-api，
          // 而 discovered_api_port() 取首条 → 壳可能永远等「已废弃的旧端口」→ 判定未就绪。
          try { ports.release(prev, 'system:supervisor-api'); } catch {}
          this.config.apiPort = port;
          if (this.configPath) this.persistConfigPatch({ apiPort: port });
        }
        // **登记实际绑定端口**（docs/ANDROID-PLAN.md（端口登记））：
        // 壳的唯一就绪判据 =「ports.json 的 supervisor-api 实际值」；绝不能让配置期望值滞留在登记表。
        try { ports.register('supervisor-api', port); } catch (e) { this.logger.warn('ports.register(actual) 失败: ' + e.message); }
        this.events.append('api_listening', { host: this.config.apiHost, port });
        this.logger.info('api listening on ' + this.config.apiHost + ':' + port);
      });
      return server;
    };
    this.api = attempt(this.config.apiPort, 0);
    this.logger.info('guard started v' + this.guardVersion + ' pid=' + process.pid);
    // 统一生命周期管理器注册（归一化架构）：把全部模块注册为 ManagedLifecycle。
    // 注册后：前端启停/状态统一走 /lifecycle/*（见 api.js），不再直调模块对象。
    try {
      registerAll(this.lifecycleManager, {
        router: this.router,
        supervisor: this, pluginManager: this.pluginManager, logger: this.logger,
      });
      if (this.logger && this.logger.info) this.logger.info('[lifecycle] 已注册模块: ' + this.lifecycleManager.all().map((l) => l.id).join(','));
      this._syncDshLifecycleView(); // 注册后立即同步 DSH 视图（不等首个 tick）
    } catch (e) { this.logger.warn && this.logger.warn('[lifecycle] 注册失败: ' + (e && e.message)); }
    this.tick(); // 首拍立即收敛
    // main(dsh) 收敛驱动源（C3-3b G3 接管 → C3-5 终态）：唯一心跳（registry heartbeat →
    // dsh supervise → _dshConverge）是唯一周期驱动——tick 定时器不再创建；
    // 仅 registry 不可用（极罕见）时保留 tick 定时器兜底（保证 main 不被放养）。
    this._timer = this.managedObjects ? null : setInterval(() => this.tick(), this.config.probeIntervalMs);
    // 唯一心跳（v3 R3 C3-2/C3-3b G3）：daemon 监督(router-daemon, 节流≈30s) +
    // main 收敛(on 模式) 都收进 ManagedRegistry.heartbeat。
    // _heartbeatBusy 防慢拍重叠（probe 超时/长 I/O 时心跳不并发，防 daemon 双监督/main 双收敛）。
    // P1 修复（2026-09-13）：_heartbeatBusy 必须有**兜底释放**，否则一次卡死 = 心跳永停。
    //
    // 缺陷：`if (this._heartbeatBusy) return;` 是**丢拍**语义（注释只写「防慢拍重叠」，
    // 未声明丢拍）。更严重的是 _heartbeatBusy 只在 .finally 里释放 ——
    // 若 heartbeat 返回的 promise 永不 settle（且 ManagedRegistry.heartbeat 内的
    // 逐对象超时也覆盖不到的那类：例如 heartbeat 本身在进入循环前就卡住），
    // .finally 永不执行 → **_heartbeatBusy 永久 true → 心跳永停**。
    // 为什么致命：managedObjects 存在时**不创建 tick 定时器**（见上），故心跳是
    // main 收敛/沙箱监督/daemon 监督的**唯一**周期驱动。停摆后
    // main 即使 desired=running 也永不 spawn/adopt、沙箱挂了永不退避重试、
    // router/lan daemon 失联永不被拉起，而 /status 仍显示最后一次写入的 phase
    // —— 用户看到「面板开着、服务全死、无任何事件」。
    // 修法：① 保留丢拍语义（并发重入仍不可能），但用**独立兜底定时器**在
    // 一个「远大于任何正常拍」的阈值后强制释放 busy（并记 warn），使心跳必定恢复；
    // ② 暴露 _lastHeartbeatAt / _heartbeatStalls，使「心跳停摆」可观测而非隐形。
    this._lastHeartbeatAt = Date.now();
    this._heartbeatStalls = 0;
    // 拍宽必须在 setInterval **之前**求值：它同时用作间隔与超时阈值。
    // （我第一版把它写在回调内部，却在 `}, iv)` 处引用 → ReferenceError，
    // 心跳定时器根本没建起来 → smoke S1 永不进入 RUNNING。已改正。）
    const heartbeatIv = this.config.probeIntervalMs || 5000;
    this._heartbeatTimer = setInterval(() => {
      if (this._heartbeatBusy) return;
      this._heartbeatBusy = true;
      const iv = heartbeatIv;
      this._lastHeartbeatAt = Date.now();
      // 兜底释放（阈值 = 拍宽 × 12：远大于任何正常拍，又保证必定恢复）。
      // unref：不拖住进程退出。
      const stallMs = Math.max(30000, iv * 12);
      const guard = setTimeout(() => {
        if (this._heartbeatBusy) {
          this._heartbeatBusy = false;
          this._heartbeatStalls++;
          if (this.logger && this.logger.warn) {
            this.logger.warn('[heartbeat] 单拍超过 ' + stallMs + 'ms 未结算，强制释放防停摆（第 ' + this._heartbeatStalls + ' 次）');
          }
        }
      }, stallMs);
      if (guard && typeof guard.unref === 'function') guard.unref();
      Promise.resolve(this.managedObjects ? this.managedObjects.heartbeat(iv) : null)
        .catch(() => {})
        .finally(() => { clearTimeout(guard); this._heartbeatBusy = false; });
    }, heartbeatIv);
    // Android 内核：无远程控制（relay/frpc）与沙箱实例监督；lan-daemon / 实例代理逻辑已移除。
    if (this.config.routerAutostart === true) {
      // 统一生命周期视图同步：router 期望运行 → 注册项纳入监测
      const rlc = this.lifecycleManager ? this.lifecycleManager.get('router') : null;
      if (rlc) { rlc.wantRunning(); rlc._monitoring = true; rlc._setPhase && rlc._setPhase('starting'); }
      // L3 进程解耦：独立 router-daemon 优先——daemon 在跑则监督它（不再内嵌启动双占 43011）；
      // daemon 未跑则拉起独立 daemon（detached，守卫重启不影响）；daemon 不可用（脚本缺失）退回内嵌。
      // 接管既有 daemon（守护重启/手动拉起）→ 先落管理锁（本守卫目录），监督/启停权归属本守卫。
      if (this._routerDaemonActive()) this._writeRouterDaemonLock();
      const rt = this._ensureRouterRuntime(true);
      if (rt.mode === 'daemon') {
        // 状态文件写权归 daemon（防双写覆盖：守卫只读，providers.json 由 daemon 独占持久化）
        // 2026-09-12：改用 `_disableRouterPersist()` —— 该纪律已在 `_ensureRouterRuntime`
        // 内部对**全部三条** daemon 路径统一处置（此前只有本处执行 → 另两条路径会双写）。
        // 本行保留为幂等兜底（明确表达「进入 daemon 即关写权」的意图）。
        this._disableRouterPersist();
        if (rt.spawned) {
          // 刚拉起：等待 daemon 就绪（短轮询 43011）
          setTimeout(() => {
            const up = pidlook.findListeningPid(this._routerCtlPort());
            if (rlc) { if (up) { rlc._setPhase('running'); rlc.startedAt = rlc.startedAt || new Date().toISOString(); } else { rlc._setPhase('starting'); } /* healthy 由 _supervise mirror 观测置位 */ }
          }, 3000);
        } else if (rt.active) {
          // daemon 已在跑：监督模式
          if (rlc) { rlc._setPhase('running'); rlc.startedAt = rlc.startedAt || new Date().toISOString(); } /* healthy 由 _supervise mirror 观测置位 */
        }
        return; // 已由独立 daemon 承担，不执行下方内嵌启动
      }
      // daemon 不可用 → 内嵌 router（回退路径，保持原行为）
      this.router.start().then((r) => {
        if (rlc) { if (r && r.ok !== false) { rlc._setPhase('running'); rlc.startedAt = rlc.startedAt || new Date().toISOString(); } else { rlc._setPhase('stopped'); rlc.error = (r && r.error) || 'start 失败'; } /* healthy 由 _supervise mirror 观测置位 */ }
        if (r && r.ok === false) this.logger.warn('中转服务启动失败：' + (r.error || '未知错误'));
      });
    } else {
      const rlc = this.lifecycleManager ? this.lifecycleManager.get('router') : null;
      if (rlc) { rlc.desired = 'stopped'; rlc._monitoring = false; }
    }
    if (this.config.updateCheckEnabled !== false) {
      this._initialCheckTimer = setTimeout(() => {
        this.nativeManager.checkUpdate();
      }, this.config.initialCheckDelayMs || 20000);
      this._upgradeTimer = setInterval(() => {
        this.nativeManager.checkUpdate();
      }, this.config.updateCheckIntervalMs || 3600000);
    }
  }

  /** 优雅停机（**异步**）。
   *
   * 2026-09-12（P1）：改为返回 Promise —— 此前是同步函数，但内部调用
   * `lifecycleManager.stopAll(...)`（**async**）而**不 await**：
   * 而 `stopAll` 依次 `await lc.stop()` 停 router/lan（含反代实例、relay、frpc、端口释放）。
   *
   * 调用方（bin 的 SIGTERM/SIGINT 处理、settings-view 的退出）都在 `shutdown()` 之后
   * **立即 `process.exit(0)`** —— 于是那些 stop 只跑了同步前缀就被**截断**：
   * router/lan 的子进程与端口残留成孤儿（正是该段注释声称要防的事）。
   *
   * 现语义：返回 Promise；调用方必须 `await`（或 `.then(()=>exit())`）后再退出。
   * 重复调用返回**同一个** Promise（幂等；`_stopping` 守卫语义保留）。
   */
  shutdown() {
    if (this._stopping) return this._shutdownPromise || Promise.resolve();
    this._stopping = true;
    this.lifecycle.beginShutdown();
    this.events.append('guard_exit', {});
    this.logger.info('guard shutting down');
    this.writeState(true);
    if (this._timer) clearInterval(this._timer);
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    if (this._killTimer) clearTimeout(this._killTimer);
    if (this._adoptKillTimer) clearTimeout(this._adoptKillTimer);
    if (this._initialCheckTimer) clearTimeout(this._initialCheckTimer);
    if (this._upgradeTimer) clearInterval(this._upgradeTimer);
    if (this.api) {
      try {
        this.api.close();
      } catch {}
    }
    // ── 统一生命周期停止（2026-09 归一化架构）──
    // 过渡态：进程解耦（L3）完成前，router/lan 仍驻守卫进程——shutdown 必须停它们防孤儿
    // （反代实例进程、relay/frpc、41000+ 端口残留）。解耦后此段改为「只停观测，不停进程」：
    // 守卫重启不应影响任何被管模块（它们独立生命周期，由各自 supervisor / daemon 维持）。
    // 统一经 lifecycleManager 出口（而非直调模块对象），保证启停路径收敛到一处。
    // 2026-09-12（P1）：`stopAll` 是 async —— 必须 **await**，否则调用方 exit 会截断它。
    // 返回的 Promise 存到 `_shutdownPromise`，使重复调用拿到同一个（幂等）。
    this._shutdownPromise = (async () => {
      try {
        if (this.lifecycleManager) {
          // L3 解耦：router 若为独立 daemon（detached）→ 守卫退出不停它（daemon 独立生命周期继续服务）；
          // 仅内嵌 router/lan（仍驻守卫进程的）需停防孤儿。实现：先把 daemon 型 router 项从 stopAll 豁免。
          try {
            const rlc = this.lifecycleManager.get('router');
            if (rlc && this._routerDaemonActive()) {
              rlc._monitoring = false; // 守卫退出不再监督该 daemon（daemon 自身继续运行）
            }
          } catch {}
          await this.lifecycleManager.stopAll('guard-shutdown', { exclude: ['dsh'] }); // 守卫退出绝不动 DSH（RC2 契约）
        } else {
          // 兜底（lifecycleManager 未初始化时保持原行为防孤儿）
          try { if (this.router) await this.router.stop(); } catch (e) { this.logger.warn && this.logger.warn('router stop: ' + (e && e.message)); }
        }
      } catch (e) { this.logger.warn && this.logger.warn('lifecycle stopAll: ' + (e && e.message)); }
      // 守护语义：守卫退出不动 DSH，恢复后幂等调和
    })();
    return this._shutdownPromise;
  }

  // ---- 状态持久化 ----
  statusSummary() {
    // 原生 DSH 端口自检测：端口是「实际运行态」属性，而非静态配置值——
    // 仅当目标在线（有 pid）时返回其实际监听端口，未启动/离线返回 null（前端显示横杠）。
    const dshPidNow = this._mChild() ? this._mChild().pid : this._mAdoptPid();
    return {
      desired: this._mDesired(),
      phase: this._mPhase(),
      // 会话生命周期（契约 §3，INV-S4）：与 phase 正交——phase 是 main 状态机相位，
      // sessionState 是整个服务链的运行相位（前端/壳据此表达「退出中/已退出」）。
      sessionState: this._sessionState,
      // 数据目录/敏感文件保护状态（chmod 0600/0700；安卓容器 uid 隔离外的兜底）。
      dataDirProtected: Array.isArray(this._fileProtectStatus)
        ? (this._fileProtectStatus.length > 0 && this._fileProtectStatus.every((r) => r.ok))
        : null,
      guardVersion: this.guardVersion,
      // 原生 DSH 主干视图（端口/命令/守护开关/运行态）：面板「进程守护」开关的唯一数据源
      // （实例域删除后无 /instances 端点，main 元数据经本字段随快照下发）。
      main: this.dshMainView ? this.dshMainView() : null,
      dshPid: dshPidNow,
      dshPort: dshPidNow ? (this.config.targetPort || null) : null,
      adopted: this._mAdopted(),
      guardPid: process.pid,
      lastProbeAt: this._mLastProbeAt(),
      lastProbeOk: this._mLastProbeOk(),
      restartCount: this._mRestartCount(),
      crashWindowStart: this._mCrashWindowStart(),
      crashWindowRestarts: this._mCrashWindowRestarts(),
      backoffLevel: this._mBackoffLevel(),
      backoffUntil: this._mBackoffUntil(),
      lastFailure: this._mLastFailure(),
      lastRestartAt: this._mLastRestartAt(),
      upgradeHold: this._upgradeHold,
      commandMissing: !!(this._mSpawnBlockedUntil() && Date.now() < this._mSpawnBlockedUntil()),
      dshTokenCaptured: !!(this.tokenService && this.tokenService.get('main')),
      tasks: this.tasks ? this.tasks.running().map((t) => ({ id: t.id, kind: t.kind, action: t.action, target: t.target, state: t.state })) : [],
      native: this.nativeManager ? this.nativeManager.status() : null,
      version: this.nativeManager ? this.nativeManager.versionInfo() : null,
      upgrade: this.nativeManager ? this.nativeManager.upgradeBrief() : null,
      updatedAt: new Date().toISOString(),
    };
  }

  writeState(force) {
    try {
      const snap = this.statusSummary();
      const updatedAt = snap.updatedAt;
      snap.updatedAt = null;
      const body = JSON.stringify(snap, null, 2);
      if (!force && body === this._lastStateBody) return; // 内容未变不写盘
      this._lastStateBody = body;
      snap.updatedAt = updatedAt;
      const dir = path.dirname(this.config.stateFile);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = this.config.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.config.stateFile);
    } catch (e) {
      this.logger.error('state write failed: ' + e.message);
    }
  }

  loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.config.stateFile, 'utf8'));
      // 阶段 2 状态单源（契约 §6）：desired 的权威是受管目录（managed-objects.json），state.json 是投影。
      // 仅当目录文件**不存在**（老库首次迁移）时，才用 state.json 的 desired 作种子——避免投影反向覆盖权威（B1）。
      if (raw.desired === 'stopped' || raw.desired === 'running') {
        // 目录「从既有磁盘加载」= 已有权威源 → state.json 不回灌；否则用 state.json 作一次性迁移种子。
        const registryHasSource = !!(this.managedObjects && this.managedObjects._loadedFromDisk);
        if (!registryHasSource) this._mSetDesired(raw.desired);
      }
      if (typeof raw.restartCount === 'number') this._mSetRestartCount(raw.restartCount);
      if (typeof raw.backoffLevel === 'number') this._mSetBackoffLevel(raw.backoffLevel);
      // 崩溃窗口跨守卫重启保持（否则"DSH 反复崩 + 守卫被拉起"会重置退避保护）
      if (typeof raw.crashWindowStart === 'number' || raw.crashWindowStart === null) {
        this._mSetCrashWindowStart(raw.crashWindowStart);
      }
      if (typeof raw.crashWindowRestarts === 'number') this._mSetCrashWindowRestarts(raw.crashWindowRestarts);
      if (typeof raw.lastFailure === 'string' || raw.lastFailure === null) this._mSetLastFailure(raw.lastFailure);
      if (typeof raw.lastRestartAt === 'string' || raw.lastRestartAt === null) this._mSetLastRestartAt(raw.lastRestartAt);
      // 升级 hold 跨守卫重启保持：防止"安装途中守卫被拉起 → 用半新半旧的文件 spawn"
      if (raw.upgradeHold === true) {
        this._upgradeHold = true;
        if (!this._upgradeHoldSince) this._upgradeHoldSince = Date.now();
      }
    } catch {}
    // C3-3b G4：boot 相位不继承（进程句柄不持久化——守卫重启后无 child/adoptedPid）。
    // 若目录恢复 running/starting 等，首拍会误判"已在运行"而永不 adopt/调和；复位 STOPPED
    // 让首拍按真实探测收敛（port up → adopt；down → spawn），与 legacy「启动相位=STOPPED」一致。
    try { this._mSetPhase('STOPPED'); } catch {}
  }

  // ---- 外部控制（API / CLI）----
  setDesired(v) {
    if (v !== 'running' && v !== 'stopped') return { error: 'invalid desired' };
    // 显式「启动」是用户意图，不受「进程守护(自动拉起)」开关短路限制：
    // 守护开关只约束「崩溃后自动拉起」，绝不约束用户主动点启动。
    if (v === 'running') { this.intents.register('start'); this._crashHalted = false; } // 显式意图（RC2）：清除未守护崩溃停靠
    if (v === 'running' && this._mPhase() === 'OBSERVED') {
      // 从观测模式转正：同一实例无缝纳管
      this._mSetObservedOnly(false);
      this._mSetPhase('STOPPED'); // 交给 switch 立即重新调和（healthOk → 正式接管）
    }
    if (v === 'stopped' && this._mPhase() === 'OBSERVED' && this._mObservedOnly()) {
      // 显式停止观测中的实例：已有 pid，可安全终止
      this.stopProcess('desired_stopped');
    }
    if (this._mDesired() !== v) {
      this._mSetDesired(v);
      this.events.append('desired_changed', { desired: v });
      // 启动/停止 DSH 与「进程守护开关」完全独立：desired 只改运行状态，不改守护(自动拉起)开关。
      // 守护开关仅由用户显式操作 /instances/update {guardian} 改变；watchdog 在 desired==='stopped' 时绝不拉起。
      this.writeState();
    }
    this.tick();
    return { ok: true, desired: this._mDesired() };
  }

  requestRestart() {
    if (this._mDesired() === 'stopped') {
      this.events.append('manual_restart_requested', { ignored: 'desired=stopped' });
      return { ok: false, error: 'desired=stopped，请先 /start' };
    }
    this.manualRestart = true;
    this._crashHalted = false; // 显式重启：清除未守护崩溃停靠
    this.intents.register('restart'); // /restart 也是显式操作：守护开关不挡（RC2）
    this.events.append('manual_restart_requested', {});
    this.tick();
    return { ok: true };
  }

  /** 把补丁合并写回守卫自己的配置文件（原子写；仅限本产品配置，绝不触碰 DSH）。 */
  persistConfigPatch(patch) {
    if (!this.configPath) return;
    try {
      let cur = {};
      try {
        cur = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      } catch {}
      Object.assign(cur, patch);
      delete cur.switcherAutoStart; // 旧键随持久化收敛删除（迁移完成态）
      const tmp = this.configPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cur, null, 2), { mode: 0o600 }); // config 含 lanToken → 0600（工业级敏感文件权限）
      fs.renameSync(tmp, this.configPath);
    } catch (e) {
      this.logger.warn('config persist failed: ' + e.message);
    }
  }

  // ---- 智能路由门面：presets/providers/proxyApps 经 sup 接口取数（消除 api 的 constructor hack）----
  // L3 监督模式（2026-09）：router-daemon 在跑时，providers/proxyApps 一律经 ctl 转发到 daemon
  // （唯一事实源，读即最新）；daemon 未跑回退守卫本地实例（内嵌模式）。返回可能是 Promise（远程），
  // 调用方统一 Promise.resolve()。
  // ── 本节已拆分 → guard/supervisor/control-view.js（§7.6 结构性重构）──

  // ---- 开机自启：已随 PC 桌面壳与系统服务管理器整体删除 ----
  // 安卓内核没有 systemd/launchd/schtasks，常驻与否由 APK 容器 / Android Service 决定，
  // 内核不提供 /autostart 开关（guard/host-service.js 与 platform/os/{autostart,service}.js 已删）。


  // ---- 退出管家（2026-09 用户定稿）：完全关闭 = 停全部服务链 + 守卫自身退出 ----------------
  /** 停掉被监管的 DSH 主实例（spawn/adopt 目标），并将期望状态持久化为 stopped——
   * 「退出管家」= 用户显式要求全部停止：若只杀进程不翻 desired，容器/Android Service
   * 拉起守卫后收敛循环会按 desired=running 重新拉起 DSH，与服务链全停意图相悖。 */
  _stopMainDsh() {
    try {
      // 退出会话 ≠ 改变用户运行意图（契约 §6：desired 仅在用户显式启停时改变）。
      // 「停后不再拉起」由 sessionState=stopping 抑制（INV-S1）；不再靠翻 desired——
      // 旧架构翻 desired 是为防 systemd Restart=always 重拉 DSH，安卓内核无服务管理器，该理由已消失。
      // 保留 desired=running 使「下次启动容器」可恢复运行（契约 §5 启动时序）。
      if (this._mChild() || this._mAdoptPid()) { this.stopProcess('session_stop'); }
    } catch (e) { this.logger.warn && this.logger.warn('shutdownAll stop main: ' + e.message); }
  }

  // Android 内核：沙箱实例域已删除，无需停止沙箱实例。

  /** 会话态（契约 §3）：starting|running|stopping|stopped|failed。唯一读取口 /session/status。 */
  sessionState() { return this._sessionState; }

  /** 会话态迁移（内部）。starting→running 由首拍收敛完成触发。 */
  _setSessionState(s) {
    if (this._sessionState === s) return;
    const prev = this._sessionState;
    this._sessionState = s;
    if (this.events) { try { this.events.append('session_state', { from: prev, to: s }); } catch {} }
  }

  /** 会话是否处于「退出中/已退出」——此期间一切自动拉起必须抑制（INV-S1）。 */
  _sessionHalting() { return this._sessionState === 'stopping' || this._sessionState === 'stopped'; }

  /** 契约 §6 判定规则（阶段 2 意图单源）：
   * 是否应运行 = (desired == running) && sessionState ∈ {starting, running, failed}
   * desired 是唯一「是否运行」权威；guardian 不参与本判定（只管崩溃重启）。 */
  _shouldRun() {
    if (this._mDesired() !== 'running') return false;
    if (this._sessionHalting()) return false;
    if (this._crashHalted) return false; // guardian=false 崩溃后停靠：等显式启动（不违背守护语义）
    return true;
  }

  /** 退出内核（契约 §4.1 冻结时序）：停全部被管对象 → 置 stopped → 回执。
   * **守卫绝不自己 stop 自己**：进程的所有者是外部（APK 容器 / Android Service），
   * 守卫只回执「被管对象已全部停止」，由容器侧停止守卫进程（docs/ANDROID-PLAN.md §6）。
   * 返回 { ok, sessionState } 供容器做退出握手。 */
  async shutdownAll() {
    // 幂等：已进入退出流程 → 直接回执当前态（壳可安全重试/轮询）
    if (this._sessionHalting()) return { ok: true, already: true, sessionState: this._sessionState };
    this._setSessionState('stopping'); // 抑制一切自动拉起（INV-S1）
    this.logger.info('[session] 退出流程开始：停止全部被管对象…');
    this.events && this.events.append('shutdown_all', {});
    // 1) 停 DSH 主实例（本守卫是被管对象的所有者，契约 §2）
    this._stopMainDsh();
    // 2) 停路由 daemon（独立进程；DaemonLifecycle.stop 串行换代语义）
    // 2026-09-12（P2-2 配套）：`stop()` 现在**会如实返回 ok:false**（进程未在超时内退出时）。
    // 此前该返回值被直接丢弃 → 孤儿 daemon 会被静默放过（与「已全部停止」的回执矛盾）。
    // 现：失败即记事件 + warn，让面板/日志可见（仍继续后续步骤，不阻断关停流程）。
    const stopDaemon = async (kind) => {
      try {
        const lc = this._daemonLifecycle(kind);
        if (!lc) return;
        const r = await lc.stop();
        if (r && r.ok === false) {
          this.logger.warn && this.logger.warn('shutdownAll stop ' + kind + ' 未完成: ' + (r.error || '未知'));
          this.events && this.events.append('shutdown_daemon_stop_incomplete', { kind, pid: r.stopped || null, error: r.error || null });
        }
      } catch (e) { this.logger.warn && this.logger.warn('shutdownAll stop ' + kind + ': ' + e.message); }
    };
    await stopDaemon('router');
    // 3) 会话置 stopped 并回执——**守卫不停止自己**：进程所有者是 APK 容器 / Android Service，
    // 容器收到本回执后停止守卫进程（守卫随之收到 SIGTERM 自然退出）。
    this._setSessionState('stopped');
    this.writeState(true);
    this.events && this.events.append('session_stopped', {});
    this.logger.info('[session] 被管对象已全部停止；等待容器停止守卫进程');
    return { ok: true, sessionState: 'stopped' };
  }

  /** 平滑重绑 API host：旧 server close + 强制断连释放端口，新 server 重试 listen。
   * 关键：旧 keep-alive 连接未断时端口不会释放，直接 listen 会 EADDRINUSE 把 API 打死。
   * 这里 closeAllConnections() 立即断开空闲连接，并带重试（最多 10 次 × 300ms）。 */
  _rebindApiHost() {
    const { createServer } = require('./api/index');
    const old = this.api;
    if (old) {
      try { old.close(); } catch {}
      try { if (typeof old.closeAllConnections === 'function') old.closeAllConnections(); } catch {}
    }
    const bind = () => {
      const server = createServer(this);
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          // 端口仍被旧连接占用：短暂等待后重试；10 次后降级为 30s 慢重试（持续自愈，绝不永久下线）
          const tries = bind._tries || 0;
          if (tries < 10) {
            bind._tries = tries + 1;
            setTimeout(bind, 300);
          } else {
            bind._tries = 0;
            setTimeout(bind, 30000);
            this.events.append('api_error', { message: 'API 重绑端口持续被占用，30s 后自动重试: ' + err.message });
            this.logger.error('api rebind degraded (30s slow retry): ' + err.message);
          }
          return;
        }
        this.events.append('api_error', { message: err.message });
        this.logger.error('api error: ' + err.message);
      });
      server.listen(this.config.apiPort, this.config.apiHost, () => {
        bind._tries = 0;
        this.api = server;
        // 重绑成功后同样登记**实际端口**（与 start() 的 listen 一致；D3）。
        try { ports.register('supervisor-api', this.config.apiPort); } catch {}
        this.events.append('api_listening', { host: this.config.apiHost, port: this.config.apiPort });
        this.logger.info('api listening on ' + this.config.apiHost + ':' + this.config.apiPort);
      });
    };
    bind._tries = 0;
    this.api = null;
    bind();
  }

  /** 通知（平台层最佳努力）：关键事件即使面板没开也能触达用户。
   * 安卓内核 desktopNotify:false：平台层不提供系统通知实现（无 notify-send / osascript），
   * 通知归容器层经 HostBridge 下发；此处调用会因平台无实现而静默停用。 */
  notify(title, body) {
    if (!this.notifyEnabled) return;
    platform.notify(title, body, () => {
      this.notifyEnabled = false;
      this.logger.warn('系统通知不可用（安卓内核无平台实现，归容器层），已停用');
    });
  }

  // ---- 升级流程挂钩（先停后装，消除运行中替换文件的混合版本窗口）----
  _enterUpgradeHold() {
    this._upgradeHold = true;
    this._upgradeHoldSince = Date.now();
    const targetAlive =
      (this._mChild() && this._mChild().exitCode === null && this._mChild().signalCode === null) ||
      (this._mAdoptPid() !== null && pidlook.isAlive(this._mAdoptPid()));
    if (targetAlive) {
      this.stopProcess('upgrade'); // 落实“先停后装”：停掉当前运行的 main 进程再安装
    } else if (this._mPhase() !== 'STOPPED') {
      this._mSetPhase('STOPPED');
      this.writeState();
    }
  }

  /** 升级前停目标并【等待其真正退出】（先停后装的完整语义，消除混合版本窗口）。
   * - spawn 模式：stopProcess 只发 SIGTERM 即返回（SIGKILL 兜底在 stopGraceMs 后）——
   * 若不等 exit 就开始 npm install，旧进程存活期间文件被替换。这里等待 child.exit / pid 消亡，
   * 超时上限 = stopGraceMs + 5s 兜底（届时 SIGKILL 兜底定时器已触发）。
   * - 安卓内核只有 spawn/adopt 两种形态：stopProcess 均为「发信号 + 等退出」。 */
  async _enterUpgradeHoldAsync() {
    // 先捕获目标引用：_enterUpgradeHold 内部 stopProcess 会清空 child/adoptedPid，
    // 必须在调用前保存，否则无法等待旧进程退出。
    const refs = { child: this._mChild(), adoptedPid: this._mAdoptPid() };
    this._enterUpgradeHold();
    // 等待目标进程退出（有句柄的 child 或仅有 pid 的接管实例）
    if (refs.child && refs.child.exitCode === null && refs.child.signalCode === null) {
      await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        refs.child.once('exit', done);
        setTimeout(done, this.config.stopGraceMs + 5000);
      });
      return;
    }
    if (refs.adoptedPid && pidlook.isAlive(refs.adoptedPid)) {
      await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        // stopProcess 的 _killAdopted 同样有 SIGKILL 兜底定时器
        const check = () => {
          if (!pidlook.isAlive(refs.adoptedPid)) return done();
          if (Date.now() > start + this.config.stopGraceMs + 5000) return done();
          setTimeout(check, 200);
        };
        const start = Date.now();
        check();
      });
      return;
    }
  }

  _exitUpgradeHold(explicit) {
    this._upgradeHold = false;
    this._upgradeHoldSince = null;
    // 升级完成后恢复运行 = 用户显式意图（点升级即意图）：登记后由收敛循环消费——
    // 守护开关（guardian 默认关）不再拦截升级恢复（审计 P1-3：升级后 DSH 不自动拉起）。
    if (explicit) this.intents.register('upgrade-resume');
    this.tick();
  }

  // ══ C3-3b G1：main(dsh) 影子对比框架（先建，纯新增；并行不驱动）══
  // 定位（C3-3b G1 影子框架）：旧 tick 仍是唯一驱动，
  // 本框架只按现有 tick 语义「纯计算应然下一步」并把实际迁移记入事件——绝不执行。
  // heartbeat dsh adapter 由 observe 升级为 supervise（G3 复用同一 supervise 驱动点）；
  // supervise 调 _shadowCompute() 产出 action 与旧 tick 实际 phase 迁移对比（diff 时 warn，
  // 连续 5 拍零 diff 才允许 G3 切换）。影子与 actual 对比在 tick 同步域内完成
  // （t0 快照→拍末对比），消除「双定时器异步竞态」的假 diff；心跳拍只做聚合记账/日志。

  /** dsh adapter 监督单拍（C3-3b G1 observe → supervise 接管；C3-5 终态：唯一心跳驱动 main）。
   * 每拍先调 _dshConverge()（=原 tick 收敛段；端口再推导/hold/manualRestart/adopt令牌/假死
   * 业务钩子全在收敛段内）驱动 main，再做实例聚合视图刷新与影子记账（自洽校验日志）。
   * 返回实然观测（ok 与探测同源），heartbeat 统一写入目录 lastObserved。 */
  // ── 本节已拆分 → guard/supervisor/supervise-view.js（§7.6 结构性重构）──


  // ── 本节已拆分 → guard/supervisor/registry-view.js（§7.6 结构性重构）──


  /** 状态存储解析（唯一读写口基座）：目录 main 项，缺省回退构造期 fallback。 */
  _mStore() {
    return this._dshEntry() || this._mainFallbackEntry();
  }

  /** 通用 entry 字段读写（变化才写）。phase/desired 走专属口（registry 事件/持久化）。
   * B2 归一（2026-09）：对随目录持久化的崩溃/退避字段，写后同步 registry._save —— 使目录成为唯一事实源，
   * state.json 降为纯投影（不再双副本）。事务开销小（仅该子集，非每拍全量）。 */
  _mField(name, v) {
    const e = this._mStore();
    if (arguments.length >= 2) {
      if (e[name] !== v) {
        e[name] = v;
        this._persistCrashField();
      }
      return e;
    }
    return e[name];
  }

  /** entry.process 字段读写（进程句柄/运行期瞬态；首建播种默认值，不持久化）。 */
  _mProcField(name, v) {
    const e = this._mStore();
    let p = e.process;
    if (!p) {
      p = e.process = {
        child: null, adoptedPid: null, adopted: false, observedOnly: false,
        startDeadline: null, restartAt: null, spawnBlockedUntil: null, missingNotified: false,
        failStreak: 0, lastProbeAt: null, lastProbeOk: null, lastProbeHttpOk: null,
        lastFailure: null, lastRestartAt: null,
      };
    }
    if (arguments.length >= 2) { if (p[name] !== v) p[name] = v; return p; }
    return p[name];
  }

  // ── 唯一 phase 词表（R3 C3-5 命名统一；目录 canonical 全表见 guard/lifecycle/objects.js PHASES）──
  // 守卫 legacy（大写，语义保留给 statusSummary 门面）→ 目录 canonical（小写）映射：
  // STOPPED→stopped / STARTING→starting / RUNNING→running / RESTARTING→restarting /
  // BACKOFF→backoff / OBSERVED→stopped(+process.observedOnly+adopted 位合成呈现)。
  // 沙箱域(instance state)映射在 _syncSandboxRegistryEntry：INSTALLING→installing / FAILED→failed。
  /** 守卫 legacy 大写 phase → 目录唯一词表（小写）。OBSERVED 由 process.observedOnly 表达，phase=stopped。 */
  _legacyToEntryPhase(ph) {
    return { STOPPED: 'stopped', STARTING: 'starting', RUNNING: 'running', RESTARTING: 'restarting', BACKOFF: 'backoff', OBSERVED: 'stopped' }[ph] || 'stopped';
  }

  /** 目录小写 phase → 守卫 legacy 大写。 */
  _entryToLegacyPhase(ph) {
    return { stopped: 'STOPPED', starting: 'STARTING', running: 'RUNNING', restarting: 'RESTARTING', backoff: 'BACKOFF' }[ph] || 'STOPPED';
  }

  /** 读守卫视角 phase（大写；OBSERVED 按 observedOnly+adopted 合成）。守卫内唯一 phase 读口。 */
  _mPhase() {
    const e = this._mStore();
    const p = e.process || null;
    const upper = this._entryToLegacyPhase(e.phase || 'stopped');
    if (upper === 'STOPPED' && p && p.observedOnly && p.adopted) return 'OBSERVED';
    return upper;
  }

  /** 写守卫视角 phase（大写→目录 canonical 经 registry.setPhase：事件/持久化/迁移由 registry 负责）。 */
  _mSetPhase(upper) {
    const e = this._mStore();
    const ph = this._legacyToEntryPhase(upper);
    const reg = this.managedObjects;
    try {
      if (reg && typeof reg.setPhase === 'function' && this._dshEntry() === e) {
        if (e.phase !== ph) reg.setPhase('main', ph);
      } else if (e.phase !== ph) {
        e.phase = ph;
      }
    } catch (e2) { this.logger && this.logger.warn && this.logger.warn('_mSetPhase: ' + ((e2 && e2.message) || e2)); }
    return this;
  }

  /** 读守护开关（dsh-main.json meta.guardian；守卫内唯一 guardian 读口——与 _managedMainSpec 申报同源）。
   * true=运行中崩溃自动接管拉起；false=崩溃后保持停止（等用户手动启动）。 */
  _mGuardian() {
    try { return this._readDshMain().guardian === true; } catch { return false; }
  }

  /** 公开门面：main 守护开关（供 adapters/lifecycle 读取，A 平面同源）。 */
  mainGuardian() { return this._mGuardian(); }

  /** 读 desired（running|stopped）。守卫内唯一 desired 读口。 */
  _mDesired() {
    return this._mStore().desired === 'stopped' ? 'stopped' : 'running';
  }

  /** 写 desired（registry.update 持久化；state.json 经 writeState 同源）。 */
  _mSetDesired(v) {
    const want = v === 'stopped' ? 'stopped' : 'running';
    const e = this._mStore();
    const reg = this.managedObjects;
    try {
      if (reg && typeof reg.update === 'function' && this._dshEntry() === e) {
        if (e.desired !== want) reg.update('main', { desired: want });
      } else if (e.desired !== want) {
        e.desired = want;
      }
    } catch (e2) { this.logger && this.logger.warn && this.logger.warn('_mSetDesired: ' + ((e2 && e2.message) || e2)); }
    return this;
  }


  // ---- C3-3b G4 兼容访问器（外部/测试经统一读写口；守卫内部一律 _m*，不出现 this.<字段>uff09----
  // 例：adopt-token-reclaim-test / precheck-test / api 直接置读 phase/desired/child 等——经此落到 entry。
  get phase() { return this._mPhase(); }
  set phase(v) { this._mSetPhase(v); }
  get desired() { return this._mDesired(); }
  set desired(v) { this._mSetDesired(v); }
  get child() { return this._mProcField('child'); }
  set child(c) { this._mProcField('child', c); }
  get adoptedPid() { return this._mProcField('adoptedPid'); }
  set adoptedPid(v) { this._mProcField('adoptedPid', v); }
  get adopted() { return this._mProcField('adopted') === true; }
  set adopted(v) { this._mProcField('adopted', v === true); }
  get observedOnly() { return this._mProcField('observedOnly') === true; }
  set observedOnly(v) { this._mProcField('observedOnly', v === true); }
  get restartCount() { const v = this._mField('restartCount'); return typeof v === 'number' ? v : 0; }
  set restartCount(v) { this._mField('restartCount', v); }
  get spawnBlockedUntil() { const v = this._mProcField('spawnBlockedUntil'); return v === undefined ? null : v; }
  set spawnBlockedUntil(v) { this._mProcField('spawnBlockedUntil', v); }
  get missingNotified() { return this._mProcField('missingNotified') === true; }
  set missingNotified(v) { this._mProcField('missingNotified', v === true); }

  /** 概念清分迁移（2026-09-06）：instances.json 若仍含历史 main 记录 → 元数据迁入 dsh-main.json 并剔除。 */
  _migrateMainRecord() {
    // Android 内核：沙箱实例域已删除；main 记录不再寄存在 instances.json，无需迁移。
  }


  /** 组装 DSH 启动命令（原生专属，交给 guard/native）。 */
  // ── 本节已拆分 → guard/supervisor/main-process.js（§7.6 结构性重构）──

}

// §7.6 拆分：supervise-view（原型 mixin 注入；行为与拆分前逐字一致）
Object.defineProperties(Supervisor.prototype, require('./guard/supervisor/supervise-view'));

// §7.6 拆分：converge-view（原型 mixin 注入；行为与拆分前逐字一致）
Object.defineProperties(Supervisor.prototype, require('./guard/supervisor/converge-view'));

// §7.6 拆分：settings-view（原型 mixin 注入；行为与拆分前逐字一致）
Object.defineProperties(Supervisor.prototype, require('./guard/supervisor/settings-view'));

// §7.6 拆分：control-view（原型 mixin 注入；行为与拆分前逐字一致）
Object.defineProperties(Supervisor.prototype, require('./guard/supervisor/control-view'));

// §7.6 拆分：main-process（原型 mixin 注入；行为与拆分前逐字一致）
Object.defineProperties(Supervisor.prototype, require('./guard/supervisor/main-process'));

// §7.6 拆分：registry-view（原型 mixin 注入；行为与拆分前逐字一致）
Object.defineProperties(Supervisor.prototype, require('./guard/supervisor/registry-view'));

// ══ C3-3b G4：每字段 _mX()/_mSetX() 读写 helper 生成（entry/process 唯一存储口）══
// 配合 codemod 产生的调用点：守卫内 this.<字段> 全部转换为 this._mXxx()/this._mSetXxx()。
(function installMainFieldHelpers(proto) {
  const ENTRY = [
    // [读写 helper 后缀, entry 字段]
    ['CrashWindowStart', 'crashWindowStart'],
    ['CrashWindowRestarts', 'crashWindowRestarts'],
    ['BackoffLevel', 'backoffLevel'],
    ['BackoffUntil', 'backoffUntil'],
    ['RestartCount', 'restartCount'],
  ];
  const PROC = [
    // [读写 helper 后缀, process 字段, 是否布尔]
    ['Child', 'child', false],
    ['AdoptPid', 'adoptedPid', false],
    ['Adopted', 'adopted', true],
    ['ObservedOnly', 'observedOnly', true],
    ['FailStreak', 'failStreak', false],
    ['RestartAt', 'restartAt', false],
    ['StartDeadline', 'startDeadline', false],
    ['SpawnBlockedUntil', 'spawnBlockedUntil', false],
    ['MissingNotified', 'missingNotified', true],
    ['LastProbeAt', 'lastProbeAt', false],
    ['LastProbeOk', 'lastProbeOk', false],
    ['LastProbeHttpOk', 'lastProbeHttpOk', false],
    ['LastFailure', 'lastFailure', false],
    ['LastRestartAt', 'lastRestartAt', false],
  ];
  for (const [suf, field] of ENTRY) {
    proto['_m' + suf] = function () { return this._mField(field); };
    proto['_mSet' + suf] = function (v) { this._mField(field, v); return this; };
  }
  for (const [suf, field, isBool] of PROC) {
    proto['_m' + suf] = function () { return this._mProcField(field); };
    proto['_mSet' + suf] = function (v) { this._mProcField(field, isBool ? v === true : v); return this; };
  }
  // 兼容访问器（phase/desired 已在类体内定义）
})(Supervisor.prototype);

module.exports = { Supervisor, normalize };
