'use strict';

// §7.6 拆分自 supervisor.js：settings-view（原型 mixin）。
// 仅经 this 协作；导出「原型属性描述符」由 supervisor.js 注入 Supervisor.prototype。
// 行为与拆分前逐字一致（含 getter/setter；class 体方法无需逗号）。
// 依赖由拆分脚本按块内实际使用自动携带（遗漏会导致运行期 ReferenceError）。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { execFile } = require('node:child_process');
const ex = require('../../platform/exec');
const netInfo = require('../../platform/os/netinfo');
const { EnvCatalog } = require('../../platform/env-catalog');
const { guardVersion } = require('../../platform/version'); // 拆分携带：守卫版本自报

// 环境目录摘要（随设置块迁移；原为 supervisor.js 模块级函数，仅本块使用）。
// 原 `extra.selfUpdate`（内核 npm 子包 corePackageName 条目）已删：
// 安卓内核不经 npm 分发，更新 = 容器 OTA，内核没有"自己查自己新版本"这回事。
function envCatalogSummary(that) {
  const cat = new EnvCatalog(that.config);
  const extra = {};
  const d = that.dshenvStatus();
  extra.dsh = cat.dshEntry(d.binOk, d.installed, d.bin);
  return cat.summary(extra);
}

class SettingsView {
  // autostartStatus / setAutostart 已随 PC 桌面壳删除（原委托 guard/host-service.js →
  // platform/os/autostart.js）。安卓内核的常驻由 APK 容器 / Android Service 决定，
  // 内核不再提供「整条服务链开机自启」开关，对应 /autostart API 也已下架。

  // ---- 环境状态（Phase1 壳写 runtime.json；EnvCatalog 声明式探测）----
  envStatus() {
    const rt = {};
    try { const f = path.join(path.dirname(this.config.stateFile), 'runtime.json'); if (fs.existsSync(f)) Object.assign(rt, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch {}
    const cat = new EnvCatalog(this.config).probe();
    const en = this.nativeManager && typeof this.nativeManager.checkEnvironment === 'function' ? this.nativeManager.checkEnvironment() : null;
    return {
      node: { detected: cat.node.detail || null, runtime: rt.nodeVersion || null, path: rt.nodePath || null },
      npm: { detected: cat.npm.detail || null },
      git: { detected: cat.git.detail || null },
      installedAt: rt.installedAt || null,
      source: rt.source || null,
      ok: cat.node.state === 'ok' && cat.npm.state === 'ok',
      npmRoot: en ? en.npmRoot : null,
      // EnvCatalog 声明式视图（面板环境卡演进用）
      catalog: (envCatalogSummary(this)),
      // 平台能力矩阵（A1 断点修复）：安卓静态档位（Android-only，无工具探测）。
      // 前端据此做能力感知呈现与降级提示——
      // 此前注释已承诺该字段，但实现未暴露，导致 UI 只能在后端报错后才知道。
      capabilities: (() => { try { return require('../../platform/os/index').capabilities(); } catch { return null; } })(),
      // Android 内核：桌面壳（Tauri）已删除；`shellWatchdog` 观测快照随之移除——
      // 现由 APK 容器 / Android Service 保活，内核侧不再持有桌面壳看护状态（见 docs/ANDROID-PLAN.md）。
    };
  }

  /** Node LTS 在线检查（6h 缓存 + 失败降级）：探测当前 node 运行版本并给出 LTS 建议。
   * 实现不做远端查询（避免守卫启动依赖网络）——本地判定 + 可刷新缓存；
   * 失败返回 { ok:false, error } 由前端降级展示，绝不抛异常。 */
  async nodeLtsStatus() {
    try {
      const cacheFile = path.join(path.dirname(this.config.stateFile), 'node-lts-cache.json');
      const now = Date.now();
      let cache = null;
      try { if (fs.existsSync(cacheFile)) cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
      if (cache && now - (cache.fetchedAt || 0) < 6 * 3600 * 1000) {
        return { ok: true, ...cache, cached: true };
      }
      const ver = process.versions.node || '';
      const major = parseInt(String(ver).split('.')[0], 10) || 0;
      // LTS 建议：Node 偶数主版本为 LTS 线（保守本地判定，不作远端断言）
      const ltsLine = major % 2 === 0;
      const data = {
        current: ver,
        major,
        ltsLine,
        suggested: '当前 ' + ver + (ltsLine ? '（偶数主版本线，通常为 LTS）' : '（奇数主版本非 LTS 线，建议偶数主版本）'),
        fetchedAt: now,
      };
      try { fs.writeFileSync(cacheFile, JSON.stringify(data)); } catch {}
      return { ok: true, ...data, cached: false };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---- 内核更新（单写入者契约：安装/重启归安卓容器 OTA）----
  //
  // `guardSelfUpdateApply` / `guardSelfUpdateRestart` / `guardSelfUpdateStatus` **已删除**，
  // `/self-update/*` 端点（含 410 下架桩）也**已删除** —— 安卓内核不经 npm 分发，
  // 更新由容器 OTA 完成（单写入者 = 安卓容器），内核不持有任何自更新实现或端点。
  // 随同删除：`platform/deploy.js`（SEA/launcher/源码三形态判定）、
  // `corePackageName` 配置与 env-catalog 的 selfUpdate 条目。

  /** 读磁盘上**运行位**的自报版本（A1 校验用）：spawn `--version`，解析 "dsh-supervisor v<ver>"。
   *
   * 用途：容器 OTA 写入新内核后、守卫尚未重启时，面板可显示「新版本已就位，待重启生效」
   * （diskVersion ≠ 进程运行版本 ⇒ updatePending）。
   */
  _readBinarySelfVersion() {
    let target = null;
    try {
      const a1 = process.argv[1];
      if (a1) target = require('node:fs').realpathSync(require('node:path').resolve(a1));
    } catch {}
    if (!target) return null;
    try {
      const out = ex.runOut(target, ['--version'], { timeoutMs: 20000 });
      // 2026-09-11 修复（K9）：原为 /dsh-supervisor v([^s]+)/ —— 字符类 [^s] 的意图
      // 是「非空白」，却写成了「非字母 s」：版本串里一旦出现 s 就截断，
      // 且 \n 不在排除集内，正则会跨行吞字符。结果污染自更新状态判定。
      const m = /dsh-supervisor v([^\s]+)/.exec(out);
      return m ? m[1] : null;
    } catch { return null; }
  }

  // ---- DSH 即安即用：本体安装状态判定（命令指向的 bin 可执行 + 已管实例版本）----
  dshenvStatus() {
    let bin = null, binOk = false, installed = null, cmdOk = false;
    try {
      const cmd0 = Array.isArray(this.config.command) ? this.config.command : [];
      cmdOk = cmd0.length > 0;
      bin = (cmd0[0] === 'node' && cmd0[1]) ? cmd0[1] : (cmd0[0] || null);
      if (bin) binOk = fs.existsSync(bin);
    } catch {}
    try { if (this.nativeManager && typeof this.nativeManager.installedVersion === 'function') installed = this.nativeManager.installedVersion(); } catch {}
    // main = 守卫核心服务(概念清分)：受管状态以 config.command 有效为准（不再依赖沙箱实例登记）
    return { installed, bin: bin || null, binOk, managed: cmdOk, phase: this._mPhase() || null };
  }

  // ---- 管家自身版本检查（与 DSH 更新解耦）：本地仓库 git 视角，配了远程才 fetch 比对 ----
  /** VCS 根解析：从**包根**上溯找最近的「外层」.git（排除自身嵌套仓）。
   *
   * 修复（2026-09）：原实现命中 dsh-supervisor/.git 嵌套仓，其 HEAD 与真实外层仓脱节
   * （嵌套仓 06:29 早于外层 07:15 提交）→ UI 版本/commit 失真。
   * 找不到外层仓时回退包根（行为与历史一致，commit 解析失败仍为 null）。
   *
   * 二次修复（2026-09-11）：包根解析原为 `path.resolve(__dirname, '..')` 并注释
   * 「= dsh-supervisor/」，但 §7.6 拆分把本文件从 `src/` 移到 `src/guard/supervisor/`，
   * 该表达式实际得到 `src/guard/` —— **注释与行为已不符**，
   * 使「排除嵌套 .git」的判据作用在错误目录（真正的包根 .git 不再被排除）。
   * 改用 srcpath.resolvePackageRoot()（按 package.json 上溯，不受层级调整影响）。 */
  _vcsRoot() {
    const dir = require('../../platform/srcpath').resolvePackageRoot() || path.resolve(__dirname, '..');
    const innerGit = path.join(dir, '.git');
    let parent = path.dirname(dir);
    while (parent !== path.dirname(parent)) {
      const cand = path.join(parent, '.git');
      if (cand !== innerGit && fs.existsSync(cand)) return parent; // 最近的外层仓
      parent = path.dirname(parent);
    }
    return dir; // 无外层仓：回退自身（嵌套仓/部署态）
  }

  /** 本地视角（无网络 I/O，同步安全）：commit + 是否配了 upstream。 */
  guardVersionLocal() {
    const root = this._vcsRoot();
    let commit = null;
    commit = (ex.runOut('git', ['-C', root, 'rev-parse', '--short', 'HEAD']) || '').trim() || null;
    let upstream = 'local';
    try {
      const up = (ex.runOut('git', ['-C', root, 'rev-parse', '--abbrev-ref', '@{u}']) || '').trim();
      if (up) upstream = 'git-repo';
    } catch {}
    // version = 进程运行版本（启动时固化，打包态为编译期常量）——语义明确标注（A3）。
    // 磁盘实况版本（runningVersion vs diskVersion 的 updatePending 判定）在 async guardVersionCheck。
    return { version: this.guardVersion, runningVersion: this.guardVersion, commit, updateAvailable: false, upstream, latest: this.guardVersion };
  }

  /**
   * 完整版本检查（async）：本地 commit + 远端 fetch 比对。
   * 关键架构约束：git fetch 是网络 I/O，绝不能同步执行（会冻结整个事件循环，守卫假死且无法自愈）。
   * 这里用 execFile（异步）+ 10s 超时；fetch 失败/超时只降级为「本地视图」，不抛错。
   */
  async guardVersionCheck() {
    const base = this.guardVersionLocal();
    if (base.upstream !== 'git-repo') return base;
    const root = this._vcsRoot();
    const fetchOk = await new Promise((resolve) => {
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      try {
        const child = execFile('git', ['-C', root, 'fetch', '--quiet'], { timeout: 10000 }, (err) => done(!err));
        child.on('error', () => done(false));
      } catch { done(false); }
    });
    if (!fetchOk) return base; // fetch 失败：保持本地视图，不误报
    let updateAvailable = false;
    try {
      // git 可能因网络盘/凭证助手挂起 → 必须有界（原为裸 execFileSync，无 timeout）。
      const ahead = (ex.runOut('git', ['-C', root, 'rev-list', '--count', 'HEAD..@{u}']) || '').trim();
      updateAvailable = parseInt(ahead, 10) > 0;
    } catch {}
    // A3：磁盘运行位实况版本 vs 进程运行版本——不一致 = 「容器 OTA 已装新内核、待重启生效」
    const diskVersion = this._readBinarySelfVersion();
    const updatePending = !!(diskVersion && diskVersion !== this.guardVersion);
    return { ...base, diskVersion, updatePending };
  }

  // ---- 管家面板局域网访问开关（0.0.0.0 <-> 127.0.0.1）----
  lanPanelStatus() {
    const enabled = this.config.apiHost === '0.0.0.0';
    const port = this.config.apiPort;
    // 真实可访问地址（2026-09 用户指正）：只给局域网内设备真正能访问的地址——
    // 取「走默认路由的真实出口网卡」的 IPv4，过滤虚拟网桥(virbr*/veth*/docker*/br-*)。
    const ips = [];
    if (enabled) {
      // 平台化（2026-09-11 修 K8）：原实现**直接**调用 `ip` (iproute2) ——
      // 这是 Linux 专有命令；在 macOS/Windows 上抛异常后被 catch 吞掉，
      // 于是 ips 恒为空 → 面板显示「开关已开但没有任何可访问地址」，
      // 且**不报错**（静默降级）。同时它也是裸 execFileSync（无超时）。
      // 现下沉到 platform/os/netinfo（三平台实现 + 经 platform/exec 有界）。
      ips.push(...netInfo.lanAddresses());
      if (!ips.length) {
        this.logger && this.logger.warn && this.logger.warn(
          "lan ips: 未枚举到可用局域网地址（platform=" + netInfo.PLATFORM +
          ", supported=" + netInfo.supported + "）"
        );
      }
    } else {
      ips.push("127.0.0.1");
    }
    // 去重保持稳定顺序
    const unique = [...new Set(ips)];
    return { enabled, host: this.config.apiHost, port, urls: unique.map((ip) => 'http://' + ip + ':' + port) };
  }

  /** 开=面板绑定 0.0.0.0（局域网可访问，经 apiHost 白名单限制为局域网/本机）；关=仅绑定 127.0.0.1（本机可访问）。 */
  setLanPanel(enabled) {
    try {
      const host = enabled ? '0.0.0.0' : '127.0.0.1';
      const changed = this.config.apiHost !== host;
      this.config.apiHost = host;
      if (this.configPath) {
        try {
          const doc = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
          doc.apiHost = host;
          const ctmp = this.configPath + '.tmp';
          fs.writeFileSync(ctmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
          fs.renameSync(ctmp, this.configPath); // 原子 + 0600
        } catch (e) { this.logger.error('persist apiHost: ' + e.message); }
      }
      if (changed && this.api && typeof this.api.close === 'function') this._rebindApiHost();
      if (this.events) this.events.append('lan_panel_changed', { enabled });
      if (this.logger && this.logger.info) this.logger.info('管家面板局域网访问 -> ' + (enabled ? '开(0.0.0.0)' : '关(127.0.0.1)'));
      return { ok: true, ...this.lanPanelStatus() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---- 出回环访问密钥（F2 定案）：状态查询 + 设置/清除（api.js 路由引用此门面；
  // 2026-09 修复：此前 api.js:493 调 sup.accessKeyStatus() 但 Supervisor 从未实现该门面 →
  // 设置页每次 GET 抛 uncaughtException → 守卫 60s 3 次异常自杀重启 → 设置页长时间无响应。）----
  /** 状态（不回显明文）：configured + host。 */
  accessKeyStatus() {
    const cfg = this.config || {};
    return { configured: !!cfg.apiAccessKey, host: cfg.apiHost || undefined };
  }

  /** 设置/清除出回环访问密钥（空串=清除）。原子持久化到守卫 config。 */
  setAccessKey(key) {
    try {
      const cfg = this.config || {};
      const k = typeof key === 'string' ? key.trim() : '';
      if (k && k.length < 8) return { ok: false, error: '访问密钥至少 8 位（建议 16+ 位随机串）' };
      cfg.apiAccessKey = k || null;
      if (this.configPath) this.persistConfigPatch({ apiAccessKey: k || null });
      if (this.events) this.events.append('access_key_changed', { configured: !!k });
      return { ok: true, configured: !!k };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

}

const _desc = Object.getOwnPropertyDescriptors(SettingsView.prototype);
delete _desc.constructor; // 不覆盖 Supervisor.prototype.constructor

module.exports = _desc;
