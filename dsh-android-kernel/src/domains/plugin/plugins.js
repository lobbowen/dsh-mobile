'use strict';

// 插件安装管理器（工业级，双机制：原生宿主 × 沙箱实例）：
//  - 目标系统：插件作用域 = 原生实例 / 沙箱实例 / 全部（每实例独立 DSH + profile）；
//  - 官方生效模型（dsh-app-boot/profile-boot 语义）：
//      · bundle 层变化（安装/卸载/更新）→ 启动时装配 → 需要重启生效（_applyPluginChange）；
//      · 补丁层变化（停用/启用）→ cordis.patch.yml（profile 级 + home 级）运行时热载（patchReload=live
//        默认开启）→ 无需重启。supervisor 管理的停用面统一为「home 级补丁层 $DSH_HOME/cordis.patch.yml」，
//        原生与沙箱共用同一文件语义，不再改 profile bundles（避免 reconcile 击穿）。
//  - 卸载按目标「检测并卸载」+ 跨层残留清理（home 补丁层 / 原生 overlay / profile 补丁层检测）；
//  - 更新：检测（registry 最高版 vs 已装版）+ 执行（dsh plugin … update，官方 pnpm 更新 + reconcile）；
//  - 异步 CLI：spawn + 超时 + 行进度（不阻塞事件循环）；
//  - 作用域互斥：同一目标同时只允许一个插件操作（install/uninstall/update 共用锁，启停走文件原子写）；
//  - Job 管理：install/uninstall/update 统一任务模型，保留最近 MAX_JOBS 个（防内存堆积）。
// 边界：安装级内置组件（dsh-base / web-app）只读展示，拒绝一切变更操作。

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
// 平台知识唯一事实源（跨平台架构规范）：能力查询（进程组语义）经此，不自行判断 platform。
const matrix = require('../../platform/matrix');
const { semverCompare } = require('../dist/index');
const { dirSizeBytes } = require('../../platform/fs-utils');

const PROTECTED = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
const MAX_JOBS = 50;      // job 保留上限（超出清理最旧）
const CLI_TIMEOUT_MS = 180000; // 单次 dsh plugin CLI 超时



class PluginManager {
  constructor(opts) {
    this.dshBin = opts.dshBin || 'dsh';
    this.profileName = opts.profileName || 'web';
    this.profileDir = opts.profileDir;         // 原生 profile 目录
    this.overlayFile = opts.overlayFile;
    this.dshPort = opts.dshPort;
    // ⚠ 已删除的依赖（勿回潮）：`opts.instances`（沙箱实例域 InstanceManager）——
    //   Android 内核只有原生主干一个安装目标，插件不再有沙箱目标。
    //   原生 DSH 是否运行改由 `dshRunning` 探针注入（supervisor 持有真实运行态）。
    this.dshRunning = opts.dshRunning || null;
    this.onNativeRestart = opts.onNativeRestart || null; // 原生 DSH 重启回调（supervisor 注入 → requestRestart()，走守卫生命周期）
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.dist = opts.dist || null;
    this.tasks = opts.tasks || null;           // 统一安装/更新任务注册表（持久化历史 + 统一 API）
    this._jobs = {};                           // jobId -> job（install/uninstall/update；兼容视图，桥接统一任务）
    this._scopeQueues = {};                    // targetId -> Promise 链（作用域互斥）
    this._bundleOpQueue = Promise.resolve();    // 补丁层写串行队列（setBundleEnabled/scrub 共用，防丢失更新）
    this._updCache = {};                       // 插件更新检测缓存：name -> { latest, at }（TTL 6h，与实例更新对齐）
    this._updTTL = 6 * 3600 * 1000;
  }

  /* ═══════ 目标系统（TargetRegistry）═══════ */
  _pathExtra() {
    return (process.env.PATH || '') + path.delimiter + path.join(os.homedir(), '.npm-global', 'bin');
  }

  /** 原生目标（默认作用域）。 */
  _nativeTarget() {
    return {
      id: 'native',
      name: '原生实例',
      kind: 'native',
      bin: this.dshBin,
      profileDir: this.profileDir,
      profileName: this.profileName,
      env: { HOME: os.homedir(), PATH: this._pathExtra() },
    };
  }

  /** 严格解析目标：Android 内核**只有一个安装目标** —— 原生主干（native）。
   *  `all` 与 `native` 等价（历史上 all = native + 全部沙箱实例；沙箱实例域已删除）。
   *  其它目标（含旧的 `id:<实例id>` 写法）一律报错，不静默降级。 */
  resolveTargets(targetStr) {
    let str = (targetStr === undefined || targetStr === null || targetStr === '') ? 'native' : String(targetStr);
    if (str.startsWith('id:')) str = str.slice(3); // 旧前端写法（已无实例目标）
    if (str === 'native' || str === 'all') return { ok: true, targets: [this._nativeTarget()] };
    return { ok: false, error: '未知安装目标: ' + str + '（Android 内核只有 native 一个安装目标）' };
  }

  /* ═══════ 每目标插件状态 ═══════ */
  _readProfile(profileDir) {
    try { return JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')); } catch { return {}; }
  }

  _pkgVersion(profileDir, name) {
    try { return JSON.parse(fs.readFileSync(path.join(profileDir, 'node_modules', name, 'package.json'), 'utf8')).version || null; }
    catch { return null; }
  }

  /** 从目标 profile 的 dsh.profile.bundles 中移除指定插件（bundle 型插件卸载必需）。
   *  返回是否实际移除了；profile 无该插件时返回 false。 */
  _removeFromProfileBundles(target, pluginName) {
    const profilePath = path.join(target.profileDir, 'package.json');
    const profile = this._readProfile(target.profileDir);
    const bundles = (profile.dsh && profile.dsh.profile && profile.dsh.profile.bundles) || [];
    if (!bundles.includes(pluginName)) return false;
    const nextBundles = bundles.filter((b) => b !== pluginName);
    profile.dsh = profile.dsh || {};
    profile.dsh.profile = profile.dsh.profile || {};
    profile.dsh.profile.bundles = nextBundles;
    // 原子写（tmp+rename + 0600）：裸 writeFileSync 在并发/中断下可能撕裂 package.json，
    // 且默认 umask 下可能世界可读。与 _writeHomePatch 同款模式（2026-09 审计修复）。
    const tmp = profilePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, profilePath);
    return true;
  }

  /* ═══════ 补丁层（停用/启用的官方热载面）═══════ */
  /** 目标 DSH 的 home 级补丁层文件：$DSH_HOME/cordis.patch.yml。
   *  原生与沙箱同规则：<$DSH_HOME>/cordis.patch.yml（并且都是 profileDir 的上上级目录）。 */
  _targetHomePatchPath(target) {
    return path.resolve(path.dirname(path.dirname(target.profileDir)), 'cordis.patch.yml');
  }

  /** 读 home 补丁层（supervisor 管理面，JSON 数组）。
   *  返回 { ok, entries }；文件缺失 ok=true/[]；非 JSON（用户 YAML）返回 ok=false 并附原因。 */
  _readHomePatch(target) {
    const file = this._targetHomePatchPath(target);
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (!e || e.code !== 'ENOENT') return { ok: false, error: '读取补丁层失败: ' + (e && e.message || e) };
      return { ok: true, entries: [], file };
    }
    try {
      const j = JSON.parse(raw);
      return { ok: true, entries: Array.isArray(j) ? j : [], file };
    } catch {
      return { ok: false, error: '补丁层为非 JSON 格式（用户 YAML），不做自动改写', file };
    }
  }

  /** 原子写 home 补丁层（JSON 数组）。 */
  _writeHomePatch(target, entries) {
    const file = this._targetHomePatchPath(target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return file;
  }

  /** 解析插件在目标 loader 树中的补丁目标 entry id：
   *  - native：优先运行时 inventory 的 entryId；不可达时回落包名；
   *  insert/include 型（非 bundle）条目的自定义 id 需 inventory 支撑（P3），未达时按包名处理并记录。
   *
   *  ⚠ P1-5 修复（2026-09-12）：匹配从**子串**改为**版本感知的包名边界匹配**。
   *
   *    缺陷：原为 `moduleName.includes(name)` —— 于是停用 `@scope/dsh-tool` 时，
   *      `@scope/dsh-tool-extra` 的 entryId 也被收进 ids → 下游 `ids.includes(e.id)`
   *      把它一并置 `disabled`（**误伤无关插件**）。
   *      典型反例：`dsh-tool` 是 `dsh-tool-extra` 的子串。
   *
   *    修法：按「包名后紧跟 / 或字符串结束」判定边界，即 `name` 或 `name/...`
   *      （覆盖 `@scope/pkg` 与其子路径导入），但**不接受** `name-extra` 这类前缀延长。
   *      同时保留精确相等的情形（moduleName 恰为包名）。
   */
  async _patchEntryIdsForPlugin(target, name) {
    const ids = new Set([name]); // 包名兜底（bundle 插件的 loader entry id）
    if (target.kind === 'native') {
      try {
        const entries = ((await this.inventory()) || {}).entries || [];
        for (const e of entries) {
          const mn = String(e.moduleName || '');
          // 包名边界匹配：相等，或以 `<name>/` 开头（子路径），或以 `<name>@` 开头（带版本后缀）。
          // 明确**排除** `-`/`.` 等可延长包名的字符（否则 dsh-tool 会吞掉 dsh-tool-extra）。
          if (mn === name || mn.startsWith(name + '/') || mn.startsWith(name + '@')) ids.add(e.entryId);
        }
      } catch {}
    }
    return [...ids];
  }

  /** 跨层残留清理/检测（卸载调用）：home 补丁层 + 原生 overlay 清理，profile 补丁层检测报告。 */
  async _scrubPluginLayers(target, name, onLog) {
    // 与 setBundleEnabled 共用补丁层写串行队列（防并发读改写丢失更新）
    //
    // ⚠ P1 修复（2026-09-13，失效模式 g）：**队列不得被单次异常永久毒化**。
    //   见下方 _enqueueBundleOp 的完整说明（两处共用同一收敛点）。
    return this._enqueueBundleOp('scrub', () => this._scrubPluginLayersInner(target, name, onLog));
  }

  /** 补丁层写串行队列的**唯一入队点**（setBundleEnabled / _scrubPluginLayers 共用）。
   *
   *  ⚠ P1 修复（2026-09-13，失效模式 g：纪律只在一处执行）：
   *
   *    缺陷：两处入队都写成 `this._bundleOpQueue = this._bundleOpQueue.then(fn)` ——
   *      **没有 catch**。一旦某个 fn 抛异常（补丁层写盘失败：EACCES / EIO / ENOSPC 等），
   *      队列 Promise 变为 rejected，此后**每一次** .then() 都直接跳过回调、继续向下传播
   *      同一个 rejection —— 队列被**永久毒化**。
   *    后果：进程剩余生命周期内，
   *      · 每次 POST /plugins/enable|disable 都返回**上一次的旧错误**，写盘根本没发生；
   *      · 每次卸载的 _scrubPluginLayers 静默跳过，而 uninstall 的 .then 照常推进 →
   *        **卸载报成功但 home 补丁层未清**；
   *      · 全程无 warn/error 日志（调用方拿到 rejection 但多为 .catch 忽略）。
   *
   *    同文件 _withScopeLock(:396) 正是**正确写法**（`= run.catch(() => {})`）——
   *    同一纪律只在两条路径中的一条执行。
   *
   *    修法：收敛到本唯一入队点，链尾永远 .catch 掉错误（不毒化），
   *      同时把错误落日志并如实返回给调用方（不吞错）。
   */
  _enqueueBundleOp(tag, fn) {
    const run = this._bundleOpQueue.then(fn);
    // 链尾吞掉 rejection（仅用于**续链**，不影响下面 return 给调用方的 run）。
    this._bundleOpQueue = run.catch(() => {});
    return run.catch((e) => {
      const msg = (e && e.message) || String(e);
      if (this.logger && this.logger.error) this.logger.error('[plugins] 补丁层写失败(' + tag + '): ' + msg);
      return { ok: false, error: msg };
    });
  }

  async _scrubPluginLayersInner(target, name, onLog) {
    const log = (m) => { try { if (typeof onLog === 'function') onLog(m); } catch {} };
    const findings = { cleaned: [], warnings: [] };
    try {
      // 1) home 补丁层（我们管理，JSON）：移除指向该插件的行
      const hp = this._readHomePatch(target);
      if (hp.ok) {
        const before = hp.entries.length;
        const after = hp.entries.filter((e) => {
          if (!e || typeof e !== 'object') return true;
          if (e.id === name) return false;
          if (Array.isArray(e.insert)) return !e.insert.some((r) => r && r.name === name);
          return true;
        });
        if (after.length !== before) {
          this._writeHomePatch(target, after);
          findings.cleaned.push('home 补丁层');
          log('已清理 home 补丁层残留（' + (before - after.length) + ' 条）');
        }
      } else {
        findings.warnings.push(hp.error);
        log(hp.error);
      }
      // 2) 原生 overlay（旧机制，兼容迁移期清理）
      if (target.kind === 'native') {
        const shortName = name.split('/').pop();
        const list = this.overlayEntries.filter((e) => e.id !== name && e.id !== 'include:' + shortName && e.id !== shortName);
        if (list.length !== this.overlayEntries.length) {
          this.saveOverlayEntries(list);
          findings.cleaned.push('原生 overlay');
          log('已清理原生 overlay 残留');
        }
      }
      // 3) profile 补丁层（用户面）：纯 JSON 自动清理；YAML 检测报告
      {
        const file = path.join(target.profileDir, 'cordis.patch.yml');
        let raw = null;
        try { raw = fs.readFileSync(file, 'utf8'); } catch {}
        if (raw) {
          let cleaned = false;
          try {
            const j = JSON.parse(raw);
            if (Array.isArray(j)) {
              const after = j.filter((e) => {
                if (!e || typeof e !== 'object') return true;
                if (e.id === name) return false;
                if (Array.isArray(e.insert)) return !e.insert.some((r) => r && r.name === name);
                return true;
              });
              if (after.length !== j.length) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                const tmp = file + '.tmp';
                fs.writeFileSync(tmp, JSON.stringify(after, null, 2) + '\n');
                fs.renameSync(tmp, file);
                cleaned = true;
                findings.cleaned.push('profile 补丁层');
                log('已清理 profile 补丁层残留');
              }
            }
          } catch {
            // 非 JSON（用户 YAML）：只检测不改写（不破坏用户手写内容）
            if (raw.includes(name)) {
              const msg = 'profile 补丁层（cordis.patch.yml）仍引用 ' + name + '：为避免下次启动装配失败，请手动移除相关 insert/include 行';
              findings.warnings.push(msg);
              log('⚠ ' + msg);
            }
          }
          if (!cleaned && !findings.warnings.length) log('profile 补丁层无该插件引用');
        }
      }
    } catch (e) {
      log('补丁层清理失败: ' + (e && e.message || e));
      findings.warnings.push('补丁层清理失败: ' + (e && e.message || e));
    }
    return findings;
  }

  /** 该目标已装第三方插件清单（读该 profile 的 bundles/dependencies）。 */
  installedOn(target) {
    const profile = this._readProfile(target.profileDir);
    const bundles = (profile.dsh && profile.dsh.profile && profile.dsh.profile.bundles) || [];
    const deps = profile.dependencies || {};
    const names = new Set([...bundles, ...Object.keys(deps)]);
    const out = [];
    for (const name of names) {
      if (PROTECTED.has(name)) continue;
      out.push({ name, version: this._pkgVersion(target.profileDir, name), source: deps[name] || name, bundle: bundles.includes(name) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /* ═══════ 异步 CLI（spawn + 超时 + 行进度）═══════ */
  _registryOriginAsync() {
    if (this.dist) { try { return this.dist.selectRegistry(false); } catch {} }
    return Promise.resolve('https://registry.npmjs.org');
  }

  /** CLI 参数注入防护：插件操作的目标参数（spec/name）来自 API/外部输入，
   *  若以 '-' 开头会被 dsh/pnpm 当作选项解析（如 install('-y foo')、name='--store-dir'）。
   *  包名/规格不可能合法以 '-' 开头（npm 名首字符须为字母/@/.），此处统一拒绝（2026-09 审计修复）。
   *  @returns {string|null} 错误信息（null = 全部参数安全） */
  _assertSafeCliArgs(args) {
    for (const a of args) {
      if (typeof a === 'string' && a.length > 1 && a[0] === '-' && !/^-[0-9]/.test(a)) {
        return '非法插件参数（禁止以 - 开头）: ' + a.slice(0, 40);
      }
    }
    return null;
  }

  _runCli(target, args, opts) {
    const guardErr = this._assertSafeCliArgs(args);
    const o = opts || {};
    const timeoutMs = o.timeoutMs || CLI_TIMEOUT_MS;
    return new Promise((resolve) => {
      if (guardErr) return resolve({ ok: false, error: guardErr });
      let settled = false;
      let timer = null; // 提升到 executor 顶层：settle 必须能访问（此前 const 定义在 .then 内，settle 引用越界 → ReferenceError → resolve 不执行 → job 永久 running）
      const settle = (v) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(v); } };
      this._registryOriginAsync().then((regRaw) => {
        // ⚠ P1-6 修复（2026-09-12）：registry 为 null 时**不得写进 env**。
        //
        //   缺陷：`selectRegistry` 在全镜像不可达时**返回 null**（dist/index.js:283 的分支），
        //     而 Node 的 spawn 会把 env 值强转字符串 —— `{X: null}` 变成 `'null'`（已实测）。
        //     于是 pnpm 收到 `npm_config_registry='null'` → 报错内容与真实原因（无可用镜像）无关，
        //     把排查引向错误方向。
        //
        //   修法：null/空 → **不注入该键**（让 pnpm 用自身默认），并把无可用镜像如实记日志。
        const reg = regRaw || null;
        const envBase = Object.assign({}, process.env, target.env);
        if (reg) { envBase.npm_config_registry = reg; envBase.NPM_CONFIG_REGISTRY = reg; }
        else if (this.logger && this.logger.warn) this.logger.warn('plugin CLI: 无可用的 registry 镜像，回退 pnpm 默认（npmjs.org）');
        const env = envBase;
        let child;
        try {
          // 沙箱 target：固定 pnpm store（--store-dir 传给 dsh plugin → pnpm），
          // 防止 HOME 变化（沙箱隔离）导致 ERR_PNPM_UNEXPECTED_STORE。
          const cliArgs = ['plugin', '--profile', target.profileName];
          if (target.storeDir) cliArgs.push('--store-dir', target.storeDir);
          // ⚠ P1-7 修复（2026-09-12）：`detached: true` 让子进程**自成进程组**，
          //   这样才能用 `process.kill(-pid)` 杀**整棵树**（同 dist/index.js:452 的 npm 安装）。
          //   缺陷：原实现无 detached，且超时只用 `child.kill()` 杀**直接子进程** ——
          //     dsh plugin → pnpm 的**孙进程**（真正在跑安装的那个）会成为孤儿，
          //     继续占用 profile 目录与 pnpm store 锁。
          child = spawn(target.bin, [...cliArgs, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true });
        } catch (e) { return settle({ ok: false, error: e.message }); }
        // 整树终止（POSIX/安卓 = 进程组，与平台能力声明一致）
        const killTree = (sig) => {
          if (!child) return;
          try {
            // 能力查询（而非自行判断 platform）：POSIX 进程组语义只在支持的平台可用。
            if (matrix.supportsProcessGroup() && child.pid) process.kill(-child.pid, sig);
            else child.kill(sig);
          } catch { try { child.kill(sig); } catch {} }
        };
        timer = setTimeout(() => {
          killTree('SIGTERM');
          // 兜底：SIGTERM 后 3s 若未退出则 SIGKILL（防不响应挂死）
          setTimeout(() => killTree('SIGKILL'), 3000).unref();
          settle({ ok: false, error: '执行超时（' + Math.round(timeoutMs / 1000) + 's）' });
        }, timeoutMs);
        const push = (buf) => {
          if (typeof o.onLine !== 'function') return;
          for (const l of String(buf).split(/\r?\n/)) { const t = l.trim(); if (t) { try { o.onLine(t); } catch {} } }
        };
        child.stdout.on('data', push);
        child.stderr.on('data', push);
        child.on('error', (e) => settle({ ok: false, error: e.message }));
        // 关键：用 exit（进程退出即触发）而非 close——dsh plugin CLI 完成后启动的后台子进程
        // 会继承 stdout pipe，导致 close 永不触发（job 永远 running）。exit 不依赖 stdio 关闭。
        child.on('exit', (code) => settle({ ok: code === 0, error: code === 0 ? null : '退出码 ' + code }));
      }).catch((e) => settle({ ok: false, error: e.message }));
    });
  }

  /* ═══════ 作用域互斥 ═══════ */
  _withScopeLock(targetId, fn) {
    const prev = this._scopeQueues[targetId] || Promise.resolve();
    const run = prev.then(fn, fn);
    this._scopeQueues[targetId] = run.catch(() => {});
    return run.catch((e) => ({ ok: false, error: (e && e.message) || String(e) })); // 异常不吞：调用方 .then 继续推进
  }

  /* ═══════ Job 管理 ═══════ */
  _createJob(kind, name, targetStr, targets) {
    const jobId = 'pj-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const job = {
      id: jobId, kind, name, target: targetStr, state: 'running', startedAt: Date.now(), finishedAt: null, error: null,
      targets: targets.map((t) => ({ id: t.id, name: t.name, state: 'pending', log: [] })),
    };
    this._jobs[jobId] = job;
    this._cleanupJobs();
    // 桥接统一任务：plugin/<kind> 注册表任务（kind: plugin）
    if (this.tasks) {
      const taskKind = kind === 'install' ? 'install' : (kind === 'update' ? 'update' : 'uninstall');
      const verb = kind === 'install' ? '安装插件 ' : (kind === 'update' ? '更新插件 ' : '卸载插件 ');
      const task = this.tasks.begin('plugin', taskKind, { id: targets[0] ? targets[0].id : 'native', name: targets[0] ? targets[0].name : targetStr }, { to: name, createdBy: 'user' });
      this.tasks.start(task.id);
      job.taskId = task.id;
      this.tasks.log(task.id, verb + name + '（目标 ' + targetStr + '）');
    }
    return job;
  }

  _cleanupJobs() {
    const ids = Object.keys(this._jobs);
    if (ids.length > MAX_JOBS) {
      const drop = ids.slice(0, ids.length - MAX_JOBS);
      for (const id of drop) delete this._jobs[id];
    }
  }

  _finishJob(job, ok, error) {
    job.state = ok ? 'done' : 'failed';
    job.error = error || null;
    job.finishedAt = Date.now();
    // 桥接收尾统一任务
    if (this.tasks && job.taskId) {
      if (ok) { this.tasks.log(job.taskId, '完成'); this.tasks.succeed(job.taskId); }
      else this.tasks.fail(job.taskId, error || '任务失败');
    }
  }

  installStatus(jobId) {
    const job = this._jobs[jobId];
    // 单一事实源：任务存在时从 TaskRegistry 派生（前端判定 done/failed；succeeded/skipped→done，failed/canceled→failed）
    if (job && job.taskId && this.tasks) {
      const t = this.tasks.get(job.taskId);
      if (t) {
        const toView = (s) => (s === 'succeeded' || s === 'skipped') ? 'done' : (s === 'failed' || s === 'canceled') ? 'failed' : 'running';
        return {
          id: job.id, kind: job.kind, name: job.name, target: job.target,
          state: toView(t.state), startedAt: t.startedAt, finishedAt: t.finishedAt, error: t.error,
          targets: job.targets,
        };
      }
    }
    return job || { error: 'job not found' };
  }

  /* ═══════ 插件变更生效（重启运行中的目标）═══════ */
  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** 原生 DSH 是否运行中（决定插件变更要不要触发重启）。
   *  运行态由守卫注入（dshRunning），插件层不自行探测进程。 */
  _targetRunning(target) {
    if (!target || target.kind !== 'native') return false;
    try { return typeof this.dshRunning === 'function' ? this.dshRunning() === true : false; } catch { return false; }
  }

  /**
   * 插件变更（卸载/启停）后让目标实例重新加载 profile：DSH 的插件集合
   * 只在启动时装配（dsh-client-modules 文档明确：plugin-set changes take effect
   * on restart）——运行中的进程不会热载 bundles，卸载后仍会服务旧清单里已删除的
   * client.js（浏览器报 Failed to load plugins），必须重启才能生效。
   *  - native：走 onNativeRestart 回调（supervisor.requestRestart，守卫生命周期统一处理）
   *  ⚠ 已删除的路径：sandbox 目标走 InstanceManager 停/起（沙箱实例域已删除）。
   * 仅对「实际变更」的目标执行；未运行的目标记日志待下次启动生效，不阻塞流程。
   * @param target 变更目标
   * @param kind 操作类型（uninstall / enable / disable）
   * @param onLog 追加日志的行记录器（job 目标日志）
   * @returns 是否已请求/完成重启
   */
  async _applyPluginChange(target, kind, onLog) {
    const log = (m) => { try { if (typeof onLog === 'function') onLog(m); } catch {} };
    if (!target) return false;
    try {
      if (target.kind === 'native') {
        if (!this._targetRunning(target)) { log('原生 DSH 未运行：插件变更将在下次启动时生效'); return false; }
        if (typeof this.onNativeRestart === 'function') {
          let rr;
          try { rr = this.onNativeRestart(); } catch (e) { log('原生 DSH 重启请求失败: ' + e.message); return false; }
          if (rr && rr.ok === false) { log('原生 DSH 重启请求未生效：' + ((rr && rr.error) || 'unknown')); return false; }
          log('已请求重启原生 DSH 使插件变更生效');
          if (this.events) this.events.append('plugin_restart_done', { name: '原生实例', target: 'native', kind, via: 'supervisor' });
          return true;
        }
        log('提示：原生 DSH 需重启后插件变更生效（当前未配置自动重启）');
        return false;
      }
      return false;
    } catch (e) {
      log('插件变更生效处理失败: ' + e.message);
      return false;
    }
  }

  /* ═══════ 安装 ═══════ */
  async install(spec, opts) {
    if (!spec) return { ok: false, error: 'missing spec' };
    const r = this.resolveTargets(opts && opts.target);
    if (!r.ok) return r; // 目标无效：直接报错（不再静默降级原生）
    const job = this._createJob('install', spec, (opts && opts.target) || 'native', r.targets);
    if (this.events) this.events.append('plugin_install_started', { spec, jobId: job.id, target: job.target });
    let idx = 0;
    const next = () => {
      if (idx >= job.targets.length) {
        const failed = job.targets.filter((t) => t.state === 'failed');
        const ok = failed.length === 0;
        this._finishJob(job, ok, ok ? null : ((failed[0] && failed[0].error) || '部分目标失败'));
        if (this.events) {
          if (ok) this.events.append('plugin_install_done', { spec, jobId: job.id });
          else this.events.append('plugin_install_job_failed', { spec, jobId: job.id, error: (failed[0] && failed[0].error) || '部分目标失败' });
        }
        return;
      }
      const target = r.targets[idx], jt = job.targets[idx];
      jt.state = 'running';
      this._withScopeLock(target.id, async () => {
        let res;
        try { res = await this._runCli(target, ['add', spec], { onLine: (l) => { jt.log.push(l); if (jt.log.length > 30) jt.log.shift(); } }); }
        catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }
        jt.state = res.ok ? 'done' : 'failed';
        jt.error = res.ok ? null : (res.error || '');
        jt.log.push(res.ok ? '完成' : ('失败: ' + (res.error || '')));
        if (this.events) this.events.append(res.ok ? 'plugin_install_ok' : 'plugin_install_failed', { spec, target: target.name, jobId: job.id, error: res.error });
        // 安装不自动重启（新插件可能不兼容导致实例起不来——由用户确认后手动重启）；
        // 运行中的实例提示重启后可加载，避免「装了却看不到」。
        if (res.ok && this._targetRunning(target)) {
          jt.log.push('原生 DSH 运行中：新插件将在重启后加载');
        }
      }).then(() => { idx++; next(); });
    };
    next();
    return { ok: true, jobId: job.id, target: job.target };
  }

  /* ═══════ 卸载（按目标检测并卸载）═══════ */
  async uninstall(name, targetStr) {
    if (this.isProtected(name)) return { ok: false, error: '内置组件不可卸载' };
    if (!name) return { ok: false, error: 'missing plugin name' };
    const r = this.resolveTargets(targetStr);
    if (!r.ok) return r;
    // 检测：只对实际装有该插件的目标执行卸载（不同实例各自检测）
    const targets = r.targets.filter((t) => this.installedOn(t).some((p) => p.name === name));
    if (!targets.length) {
      const desc = targetStr === 'all' ? '任何目标' : ('目标「' + (targetStr || 'native') + '」');
      return { ok: false, error: desc + ' 未安装插件 ' + name };
    }
    const job = this._createJob('uninstall', name, targetStr || 'native', targets);
    if (this.events) this.events.append('plugin_uninstall_started', { name, jobId: job.id, target: job.target, targets: targets.map((t) => t.name) });
    let idx = 0;
    const next = () => {
      if (idx >= job.targets.length) {
        const failed = job.targets.filter((t) => t.state === 'failed');
        const ok = failed.length === 0;
        this._finishJob(job, ok, ok ? null : ((failed[0] && failed[0].error) || '部分目标失败'));
        if (this.events) {
          if (ok) this.events.append('plugin_uninstall_done', { name, jobId: job.id });
          else this.events.append('plugin_uninstall_job_failed', { name, jobId: job.id, error: (failed[0] && failed[0].error) || '部分目标失败' });
        }
        return;
      }
      const target = targets[idx], jt = job.targets[idx];
      jt.state = 'running';
      this._withScopeLock(target.id, async () => {
        let res;
        try { res = await this._runCli(target, ['remove', name], { onLine: (l) => { jt.log.push(l); if (jt.log.length > 30) jt.log.shift(); } }); }
        catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }
        // ── bundle 型插件清理：dsh plugin remove 只移除 dependencies，
        //    reconcile 对带 dsh.bundle 声明的插件会保留在 dsh.profile.bundles → DSH 仍加载。
        //    这里直接从 profile 的 bundles 数组移除，确保卸载彻底生效。
        let bundlesCleaned = false;
        try {
          bundlesCleaned = this._removeFromProfileBundles(target, name);
          if (bundlesCleaned) jt.log.push('已从 profile bundles 移除');
        } catch (e) {
          jt.log.push('bundles 清理失败: ' + e.message);
          if (res.ok) res = { ok: false, error: 'bundles 清理失败: ' + e.message };
        }
        // 判定成功：pnpm remove 成功，或（bundles 已清理 + pnpm 报"依赖已不存在"——
        // 说明 dependencies 此前已被移除，插件实际已不装）。
        if (!res.ok && bundlesCleaned && /no such dependency|no dependencies of any kind|CANNOT_REMOVE_MISSING|already removed|not a dependency/i.test(String(res.error || ''))) {
          res = { ok: true, error: null };
          jt.log.push('依赖已清空，bundles 已移除（卸载完成）');
        }
        jt.state = res.ok ? 'done' : 'failed';
        jt.error = res.ok ? null : (res.error || '');
        jt.log.push(res.ok ? '完成' : ('失败: ' + (res.error || '')));
        if (this.events) this.events.append(res.ok ? 'plugin_uninstall_ok' : 'plugin_uninstall_failed', { name, target: target.name, jobId: job.id, error: res.error });
        // 跨层残留清理/检测（P1）：home 补丁层 + 原生 overlay 清理；profile 补丁层检测报告。
        {
          const scrub = await this._scrubPluginLayers(target, name, (m) => jt.log.push(m));
          jt.scrub = scrub;
          if (scrub.warnings.length) jt.log.push('⚠ 残留提示：' + scrub.warnings.join('；'));
        }
        // 卸载生效：运行中的目标若不重启，DSH 仍按启动时清单加载已删插件（client.js 404
        // → 浏览器 Failed to load plugins）。这里对实际变更的目标重启，卸载才真正「完整」。
        const changed = !!(res.ok || bundlesCleaned);
        if (changed) await this._applyPluginChange(target, 'uninstall', (m) => jt.log.push(m));
      }).then(() => { idx++; next(); });
    };
    next();
    return { ok: true, jobId: job.id, target: job.target };
  }

  /* ═══════ 镜像源 / 覆盖层 / inventory（保留原有能力）═══════ */
  get overlayEntries() {
    try { return JSON.parse(fs.readFileSync(this.overlayFile, 'utf8')); } catch { return []; }
  }

  saveOverlayEntries(entries) {
    fs.mkdirSync(path.dirname(this.overlayFile), { recursive: true });
    const tmp = this.overlayFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.overlayFile);
  }

  /** inventory RPC（DSH 运行时才有值）。 */
  async inventory() {
    const http = require('node:http');
    const payload = JSON.stringify({ type: 'client-request', rpcId: 'pm-' + Date.now(), method: 'pluginInventory/list', payload: { args: {} } });
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: this.dshPort, path: '/api/pluginInventory/list', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 5000 }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try { const j = JSON.parse(b); if (j.result && j.result.ok) resolve(j.result.value); else reject(new Error((j.result && j.result.error && j.result.error.message) || 'rpc failed')); }
          catch (e) { reject(e); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(payload);
    });
  }

  readManifest() {
    try { return JSON.parse(fs.readFileSync(path.join(this.profileDir, 'package.json'), 'utf8')); } catch { return {}; }
  }

  /** 已装清单：原生详细（inventory 运行态）× 各目标聚合（每插件目标分布）。
   *  返回 targets（Android 内核只有原生主干一个目标）+ thirdParty（含 targetNames）。 */
  async listInstalled() {
    const nativeDetail = await this._listInstalledNative();
    const targets = [this._nativeTarget()];   // Android 内核：唯一安装目标（沙箱目标已删）
    const byName = new Map();
    for (const t of targets) {
      for (const p of this.installedOn(t)) {
        if (!byName.has(p.name)) byName.set(p.name, { name: p.name, version: p.version, bundle: p.bundle, source: p.source, targets: [] });
        byName.get(p.name).targets.push(t.id);
      }
    }
    // enabled 计算：任一目标处于启用态即视为启用——
    //  生效面：bundles 加载层 + home 补丁层（$DSH_HOME/cordis.patch.yml，热载）禁用行 + 原生 legacy overlay
    //  - disabledByPatch：home 补丁层中该插件有 disabled:true 行 → 禁用（双域一致）
    //  - disabledByOverlay：原生 legacy --patch overlay 行 → 禁用（迁移期兼容）
    const overlayIds = new Set(this.overlayEntries.map((e) => e.id));
    const homePatchDisabledIds = (t) => {
      const hp = this._readHomePatch(t);
      const set = new Set();
      if (hp.ok) for (const e of hp.entries) if (e && typeof e === 'object' && e.disabled && typeof e.id === 'string') set.add(e.id);
      return set;
    };
    const isEnabledOn = (t, pname) => {
      const profile = this._readProfile(t.profileDir);
      const inBundles = ((profile.dsh && profile.dsh.profile && profile.dsh.profile.bundles) || []).includes(pname);
      if (!inBundles) return false;
      if (homePatchDisabledIds(t).has(pname)) return false;
      if (t.kind === 'native') {
        const shortName = pname.split('/').pop();
        if (overlayIds.has(pname) || overlayIds.has(shortName) || overlayIds.has('include:' + shortName)) return false;
      }
      return true;
    };
    const thirdParty = [...byName.values()]
      .map((x) => {
        const enabled = x.targets.some((tid) => {
          const t = targets.find((tt) => tt.id === tid);
          return t ? isEnabledOn(t, x.name) : false;
        });
        // size：取首个安装目标目录体积（近似同源；目录缺失时为 0）
        const firstTarget = targets.find((t) => t.id === x.targets[0]);
        const size = firstTarget && x.name
          ? dirSizeBytes(path.join(firstTarget.profileDir, 'node_modules', x.name))
          : 0;
        return { name: x.name, version: x.version, bundle: x.bundle, source: x.source, targets: x.targets, targetNames: x.targets.map((id) => (targets.find((t) => t.id === id) || {}).name || id), enabled, size };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      ok: true,
      auditVer: 'AV2',
      inventoryReachable: nativeDetail.inventoryReachable,
      profile: this.profileName,
      targets: targets.map((t) => ({ id: t.id, name: t.name, kind: t.kind })),
      counts: { ...nativeDetail.counts, targets: targets.length },
      rows: nativeDetail.rows,
      thirdParty,
      builtinBundles: nativeDetail.builtinBundles,
      installationOwned: nativeDetail.installationOwned,
    };
  }

  async _listInstalledNative() {
    const manifest = this.readManifest();
    const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || [];
    let invOk = true;
    let invEntries = [];
    try { const r = ((await this.inventory()) || {}); invEntries = r.entries || []; } catch { invOk = false; }
    const overlayIds = new Set(this.overlayEntries.map((e) => e.id));
    const nativeHomePatch = this._readHomePatch(this._nativeTarget());
    const homePatchIds = new Set(nativeHomePatch.ok ? nativeHomePatch.entries.filter((e) => e && e.disabled && typeof e.id === 'string').map((e) => e.id) : []);
    const rows = invEntries.map((e) => {
      const pkg = ownerPackage(e.moduleName, bundles);
      const isThird = !!pkg;
      const disabledByOverlay = overlayIds.has(e.entryId) || overlayIds.has(e.moduleName);
      const disabledByPatch = homePatchIds.has(e.entryId) || homePatchIds.has(e.moduleName);
      return { entryId: e.entryId, moduleName: e.moduleName, enabled: !disabledByOverlay && !disabledByPatch && !!e.enabled, baseDisabled: !e.enabled, fiberPhase: e.fiberPhase, tier: isThird ? 'third-party' : 'core', pkg: pkg || null, toggleable: isThird };
    });
    const builtinPkgs = [...new Set(rows.filter((r0) => r0.tier === 'core').map((r0) => r0.moduleName))];
    return {
      inventoryReachable: invOk,
      counts: { rows: rows.length, active: rows.filter((r0) => r0.fiberPhase === 'active').length, disabledBase: rows.filter((r0) => r0.baseDisabled).length, pkgs: builtinPkgs.length },
      rows,
      builtinBundles: bundles.filter((n) => PROTECTED.has(n)).map((n) => ({ name: n, readonly: true })),
      installationOwned: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    };
  }

  /** 整插件启停（官方补丁层机制，双域统一）
   *  停用/启用写入目标 DSH 的 home 级补丁层 $DSH_HOME/cordis.patch.yml
   *  （原生 ~/.dsh ；沙箱 <dataDir>/.dsh）。该层运行时热载（patchReload=live 默认开启），
   *  运行中即时生效、无需重启；未运行则下次启动生效。不再改 dsh.profile.bundles，
   *  从根本上消除官方 reconcile「把 dependencies 中带 dsh.bundle 的包自动加回 bundles」的击穿。
   *  @param name 插件名（loader 补丁目标 id = 包名；native 优先用 inventory entryId）
   *  @param on true=启用（移除禁用行，并清 legacy overlay 禁用行） false=禁用（写入 disabled 行）
   *  @param targetStr 目标（native | all | 实例id）；缺省 native。 */
  async setBundleEnabled(name, on, targetStr) {
    // 补丁层读改写必须串行：并发 enable/disable（或与卸载的 scrub）会在同一文件上
    // 各自 read→write 导致丢失更新（原子 rename 只防撕裂，不防丢改）
    // ⚠ P1 修复（2026-09-13）：经**唯一入队点**（异常不毒化队列）——见 _enqueueBundleOp。
    return this._enqueueBundleOp('setBundleEnabled', () => this._setBundleEnabledInner(name, on, targetStr));
  }

  async _setBundleEnabledInner(name, on, targetStr) {
    if (this.isProtected(name)) return { ok: false, error: '内置组件不可变更' };
    if (!name) return { ok: false, error: 'missing plugin name' };
    let targets = [];
    if (targetStr && targetStr !== 'native') {
      const r = this.resolveTargets(targetStr);
      if (!r.ok) return r;
      targets = r.targets;
    } else {
      targets = [this._nativeTarget()];
    }
    const results = [];
    for (const target of targets) {
      const notes = [];
      const isInstalled = this.installedOn(target).some((p) => p.name === name);
      if (!isInstalled) {
        notes.push('该目标未安装，跳过');
        results.push({ id: target.id, name: target.name, changed: false, hot: false, notes });
        continue;
      }
      const ids = await this._patchEntryIdsForPlugin(target, name);
      const hp = this._readHomePatch(target);
      if (!hp.ok) {
        notes.push(hp.error);
        results.push({ id: target.id, name: target.name, changed: false, hot: false, notes });
        continue;
      }
      let changed = false;
      // 补丁行只增/只删「本插件的 disabled 行」，绝不整删本插件 id 的所有行——
      // home 补丁层可能含 insert/include 型或用户手写的非 disabled 行（见 _scrubPluginLayers 对 insert 行的
      // 谨慎处理），一刀切 filter 会静默丢弃这些行（2026-09 架构审计 Blocker 级缺陷修复）。
      const isOwnRow = (e) => e && typeof e === 'object' && typeof e.id === 'string' && ids.includes(e.id);
      const isOwnDisabled = (e) => isOwnRow(e) && e.disabled === true;
      if (!on) {
        // 禁用：本插件的既有行统一置 disabled（保留行身份/其它字段），缺失则追加 disabled 行
        const before = JSON.stringify(hp.entries);
        const next = hp.entries.map((e) => (isOwnRow(e) ? { ...e, disabled: true } : e));
        for (const id of ids) if (!next.some((e) => e.id === id)) next.push({ id, disabled: true });
        changed = JSON.stringify(next) !== before;
        if (changed) this._writeHomePatch(target, next);
        else notes.push('已在禁用态，无变更');
        if (changed) notes.push('已写补丁层禁用（' + ids.length + ' 个 entry）');
      } else {
        // 启用：只移除本插件的 disabled:true 行；非 disabled 用户/insert 行保留
        const before = JSON.stringify(hp.entries);
        const next = hp.entries.filter((e) => !isOwnDisabled(e));
        changed = JSON.stringify(next) !== before;
        if (changed) this._writeHomePatch(target, next);
        else notes.push('本未禁用，无变更');
        // 兼容迁移：顺带清 legacy overlay 禁用行（旧机制残留，形态为 {id} / {id:include:<n>}，无 disabled 标志）
        if (target.kind === 'native') {
          const ovBefore = JSON.stringify(this.overlayEntries);
          const shortName = name.split('/').pop();
          const list = this.overlayEntries.filter((e) => !ids.includes(e && e.id) && e.id !== 'include:' + shortName && e.id !== shortName);
          if (JSON.stringify(list) !== ovBefore) {
            this.saveOverlayEntries(list);
            changed = true;
            notes.push('已清理 legacy overlay 禁用行');
          }
        }
      }
      if (this._targetRunning(target)) notes.push('运行中：补丁层热应用，即时生效（无需重启）');
      else notes.push('未运行：已写入补丁层，下次启动生效');
      if (this.events) this.events.append(on ? 'plugin_enabled' : 'plugin_disabled', { name, target: target.id, entries: ids.length, hot: true, changed, running: this._targetRunning(target) });
      results.push({ id: target.id, name: target.name, changed, hot: true, ids, notes });
    }
    const rows = results.filter((r) => r.changed).length;
    return { ok: true, rows, results };
  }
  /* ═══════ 插件更新（检测 + 执行，P2）═══════ */
  _specType(spec) {
    const sp = String(spec || '');
    if (sp.startsWith('git+') || sp.startsWith('github:') || sp.endsWith('.git')) return 'git';
    if (sp.startsWith('file:') || sp.startsWith('link:') || sp.startsWith('.') || sp.startsWith('/')) return 'local';
    return 'npm';
  }

  async checkUpdates(force) {
    const targets = [this._nativeTarget()];   // Android 内核：唯一安装目标（沙箱目标已删）
    const meta = new Map();
    for (const t of targets) {
      for (const p of this.installedOn(t)) {
        if (meta.has(p.name)) continue;
        const specType = this._specType(p.source);
        let latest = null;
        const c = this._updCache[p.name];
        if (c && !force && (Date.now() - c.at) < this._updTTL) latest = c.latest;
        else {
          if (specType === 'npm' && this.dist) { try { latest = await this.dist.fetchNpmLatest(p.name); } catch {} }
          this._updCache[p.name] = { latest, at: Date.now() };
        }
        meta.set(p.name, { specType, latest });
      }
    }
    const rows = [];
    for (const t of targets) {
      for (const p of this.installedOn(t)) {
        const m = meta.get(p.name) || { specType: 'npm', latest: null };
        const updateAvailable = m.specType === 'npm' && !!m.latest && !!p.version && semverCompare(String(m.latest), String(p.version)) > 0;
        rows.push({ name: p.name, target: t.id, targetName: t.name, installed: p.version || null, latest: m.latest || null, updateAvailable, specType: m.specType, bundle: p.bundle });
      }
    }
    const byName = new Map();
    for (const row of rows) {
      let rec = byName.get(row.name);
      if (!rec) { byName.set(row.name, { name: row.name, specType: row.specType, targets: [] }); rec = byName.get(row.name); }
      rec.targets.push({ id: row.target, name: row.targetName, installed: row.installed, latest: row.latest, updateAvailable: row.updateAvailable });
    }
    const plugins = [...byName.values()].map((x) => ({ name: x.name, specType: x.specType, updateAvailable: x.targets.some((t) => t.updateAvailable), targets: x.targets })).sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, checkedAt: Date.now(), plugins };
  }

  async update(name, targetStr) {
    if (!name) return { ok: false, error: 'missing plugin name' };
    const r = this.resolveTargets(targetStr);
    if (!r.ok) return r;
    const targets = r.targets.filter((t) => this.installedOn(t).some((p) => p.name === name));
    if (!targets.length) { const desc = targetStr === 'all' ? '任何目标' : ('目标「' + (targetStr || 'native') + '」'); return { ok: false, error: desc + ' 未安装插件 ' + name }; }
    let latest = null;
    const c = this._updCache[name];
    if (c && (Date.now() - c.at) < this._updTTL) latest = c.latest;
    else {
      if (this.dist) { try { latest = await this.dist.fetchNpmLatest(name); } catch {} }
      this._updCache[name] = { latest, at: Date.now() };
    }
    if (!latest) return { ok: false, error: '无法获取 ' + name + ' 的最新版本（registry 不可达），请检查网络后重试' };
    const job = this._createJob('update', name, targetStr || 'native', targets);
    if (this.events) this.events.append('plugin_update_started', { name, jobId: job.id, target: job.target, targets: targets.map((t) => t.name) });
    let idx = 0;
    const next = () => {
      if (idx >= job.targets.length) {
        const failed = job.targets.filter((t) => t.state === 'failed');
        const ok = failed.length === 0;
        this._finishJob(job, ok, ok ? null : ((failed[0] && failed[0].error) || '部分目标失败'));
        if (this.events) {
          if (ok) this.events.append('plugin_update_done', { name, jobId: job.id });
          else this.events.append('plugin_update_job_failed', { name, jobId: job.id, error: (failed[0] && failed[0].error) || '部分目标失败' });
        }
        return;
      }
      const target = targets[idx], jt = job.targets[idx];
      jt.state = 'running';
      this._withScopeLock(target.id, async () => {
        let res;
        const installed = this.installedOn(target).find((x) => x.name === name);
        const specType = installed ? this._specType(installed.source) : 'npm';
        if (specType !== 'npm') {
          res = { ok: false, error: '本地/git 型插件不支持 registry 更新（spec: ' + (installed && installed.source) + '）' };
        } else if (!installed || !installed.version || semverCompare(String(latest), String(installed.version)) <= 0) {
          res = { ok: true, skipped: true, error: null };
          jt.log.push('已是最新版本（' + (installed && installed.version || '?') + '）');
        } else {
          res = await this._runCli(target, ['update', name + '@' + latest], { onLine: (l) => { jt.log.push(l); if (jt.log.length > 30) jt.log.shift(); } });
          if (!res.ok) {
            const addRes = await this._runCli(target, ['add', name + '@' + latest], { onLine: (l) => { jt.log.push(l); if (jt.log.length > 30) jt.log.shift(); } });
            if (addRes.ok) { res = { ok: true, error: null }; jt.log.push('已通过 add 确立依赖并更新'); }
          }
        }
        jt.state = res.ok ? 'done' : 'failed';
        jt.error = res.ok ? null : (res.error || '');
        if (!(res && res.skipped)) jt.log.push(res.ok ? '完成' : ('失败: ' + (res.error || '')));
        if (this.events) this.events.append(res.ok ? 'plugin_update_ok' : 'plugin_update_failed', { name, target: target.name, jobId: job.id, error: res.error });
        if (res.ok && !res.skipped) await this._applyPluginChange(target, 'update', (m) => jt.log.push(m));
      }).then(() => { idx++; next(); });
    };
    next();
    return { ok: true, jobId: job.id, target: job.target };
  }
  isProtected(name) { return PROTECTED.has(name); }
}

/** 从模块说明符推断所属包名；cordis: 前缀为内置无主。 */
function ownerPackage(moduleName, bundles) {
  if (!moduleName || String(moduleName).startsWith('cordis:')) return null;
  for (const b of bundles) if (String(moduleName).includes(b)) return b;
  return null;
}

module.exports = { PluginManager, PROTECTED };
