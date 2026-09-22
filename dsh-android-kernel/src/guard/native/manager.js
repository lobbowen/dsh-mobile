'use strict';

// 原生 DeepSeek Harness（原生 DSH）生命周期管理器 —— 原生 DSH 的唯一管理门面。
// 职责（完整生命周期，单通道）：安装状态探测 / 版本检测 / 安装 / 升级（先停后装、验证、回滚）/ 卸载。
// 状态机（安装态）：uninstalled → installing → installed → uninstalling → uninstalled；
// 升级态（upgradeState，正交于安装态）：idle → restarting → verifying → done | failed（失败含 rolling_back → failed）。
//   注：2026-09 审计修正——原注释写 upgrading，代码实际用 restarting（manager.js upgradeState 赋值处）。
// 关键：安装/升级/回滚共用同一安装执行核心（_runInstall），无重复逻辑；
//       版本检测/升级统一走 domain/dist（全局镜像源），无第二通道；
//       安装时记录安装清单(manifest)，卸载时按清单全量清理，不留残留。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const ex = require('../../platform/exec');
// npm 的统一解析入口（经 platform/os/exec-path）。
//   ⚠ 经**模块对象**调用而非解构：解构是值绑定，无法被测试替换 ——
//     曾因此让行为测试意外执行了真实 npm（见构造函数 `_npmBin` 的说明）。
const execPath = require('../../platform/os/exec-path');
const runtimeContract = require('../../platform/runtime-contract');
// npm 的**唯一 spawn 调用形态**：恒返回 `{bin, args}`，调用方拼
// `inv.args.concat(自己的参数)` 后再 spawn。
//   · 测试注入（构造期 opts.npmBin，或赋值 _npmBinArgs）优先 —— 结构上保证
//     不触碰真实 npm；假 npm 的做法是 bin=process.execPath + args=[要跑的 .js]，
//     因为 POSIX #!/bin/sh 脚本在非 POSIX 环境无法执行。
//   · 生产经契约统一解析：安卓 = node 代跑 npm-cli.js（W^X 下 bin/ 里的 npm
//     shim 脚本不可 execve），无契约退回 ambient 'npm'（PC 形态，不变量 C2）。
function npmSpawn(self) {
  if (self && self._npmBin) {
    return { bin: self._npmBin, args: Array.isArray(self._npmBinArgs) ? self._npmBinArgs.slice() : [] };
  }
  return runtimeContract.npmInvocation(execPath.npmBin());
}
const { semverCompare, VERSION_RE } = require('../../domains/dist/index');

class NativeManager {
  constructor(opts) {
    this.config = opts.config;
    this.dist = opts.dist || null;          // 统一分发：镜像源适配 + 版本获取
    this.events = opts.events || null;
    this.logger = opts.logger || console;
    this.stateDir = opts.stateDir;          // ~/.dsh/supervisor
    this.manifestFile = path.join(this.stateDir, 'native-manifest.json');
    this.dshHome = path.join(os.homedir(), '.dsh'); // DSH 数据目录（守卫数据在 ~/.dsh/supervisor，分开）
    this.npmRoot = opts.npmRoot || null;    // npm 全局根（测试可注入隔离目录）
    // npm 可执行的解析入口（**依赖注入**，默认经跨平台解析）。
    //   ⚠ 为什么必须可注入（2026-09-12 事故）：
    //     我写 P1-F 行为测试时用「patch 模块导出」的方式替换 npmBin，
    //     但 `const { npmBin } = require(...)` 是**值绑定**，patch 无效 ——
    //     于是测试里那次「伪造的卸载挂起」实际执行了**真实 npm**。
    //     该次恰好是 no-op（目标 prefix 无此包），但这是**侥幸**：
    //     若目标 prefix 真装了包，测试就会删掉用户环境。
    //     故：把 npm 可执行做成构造期可注入依赖，测试才能在**结构上**
    //     保证不触碰真实 npm（而不是依赖环境巧合）。
    this._npmBin = opts.npmBin || null;
    this.hooks = opts.hooks || {};          // 守卫生命周期钩子（supervisor 注入）：升级需停/起 DSH 时回调
    this.tasks = opts.tasks || null;        // 统一安装/更新任务注册表（持久化历史 + 统一 API）
    // 启动命令写回的持久化回调（supervisor 注入 persistConfigPatch）：
    // 装完 dsh 后 config.command 必须落盘，否则守卫重启回到模板形态 → 永远拉不起。
    this.persistCommand = opts.persistCommand || null;
    // 升级状态机字段（idle | installing | restarting | verifying | rolling_back | done | failed）
    this.upgradeState = 'idle';
    this.oldVersion = null;
    this.targetVersion = null;
    this.upgradeStartedAt = null;
    this.upgradeFinishedAt = null;
    this.upgradeError = null;
    this.rolledBack = false;
    this.upgradeLog = [];
    this.checkingNow = false;
    this.lastCheck = null; // { at, installed, latest, updateAvailable, error? }
    this.installing = null;   // 安装进行中标记
    this.uninstalling = null; // 卸载进行中标记
    // 安装/卸载任务可观测状态（前端进度轮询的数据源）：
    this.installLog = [];     // 安装输出（有界尾部）
    this.lastInstall = null;  // { ok, version, error, at, log }
    this.lastUninstall = null;// { ok, removed, error, at }
  }

  /** 追加安装输出（有界，仅任务进行中由 _runInstall 写入）。 */
  _appendInstallLog(line) {
    this.installLog.push(line);
    if (this.installLog.length > 60) this.installLog.splice(0, this.installLog.length - 60);
  }

  /* ═══════ 安装状态探测 ═══════ */
  binPath() {
    const bin = this.config.command && this.config.command[1];
    if (!bin) return null;
    const p = bin === '~' ? os.homedir() : (bin.startsWith('~/') ? path.join(os.homedir(), bin.slice(2)) : bin);
    return p;
  }

  /** 已安装版本：优先显式配置（installedPkgJsonPath），否则从 bin 所在目录向上找 package.json。未安装返回 null（唯一探测实现）。 */
  installedVersion() {
    if (this.config.installedPkgJsonPath) {
      try {
        const j = JSON.parse(fs.readFileSync(this.config.installedPkgJsonPath, 'utf8'));
        if (j.name) return String(j.version || '');
      } catch { return null; }
    }
    const bin = this.binPath();
    if (!bin || !fs.existsSync(bin)) return null;
    try {
      let dir = path.dirname(fs.realpathSync(bin));
      for (let i = 0; i < 8; i++) {
        const cj = path.join(dir, 'package.json');
        if (fs.existsSync(cj)) {
          try {
            const j = JSON.parse(fs.readFileSync(cj, 'utf8'));
            if (j.name) return String(j.version || '');
          } catch {}
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {}
    return null;
  }

  /** 安装状态（含版本 + 任务进度，供前端即时渲染）。 */
  status() {
    const bin = this.binPath();
    const installed = this.installedVersion();
    const activeTask = this.tasks ? this.tasks.current('native', 'main') : null;
    let state;
    if (this.installing || (activeTask && activeTask.action === 'install' && activeTask.state === 'running')) state = 'installing';
    else if (this.uninstalling || (activeTask && activeTask.action === 'uninstall' && activeTask.state === 'running')) state = 'uninstalling';
    else state = installed ? 'installed' : 'uninstalled';
    return {
      installed: installed !== null && installed !== '',
      version: installed || null,
      binPath: bin,
      executable: bin ? fs.existsSync(bin) : false,
      state,
      installLog: this.installLog.slice(-8),
      lastInstall: this.lastInstall,
      lastUninstall: this.lastUninstall,
      // 统一任务视图（若注册表存在）
      task: activeTask ? this.tasks.view(activeTask) : null,
    };
  }

  /* ═══════ 版本检测（唯一通道）═══════ */
  async _latestVersion() {
    if (!this.dist || !this.config.packageName) throw new Error('分发服务未初始化，无法查询最新版本');
    const channel = this.config.releaseChannel || 'npm';
    return this.dist.fetchLatestVersion(this.config.packageName, channel);
  }

  /** 版本检测：未安装时静默（安装由本管理器负责）；已安装时比较最新版。 */
  async checkUpdate() {
    if (this.checkingNow) return this.versionInfo();
    this.checkingNow = true;
    try {
      const installed = this.installedVersion();
      if (!installed) {
        this.lastCheck = { at: new Date().toISOString(), installed: null, latest: null, updateAvailable: false, note: 'not-installed' };
        return this.versionInfo();
      }
      const latest = await this._latestVersion();
      // 网络故障与「确无更新」必须区分：latest 为 null（镜像不可达/查询失败）时如实标注失败，
      // 避免把故障误报为「已是最新」（旧实现静默置 false）
      this.lastCheck = {
        at: new Date().toISOString(), installed, latest,
        updateAvailable: latest ? semverCompare(latest, installed) > 0 : false,
        error: latest ? null : '镜像源不可达或未查询到版本',
      };
      if (this.events) this.events.append('version_checked', { installed, latest, updateAvailable: this.lastCheck.updateAvailable });
    } catch (e) {
      this.lastCheck = { ...(this.lastCheck || {}), at: new Date().toISOString(), installed: this.installedVersion(), error: e.message, updateAvailable: false };
      if (this.events) this.events.append('version_check_failed', { message: e.message });
    } finally {
      this.checkingNow = false;
    }
    return this.versionInfo();
  }

  /** 版本信息（已装/最新/可更新/检查时间）。 */
  versionInfo() {
    const c = this.lastCheck || {};
    return {
      installed: c.installed || this.installedVersion() || null,
      latest: c.latest || null,
      updateAvailable: !!c.updateAvailable,
      lastCheckAt: c.at || null,
      checking: this.checkingNow,
      error: c.error || null,
    };
  }

  /* ═══════ 环境检查 ═══════ */
  checkEnvironment() {
    const errors = [];
    // ⚠ 经统一执行器（2026-09-11）：原为裸 execFileSync **无 timeout** ——
    //   npm/node 在 PATH 指向网络盘、或 npm 因缓存锁挂起时会无限阻塞守卫事件循环。
    const nv = ex.runOut(runtimeContract.nodeBin('node'), ['--version']);
    if (!nv || !nv.trim()) errors.push('node 未安装或不可执行');
    const inv = npmSpawn(this);
    const npmv = ex.runOut(inv.bin, inv.args.concat(['--version']));
    if (!npmv || !npmv.trim()) errors.push('npm 未安装或不可执行');
    let npmRoot = this.npmRoot;
    if (!npmRoot) { const r = ex.runOut(inv.bin, inv.args.concat(['root', '-g']), { env: runtimeContract.npmEnv(process.env) }); if (r) npmRoot = r.trim(); }
    return { ok: errors.length === 0, errors, npmRoot };
  }

  /* ═══════ 安装清单 ═══════ */
  _manifest() {
    try { return JSON.parse(fs.readFileSync(this.manifestFile, 'utf8')); } catch { return null; }
  }

  _saveManifest(m) {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      (() => { try { const f = this.manifestFile; fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(m, null, 2), { mode: 0o600 }); fs.renameSync(tmp, f); } catch (e) { /* 回滚时 manifest 失败不致命 */ } })()
    } catch (e) { this.logger.warn && this.logger.warn('manifest 保存失败: ' + e.message); }
  }

  /** 记录安装清单。
   *  dataPaths 语义（2026-09 审计修正）：卸载时是否连带删除 ~/.dsh 用户数据目录。
   *  - 默认不认领：调用方未显式传 dataPaths 时为空数组（卸载只卸 npm 包，保留用户数据）；
   *  - 仅全新安装且 ~/.dsh 无既有 DSH 数据时，install() 才传 dataPaths（见 install）；
   *  - 升级/回滚调用本方法时传既有 manifest 的 dataPaths（保留首装认领，不覆盖/不新增）。
   *  @param {string} version
   *  @param {string[]|undefined} dataPaths 卸载时删除的数据路径（默认 []） */
  _recordManifest(version, dataPaths) {
    // dataPaths 未显式传（升级/回滚）：继承既有 manifest 的认领——首装认领不因升级丢失
    let claim = Array.isArray(dataPaths) ? dataPaths : null;
    if (claim === null) {
      const prev = this._manifest();
      if (prev && Array.isArray(prev.dataPaths)) claim = prev.dataPaths;
    }
    let npmRoot = this.npmRoot;
    try {
      if (!npmRoot) { const inv = npmSpawn(this); const r = ex.runOut(inv.bin, inv.args.concat(['root', '-g']), { env: runtimeContract.npmEnv(process.env) }); if (r) npmRoot = r.trim(); }
    } catch {}
    // 启动命令写回放在 binPath 读取**之前**：清单应记录安装完成后的现行启动形态。
    this._applyLaunchCommand(npmRoot);
    this.ensureRequireBuiltinShim();
    this.ensureFlockShim();
    this.ensureLinkPublishShim();
    this.ensurePtcEnvShim();
    this.ensureCapabilityEnvShim();
    const bin = this.binPath();
    let pkgDir = null;
    try { pkgDir = path.join(npmRoot, this.config.packageName || '@deepseek-ai/dsh'); } catch {}
    this._saveManifest({
      installedAt: new Date().toISOString(),
      version,
      binPath: bin || null,
      npmRoot,
      packageDir: pkgDir || null,
      dshHome: this.dshHome,
      // 只保留显式/继承认领的数据路径；绝不默认写入 ~/.dsh 全部用户数据（防误删凭据/会话）
      dataPaths: claim || [],
    });
  }

  /* ═══════ 启动命令写回 + dsh CLI 调用形态（安卓容器）═══════ */
  /** 安装/升级/回滚成功后把 config.command 落为**绝对形态**：
   *    [契约 node（libnode.so）, <npmRoot>/<pkg> 的 bin 入口脚本绝对路径, 'web', '--no-open']
   *  --no-open：dsh web 启动后会 spawn xdg-open/open 打开默认浏览器 —— 安卓无此命令，
   *  且面板本就由容器 WebView 呈现，URL 交给外部打开没有意义。
   *  为什么必须写回：模板形态 ['node','dsh','web'] 依赖 PATH 与可 execve 的
   *  dsh shim —— 安卓容器两者都不成立（W^X）；装完不写回，守卫重启即拉不起。
   *  只认容器契约形态（npmEntry 在场）；PC（无契约）行为逐字不变。解析失败静默
   *  保留原命令（不变量 C2：绝不让已成功的安装因写回失败而报错）。 */
  _applyLaunchCommand(npmRoot) {
    try {
      const c = runtimeContract.read();
      if (!c || !c.npmEntry) return;
      const root = npmRoot || this.npmRoot;
      if (!root) return;
      const pkgDir = path.join(root, this.config.packageName || '@deepseek-ai/dsh');
      const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      const b = pj.bin;
      const rel = typeof b === 'string' ? b : (b && (b.dsh || Object.values(b)[0])) || null;
      if (!rel) return;
      const entry = path.resolve(pkgDir, String(rel));
      if (!fs.existsSync(entry)) return;
      const command = [c.nodePath || process.execPath, entry, 'web', '--no-open'];
      const prev = this.config.command;
      if (Array.isArray(prev) && prev.join('\u0000') === command.join('\u0000')) return;
      this.config.command = command;
      if (this.persistCommand) this.persistCommand({ command });
      if (this.events) this.events.append('native_launch_command_persisted', { command });
      this.logger.info && this.logger.info('启动命令已写回: ' + command.join(' '));
    } catch (e) {
      this.logger.warn && this.logger.warn('启动命令写回失败（保留原命令）: ' + e.message);
    }
  }

  /** dsh CLI 调用形态（插件域共用主干形态）：config.command 已是写回后的
   *  node 代跑形态时返回 {bin, args}；否则 null（调用方退回 dsh 逻辑名）。 */
  dshCliInvocation() {
    try {
      const c = runtimeContract.read();
      if (!c || !c.npmEntry) return null;
      const cmd = (this.config && this.config.command) || [];
      const entry = String(cmd[1] || '');
      if (cmd.length >= 2 && entry.endsWith('.js') && fs.existsSync(entry)) {
        // 容器契约形态（node 代跑）恒带 --expose-internals：dsh app-boot 硬 require
        // 内部模块，JS 垫片与 cordis loader 的 no-native 路径都依赖该 flag（幂等无害）。
        return { bin: String(cmd[0]), args: ['--expose-internals', entry] };
      }
    } catch {}
    return null;
  }

  /** 安卓容器自愈：给安装树里的 node-addon-require-builtin 投放 JS 垫片。
   *  根因与方案见 require-builtin-shim.js 头注释。幂等（已投放即 no-op），
   *  每次 spawn 前由守卫调用 —— 覆盖安装/内核升级后旧 dsh 不重装也能被修复。
   *  门控同 _applyLaunchCommand：只认容器契约形态（npmEntry 在场），PC 行为逐字不变；
   *  失败只告警不抛（不变量 C2：绝不让运行因自愈失败而中断）。
   *  @param {string} [rootOverride] 显式 npm 全局根（安装完成路径传入刚解析的值） */
  ensureRequireBuiltinShim(rootOverride) {
    try {
      const c = runtimeContract.read();
      if (!c || !c.npmEntry) return null;
      const root = rootOverride || this.npmRoot || (this._manifest() || {}).npmRoot || null;
      if (!root || !fs.existsSync(root)) return null;
      const r = require('./require-builtin-shim').ensureShim(root);
      for (const a of r.results) {
        if (a.status === 'applied') {
          this.narbShimApplied = true;
          if (this.events) this.events.append('narb_shim_applied', { dir: a.dir });
          this.logger.info && this.logger.info('require-builtin JS 垫片已投放: ' + a.dir);
        } else if (a.status === 'failed') {
          if (this.events) this.events.append('narb_shim_failed', { dir: a.dir, error: a.error });
          this.logger.warn && this.logger.warn('require-builtin JS 垫片投放失败: ' + a.dir + ' ' + a.error);
        } else if (a.status === 'already') {
          this.narbShimApplied = true;
        }
      }
      return r;
    } catch (e) {
      this.logger.warn && this.logger.warn('require-builtin JS 垫片检查异常（忽略）: ' + e.message);
      return null;
    }
  }

  /** 安卓容器自愈：给安装树里的 @deepseek-ai/node-addon-system 投放 flock 垫片
   *  （真 flock(2) 走 APK jniLibs 的 libdshflock.so，根因见 flock-shim.js 头注释）。
   *  门控 = 容器契约形态（同 ensureRequireBuiltinShim）**且** 容器已递来
   *  DSH_FLOCK_NATIVE 路径 —— PC/dev 无该变量 ⇒ 树不动、行为逐字不变。
   *  幂等；失败只告警不抛（不变量 C2）。
   *  @param {string} [rootOverride] 显式 npm 全局根（安装完成路径传入刚解析的值） */
  ensureFlockShim(rootOverride) {
    try {
      const c = runtimeContract.read();
      if (!c || !c.npmEntry) return null;
      const native = process.env.DSH_FLOCK_NATIVE;
      if (!native || !String(native).trim()) return null;
      const root = rootOverride || this.npmRoot || (this._manifest() || {}).npmRoot || null;
      if (!root || !fs.existsSync(root)) return null;
      const r = require('./flock-shim').ensureShim(root);
      for (const a of r.results) {
        if (a.status === 'applied') {
          this.flockShimApplied = true;
          if (this.events) this.events.append('flock_shim_applied', { dir: a.dir });
          this.logger.info && this.logger.info('flock 原生垫片已投放: ' + a.dir);
        } else if (a.status === 'failed') {
          if (this.events) this.events.append('flock_shim_failed', { dir: a.dir, error: a.error });
          this.logger.warn && this.logger.warn('flock 原生垫片投放失败: ' + a.dir + ' ' + a.error);
        } else if (a.status === 'already') {
          this.flockShimApplied = true;
        }
      }
      return r;
    } catch (e) {
      this.logger.warn && this.logger.warn('flock 原生垫片检查异常（忽略）: ' + e.message);
      return null;
    }
  }

  /** 安卓容器自愈：把安装树 5 处 link(2) 独占发布桥到 renameat2(RENAME_NOREPLACE)
   *  （SELinux 禁 app 硬链接，真机实证 EACCES；根因与锚点见 link-publish-shim.js）。
   *  门控同 ensureFlockShim：契约在场 + 容器递来原生库路径声明
   *  （DSH_PUBLISH_NATIVE 或 DSH_FLOCK_NATIVE 任一，helper 从后者目录推导前者）；
   *  PC/dev 无这些变量 ⇒ 树不动、行为逐字不变。幂等；失败只告警不抛（不变量 C2）。
   *  @param {string} [rootOverride] 显式 npm 全局根（安装完成路径传入刚解析的值） */
  ensureLinkPublishShim(rootOverride) {
    try {
      const c = runtimeContract.read();
      if (!c || !c.npmEntry) return null;
      const hasNative = (v) => typeof v === 'string' && v.trim() !== '';
      if (!hasNative(process.env.DSH_PUBLISH_NATIVE) && !hasNative(process.env.DSH_FLOCK_NATIVE)) return null;
      const root = rootOverride || this.npmRoot || (this._manifest() || {}).npmRoot || null;
      if (!root || !fs.existsSync(root)) return null;
      const r = require('./link-publish-shim').ensureShim(root);
      for (const a of r.results) {
        if (a.status === 'applied') {
          this.linkShimApplied = true;
          if (this.events) this.events.append('link_shim_applied', { file: a.file });
          this.logger.info && this.logger.info('link 发布垫片已投放: ' + a.file);
        } else if (a.status === 'failed') {
          if (this.events) this.events.append('link_shim_failed', { file: a.file, error: a.error });
          this.logger.warn && this.logger.warn('link 发布垫片投放失败: ' + a.file + ' ' + a.error);
        } else if (a.status === 'already') {
          this.linkShimApplied = true;
        }
      }
      return r;
    } catch (e) {
      this.logger.warn && this.logger.warn('link 发布垫片检查异常（忽略）: ' + e.message);
      return null;
    }
  }

  /** 安卓容器自愈：给 PTC/workflow 子进程环境白名单补 LD_LIBRARY_PATH
   *  （Android linker 只认该变量/DT_RUNPATH，剥掉 ⇒ libnode.so 子进程 libc++ 符号
   *   缺失必崩；根因见 ptc-env-shim.js 头注释）。
   *  门控同 ensureFlockShim（DSH_FLOCK_NATIVE = 设备容器标记）；PC/dev 树不动。
   *  幂等；失败只告警不抛（不变量 C2）。
   *  @param {string} [rootOverride] 显式 npm 全局根（安装完成路径传入刚解析的值） */
  ensurePtcEnvShim(rootOverride) {
    try {
      const c = runtimeContract.read();
      if (!c || !c.npmEntry) return null;
      const native = process.env.DSH_FLOCK_NATIVE;
      if (!native || !String(native).trim()) return null;
      const root = rootOverride || this.npmRoot || (this._manifest() || {}).npmRoot || null;
      if (!root || !fs.existsSync(root)) return null;
      const r = require('./ptc-env-shim').ensureShim(root);
      for (const a of r.results) {
        if (a.status === 'applied') {
          this.ptcEnvShimApplied = true;
          if (this.events) this.events.append('ptc_env_shim_applied', { file: a.file });
          this.logger.info && this.logger.info('PTC 环境垫片已投放: ' + a.file);
        } else if (a.status === 'failed') {
          if (this.events) this.events.append('ptc_env_shim_failed', { file: a.file, error: a.error });
          this.logger.warn && this.logger.warn('PTC 环境垫片投放失败: ' + a.file + ' ' + a.error);
        } else if (a.status === 'already') {
          this.ptcEnvShimApplied = true;
        }
      }
      return r;
    } catch (e) {
      this.logger.warn && this.logger.warn('PTC 环境垫片检查异常（忽略）: ' + e.message);
      return null;
    }
  }

  /** 安卓容器自愈：bash/rg 二进制路径与终端进程检视平台门的能力垫片
   *  （4 处桌面硬编码 → 容器 env 旋钮；根因与锚点见 capability-env-shim.js）。
   *  门控同 ensurePtcEnvShim；PC/dev 树不动。幂等；失败只告警不抛（不变量 C2）。
   *  @param {string} [rootOverride] 显式 npm 全局根（安装完成路径传入刚解析的值） */
  ensureCapabilityEnvShim(rootOverride) {
    try {
      const c = runtimeContract.read();
      if (!c || !c.npmEntry) return null;
      const native = process.env.DSH_FLOCK_NATIVE;
      if (!native || !String(native).trim()) return null;
      const root = rootOverride || this.npmRoot || (this._manifest() || {}).npmRoot || null;
      if (!root || !fs.existsSync(root)) return null;
      const r = require('./capability-env-shim').ensureShim(root);
      for (const a of r.results) {
        if (a.status === 'applied') {
          this.capShimApplied = true;
          if (this.events) this.events.append('cap_shim_applied', { file: a.file });
          this.logger.info && this.logger.info('能力垫片已投放: ' + a.file);
        } else if (a.status === 'failed') {
          if (this.events) this.events.append('cap_shim_failed', { file: a.file, error: a.error });
          this.logger.warn && this.logger.warn('能力垫片投放失败: ' + a.file + ' ' + a.error);
        } else if (a.status === 'already') {
          this.capShimApplied = true;
        }
      }
      return r;
    } catch (e) {
      this.logger.warn && this.logger.warn('能力垫片检查异常（忽略）: ' + e.message);
      return null;
    }
  }

  /** 卸载时拟删除的 DSH 用户数据路径（仅当本 supervisor 是干净 ~/.dsh 的首装者才认领）。
   *  语义：~/.dsh 无任何既有 DSH 数据时，本安装视为主权安装——卸载连带清理数据；
   *        若已存在 sessions/storages/profiles/settings.yaml/.credentials.yaml 等用户数据，
   *        视为既有环境（可能由用户手动/其它工具建立），卸载只卸 npm 包，绝不删用户数据。 */
  _claimDataPaths() {
    const paths = [
      path.join(this.dshHome, 'sessions'),
      path.join(this.dshHome, 'storages'),
      path.join(this.dshHome, 'profiles'),
      path.join(this.dshHome, 'settings.yaml'),
      path.join(this.dshHome, '.credentials.yaml'),
      path.join(this.dshHome, '.anonymous-user-id'),
    ];
    // 任一 DSH 数据已存在（无论是否来自本 supervisor）→ 不认领
    for (const p of paths) {
      try { if (fs.existsSync(p)) return []; } catch { return []; }
    }
    // supervisor 自身目录（~/.dsh/supervisor）不算 DSH 用户数据，忽略
    return paths;
  }

  /* ═══════ 安装执行核心（安装/升级/回滚共用，唯一实现）═══════ */
  /** 安装执行（唯一入口 = dist.runNpmInstall）：
   *  - installCommandTemplate（测试/特殊环境）经 commandTemplate 透传，完整替换执行命令（fake-npm 等）；
   *  - 行日志统一经 onLine 写入升级日志 +（安装中）安装日志。
   *  旧版在 native 复制整套 spawn/killTree/超时/行收集实现，已收敛删除（2026-09 架构收敛）。 */
  _runInstall(version, registry) {
    if (!this.dist) return Promise.resolve({ ok: false, error: 'dist 分发服务不可用，无法安装', output: [] });
    const pkg = this.config.packageName || '@deepseek-ai/dsh';
    const tpl = this.config.installCommandTemplate;
    return this.dist.runNpmInstall({
      pkg,
      version,
      registry,
      // 测试/特殊环境可注入自定义安装命令（默认 null → npm install -g --no-audit）
      commandTemplate: Array.isArray(tpl) && tpl.length ? tpl : null,
      timeoutMs: this.config.upgradeTimeoutMs || 600000,
      onLine: (l) => {
        this._appendUpgradeLog(l);
        if (this.installing) this._appendInstallLog(l);
      },
    });
  }

  /** 选最快可达镜像（网络环境自适应）。 */
  async _selectRegistry() {
    if (!this.dist) return null;
    try { return await this.dist.selectRegistry(true); } catch { return null; }
  }

  /** 升级后健康验证（统一走 dist.waitPortHealthy）：端口 + 稳定期。
   *  返回 { ok, reason }。 */
  async _waitNativeHealthy(port, timeoutMs) {
    if (!this.dist) return { ok: false, reason: 'dist 分发服务不可用' };
    return this.dist.waitPortHealthy({ host: '127.0.0.1', port, timeoutMs });
  }

  /** 自动回滚：装回升级前版本并重新拉起（仿沙箱逻辑）。返回 { ok, error }。 */
  async _rollbackNative(oldVersion, task) {
    const log = (msg) => {
      this._appendUpgradeLog(msg);
      if (task && this.tasks) this.tasks.log(task.id, msg);
    };
    if (!oldVersion) { log('无旧版本可回滚'); return { ok: false, error: 'no old version to rollback' }; }
    log('自动回滚到 ' + oldVersion + '…');
    const registry = await this._selectRegistry();
    const res = await this._runInstall(oldVersion, registry);
    let okVer = false;
    try { okVer = this.installedVersion() === oldVersion; } catch {}
    if (!res.ok || !okVer) {
      log('回滚也失败了！请人工检查 npm 全局目录。');
      return { ok: false, error: res.error || 'rollback install failed' };
    }
    log('回滚完成，磁盘版本 ' + oldVersion);
    // 回滚同样更新安装清单（manifest 必须与磁盘版本一致，才能保证后续卸载清理正确）
    try { this._recordManifest(oldVersion); } catch (e2) { log('manifest 更新失败: ' + e2.message); }
    // 回滚后重新拉起（若期望运行）
    if (this.hooks.resumeAfterUpgrade) this.hooks.resumeAfterUpgrade();
    // 回滚后也验证（尽力而为；起不来如实报告）
    const port = this._targetPort();
    if (port) {
      const healthy = await this._waitNativeHealthy(port, 60000);
      if (healthy.ok) log('回滚后实例已恢复运行');
      else log('回滚后实例未恢复（' + healthy.reason + '）');
    }
    return { ok: true };
  }

  /** 原生 DSH 目标端口（从 healthUrl 或配置提取）。 */
  _targetPort() {
    try { return Number(new URL(this.config.healthUrl).port) || null; } catch { return null; }
  }

  // ⚠ _mainUnit()（systemd 托管单元名）已删：安卓内核无系统服务管理器，
  //   原生 DSH 由内核直接 spawn/adopt，健康验证只按端口+稳定期（dist.waitPortHealthy）。

  /* ═══════ 安装（统一任务模型）═══════ */
  async install(version) {
    if (this.tasks && this.tasks.isBusy('native', 'main')) return { ok: false, error: '已有任务在进行中' };
    if (this.installing) return { ok: false, error: '安装已在进行中' };
    if (this.uninstalling) return { ok: false, error: '卸载进行中，请稍后再装' };
    // ⚠ 2026-09-12（P2）：显式拒绝「升级进行中」（见 upgrade 内的对称说明）。
    //   `busy()` 覆盖 installing/restarting/verifying/rolling_back（upgradeState 非 idle/done/failed）。
    if (this.busy()) return { ok: false, error: '升级进行中，请稍后再装（state=' + this.upgradeState + '）' };
    if (version && !VERSION_RE.test(version)) return { ok: false, error: '非法版本号: ' + version };
    const env = this.checkEnvironment();
    if (!env.ok) return { ok: false, error: '环境检查失败: ' + env.errors.join('; ') };
    // 并发锁必须在任何 await 之前置位：否则两次并发 POST /native/install 会在
    // _latestVersion/_selectRegistry 的 await 间隙同时通过检查 → 并发跑两个 npm install -g。
    this.installing = true;
    this.installLog = [];
    let task = null;
    if (this.tasks) {
      task = this.tasks.begin('native', 'install', { id: 'main', name: '原生 DeepSeek Harness' }, { to: version || null, createdBy: 'user' });
      this.tasks.start(task.id);
    }
    let target = version;
    if (!target) {
      target = await this._latestVersion().catch(() => null);
      if (!target) {
        this.installing = null;
        if (task) this.tasks.fail(task.id, '无法从镜像源获取最新版本');
        return { ok: false, error: '无法从镜像源获取最新版本' };
      }
    }
    const registry = await this._selectRegistry();
    if (task) this.tasks.log(task.id, '安装 ' + (this.config.packageName || '@deepseek-ai/dsh') + '@' + target + (registry ? ' via ' + registry : ''));
    if (this.events) this.events.append('native_install_started', { version: target, registry });
    this.logger.info && this.logger.info('native install: ' + (this.config.packageName || '@deepseek-ai/dsh') + '@' + target + (registry ? ' via ' + registry : ''));
    const res = await this._runInstall(target, registry);
    if (!res.ok) {
      this.installing = null;
      this.lastInstall = { ok: false, version: null, error: res.error, at: new Date().toISOString(), log: this.installLog.slice(-8) };
      if (this.events) this.events.append('native_install_failed', { error: res.error, output: res.output });
      if (task) this.tasks.fail(task.id, res.error);
      return { ok: false, error: res.error, output: res.output };
    }
    // 卸载数据认领：仅首装（manifest 尚不存在）尝试；~/.dsh 已有用户数据时不认领（防误删既有数据/凭据）
    const isFirstInstall = !this._manifest();
    this._recordManifest(target, isFirstInstall ? this._claimDataPaths() : []);
    const ver = this.installedVersion();
    this.installing = null;
    this.lastInstall = { ok: true, version: ver || target, error: null, at: new Date().toISOString(), log: this.installLog.slice(-8) };
    if (this.events) this.events.append('native_installed', { version: target });
    this.logger.info && this.logger.info('native installed: ' + (ver || target));
    if (task) { this.tasks.log(task.id, '安装完成，版本 ' + (ver || target)); this.tasks.succeed(task.id); }
    return { ok: true, version: ver || target };
  }

  /* ═══════ 安装入口（异步任务模式）═══════ */
  /** 启动安装（API 用）：同步前置检查，通过则后台执行 install() 并立即返回。
   *  结果/进度经 status().state|lastInstall|installLog 暴露，前端轮询呈现——消除"点击后真空"。
   *  返回 { ok:false, error }（前置拒绝）或 { ok:true, started:true }。 */
  startInstall(version) {
    if (this.installing) return { ok: false, error: '安装已在进行中' };
    if (this.uninstalling) return { ok: false, error: '卸载进行中，请稍后再装' };
    if (version && !VERSION_RE.test(version)) return { ok: false, error: '非法版本号: ' + version };
    const env = this.checkEnvironment();
    if (!env.ok) return { ok: false, error: '环境检查失败: ' + env.errors.join('; ') };
    this.install(version).then(() => {}).catch((e) => {
      // 后台任务意外抛错：复位标志并记录，绝不让调用方挂死；
      // 同时兜底任务注册表（若 install() 在任务已 begin 后抛出 → 任务永久 running 会占锁挡住后续安装/升级）
      this.installing = null;
      this.lastInstall = { ok: false, version: null, error: e.message, at: new Date().toISOString(), log: this.installLog.slice(-8) };
      if (this.events) this.events.append('native_install_failed', { error: e.message });
      if (this.tasks) {
        try {
          const cur = this.tasks.current('native', 'main');
          if (cur && cur.action === 'install') this.tasks.fail(cur.id, '安装异常: ' + e.message);
        } catch {}
      }
      this.logger.error && this.logger.error('native install crashed: ' + e.message);
    });
    return { ok: true, started: true };
  }

  /* ═══════ 升级（先停后装、验证、回滚）═══════ */
  busy() { return !['idle', 'done', 'failed'].includes(this.upgradeState); }

  upgradeBrief() {
    return {
      state: this.upgradeState,
      targetVersion: this.targetVersion,
      startedAt: this.upgradeStartedAt,
      finishedAt: this.upgradeFinishedAt,
      lastError: this.upgradeError,
      rolledBack: this.rolledBack,
    };
  }

  upgradeStatus() { return { ...this.upgradeBrief(), logTail: this.upgradeLog.slice(-40) }; }

  _appendUpgradeLog(line) {
    const ts = new Date().toISOString().slice(11, 19);
    this.upgradeLog.push('[' + ts + '] ' + line);
    if (this.upgradeLog.length > 60) this.upgradeLog.splice(0, this.upgradeLog.length - 60);
  }

  /** 一键升级（统一任务模型）：先停 DSH → 安装 → 验证 → 失败自动回滚。 */
  async upgrade(requestedVersion) {
    if (this.tasks && this.tasks.isBusy('native', 'main')) return { ok: false, error: '已有任务在进行中' };
    if (this.busy()) return { ok: false, error: 'upgrade already in progress (state=' + this.upgradeState + ')' };
    // ⚠ 2026-09-12（P2）：**显式**检查安装/卸载锁，不再只依赖 tasks。
    //   缺陷：本方法**从不设置** `this.installing`，而 `install()` 也**不检查** `busy()` ——
    //     两者的互斥完全依赖 `tasks.isBusy('native','main')` 这一**可选**依赖。
    //     生产中 `tasks` 总被注入（supervisor.js:328-334）故当前成立；
    //     但一旦未注入（嵌入/测试/将来重构），install 与 upgrade 会**并发跑两个
    //     `npm install -g`** —— 同前缀并发写 npm 全局目录，结果不可预期。
    //   现补上与 install/uninstall 对称的三个显式锁（`installing` 同时充当 upgrade 的安装互斥）。
    if (this.installing) return { ok: false, error: '安装/升级已在进行中' };
    if (this.uninstalling) return { ok: false, error: '卸载进行中，请稍后再试' };
    if (requestedVersion && !VERSION_RE.test(requestedVersion)) return { ok: false, error: '非法版本号: ' + requestedVersion };
    this.upgradeState = 'installing';
    this.upgradeStartedAt = new Date().toISOString();
    this.upgradeFinishedAt = null;
    this.upgradeError = null;
    this.rolledBack = false;
    this.upgradeLog = [];
    this.targetVersion = requestedVersion || null;
    // 统一任务
    let task = null;
    if (this.tasks) {
      const oldV = this.installedVersion();
      task = this.tasks.begin('native', 'upgrade', { id: 'main', name: '原生 DeepSeek Harness' }, { from: oldV, to: requestedVersion || null, createdBy: 'user' });
      this.tasks.start(task.id);
      this._activeTaskId = task.id;
    }
    try {
      const oldV = this.installedVersion();
      this.oldVersion = oldV;
      let target = requestedVersion;
      if (!target) {
        if (task) this.tasks.log(task.id, '查询最新版本…');
        this._appendUpgradeLog('查询最新版本…');
        target = await this._latestVersion();
        if (!target) throw new Error('无法从任何 registry 获取最新版本');
      }
      this.targetVersion = target;
      if (task) this.tasks.log(task.id, '目标版本 ' + target);
      if (!oldV) {
        if (this.events) this.events.append('upgrade_fresh_install', { to: target });
        this._appendUpgradeLog('未检测到已安装的 DeepSeek Harness，执行全新安装：' + target);
        if (task) this.tasks.log(task.id, '未检测到已安装的 DeepSeek Harness，执行全新安装：' + target);
      } else if (semverCompare(target, oldV) <= 0) {
        this.upgradeState = 'done';
        this.upgradeFinishedAt = new Date().toISOString();
        this._appendUpgradeLog('已安装 ' + oldV + '，目标 ' + target + ' 不更新。');
        if (this.events) this.events.append('upgrade_skipped', { from: oldV, to: target });
        if (task) { this.tasks.log(task.id, '已安装 ' + oldV + '，目标 ' + target + ' 不更新'); this.tasks.skip(task.id, '已是最新版本'); }
        this._activeTaskId = null;
        return { ok: true, result: 'up-to-date', from: oldV, to: target };
      }
      if (this.events) this.events.append('upgrade_started', { from: oldV, to: target });
      this._appendUpgradeLog('升级 ' + oldV + ' → ' + target);
      if (task) this.tasks.log(task.id, '升级 ' + oldV + ' → ' + target);
      // 第一步：先停 DSH（含接管实例），期间守卫暂停自动拉起
      if (this.hooks.isDshActive && this.hooks.isDshActive()) {
        this.upgradeState = 'restarting';
        this._appendUpgradeLog('停止 DSH 以便安全安装…');
        if (this.events) this.events.append('upgrade_stopping_dsh', {});
        if (task) {
          const s = this.tasks.step(task.id, '停止 DSH');
          this.tasks.stepState(task.id, this.tasks.get(task.id).steps.indexOf(s), 'running');
          this.tasks.log(task.id, '停止 DSH 以便安全安装…');
        }
        // 先停后装：等待旧进程真正退出（spawn 模式下 SIGTERM 后需确认 exit）再继续安装
        if (this.hooks.stopForUpgrade) await this.hooks.stopForUpgrade();
      }
      // 第二步：安装（此时目标进程已不在运行）
      const registry = await this._selectRegistry();
      if (task) { const s = this.tasks.step(task.id, '安装 ' + target); this.tasks.stepState(task.id, this.tasks.get(task.id).steps.indexOf(s), 'running'); }
      const res = await this._runInstall(target, registry);
      if (!res.ok) throw new Error(res.error || 'install failed');
      const newV = this.installedVersion();
      if (newV !== target) throw new Error('安装后版本校验失败：期望 ' + target + '，实际 ' + newV);
      // 更新安装清单：升级路径原先不写 manifest，导致多次升级后卸载清理不完整/清错对象
      this._recordManifest(newV || target);
      if (this.events) this.events.append('upgrade_installed', { from: oldV, to: target });
      this._appendUpgradeLog('安装完成，磁盘版本 ' + newV);
      if (task) { this.tasks.log(task.id, '安装完成，磁盘版本 ' + newV); const st = this.tasks.get(task.id).steps[this.tasks.get(task.id).steps.length - 1]; if (st) this.tasks.stepState(task.id, this.tasks.get(task.id).steps.indexOf(st), 'done'); }
      // 第三步：按需拉起并进入内联验证（仿沙箱逻辑）
      if (!(this.hooks.desiredRunning && this.hooks.desiredRunning())) {
        this.upgradeState = 'done';
        this.upgradeFinishedAt = new Date().toISOString();
        this._appendUpgradeLog('DSH 期望状态为 stopped；下次 start 将使用新版本。');
        if (this.events) this.events.append('upgrade_done', { from: oldV, to: target, note: 'desired=stopped' });
        if (task) { this.tasks.log(task.id, 'DSH 期望状态为 stopped；下次 start 将使用新版本'); this.tasks.succeed(task.id); }
        this._activeTaskId = null;
        if (this.hooks.resumeAfterUpgrade) this.hooks.resumeAfterUpgrade();
        return { ok: true, result: 'installed', from: oldV, to: target };
      }
      // 第三步：拉起新版本并内联验证（仿沙箱逻辑：不再依赖守卫 onTick——
      // 守卫 guardian=false 时 onTick 被 gate return 跳过，健康验证永不触发）。
      // 验证失败 → 内联自动回滚，保证 DSH 永远可用。
      this.upgradeState = 'verifying';
      if (task) { const s = this.tasks.step(task.id, '拉起并验证'); this.tasks.stepState(task.id, this.tasks.get(task.id).steps.indexOf(s), 'running'); }
      this._appendUpgradeLog('重新拉起 DSH，等待健康验证…');
      if (task) this.tasks.log(task.id, '重新拉起 DSH，等待健康验证…');
      // 触发守卫重新拉起 DSH（异步，不等待）
      if (this.hooks.resumeAfterUpgrade) this.hooks.resumeAfterUpgrade();
      // 内联等待端口 + 稳定期
      const port = this._targetPort();
      if (!port) {
        const msg = '无法确定原生 DSH 端口（healthUrl 缺失）';
        this.upgradeState = 'failed';
        this.upgradeError = msg;
        if (task) this.tasks.fail(task.id, msg);
        this._activeTaskId = null;
        return { ok: false, error: msg, state: this.upgradeState };
      }
      const healthy = await this._waitNativeHealthy(port, this.hooks.verifyDeadlineMs ? this.hooks.verifyDeadlineMs() : 120000);
      if (healthy.ok) {
        // 验证通过：升级完成
        this.upgradeState = 'done';
        this.upgradeFinishedAt = new Date().toISOString();
        this._appendUpgradeLog('健康验证通过，升级完成（' + oldV + ' → ' + target + '）。');
        if (this.events) this.events.append('upgrade_done', { from: oldV, to: target });
        if (task) { this.tasks.log(task.id, '健康验证通过，升级完成（' + oldV + ' → ' + target + '）'); this.tasks.succeed(task.id); }
        this._activeTaskId = null;
        if (this.hooks.notify) this.hooks.notify('DSH 升级完成', oldV + ' → ' + target);
        return { ok: true, result: 'upgraded', from: oldV, to: target };
      }
      // 验证失败：内联自动回滚
      this._appendUpgradeLog('健康验证失败（' + healthy.reason + '）');
      if (task) this.tasks.log(task.id, '健康验证失败（' + healthy.reason + '）');
      this.rolledBack = true;
      this.upgradeState = 'rolling_back';
      const rb = await this._rollbackNative(oldV, task);
      this.upgradeError = rb.ok ? ('升级失败，已回滚到 ' + oldV) : ('升级失败且回滚失败：' + (rb.error || ''));
      this.upgradeState = 'failed';
      this.upgradeFinishedAt = new Date().toISOString();
      if (this.events) this.events.append('upgrade_failed', { error: this.upgradeError, rolledBack: rb.ok });
      if (task) this.tasks.fail(task.id, this.upgradeError, { meta: { rolledBack: rb.ok, rolledBackTo: rb.ok ? oldV : null } });
      this._activeTaskId = null;
      return { ok: false, error: this.upgradeError, state: this.upgradeState };
    } catch (err) {
      await this._handleUpgradeFailure(err);
      return { ok: false, error: err.message, state: this.upgradeState };
    }
  }


  async _handleUpgradeFailure(err) {
    this.upgradeError = err.message;
    if (this.events) this.events.append('upgrade_failed', { error: err.message, target: this.targetVersion });
    this._appendUpgradeLog('失败：' + err.message);
    const taskId = this._activeTaskId || null;
    if (taskId && this.tasks) this.tasks.log(taskId, '失败：' + err.message);
    let cur = null;
    try { cur = this.installedVersion(); } catch {}
    const needRollback = this.config.upgradeAutoRollback !== false && this.oldVersion && cur !== null && cur !== this.oldVersion;
    if (needRollback) {
      this.upgradeState = 'rolling_back';
      this.rolledBack = true;
      if (this.events) this.events.append('upgrade_rollback_started', { to: this.oldVersion });
      this._appendUpgradeLog('回滚到 ' + this.oldVersion + '…');
      const registry = await this._selectRegistry();
      const res = await this._runInstall(this.oldVersion, registry);
      let okVer = false;
      try { okVer = this.installedVersion() === this.oldVersion; } catch {}
      if (!res.ok || !okVer) {
        this.upgradeState = 'failed';
        this.upgradeFinishedAt = new Date().toISOString();
        this._appendUpgradeLog('回滚也失败了！请人工检查 npm 全局目录。');
        if (this.events) this.events.append('upgrade_rollback_failed', {});
        if (this.hooks.notify) this.hooks.notify('DSH 升级失败', '回滚也失败，请立即人工检查 npm 全局目录');
        if (taskId && this.tasks) this.tasks.fail(taskId, '回滚也失败：' + this.upgradeError, { meta: { rolledBack: false, rollbackFailed: true } });
        if (this.hooks.resumeAfterUpgrade) this.hooks.resumeAfterUpgrade();
        return;
      }
      this._appendUpgradeLog('回滚完成。');
      // 回滚保持 manifest 与磁盘版本一致（卸载清理依赖它）
      try { this._recordManifest(this.oldVersion); } catch (e2) { this._appendUpgradeLog('manifest 更新失败: ' + e2.message); }
      // 末态统一为 failed（rolledBack 标志如实）：避免『升级失败+回滚成功』被状态机谎报为 done
      this.upgradeState = 'failed';
      this.upgradeFinishedAt = new Date().toISOString();
      if (this.events) this.events.append('upgrade_failed', { error: this.upgradeError || '升级失败', rolledBack: true, rolledBackTo: this.oldVersion });
      if (taskId && this.tasks) { this.tasks.log(taskId, '回滚到 ' + this.oldVersion + ' 完成'); this.tasks.fail(taskId, this.upgradeError, { meta: { rolledBack: true, rolledBackTo: this.oldVersion } }); }
    } else {
      this.upgradeState = 'failed';
      this.upgradeFinishedAt = new Date().toISOString();
      if (cur === this.oldVersion) this._appendUpgradeLog('磁盘仍是旧版本，无需回滚。');
      if (this.hooks.notify) this.hooks.notify('DSH 升级失败', err.message);
      if (taskId && this.tasks) this.tasks.fail(taskId, err.message, { meta: { rolledBack: false } });
    }
    if (this.hooks.desiredRunning && this.hooks.desiredRunning()) this._appendUpgradeLog('恢复启动 DSH（当前磁盘版本）。');
    if (this.hooks.resumeAfterUpgrade) this.hooks.resumeAfterUpgrade();
    this._activeTaskId = null;
  }

  /* ═══════ 卸载（全量清理，不留残留）═══════ */
  /** 启动卸载（API 用）：同步前置检查 + 后台执行，立即返回（消除同步 execFileSync 冻结守卫事件循环）。
   *  进度/结果经 status().state|lastUninstall 暴露。 */
  startUninstall() {
    if (this.installing) return { ok: false, error: '安装进行中，无法卸载' };
    if (this.uninstalling) return { ok: false, error: '卸载已在进行中' };
    // P2 配套：与 uninstall() 对称 —— 升级进行中同样拒绝（否则前置检查通过后，
    //   uninstall() 内部的 busy() 会拒绝，但那时已 begin 了 task 并置了 uninstalling，
    //   徒增一次「已接受却立即失败」的体验）。
    if (this.busy()) return { ok: false, error: '升级进行中，无法卸载（state=' + this.upgradeState + '）' };
    this.uninstall().then(() => {}).catch((e) => {
      this.uninstalling = null;
      this.lastUninstall = { ok: false, removed: [], error: e.message, at: new Date().toISOString() };
      if (this.events) this.events.append('native_uninstall_failed', { error: e.message });
      this.logger.error && this.logger.error('native uninstall crashed: ' + e.message);
    });
    return { ok: true, started: true };
  }

  /** 异步卸载（统一任务模型）：npm uninstall（spawn，不阻塞事件循环）→ 按 manifest 清理数据路径。 */
  async uninstall() {
    if (this.tasks && this.tasks.isBusy('native', 'main')) return { ok: false, error: '已有任务在进行中' };
    if (this.installing) return { ok: false, error: '安装进行中，无法卸载' };
    if (this.uninstalling) return { ok: false, error: '卸载已在进行中' };
    // ⚠ 2026-09-12（P2）：**必须也拒绝「升级进行中」**。
    //   缺陷：`upgrade()` 全程只改 `upgradeState`，**从不设置** `this.installing` ——
    //     故升级期间 uninstall 的三个旧检查全部通过 → 会在 npm 正装新版时**卸载它**，
    //     留下「包装了一半 + manifest 被清」的不可恢复状态。
    //     （由新增的行为测试 K-d 抓出：升级中 uninstall 返回了 ok:true。）
    if (this.busy()) return { ok: false, error: '升级进行中，无法卸载（state=' + this.upgradeState + '）' };

    // 先停运行中的 DSH：运行进程中直接删包/数据文件会懒加载崩溃；且 desired=running 时守卫会
    // 用已删的 bin 反复重启（ENOENT crash loop）。通过升级 hold 语义让守卫卸载期间不自动拉起。
    if (this.hooks && this.hooks.isDshActive && this.hooks.isDshActive()) {
      this._appendUpgradeLog('停止运行中的 DeepSeek Harness…');
      if (this.hooks.stopForUpgrade) await this.hooks.stopForUpgrade();
    }
    const m = this._manifest();
    const removed = [];
    const rm = (p) => {
      if (!p) return;
      try { fs.rmSync(p, { recursive: true, force: true }); removed.push(p); }
      catch (e) { this.logger.warn && this.logger.warn('uninstall 清理失败: ' + p + ' - ' + e.message); }
    };
    let task = null;
    if (this.tasks) {
      task = this.tasks.begin('native', 'uninstall', { id: 'main', name: '原生 DeepSeek Harness' }, { from: this.installedVersion(), createdBy: 'user' });
      this.tasks.start(task.id);
      this.tasks.log(task.id, '卸载 ' + (this.config.packageName || '@deepseek-ai/dsh'));
    }
    this.uninstalling = true;
    if (this.events) this.events.append('native_uninstall_started', {});
    try {
    // npm uninstall 异步执行：同步 execFileSync 会冻结整个守卫（tick/API 全挂），必须避免
    // 关键：注入 --prefix（与 install/_recordManifest 一致）——否则测试/自定义环境会真实卸载宿主全局 DSH
    const uninstallArgs = ['uninstall', '-g'];
    if (this.npmRoot) uninstallArgs.push('--prefix', this.npmRoot);
    uninstallArgs.push(this.config.packageName || '@deepseek-ai/dsh');
    // ⚠ P1-F 修复（2026-09-12）：**必须有超时看门狗**。
    //   旧实现只监听 error/exit，且 `this.uninstalling` 只在本函数末尾复位 ——
    //   npm 一旦挂起（registry 不可达、凭证助手弹窗等待、网络盘卡住），
    //   Promise **永不 settle** → `uninstalling` 永为真 → 之后 install/uninstall **全部被拒**，
    //   任务永久 running，用户只能重启守卫。
    //   对照：同仓安装路径（domains/dist.runNpmInstall）本就有 timeout + killTree，唯独卸载漏了。
    //   现：超时 → 杀进程树 → 以明确的「超时」结论收尾（而非无限等待）。
    // 超时**可注入**（测试用）：默认与 Rust 侧 npm 上限（15min）同量级。
    //   ⚠ 为什么必须可注入：真实 15 分钟无法在测试里等待，于是「超时是否真的会触发」
    //     就只能靠静态断言（看代码形状）—— 而静态断言**无法证明行为**。
    //     可注入之后才能做行为级验证（见 test/uninstall-timeout-behavior-test.js）。
    const UNINSTALL_TIMEOUT_MS = (typeof this.config.uninstallTimeoutMs === 'number' && this.config.uninstallTimeoutMs > 0)
      ? this.config.uninstallTimeoutMs
      : 15 * 60 * 1000;
    let uninstallTimedOut = false;
    const exitCode = await new Promise((resolve) => {
      let child;
      try {
        const inv = npmSpawn(this);
        // env 必须同装侧（npmEnv）：卸载要找的全局根 = 安装写入的显式 prefix，二者不同源即卸错目录。
        child = spawn(inv.bin, inv.args.concat(uninstallArgs), { stdio: ['ignore', 'pipe', 'pipe'], env: runtimeContract.npmEnv(process.env) });
      } catch (e) { return resolve(-1); }
      child.stdout.resume(); child.stderr.resume();
      let done = false;
      const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve(code); };
      const timer = setTimeout(() => {
        uninstallTimedOut = true;
        this.logger.warn && this.logger.warn(
          'npm uninstall 超时（' + Math.round(UNINSTALL_TIMEOUT_MS / 1000) + 's），终止进程树'
        );
        // 尽力杀进程树：只 kill 父进程会留下 npm 拉起的 node 子进程。
        try {
          const { killTree } = require('../../platform/os/process');
          killTree(child.pid, 'SIGKILL', () => finish(-1));
        } catch (e) {
          try { child.kill('SIGKILL'); } catch (e2) {}
          finish(-1);
        }
      }, UNINSTALL_TIMEOUT_MS);
      if (timer.unref) timer.unref(); // 不因看门狗阻止进程退出
      child.on('error', () => finish(-1));
      child.on('exit', (code) => finish(code == null ? -1 : code));
    });
    if (exitCode === 0 && m) {
      if (m.packageDir) rm(m.packageDir);
      if (m.binPath) rm(m.binPath);
      for (const p of (m.dataPaths || [])) rm(p);
    }
    // ⚠ 2026-09-11 修复（K10）：**卸载失败时不得删除 manifest**。
    //   旧实现在 exitCode!==0 时只打日志，随后**无条件** rm(manifestFile)。
    //   而 npm uninstall 非 0（离线/权限/包被占用）时包其实**还在**：
    //   记录一旦丢失，之后即使卸载成功也不再知道要清哪些残留
    //   （packageDir / binPath / dataPaths），也无法向用户说明「上次卸载失败了」。
    //   正确语义：成功 → 清 manifest（已无残留可追）；失败 → **保留**以便重试与如实上报。
    if (exitCode === 0) {
      rm(this.manifestFile);
    } else {
      this.logger.warn && this.logger.warn(
        'npm uninstall exit ' + exitCode + '，保留 manifest 以便重试（数据路径未删）'
      );
    }
    // 锁的释放统一由外层 `finally` 负责（含异常路径）——此处不再重复复位。
    const uninstallError = exitCode === 0
      ? null
      : (uninstallTimedOut
        ? ('npm uninstall 超时（' + Math.round(UNINSTALL_TIMEOUT_MS / 1000) + 's）已终止，包可能仍在，可重试')
        : ('npm uninstall 退出码 ' + exitCode));
    this.lastUninstall = { ok: exitCode === 0, removed, error: uninstallError, timedOut: uninstallTimedOut, at: new Date().toISOString() };
    if (this.events) this.events.append('native_uninstalled', { removed });
    this.logger.info && this.logger.info('native uninstalled, removed ' + removed.length + ' paths');
    if (task) {
      if (exitCode === 0) { this.tasks.log(task.id, '卸载完成，清理 ' + removed.length + ' 个路径'); this.tasks.succeed(task.id); }
      else this.tasks.fail(task.id, 'npm uninstall 退出码 ' + exitCode);
    }
    // `timedOut` 必须出现在**返回值**里（不只 lastUninstall）：
    //   调用方（面板/任务）据此把「超时」与「普通失败」区分开 —— 前者应提示可重试。
    return { ok: exitCode === 0, removed, timedOut: uninstallTimedOut, error: uninstallError };
    } finally {
      // 结构性保证：本函数任何路径（含抛出）都必须释放卸载锁 ——
      //   旧实现只在正常路径末尾复位，任何异常都会让 `uninstalling` 永久为真。
      this.uninstalling = null;
    }
  }
}

module.exports = { NativeManager };
