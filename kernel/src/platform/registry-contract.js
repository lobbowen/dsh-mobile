'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 镜像契约读取器（**壳 → 内核**）
//
// 契约文件：`~/.dsh/supervisor/registry.json`，由**桌面壳**写。
//
// ## 为什么由壳写（所有权，非偏好）
//
// 用户在装壳那一刻机器上**没有内核** —— 内核是壳随后安装的。
// 壳必须先于内核完成镜像选择（否则连内核都装不上），故：
//   · 目录（catalog）与探测方法（probe）的**所有权在壳**；
//   · 内核**消费产物**，而不是自己持有一份硬编码副本。
//
// 此前内核在 `dist/index.js` 与 `platform/config.js` 各持一份 6 条镜像副本，
// 共 3 份（含壳）逐字节相同 —— 任何一处更新都会漂移。
//
// ## schema 版本
//
//   1 —— 仅 `mode` / `origins` / `manualOrigin`（旧格式，仍兼容）
//   2 —— 增加 `catalog`（全集）/ `selected`（选择结果）/ `probe`（探测规格）
//
// ## 关键设计：为什么 `probe` 必须随契约投放
//
// 修复「两侧选源不一致」：内核原用 `GET <origin>/-/ping`、壳用真实包元数据，
// 同一镜像测出的延迟可差 **6.7 倍**（实测 ustclug 2613ms vs 389ms）——
// 于是内核选 huaweicloud、壳选 npmmirror，**用户看到「面板显示一个源、实际用另一个」**。
// 把探测规格随契约投放，内核照做即可得到同一答案。
//
// ## 契约缺失/损坏时的行为（不变量 C2）
//
// **内核必须能降级运行**：契约不可用时返回 `{ ok:false, reason }`，
// 调用方回退到最小兜底（`config.registries`）—— 绝不因此启动失败。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');

/** 本内核支持的契约版本。 */
const SUPPORTED_SCHEMA = 2;

/** 契约缺失/不可用时的理由码（供事件与诊断）。 */
const REASON = {
  NO_FILE: 'contract-missing',
  BAD_JSON: 'contract-bad-json',
  BAD_SHAPE: 'contract-bad-shape',
  SCHEMA_NEWER: 'contract-schema-newer',
  EMPTY_CATALOG: 'contract-empty-catalog',
};

/** 规范化一个 origin（去尾斜杠）。 */
function normOrigin(x) {
  return typeof x === 'string' ? x.trim().replace(/\/+$/, '') : '';
}

/** 合法 https 源列表（过滤脏数据；契约来自文件，必须防御）。 */
function sanitizeOrigins(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const o = normOrigin(x);
    if (/^https?:\/\//.test(o) && !out.includes(o)) out.push(o);
  }
  return out;
}

/**
 * 读取镜像契约。
 *
 * @param {string} file registry.json 路径
 * @returns {{
 *   ok: boolean, reason: string|null, schema: number|null, writtenBy: string|null,
 *   catalog: string[], probe: object|null, selected: object|null,
 *   mode: string, manualOrigin: string
 * }}
 */
function read(file) {
  const empty = {
    ok: false, reason: REASON.NO_FILE, schema: null, writtenBy: null,
    catalog: [], probe: null, selected: null,
    mode: 'auto', manualOrigin: '',
  };
  if (!file) return Object.assign({}, empty, { reason: REASON.NO_FILE });
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return empty; }
  let doc;
  try { doc = JSON.parse(raw); } catch { return Object.assign({}, empty, { reason: REASON.BAD_JSON }); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return Object.assign({}, empty, { reason: REASON.BAD_SHAPE });
  }

  const mode = doc.mode === 'manual' ? 'manual' : 'auto';
  const manualOrigin = normOrigin(doc.manualOrigin);
  const schema = Number.isInteger(doc.schema) ? doc.schema : 1;

  // 契约比本内核新 → 不猜格式，明确拒绝（不变量 C3）。
  if (schema > SUPPORTED_SCHEMA) {
    return Object.assign({}, empty, { reason: REASON.SCHEMA_NEWER, schema, mode, manualOrigin });
  }

  // v2：优先 catalog；v1 只有 origins —— 两者都接受，实现平滑升级。
  const catalog = sanitizeOrigins(doc.catalog);
  const origins = sanitizeOrigins(doc.origins);
  const list = catalog.length ? catalog : origins;
  if (!list.length) {
    return Object.assign({}, empty, { reason: REASON.EMPTY_CATALOG, schema, mode, manualOrigin });
  }

  // probe：校验到「可用」为止，形状不对就当没有（回退 /-/ping）。
  let probe = null;
  if (doc.probe && typeof doc.probe === 'object' && typeof doc.probe.kind === 'string') {
    probe = {
      kind: doc.probe.kind,
      pathTemplate: typeof doc.probe.pathTemplate === 'string' ? doc.probe.pathTemplate : null,
      timeoutMs: Number.isFinite(doc.probe.timeoutMs) && doc.probe.timeoutMs > 0
        ? Math.min(Math.max(doc.probe.timeoutMs, 1000), 20000) : 6000,
    };
  }

  // selected：须为合法 origin，且 checkedAt 为数字（用于 TTL 判定）。
  let selected = null;
  if (doc.selected && typeof doc.selected === 'object') {
    const origin = normOrigin(doc.selected.origin);
    const checkedAt = Number(doc.selected.checkedAt);
    if (origin && /^https?:\/\//.test(origin) && Number.isFinite(checkedAt) && checkedAt > 0) {
      selected = {
        origin,
        latencyMs: Number.isFinite(doc.selected.latencyMs) ? doc.selected.latencyMs : null,
        checkedAt,
      };
    }
  }

  return {
    ok: true, reason: null,
    schema,
    writtenBy: typeof doc.writtenBy === 'string' ? doc.writtenBy : null,
    catalog: list,
    probe,
    selected,
    mode,
    manualOrigin,
  };
}

module.exports = { read, SUPPORTED_SCHEMA, REASON };