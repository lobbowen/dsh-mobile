'use strict';

// C 层内容清单的**取回与验签**（C 的通道）。
//
// 通道：<baseUrl>/userland-<channel>/userland-manifest.json(+.sig)，见 ./channel.json。
// 信任根：随**内核包**分发的 ./userland-public.pem（与内核 OTA 焊在 APK 的那把同一对；公钥是公开数据）。
//   信任流：签名内核（L1）→ 内核信任的公钥 → C 的签名清单。
// 签名对象＝**文件原始字节**（分离签名）。为什么不是 canonical JSON：验签发生在内核（JS），
//   它不该为此再复制一份 canonical —— 本仓已有两份（engine/src/sign.js 与设备端 kernel-verify.js），
//   第三份就是第三把尺子。签字节＝验字节：crypto.verify(null, raw, pubkey, sig)，零额外实现。
//
// 防重放：清单带 sequence（单调）与 expiresEpochMs；水位持久化在 $PREFIX/lib/toolchain/.manifest.json，
//   sequence 不得倒退、过期即拒（与内核 OTA 的 manifest 同一套纪律）。
// 失败语义：一切失败只 throw（调用方降级为 skipped），**绝不返回半份清单**。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const runtimeContract = require('./contract');
const ANCHOR = require('./channel.json');

const PUBKEY = fs.readFileSync(path.join(__dirname, 'userland-public.pem'), 'utf8');
const FETCH_TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache = null;

function base() { return String(ANCHOR.baseUrl).replace(/\/+$/, ''); }
function manifestUrl() { return base() + '/userland-' + ANCHOR.channel + '/' + ANCHOR.manifestName + '?t=' + Date.now(); }
function sigUrl() { return base() + '/userland-' + ANCHOR.channel + '/' + ANCHOR.sigName + '?t=' + Date.now(); }

/** 取文本（跟随重定向、有界、绝不含糊）。 */
function getText(url, timeoutMs, depth) {
  const d = depth || 0;
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = https.get(url, { timeout: timeoutMs }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && d < 5) {
          res.resume();
          return resolve(getText(new URL(res.headers.location, url).toString(), timeoutMs, d + 1));
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' <- ' + url)); }
        const chunks = [];
        res.on('data', (b) => chunks.push(b));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
    } catch (e) { return reject(e); }
    req.on('timeout', () => { try { req.destroy(); } catch {} reject(new Error('取件超时 ' + timeoutMs + 'ms')); });
    req.on('error', reject);
  });
}

function watermarkPath() {
  const c = runtimeContract.read();
  return c && c.prefix ? path.join(c.prefix, 'lib', 'toolchain', '.manifest.json') : null;
}
function readWatermark() {
  const p = watermarkPath();
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
/** 完整清单的落盘点（与水位同目录、不同文件）：水位只记「见过哪一序」，判据要用完整那份。 */
function fullManifestPath() {
  const c = runtimeContract.read();
  return c && c.prefix ? path.join(c.prefix, 'lib', 'toolchain', 'userland-manifest.json') : null;
}
function writeFullManifest(m) {
  const p = fullManifestPath();
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  } catch { /* 落不下不影响本次可用性 */ }
}
function readFullManifest() {
  const p = fullManifestPath();
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeWatermark(m) {
  const p = watermarkPath();
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ sequence: m.sequence, version: m.version, at: new Date().toISOString() }) + '\n');
  } catch { /* 水位写不下不影响本次可用性 */ }
}

/** 结构与语义校验：缺一项即拒（宁可不用清单，也不按半份清单投放）。 */
function validate(m) {
  if (!m || typeof m !== 'object') throw new Error('清单不是对象');
  if (m.schema !== 1) throw new Error('清单 schema 不认识: ' + m.schema);
  if (m.channel !== ANCHOR.channel) throw new Error('清单通道不符: ' + m.channel + ' ≠ ' + ANCHOR.channel);
  if (!Array.isArray(m.tools) || m.tools.length === 0) throw new Error('清单没有件（tools 空）');
  if (typeof m.sequence !== 'number') throw new Error('清单缺 sequence（无法防重放）');
  if (typeof m.expiresEpochMs !== 'number' || m.expiresEpochMs < Date.now()) throw new Error('清单已过期或缺有效期');
  const names = new Set();
  for (const t of m.tools) {
    if (!t || !t.name || !t.version || !t.sha256) throw new Error('件缺字段(name/version/sha256): ' + JSON.stringify(t).slice(0, 120));
    if (names.has(t.name)) throw new Error('件重名: ' + t.name);
    names.add(t.name);
  }
}

/** 取回并验签一份清单（带 TTL 缓存；opts.fresh 强制回源）。失败只 throw。 */
async function load(opts) {
  const o = opts || {};
  if (!o.fresh && _cache && (Date.now() - _cache.at) < CACHE_TTL_MS) return _cache.manifest;
  const body = await getText(manifestUrl(), o.timeoutMs || FETCH_TIMEOUT_MS, 0);
  const sigB64 = (await getText(sigUrl(), o.timeoutMs || FETCH_TIMEOUT_MS, 0)).trim();
  const ok = crypto.verify(null, Buffer.from(body, 'utf8'), PUBKEY, Buffer.from(sigB64, 'base64'));
  if (!ok) throw new Error('清单验签不过（信任根＝随内核分发的公钥）');
  const m = JSON.parse(body);
  validate(m);
  const wm = readWatermark();
  if (wm && typeof wm.sequence === 'number' && m.sequence < wm.sequence) {
    throw new Error('清单 sequence 倒退（' + m.sequence + ' < 已见 ' + wm.sequence + '）：按重放拒绝');
  }
  writeWatermark(m);
  writeFullManifest(m);   // 判据（tools[].verify）随件下发 —— 完整那份必须留在盘上，供同步消费方读
  _cache = { at: Date.now(), manifest: m };
  return m;
}

async function specFor(name, opts) {
  const m = await load(opts);
  return (m.tools || []).find((t) => t && t.name === name) || null;
}
async function toolNames(opts) {
  const m = await load(opts);
  return (m.tools || []).map((t) => t.name);
}
function resetCache() { _cache = null; }
/**
 * 已取回并验过的清单（没有则 null）。给**同步**消费方用（如能力探针）：不发起网络。
 *
 * 为什么回退读**盘上那份完整清单**（真机定罪 2026-09-28，kernel .39）：水位文件里只记
 *   {sequence,version,at}，而探针要在投放前后**任何时刻**读到 tools[].verify。只看进程内缓存时，
 *   重启后的首个探针永远读不到 ⇒ 面板上 C 层四格停在「清单尚未取回」，而件其实早装好了。
 */
function cached() {
  if (_cache) return _cache.manifest;
  const disk = readFullManifest();
  if (!disk) return null;
  try { validate(disk); } catch { return null; }   // 过期/残缺一律当没有，不按半份清单办事
  let at = Date.now();
  try { at = fs.statSync(fullManifestPath()).mtimeMs; } catch { /* 取不到 mtime 就用当下 */ }
  _cache = { at, manifest: disk };
  return disk;
}

module.exports = { load, specFor, toolNames, cached, resetCache, manifestUrl, sigUrl, validate };
