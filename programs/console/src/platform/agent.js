'use strict';

// 产品声明（F）的**内核侧残留**：解析顺序 + schema 校验 + 默认值。
//
// 分层（ADR-0009 §2.1 / §3）：
//   · **实例**（某产品实际用的那份声明）住**产品侧**：<状态根>/agents/<id>.json ——
//     随产品走、可被产品安装器/运维改写，**不需要发内核**。
//   · 内核只留 **schema + 默认值**（./agent-defaults.json）与解析机制（本文件）。
//   · 首次缺实例时以默认值**播种**一次（幂等）；此后该文件归产品侧所有，内核不再覆盖。
//
// 为什么实例不能住内核：包名/入口/profile/数据目录/启动参数是**产品契约**，改它等于改产品行为；
//   若它住内核，运维每调一次启动参数都要发一次内核 OTA（这正是 2026-09-27 定罪的越层）。
//
// 失败语义（与内核其它平台件一致）：**绝不因声明缺失/损坏而启动失败**。
//   · 实例缺失 → 播种；播种失败（只读等）→ 内存里用默认值；
//   · 实例损坏/不合规 → 用默认值并如实标记 source，**不覆盖**运维可能手改的那份文件。

const fs = require('node:fs');
const path = require('node:path');
const stateRoot = require('./state-root');

const DEFAULTS = require('./agent-defaults.json');
const DEFAULT_ID = 'lobos';
const REQUIRED = ['id', 'npmPackage', 'entry', 'profileName', 'homeDirName'];
let cached = null;

/** 产品侧实例文件（声明实例的家；内核只在这一处读写）。 */
function instanceFile(id) {
  return path.join(stateRoot.root(), 'agents', (id || DEFAULT_ID) + '.json');
}

function defaultsFor(id) {
  const d = (DEFAULTS.products || {})[id];
  if (!d) throw new Error('内核默认值里没有该产品: ' + id);
  return JSON.parse(JSON.stringify(d));
}

/** schema 校验 + 补默认空集合（产品侧手改也要过得去，不合规即视为损坏）。 */
function normalize(d, srcLabel) {
  for (const k of REQUIRED) {
    if (!d || typeof d[k] !== 'string' || !d[k]) throw new Error('声明缺字段 ' + k + '（' + srcLabel + '）');
  }
  d.dataPaths = Array.isArray(d.dataPaths) ? d.dataPaths : [];
  d.protectedPackages = Array.isArray(d.protectedPackages) ? d.protectedPackages : [];
  d.android = (d.android && typeof d.android === 'object' && !Array.isArray(d.android)) ? d.android : {};
  d.android.launchFlags = Array.isArray(d.android.launchFlags)
    ? d.android.launchFlags.filter((x) => typeof x === 'string' && x.length > 0)
    : [];
  return d;
}

function readFileOrNull(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/** 幂等播种：只有实例**不存在**时才写（存在即归产品侧所有，绝不覆盖）。 */
function seed(id, d) {
  const p = instanceFile(id);
  if (readFileOrNull(p) !== null) return 'exists';
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
    return 'seeded';
  } catch { return 'unwritable'; }
}

/**
 * 载入某产品的声明。**不抛**（缺/坏一律退回默认值），用 source 如实说明来源。
 * @param {string} [id] 产品 id（缺省 LOBOS_AGENT 或 'lobos'）
 * @returns {{id:string, source:string, file:string}} 声明（含诊断字段 source/file）
 */
function load(id) {
  const want = id || process.env.LOBOS_AGENT || DEFAULT_ID;
  if (cached && cached.id === want && cached.file === instanceFile(want)) return cached;
  const file = instanceFile(want);
  let out = null;
  const text = readFileOrNull(file);
  if (text !== null) {
    try { out = normalize(JSON.parse(text), file); out.source = 'product'; }
    catch (e) {
      const fb = normalize(defaultsFor(want), 'defaults');
      fb.source = 'default(corrupt: ' + e.message + ')';
      fb.file = file;
      cached = fb;
      return fb;
    }
  }
  if (!out) {
    const fb = normalize(defaultsFor(want), 'defaults');
    const how = seed(want, fb);
    fb.source = how === 'seeded' ? 'seeded' : (how === 'exists' ? 'default(实例不可读)' : 'default(播种失败)');
    out = fb;
  }
  out.file = file;
  cached = out;
  return out;
}

module.exports = { load, instanceFile, DEFAULT_ID, DEFAULTS };
