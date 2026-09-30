'use strict';

// 自动取证（2026-09，下一步）：上游限流/拒绝响应的持久化证据。
// 动机：路由对上游错误分类/切换后，需要可事后核对的原始证据——状态码/响应头（retry-after 等）/
// 响应体/判定信号/处置动作，供对照「这次分类与切换是否合理」，也用于真实报错回归样本沉淀。
// 设计：纯基础设施，不含任何供应商语义（供应商语义归 provider.classifyResponse）。
//    - JSONL 追加（一记录一行），轮转：超过 maxBytes 把当前文件改名 <file>.1 再开新文件；
//    - 记录在写入前截断/过滤（体 MAX_BODY、响应头白名单），绝不含 Authorization/Cookie；
//    - 写入失败绝不抛出（取证是尽力而为的旁路，不影响主转发路径）。

const fs = require('node:fs');
const path = require('node:path');

/** 单文件上限（4MB ≈ 数千条失败记录；超限轮转到 .1）。 */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/** 证据体截断（字节）：足够看清错误码/关键 message，又不撑爆文件。 */
const MAX_BODY = 2048;
/** 响应头白名单：只保留与限额/恢复/排查相关的头，其余（含 set-cookie 等敏感项）一律不落盘。 */
const EVIDENCE_HEADERS = [
  'retry-after', 'x-ratelimit-reset-ms', 'x-ratelimit-type', 'x-ratelimit-limit', 'x-ratelimit-remaining',
  'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset',
  'x-request-id', 'request-id', 'content-type', 'date',
];

/** 从头对象取白名单头（兼容 node 小写键与原始大小写）。 */
function pickEvidenceHeaders(headers) {
  const out = {};
  const h = (headers && typeof headers === 'object') ? headers : {};
  for (const k of EVIDENCE_HEADERS) {
    let v = h[k];
    if (v === undefined && k !== k.toLowerCase()) v = h[k.toLowerCase()];
    if (v === undefined) {
      // 原始大小写（fixture / 其它运行时）：试 key 原样与标题式
      const lk = k.toLowerCase();
      for (const [hk, hv] of Object.entries(h)) {
        if (String(hk).toLowerCase() === lk) { v = hv; break; }
      }
    }
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v = v[0];
    if (v !== undefined) out[k] = String(v).slice(0, 200);
  }
  return out;
}

class UpstreamEvidence {
  constructor(opts) {
    const o = opts || {};
    if (!o.file) throw new Error('UpstreamEvidence: file required');
    this.file = o.file;
    this.maxBytes = o.maxBytes || DEFAULT_MAX_BYTES;
    this._rotated = 0;
  }

  /** 轮转（当前 → <file>.1；存在则覆盖旧的 .1）。 */
  rotate() {
    try { fs.rmSync(this.file + '.1', { force: true }); } catch {}
    try { fs.renameSync(this.file, this.file + '.1'); } catch {}
    this._rotated += 1;
  }

  _size() {
    try { return fs.statSync(this.file).size; } catch { return 0; }
  }

  /** 追加一条已脱敏的证据记录（调用方负责记录内容语义）。尽力而为：失败仅计数，不抛出。 */
  append(rec) {
    try {
      let line;
      try { line = JSON.stringify(rec); } catch { line = JSON.stringify({ ts: Date.now(), drop: 'unsafe record' }); }
      if (!line) return false;
      line += '\n';
      const dir = path.dirname(this.file);
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      if (this._size() + Buffer.byteLength(line) > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, line, { mode: 0o600 });
      return true;
    } catch { return false; }
  }

  /** 读取最后 n 条（解析失败的行跳过）。整个文件 ≤ maxBytes(4MB)，直接整读可接受。 */
  readTail(n) {
    const limit = (typeof n === 'number' && n > 0) ? n : 20;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const out = [];
      for (const l of raw.split('\n')) {
        if (!l.trim()) continue;
        try { const j = JSON.parse(l); out.push(j); } catch {}
      }
      return out.slice(-limit);
    } catch { return []; }
  }

  stats() {
    try {
      const st = fs.statSync(this.file);
      return { enabled: true, file: this.file, bytes: st.size, rotated: this._rotated, modifiedAt: st.mtimeMs };
    } catch {
      return { enabled: true, file: this.file, bytes: 0, rotated: this._rotated, modifiedAt: null };
    }
  }
}

module.exports = { UpstreamEvidence, pickEvidenceHeaders, MAX_BODY };
