'use strict';

// 统一的「包发布/安装/更新」领域逻辑。
//
// 核心抽象：凡是从「外部发布通道」获取并安装软件的地方（DeepSeek Harness 自升级、
// 反向代理子应用），都共用同一套：
// - 全局 npm 镜像源配置（一个来源，自动适配国内网络/手动固定）
// - 版本检查（npm registry + GitHub Releases，按 channel 抽象）
// - 版本比较（semver）
// - 安装命令执行（注入选中镜像）
//
// 这样镜像源配置、版本检测、安装逻辑只有一份，不再各自旁路分支。
// 未来产品经 npm / GitHub 发布，也走这里。

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
// 平台知识唯一事实源（跨平台架构规范）：os/arch→标签映射只在 src/platform/matrix.js。
const matrix = require('../../platform/matrix');
const { spawn } = require('node:child_process');
// npm 的统一解析入口（经 platform/os/exec-path，避免各域硬编码 'npm'）。
const { npmBin } = require('../../platform/os/exec-path');
// 运行期启动契约（壳写、内核读）：npm/PATH 的**单一事实源**，与壳侧成对。
const runtimeContract = require('../../platform/runtime-contract');
// 镜像契约读取器（壳 → 内核）。**目录与探测方法的所有权在壳**：
// 用户在装壳那刻机器上没有内核，壳必须先完成镜像选择才能装内核，
// 故内核**消费壳投放的契约**，而不是自己再持一份硬编码副本。
const registryContract = require('../../platform/registry-contract');

/** 壳投放契约的重载 TTL（ms）。见 DistributionManager._reloadContractIfStale。 */
const CONTRACT_TTL_MS = 60 * 1000;
// 原「服务管理器抽象」（platform/os/service：systemd/launchd/windows-service Provider）
// 已随 PC 桌面壳删除：安卓内核没有系统服务管理器，原生 DSH 由内核直接 spawn/adopt，
// 健康验证只看**端口 + 稳定期**（见 waitPortHealthy）。

// 合法 semver（含 prerelease/build），杜绝脏版本号进比较/安装链路。
// 收紧：core 段禁止前导零（1.02.3 非法）、pre/build 标识符禁止连续/首尾点（rc..1 非法）
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** 简化 semver 比较：返回 >0 / 0 / <0。支持 1.2.3 与 1.2.3-rc.1 形态（prerelease < release）。
 * build metadata（+xxx）按规范忽略：1.0.0-rc.1+build5 与 1.0.0-rc.1 相等。 */
function semverCompare(a, b) {
  const parse = (v) => {
    const clean = String(v).split('+')[0]; // 剥离 build metadata（不参与比较）
    // P1-2 修复（2026-09-12）：按**第一个**连字符切分 core/prerelease。
    //
    // 缺陷：原为 `clean.split('-')` —— 那会**切出多段**，而解构 `[core, pre]`
    // 只取前两段，故 `1.0.0-beta-2` 得到 core='1.0.0'、pre='beta' ——
    // **`-2` 被丢弃**。于是 `1.0.0-beta-2` 与 `1.0.0-beta-1` 比较结果相等
    // （实测均为 0，应 >0）。
    // 而 `:30` 的 `VERSION_RE` 明确允许标识符内含连字符（`[0-9A-Za-z-]+`）——
    // 即正则与比较器对「合法版本号」的认知**互相矛盾**。
    //
    // 后果：`fetchNpmLatest` 取「最高版本」时会取错；
    // `guardSelfUpdateStatus` 的 `updateAvailable` 漏报更新。
    // 本仓自身版本 `0.1.5-BETA.1` 即该命名族（无内嵌连字符，暂未爆发；
    // 但 `-beta-1` / `-rc-2` 这类是常见命名）。
    //
    // 修法：只在**第一个**连字符处切分（`pre` 保留其余全部内容，交由下方
    // 既有的 prerelease 分段比较逻辑处理 —— 那段本来就是对的）。
    const dash = clean.indexOf('-');
    const core = dash === -1 ? clean : clean.slice(0, dash);
    const pre = dash === -1 ? '' : clean.slice(dash + 1);
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((A.nums[i] || 0) !== (B.nums[i] || 0)) return (A.nums[i] || 0) - (B.nums[i] || 0);
  }
  if (A.pre === B.pre) return 0;
  if (A.pre === '') return 1; // release > prerelease
  if (B.pre === '') return -1;
  const ap = A.pre.split('.');
  const bp = B.pre.split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (parseInt(x, 10) !== parseInt(y, 10)) return parseInt(x, 10) - parseInt(y, 10);
    } else if (xn !== yn) {
      return xn ? -1 : 1; // 数字段 < 字符串段（semver 规则）
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 「设备会装到哪个版本」的唯一判据：dist-tags 值全集 ∪ versions 键全集里的语义最高版。
 * 刻意不是 latest tag —— 实测 @deepseek-ai/dsh 的 latest 落后于 next（0.1.5-rc.3 vs 0.1.7-rc.2），
 * 新版本发在哪个 tag 上游随时会改，取全集才不受它影响。
 * 原生件供给门禁与此共用这一处判据，不允许出现第二份实现。 */
function pickHighestVersion(tagValues, versionKeys) {
  const candidates = new Set([...tagValues, ...versionKeys].filter((v) => typeof v === 'string' && VERSION_RE.test(v)));
  let best = null;
  for (const v of candidates) if (!best || semverCompare(v, best) > 0) best = v;
  return best;
}

/** 最小兜底镜像源 —— **仅契约缺失/损坏时使用**（2026-09-11 契约化）。
 *
 * ## 为什么从 6 条减到 2 条
 *
 * 原 6 条（npm 官方 / npmmirror / 华为 / 腾讯 / 中科大 / cnpmjs）在**三处**逐字节重复：
 * · 壳 `mirror.rs` `NPM_PRESETS`（**所有者**）
 * · 本文件原 `REGISTRY_PRESETS`（**已删除**）
 * · `platform/config.js` `registries`
 * 任何一处增删都会漂移，且实测已造成**两侧选源不一致**（探测方法不同）。
 *
 * 现目录归壳（经 `~/.dsh/supervisor/registry.json` 的 `catalog` 投放），
 * 内核只需保证「**契约不可用时也能跑**」（不变量 C2）——
 * 故保留 2 条覆盖两种基本情形：能上网（官方）+ 中国网络（npmmirror）。
 *
 * 完整目录与探测规格一律来自契约；此处**不参与**正常选择路径。
 */
const FALLBACK_REGISTRIES = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
];

/**
 * 统一分发管理器：全局镜像源配置 + 版本检查 + 安装执行。
 *
 * @param {object} opts
 * - registries: 候选镜像源（默认来自 config.registries）
 * - registryFile: 全局镜像配置持久化路径（mode/origins/manualOrigin）
 * - events: 事件总线（可选）
 * - logger
 */
class DistributionManager {
  constructor(opts) {
    this.events = opts.events || null;
    this.logger = opts.logger || console;
    this.registryFile = opts.registryFile || null;
    // 最小兜底（契约不可用时才用；见 FALLBACK_REGISTRIES 注释）。
    this.defaultRegistries = (opts.registries && opts.registries.length) ? opts.registries : [...FALLBACK_REGISTRIES];
    // 壳投放的镜像契约（目录 + 选择结果 + **探测规格**）。
    this.contract = { ok: false, reason: 'not-loaded', catalog: [], probe: null, selected: null };
    // 全局镜像配置：mode auto|manual，origins 候选，manualOrigin 手动固定。从 registryFile 加载。
    this.registryConfig = { mode: 'auto', origins: [...this.defaultRegistries], manualOrigin: this.defaultRegistries[0] || '' };
    this.selectedRegistry = null; // { origin, latencyMs, checkedAt, manual, source }
    // 必须同时记下「刚载入」的时刻，否则首次 _reloadContractIfStale 会把
    // undefined 当成「从未载入」而立刻再读一次（构造期白读一遍，且破坏 TTL 语义）。
    this._loadRegistryConfig();
    this._contractLoadedAt = Date.now();
  }

  // ---- 全局镜像配置持久化 ----
  /**
   * 载入镜像配置与**壳投放的契约**。
   *
   * 优先级（高 → 低）：
   * ① 用户在面板手动固定（`mode=manual`）—— 显式意图，最高优先；
   * ② 壳投放的契约 `catalog` —— 目录的所有者在壳；
   * ③ 构造参数 `opts.registries`；
   * ④ 最小兜底 `FALLBACK_REGISTRIES`。
   *
   * 契约不可用（缺失/坏 JSON/schema 更新/空目录）时**不阻断**：
   * 记录 reason 供诊断，选择路径自动回退到 ③/④（不变量 C2）。
   */
  /** 契约重载 TTL（ms）：壳会在运行中重写 registry.json，内核必须能看到。 */
  /** 若距上次载入超过 CONTRACT_TTL_MS 则重载壳投放的镜像契约。
   *
   * 为什么必须有（2026-09-13 P1）：`registryContract.read` 原先只在本类构造器调用一次，
   * 而壳在运行中会重写 registry.json（见 selectRegistry 处说明）→
   * 内核整个生命周期都用启动瞬间的 catalog/probe/selected/mode。
   * 为什么是 TTL 而非 fs.watch：契约读取在多个函数入口被调用，TTL 实现简单、
   * 无句柄泄漏、跨平台一致；60s 对「镜像选择」这种低频事实足够新。
   */
  _reloadContractIfStale() {
    const now = Date.now();
    if (this._contractLoadedAt && (now - this._contractLoadedAt) < CONTRACT_TTL_MS) return;
    this._loadRegistryConfig();
    this._contractLoadedAt = now;
  }

  _loadRegistryConfig() {
    // ① 先读契约（即使下面是 manual，也要拿到 probe 规格用于复测）
    this.contract = registryContract.read(this.registryFile);
    if (!this.contract.ok) {
      this.logger.warn && this.logger.warn(
        'dist: 镜像契约不可用（' + this.contract.reason + '），回退到最小兜底（' +
        this.defaultRegistries.length + ' 条）'
      );
      if (this.events) {
        try { this.events.append('dist_contract_unavailable', { reason: this.contract.reason, file: this.registryFile }); } catch {}
      }
    }

    // ② 旧字段（mode/manualOrigin/origins）保留读取，兼容 v1 与「内核自己写过的配置」
    if (!this.registryFile) return;
    try {
      if (!fs.existsSync(this.registryFile)) return;
      const doc = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
      if (typeof doc !== 'object' || !doc) return;
      // 候选集：契约 catalog 优先（壳是所有者），其次旧 origins，最后兜底。
      const fromContract = this.contract.ok ? this.contract.catalog : [];
      const fromDoc = (Array.isArray(doc.origins) && doc.origins.length) ? doc.origins : [];
      const origins = fromContract.length ? fromContract : (fromDoc.length ? fromDoc : [...this.defaultRegistries]);
      this.registryConfig = {
        mode: (doc.mode === 'manual') ? 'manual' : 'auto',
        origins,
        manualOrigin: (typeof doc.manualOrigin === 'string' && doc.manualOrigin)
          ? doc.manualOrigin : (origins[0] || ''),
      };
    } catch (e) { this.logger.warn && this.logger.warn('dist: registry config load failed: ' + e.message); }
  }

  /** 落盘 registry 配置。
   *
   * 2026-09-12（P2 修复）：**必须保留壳写入的 v2 字段**，只覆盖本内核拥有的三项。
   *
   * 背景：该文件（`~/.dsh/supervisor/registry.json`）的**所有者是桌面壳**
   * （`platform/registry-contract.js` 明确声明；理由：装壳时机器上还没有内核）。
   * 壳写入 v2 格式：`{ schema, writtenBy, catalog, probe, selected, mode, origins, manualOrigin }`；
   * 其中 `catalog`（全集）/`probe`（探测规格）/`selected`（选择结果）是**壳的产物**。
   *
   * 缺陷：本方法此前直接 `JSON.stringify(this.registryConfig)` —— 而 `registryConfig`
   * 只含 `{mode, origins, manualOrigin}`（见 `_loadRegistryConfig` 的重建）→
   * 一次 `POST /dist/registry/set` 就把壳的 v2 字段**全部抹掉**。
   * 而壳**确实会读回**该文件（`core.rs:150` 的镜像候选解析），
   * 故这会实际削弱壳自身的镜像解析能力。
   *
   * 修法：读回原文档 → 只覆盖内核拥有的三键 → 写回。
   * 「内核只消费契约」的纪律由此在**写路径**上也被遵守。
   */
  _saveRegistryConfig() {
    if (!this.registryFile) return;
    try {
      const dir = path.dirname(this.registryFile);
      if (dir && !fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch {} }
      (() => {
        try {
          const f = this.registryFile;
          const tmp = f + '.tmp';
          // 读回原文档（保留壳字段与任何未来新增字段）；读不到则从空对象起。
          let doc = {};
          try { const raw = fs.readFileSync(f, 'utf8'); const parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object') doc = parsed; } catch { /* 首次写入：无原文件 */ }
          // 只覆盖内核拥有的三键（其余原样保留）。
          doc.mode = this.registryConfig.mode;
          doc.origins = this.registryConfig.origins;
          doc.manualOrigin = this.registryConfig.manualOrigin;
          fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
          fs.renameSync(tmp, f);
        } catch (e) { /* 持久化失败不阻塞 */ }
      })()
    } catch (e) { this.logger.warn && this.logger.warn('dist: registry config save failed: ' + e.message); }
  }

  // ---- 镜像源探测/选择 ----
  /** 内核平台标签（用于展开契约的 pathTemplate；与壳的 package_name 同源）。
   *
   * 2026-09-12（P2）：原实现把「非 arm64」**静默当 x64** ——
   * 于是 ppc64le / s390x / ia32 等架构会按 x64 去取产物：
   * 轻则 404，重则**下载到架构不符的包**（比明确报错更糟）。
   * 现改为**白名单 + 未支持即抛**，与壳 `core.rs::package_name()` 同一形态
   * （那里 `other => return Err(...)`，此处对齐语义）。
   *
   * 注：本函数在 `_probeRegistry` 的 URL 展开路径上，抛错会被上层捕获
   * 并如实上报（见该函数的 try/catch），不会让守卫崩溃。
   */
  _platformTag() {
    // 2026-09-13（跨平台架构规范化）：**平台知识收口到 src/platform/matrix.js**。
    // 此处原有第二份 os/arch 映射表；现改为委托。
    // 错误文案由 matrix.npmTag 原样抛出 —— 它是既有对外契约
    // （test/arch-validation-test.js 断言其内容），不得改动。
    return matrix.npmTag();
  }

  /**
   * 探测单个 registry 的可达性 + 延迟。
   *
   * **探测 URL 由契约决定**（修复「两侧选源不一致」）：
   * 契约 `probe.kind='package-metadata'` → 与壳完全一致的**真实包元数据** URL；
   * 无契约 → 退回旧的 `/-/ping`（兜底，不阻断）。
   *
   * 为什么必须一致：实测同一镜像两种方法测出的延迟差 **6.7 倍**
   *（ustclug 2613ms vs 389ms），内核与壳因此**选到不同的源** ——
   * 用户看到「面板显示一个源、实际下载用另一个」。
   */
  async _probeRegistry(origin) {
    const base = origin.replace(/\/+$/, '');
    const spec = (this.contract && this.contract.ok && this.contract.probe) || null;
    let url = base + '/-/ping';
    let kind = 'ping';
    if (spec && spec.kind === 'package-metadata' && spec.pathTemplate) {
      url = base + '/' + spec.pathTemplate.replace('{platform}', this._platformTag());
      kind = spec.kind;
    }
    const timeoutMs = (spec && spec.timeoutMs) || 4000;
    const start = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      return { ok: res.ok, latencyMs: Date.now() - start, probe: kind };
    } catch (e) { return { ok: false, latencyMs: Date.now() - start, probe: kind }; }
  }

  /** 探测**单个** origin 的可达性与延迟（供面板「测试」按钮的同源调用）。
   *
   * 2026-09-13：新增。由 api/dist.js 的 `POST /dist/registry/probe` 调用 ——
   * 原因见那里的说明（页面 CSP `connect-src 'self'` 使浏览器直连镜像恒失败）。
   *
   * 关键：**复用 _probeRegistry**，即与内核选源使用**完全相同的探测规格**
   * （契约 probe.kind/pathTemplate 或退化的 /-/ping）—— 否则「测试按钮说可达」
   * 与「实际选源结果」会再次分叉（本仓已踩过同一镜像两种探测法差 6.7 倍的坑）。
   */
  async probeOrigin(origin) {
    const o = String(origin || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(o)) return { origin: o, ok: false, latencyMs: null, error: '非法 origin' };
    const p = await this._probeRegistry(o);
    return { origin: o, ok: !!p.ok, latencyMs: p.latencyMs, probe: p.probe };
  }

  /** 生效的候选 registry 列表（用户配置或默认）。 */
  _registryOrigins() {
    const o = (this.registryConfig && this.registryConfig.origins) || [];
    const list = o.filter((x) => typeof x === 'string' && x.trim());
    return list.length ? list : [...this.defaultRegistries];
  }

  /** 选一个可达且最快的 registry。mode=manual 时锁定 manualOrigin。TTL 缓存 30min。返回 origin。 */
  async selectRegistry(force) {
    // P1 修复（2026-09-13，失效模式 b+f+i）：**契约必须能重载**。
    //
    // 缺陷：`registryContract.read()` 与 `_loadRegistryConfig()` 全仓只在**构造器**
    // 各调用一次，无任何 reload/watch。而壳会在**运行中**重写 registry.json
    // （真实触发点：mirror.rs::export_on_boot 每次壳启动、commands/mod.rs:514 mirror_set、
    // node.rs:146 选中镜像后落盘）。
    // 后果：内核进程生命周期内永远看不到壳的新 catalog / probe 规格 / selected / mode ——
    // · 用**旧探测方法**自己重测 → 正是 registry-contract.js:23-28 声称已修复的
    // 「两侧选源不一致」；
    // · 面板手动设 manual 后，内核仍按 auto 走（若内核先启动）。
    // 修法：在**读入口**加 TTL 重载（60s）。主进程与 router-daemon 共用同一实现 →
    // 两侧自动一致；TTL 保证不会每次请求都读盘。
    this._reloadContractIfStale();
    const rc = this.registryConfig || {};
    if (rc.mode === 'manual' && rc.manualOrigin) {
      const origin = rc.manualOrigin.replace(/\/+$/, '');
      this.selectedRegistry = { origin, latencyMs: null, checkedAt: Date.now(), manual: true, probes: [] };
      return origin;
    }
    const now = Date.now();
    if (!force && this.selectedRegistry && !this.selectedRegistry.manual && this.selectedRegistry.checkedAt && (now - this.selectedRegistry.checkedAt) < 30 * 60 * 1000) return this.selectedRegistry.origin;
    // 优先采用**壳投放的选择结果**（2026-09-11 契约化）：
    // 壳已完成同轮测速（且用同一探测规格），内核无需再测一遍；
    // 仅当契约过期（超 TTL）或 force 时才自己复测。
    // 收益：正常路径零重复网络；且两侧**必然同源**（同一份 selected）。
    const c = this.contract;
    if (!force && c && c.ok && c.selected) {
      const age = Math.floor(Date.now() / 1000) - c.selected.checkedAt;
      if (age >= 0 && age < 30 * 60) {
        this.selectedRegistry = {
          origin: c.selected.origin, latencyMs: c.selected.latencyMs,
          checkedAt: Date.now(), manual: false, source: 'shell',
          probes: [],
        };
        if (this.events) {
          try { this.events.append('dist_registry_selected', { origin: c.selected.origin, source: 'shell-contract' }); } catch {}
        }
        return c.selected.origin;
      }
    }
    const origins = this._registryOrigins();
    const results = await Promise.all(origins.map(async (origin) => {
      const p = await this._probeRegistry(origin);
      return { origin, ok: p.ok, latencyMs: p.latencyMs };
    }));
    const reachable = results.filter((r) => r.ok).sort((a, b) => a.latencyMs - b.latencyMs);
    if (!reachable.length) {
      // 全部镜像不可达：返回 null（调用方降级 npm 默认源）且不缓存失败选择——
      // 旧实现仍选 origins[0] 并缓存 30min，安装会以不可达 registry 继续失败
      this.selectedRegistry = { origin: null, latencyMs: null, checkedAt: null, manual: false, probes: results };
      if (this.events) this.events.append('dist_registry_unreachable', { candidates: results.map((r) => r.origin + ':' + r.latencyMs + 'ms') });
      return null;
    }
    const picked = reachable[0];
    this.selectedRegistry = { origin: picked.origin, latencyMs: picked.latencyMs, checkedAt: Date.now(), manual: false, probes: results };
    if (this.events) this.events.append('dist_registry_selected', { origin: picked.origin, latencyMs: picked.latencyMs, candidates: results.map((r) => r.origin + ':' + r.latencyMs + 'ms') });
    return picked.origin;
  }

  /** 镜像源信息（供 UI/API 展示）。 */
  async registryInfo() {
    this._reloadContractIfStale();
    const origin = await this.selectRegistry(false);
    const rc = this.registryConfig || {};
    return {
      origin,
      mode: rc.mode || 'auto',
      manualOrigin: rc.manualOrigin || '',
      candidates: this._registryOrigins().map((o) => ({ origin: o })),
      // 预设 = 壳投放的目录（契约）；契约不可用时为空数组，
      // UI 应展示 candidates（实际候选）而非依赖 presets。
      presets: (this.contract && this.contract.ok) ? this.contract.catalog : [],
      catalogSource: (this.contract && this.contract.ok) ? (this.contract.writtenBy || 'shell') : 'fallback',
      latencyMs: (this.selectedRegistry && this.selectedRegistry.latencyMs) || null,
      checkedAt: (this.selectedRegistry && this.selectedRegistry.checkedAt) || null,
      manual: !!(this.selectedRegistry && this.selectedRegistry.manual),
      probes: (this.selectedRegistry && this.selectedRegistry.probes) || [],
    };
  }

  /** 保存全局镜像源配置（mode/手动源/候选），并立即重测。 */
  async setRegistryConfig(cfg) {
    const rc = this.registryConfig || {};
    if (cfg && typeof cfg === 'object') {
      if (cfg.mode === 'manual' || cfg.mode === 'auto') rc.mode = cfg.mode;
      if (typeof cfg.manualOrigin === 'string') rc.manualOrigin = cfg.manualOrigin.trim();
      if (Array.isArray(cfg.origins)) {
        const list = cfg.origins.map((x) => String(x).trim()).filter((x) => /^https?:\/\//.test(x));
        if (list.length) rc.origins = list;
      }
    }
    this.registryConfig = rc;
    this._saveRegistryConfig();
    this.selectedRegistry = null; // 清缓存，立即重测
    return this.registryInfo();
  }

  // ---- 版本检查 ----
  /** npm registry 最新版（用选中镜像；失败回退逐个候选；null 表示不可达）。 */
  async fetchNpmLatest(pkg, opts) {
    if (!pkg) return null;
    const o = opts || {};
    let origin = null;
    if (o.authoritative) {
      // 发布权威源解析（RC6 补充）：版本真相源 = 官方 npm registry。
      // ① 配置列表里显式配了官方源（生产 DEFAULTS 含 npmjs）→ 用它；
      // ② 测试/私有部署注入了非官方列表（如 mock）→ 尊重注入（可测试性优先）；
      // ③ 列表为空 → 默认官方。
      const official = this._registryOrigins().find((x) => /registry\.npmjs\.org/.test(x));
      origin = official || this._registryOrigins()[0] || 'https://registry.npmjs.org';
    } else {
      origin = await this.selectRegistry(false);
    }
    if (!origin) return null; // 全部镜像不可达：明确失败（checkUpdate 据此报错而非误报最新）
    try {
      // 完整版本检测：拉包完整元数据（dist-tags + versions），取最高版本——
      // 覆盖 latest/alpha/rc/next 全 tag（DeepSeek 新版本可能发布在 alpha 而非 latest）
      const res = await fetch(origin.replace(/\/+$/, '') + '/' + encodeURIComponent(pkg), { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return null;
      const j = await res.json();
      const tags = (j && j['dist-tags']) || {};
      const versions = (j && j.versions) ? Object.keys(j.versions) : [];
      const best = pickHighestVersion(Object.values(tags), versions);
      if (!best) {
        const lr = await fetch(origin.replace(/\/+$/, '') + '/' + encodeURIComponent(pkg) + '/latest', { signal: AbortSignal.timeout(8000) });
        if (!lr.ok) return null;
        const lj = await lr.json();
        return (lj && typeof lj.version === 'string' && VERSION_RE.test(lj.version)) ? lj.version : null;
      }
      return best;
    } catch (e) { return null; }
  }

  /** GitHub Releases 最新 tag（去除可选 v 前缀）。返回版本号。 */
  async fetchGithubLatest(owner, repo) {
    if (!owner || !repo) return null;
    try {
      const res = await fetch('https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/releases/latest', { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'dsh-supervisor' } });
      if (!res.ok) return null;
      const j = await res.json();
      const tag = (j && typeof j.tag_name === 'string') ? j.tag_name : (j && typeof j.name === 'string' ? j.name : null);
      if (!tag) return null;
      return String(tag).replace(/^v/, '');
    } catch (e) { return null; }
  }

  /**
   * 统一版本检查：channel = 'npm' | 'github'。返回最新版本字符串或 null。
   * @param {object} [opts] { authoritative?: boolean }
   * authoritative=true：直查发布权威源（registry.npmjs.org）——用于「我们自己发布」的包
   * （内核自更新等）：镜像（npmmirror 等）同步存在分钟~小时级延迟，把"镜像未同步"
   * 误判为"没有新版本"是真相源错误；镜像仅为安装下载流量服务（可容忍延迟）。
   * @returns Promise<string|null>
   */
  async fetchLatestVersion(pkg, channel, opts) {
    const ch = channel || 'npm';
    const o = opts || {};
    if (ch === 'github') {
      const slash = String(pkg).split('/');
      if (slash.length >= 2) return this.fetchGithubLatest(slash[0], slash.slice(1).join('/'));
      return null;
    }
    return this.fetchNpmLatest(pkg, { authoritative: o.authoritative === true });
  }

  /* ═══════ 安装执行器（统一 npm 安装）═══════
   * 收敛 native（全局 npm install -g）与沙箱（npm install -g --prefix <dir>）
   * 的 npm 安装执行：镜像注入 / 超时 / 行日志 / 退出码 / 进程树清理 全在此一份。
   * @param {object} opts
   * - pkg: 包名（npm 包标识）
   * - version: 目标版本（必须显式；npm 默认装 latest tag 可能不是最高版本）
   * - prefix: 可选；指定则 --prefix <dir>（沙箱独立安装），缺省为全局
   * - registry: 可选；注入 npm_config_registry
   * - timeoutMs: 超时（默认 600s）
   * - detached: 是否独立进程组（默认 true，便于 killTree）
   * - onLine: 可选行回调（逐行，已 trim 非空）
   * @returns Promise<{ ok, error, output }> */
  runNpmInstall(opts) {
    const o = opts || {};
    const pkg = o.pkg || require('../../platform/agent').load().npmPackage;
    if (!o.version) return Promise.resolve({ ok: false, error: 'runNpmInstall: 缺少 version（必须显式携带）', output: [] });
    // 唯一安装执行器：commandTemplate 支持完整替换命令（测试/特殊环境注入 fake-npm 等），
    // 收敛 native 旧 _runInstall 模板分支的重复 spawn/killTree/超时/行收集实现（2026-09 架构收敛）。
    let argv;
    // 统一解析入口：恒为 {bin, args} —— 安卓契约形态是「node 代跑 npm-cli.js」
    // （bin=libnode.so，args 首项=npm-cli.js），PC 无契约时退回 PATH 的 npm。
    // 旧实现硬编码可执行名，绕过了统一形态、且在 W^X 下 execve shim 必失败。
    const inv = runtimeContract.npmInvocation(npmBin);
    let bin = inv.bin;
    if (Array.isArray(o.commandTemplate) && o.commandTemplate.length) {
      argv = o.commandTemplate.map((s) => String(s).replace(/{pkg}/g, pkg).replace(/{version}/g, o.version).replace(/{prefix}/g, o.prefix || ''));
      // P1-C：模板首项通常是逻辑名 `npm`（见 platform/config.js 默认模板），
      // 必须走同一解析入口（含契约的 node 代跑前置参数）；保持模板机制不变
      // 是为了测试可注入 fake-npm 绝对路径 —— 首项非逻辑名时原样保留。
      if (argv[0] === 'npm') {
        bin = inv.bin;
        argv = inv.args.concat(argv.slice(1));
      } else {
        bin = argv[0];
        argv = argv.slice(1);
      }
    } else {
      // --ignore-scripts：容器无 sh 可 spawn（W^X），生命周期脚本既必失败又是供应链面。
      argv = inv.args.concat(['install', '-g', '--no-audit', '--no-fund', '--ignore-scripts']);
      if (o.prefix) argv.push('--prefix', o.prefix);
      argv.push(pkg + '@' + o.version);
    }
    // 契约环境注入：PATH（nodeBinDir 首位）+ 容器形态的显式全局 prefix。
    // 内核自身执行的 npm 子进程也必须能找到 node / 写进可写目录。
    const envVars = runtimeContract.npmEnv(process.env);
    if (o.registry) { envVars.npm_config_registry = o.registry; envVars.NPM_CONFIG_REGISTRY = o.registry; }
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: envVars, detached: o.detached !== false });
      } catch (e) {
        return resolve({ ok: false, error: e.message, output: [] });
      }
      const out = [];
      const killTree = () => {
        if (!child || child.exitCode !== null) return;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      };
      const timer = setTimeout(() => {
        killTree();
        resolve({ ok: false, error: '安装超时', output: out });
      }, o.timeoutMs || 600000);
      const onLine = (buf) => {
        for (const l of String(buf).split(/\r?\n/)) {
          const t = l.trim();
          if (!t) continue;
          out.push(t.slice(0, 200));
          if (o.onLine) { try { o.onLine(t.slice(0, 200)); } catch {} }
        }
      };
      child.stdout.on('data', onLine);
      child.stderr.on('data', onLine);
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message, output: out }); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, error: code === 0 ? null : 'npm install 退出码 ' + code, output: out });
      });
    });
  }

  /* ═══════ 健康验证器（端口 + 稳定期）═══════
   * 收敛原生升级后的启动验证：DSH 进程可能先监听端口、随后因插件兼容
   * 崩溃（如 dsh-mos 引用被移除的 API），只探测端口会误判成功——
   * 故端口就绪后仍需稳定期复检，防"延迟崩溃"。
   * @param {object} opts
   * - host: 默认 127.0.0.1
   * - port: 目标端口（必填）
   * - timeoutMs: 总等待上限（默认 60s）
   * - stabilityMs: 端口通过后的稳定期（默认 15s，期间再次确认端口仍存活）
   * @returns Promise<{ ok, reason }> */
  waitPortHealthy(opts) {
    const o = opts || {};
    const host = o.host || '127.0.0.1';
    const port = Number(o.port);
    if (!Number.isInteger(port) || port <= 0) return Promise.resolve({ ok: false, reason: 'waitPortHealthy: 非法端口 ' + o.port });
    const stabilityMs = o.stabilityMs !== undefined ? o.stabilityMs : 15000;
    const portListening = () => new Promise((resolve) => {
      const socket = net.connect({ host, port });
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try { socket.destroy(); } catch {}
        resolve(ok);
      };
      socket.setTimeout(1500);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
    const deadline = Date.now() + (o.timeoutMs || 60000);
    return (async () => {
      while (Date.now() < deadline) {
        if (await portListening()) {
          // 稳定期：插件加载可能在端口监听之后才失败，确认进程在稳定期后仍存活。
          // 修复（2026-09，实例升级恒判失败的另一根因）：原实现在「剩余时间 < stabilityMs」时
          // 直接 break 返回**失败**——但此刻端口/单元明明是健康的（只是探测来得晚）。
          // 慢启动实例（插件多/首次加载）端口在 25s 后就绪时会被误判「升级后未能启动」→ 触发
          // 不必要的回滚。现改为：用**剩余预算**做缩短的稳定期复检（不漏判、不超 deadline）。
          const remain = deadline - Date.now();
          const wait = Math.max(0, Math.min(stabilityMs, remain));
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          // 稳定期复查端口：进程在稳定期内崩溃 → 端口已空
          if (await portListening()) return { ok: true };
        }
        // 短眠前同样受 deadline 约束（剩余 <2s 不再空转一轮）
        const remain = deadline - Date.now();
        if (remain <= 0) break;
        await new Promise((r) => setTimeout(r, Math.min(2000, remain)));
      }
      return { ok: false, reason: '端口 ' + port + ' 未就绪' };
    })();
  }

}

module.exports = {
  DistributionManager,
  semverCompare,
  pickHighestVersion,
  VERSION_RE,
};
