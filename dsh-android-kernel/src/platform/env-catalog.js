'use strict';

// EnvCatalog：声明式环境目录（Phase2 收口）。
// 每条目 = { id, label, required, probe() → ok?detail }；状态机 ok/missing/unconfigured。
// 消费方：supervisor.envStatus/dshenvStatus/面板环境卡；壳负责 Node 前置安装，catalog 负责陈述+判定。

const fs = require('node:fs');
const ex = require('./exec');

/** 探测某二进制版本；不可执行返回 null。 */
function whichVersion(bin) {
  // 经统一执行器（默认有界；失败返回 null）。
  const v = ex.runOut(bin, ['--version'], { timeoutMs: 3000 });
  return v ? (v.trim() || null) : null;
}

// 版本探测结果缓存（TTL 10s）：envStatus 的 probe + summary 会在单次 API 调用内重复探测 3+ 次，
// 每次都是同步 execFileSync（node/npm/git）——磁盘/进程占用且阻塞事件循环（2026-09 审计修复）。
const _verCache = new Map();
const CACHE_TTL = 10000;
function cachedWhichVersion(bin) {
  const hit = _verCache.get(bin);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL) return hit.v;
  const v = whichVersion(bin);
  _verCache.set(bin, { at: now, v });
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
 * ⚠ 必须与壳的 `node.rs MIN_NODE` 一致 —— 否则会出现最糟的用户体验：
 *   **面板说「环境就绪 ✅」，而壳因门槛不满足拒绝启动内核。**
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
  const c = require('./runtime-contract').read();
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
  const v = cachedWhichVersion('node');
  if (!v) return null;
  // `node --version` 输出形如 v22.12.0；取第一个 vX.Y.Z 片段。
  const m = /v?(\d+\.\d+\.\d+)/.exec(String(v));
  const ver = m ? m[1] : String(v).trim();
  const min = String(runtimeMeta().minNode || MIN_NODE_DEFAULT);
  return { version: 'v' + ver, min, meets: verAtLeast(ver, min) };
}

/** 系统环境条目（必要前置：Node/npm 为 DSH 与反代更新的执行器；git 可选）。 */
const SYSTEM_ENTRIES = {
  node: { label: 'Node.js', required: true, probe: probeNode },
  npm:  { label: 'npm',     required: true, probe: () => cachedWhichVersion('npm') },
  git:  { label: 'git',     required: false, probe: () => cachedWhichVersion('git') },
};

class EnvCatalog {
  constructor(config) { this.config = config || {}; }

  /**
   * 系统二进制条目探测：`{id:{label,required,state,detail}}`。
   *
   * `state` 三态：
   *   · `ok`       —— 存在且**满足门槛**（Node 需 >= 壳投放的 minNode）；
   *   · `outdated` —— 存在但低于门槛（**旧实现会误报 ok → 面板谎报「环境就绪」**）；
   *   · `missing`  —— 不存在。
   *
   * ⚠ 兼容：`detail` 保持字符串（既有消费方按字符串用），
   *   新增字段放 `detail` 之外（`version` / `min` / `meets`），不破坏既有契约。
   */
  probe() {
    const out = {};
    for (const [id, e] of Object.entries(SYSTEM_ENTRIES)) {
      const v = e.probe() || null;
      if (v && typeof v === 'object' && typeof v.meets === 'boolean') {
        // Node 这类「有门槛」的条目：三态判定。
        out[id] = {
          label: e.label, required: e.required,
          state: v.meets ? 'ok' : 'outdated',
          version: v.version, min: v.min, meets: v.meets,
          detail: v.meets ? v.version : (v.version + '（低于最低要求 ' + v.min + '）'),
        };
      } else {
        out[id] = { label: e.label, required: e.required, state: v ? 'ok' : 'missing', detail: v };
      }
    }
    return out;
  }

  // ⚠ selfUpdateEntry()（内核 npm 子包 corePackageName 条目）已删：
  //   安卓内核不经 npm 分发，更新 = 容器 OTA；内核侧不报告"内核包是否配置"。

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
   *  @param extra 附加条目（dsh）
   *  @param sys 可选：已探测的系统条目（避免调用方已 probe 后又重 probe——2026-09 审计修复）
   *  无 sys 时探测一次（探测结果有 10s TTL 缓存）。 */
  summary(extra, sys) {
    const s = sys || this.probe();
    const items = { ...s, ...(extra || {}) };
    const required = Object.values(items).filter((e) => e && e.required);
    return { ready: required.every((e) => e.state === 'ok' || e.state === 'configured'), items };
  }
}

module.exports = { EnvCatalog };