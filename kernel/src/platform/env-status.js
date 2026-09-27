'use strict';

// EnvStatus：环境状态**投影**（2026-09-27 单一来源收口）。
//
// 目录（有哪些环境条目、各自可执行名、是否就绪前置）**只有一份**：E 的登记表
//   `../assembler/supply-table.json#envUnits`（它同时带处置、能力判据与落位出口）。
// 本模块**不再自持条目表** —— 只做两件事：① 把目录投影成面板/守卫要的三态视图；
//   ② 提供探测实现（版本查询；node 另需达壳投放的最低门槛）。
// 为什么原来有两份就是债：同一件事（环境里有没有这个件）在两个地方各说一遍，
//   加一件工具要改两处、两处还会漂移（正是「一把尺子」纪律要消掉的东西）。
// 消费方：supervisor.envStatus/dshenvStatus/面板环境卡。

const ex = require('./exec');
const TABLE = require('../assembler/supply-table.json');
// 单一事实源：node/npm 的可执行形态由容器投放的运行契约决定（安卓 W^X 下
// npm 只能由 node 代跑），ambient PATH 仅作无契约时的降级回退。
const rc = require('./runtime-contract');

/** 探测某命令版本（args 缺省 ['--version']）；不可执行返回 null。 */
function whichVersion(bin, args) {
  // 经统一执行器（默认有界；失败返回 null）。
  const v = ex.runOut(bin, args || ['--version'], { timeoutMs: 3000 });
  return v ? (v.trim() || null) : null;
}

// 版本探测结果缓存（TTL 10s）：envStatus 的 probe + summary 会在单次 API 调用内重复探测 3+ 次，
// 每次都是同步 execFileSync（node/npm/git）——磁盘/进程占用且阻塞事件循环（2026-09 审计修复）。
const _verCache = new Map();
const CACHE_TTL = 10000;
function cachedWhichVersion(bin, args) {
  // 键含参数：同一 bin 在不同调用形态（如 node 直跑 vs 带脚本）下结果不同。
  const key = bin + '\u0000' + (args || []).join('\u0000');
  const now = Date.now();
  const hit = _verCache.get(key);
  if (hit && now - hit.at < CACHE_TTL) return hit.v;
  const v = whichVersion(bin, args);
  _verCache.set(key, { at: now, v });
  if (_verCache.size > 16) { // 有界：清最旧
    let oldest = null;
    for (const [k, e] of _verCache) if (!oldest || e.at < oldest.at) oldest = { k, at: e.at };
    if (oldest) _verCache.delete(oldest.k);
  }
  return v;
}

/**
 * Node 最低版本门槛的**默认值**（契约不可用时使用）。
 *
 * 必须与壳的 `node.rs MIN_NODE` 一致 —— 否则会出现最糟的用户体验：
 * **面板说「环境就绪 」，而壳因门槛不满足拒绝启动内核。**
 * 真实取值由壳经 `~/.dsh/supervisor/runtime.json` 的 `minNode` 字段投放（见 runtimeMeta）。
 */
const MIN_NODE_DEFAULT = 'v22.12.0';

/** 读取壳投放的运行时元数据（`~/.dsh/supervisor/runtime.json`，**壳写内核读**）。 */
let _runtimeMetaCache = null;
let _runtimeMetaAt = 0;
function runtimeMeta() {
  const now = Date.now();
  if (_runtimeMetaCache && now - _runtimeMetaAt < 10000) return _runtimeMetaCache;
  // 单一事实源：与内核其它消费点共用 platform/runtime-contract（壳写、内核读）。
  const c = rc.read();
  const meta = (c && c.raw) || {};
  _runtimeMetaCache = meta;
  _runtimeMetaAt = now;
  return meta;
}

/** 解析形如 `v22.12.0` / `22.12.0` 的版本为数字数组（非数字段记 0）。 */
function parseVer(v) {
  return String(v).replace(/^v/i, '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0);
}

/** a >= b ? true : false（段数不同时缺位补 0）。 */
function verAtLeast(a, b) {
  const A = parseVer(a); const B = parseVer(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i] || 0; const y = B[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Node 探测：**不仅要能执行，还要达到最低门槛**。
 *
 * 旧实现只判 `which node` 是否成功 → 装了 v18 也报 ok，
 * 而壳的引导会因门槛不满足拒绝启动内核。现判据与壳对齐。
 *
 * @returns {{version:string, min:string, meets:boolean}|null}
 */
function probeNode() {
  const v = cachedWhichVersion(rc.nodeBin('node'), ['--version']);
  if (!v) return null;
  // `node --version` 输出形如 v22.12.0；取第一个 vX.Y.Z 片段。
  const m = /v?(\d+\.\d+\.\d+)/.exec(String(v));
  const ver = m ? m[1] : String(v).trim();
  const min = String(runtimeMeta().minNode || MIN_NODE_DEFAULT);
  return { version: 'v' + ver, min, meets: verAtLeast(ver, min) };
}

/** 目录（唯一来源）：有可执行名的条目才是「二进制条目」；tmp-redirect 那类运行时检查不属于这里。
 *  required 是**就绪前置**语义：只有内核自身执行所必需的那几件才卡「环境就绪」。 */
const ENTRIES = (TABLE.envUnits || []).filter((u) => u && typeof u.bin === 'string' && u.bin);

/** 特殊探测：node 需达最低门槛；npm 走契约（安卓由 node 代跑 npm-cli.js，无契约退回 ambient）。 */
const SPECIAL = {
  'env-node': () => probeNode(),
  'env-npm': () => {
    const inv = rc.npmInvocation('npm');
    return cachedWhichVersion(inv.bin, inv.args.concat(['--version']));
  },
};

class EnvStatus {
  constructor(config) { this.config = config || {}; }

  /**
   * 系统二进制条目探测：`{id:{label,required,state,detail}}`。
   *
   * `state` 三态：
   * · `ok` —— 存在且**满足门槛**（Node 需 >= 壳投放的 minNode）；
   * · `outdated` —— 存在但低于门槛（**旧实现会误报 ok → 面板谎报「环境就绪」**）；
   * · `missing` —— 不存在。
   *
   * 兼容：`detail` 保持字符串（既有消费方按字符串用），
   * 新增字段放 `detail` 之外（`version` / `min` / `meets`），不破坏既有契约。
   */
  probe() {
    const out = {};
    for (const u of ENTRIES) {
      // 视图键去掉 env- 前缀，与既有消费方（面板/API）保持兼容：env-node → node。
      const id = u.id.replace(/^env-/, '');
      const label = u.capability || u.id;
      const required = u.required === true;
      const fn = SPECIAL[u.id] || (() => cachedWhichVersion(u.bin));
      const v = fn() || null;
      if (v && typeof v === 'object' && typeof v.meets === 'boolean') {
        // Node 这类「有门槛」的条目：三态判定。
        out[id] = {
          label, required,
          state: v.meets ? 'ok' : 'outdated',
          version: v.version, min: v.min, meets: v.meets,
          detail: v.meets ? v.version : (v.version + '（低于最低要求 ' + v.min + '）'),
        };
      } else {
        out[id] = { label, required, state: v ? 'ok' : 'missing', detail: v };
      }
    }
    return out;
  }

  // selfUpdateEntry()（内核 npm 子包 corePackageName 条目）已删：
  // 安卓内核不经 npm 分发，更新 = 容器 OTA；内核侧不报告"内核包是否配置"。

  /** DSH 本体条目（外传判定：bin 可执行 + 已装版本）。 */
  dshEntry(binOk, installed, bin) {
    return {
      label: 'DSH 本体',
      required: true,
      state: binOk ? 'ok' : 'missing',
      detail: binOk ? (installed || '已装') : ('bin 不存在: ' + (bin || '?')),
    };
  }

  /** 汇总：全部必填项状态（供面板/守卫快速判定「环境就绪」）。
   * @param extra 附加条目（dsh）
   * @param sys 可选：已探测的系统条目（避免调用方已 probe 后又重 probe——2026-09 审计修复）
   * 无 sys 时探测一次（探测结果有 10s TTL 缓存）。 */
  summary(extra, sys) {
    const s = sys || this.probe();
    const items = { ...s, ...(extra || {}) };
    const required = Object.values(items).filter((e) => e && e.required);
    return { ready: required.every((e) => e.state === 'ok' || e.state === 'configured'), items };
  }
}

module.exports = { EnvStatus };