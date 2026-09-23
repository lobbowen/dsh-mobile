'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 事件日志：append-only JSONL，每行 { seq, ts, type, data }。
 * seq 从既有日志最大序号续号，供 /events?after= 增量拉取。
 * 按大小轮转：超过 maxBytes 时当前文件改名为 <file>.1（保留一代），
 * seq 全局单调递增，跨轮转的增量读取由 readSince 同时扫描两代文件。
 *
 * 跨守卫重启连续性（架构级修复）：
 *  - seq / rotatedSeq 实时持久化到 <file>.meta.json（原子写，每次 append 后更新）；
 *  - 重启后从 meta 恢复，保证 (a) seq 全局单调不重号 (b) 已轮转的 .1 文件仍参与
 *    增量读取（旧实现 rotatedSeq 仅内存态，重启后 .1 事件永久不可见）；
 *  - meta 缺失/损坏时回退到「扫描当前文件」的旧行为（向后兼容，不丢新事件）。
 */
class Events {
  constructor(file, maxBytes, opts) {
    this.file = file;
    this.maxBytes = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : 5 * 1024 * 1024;
    // 系统日志框架（历史设计文档）：行级 producer.process（additive）——
    // 由事件文件所属进程注入（守卫/daemon），跨进程聚合/审计据此区分来源。
    this.process = (opts && opts.process) || null;
    this.rotatedSeq = null; // 旧文件（.1）中最后一条事件的 seq
    this.seq = 0;
    this.metaFile = file ? file + '.meta.json' : null;
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
      } catch {}
      if (!this._loadMeta()) {
        // meta 不可用（首次运行 / 被删 / 损坏）：回退扫描当前文件续号。
        // 兼容旧数据：无 meta 时 rotatedSeq 未知 → .1 不参与增量读取（旧行为）。
        this.seq = this._maxSeq();
      }
    }
  }

  /** 从 meta 恢复 seq / rotatedSeq。成功返回 true。 */
  _loadMeta() {
    if (!this.metaFile) return false;
    try {
      const m = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
      if (typeof m !== 'object' || !m) return false;
      if (typeof m.seq === 'number' && m.seq >= 0) this.seq = m.seq;
      if (typeof m.rotatedSeq === 'number' && m.rotatedSeq >= 0) this.rotatedSeq = m.rotatedSeq;
      return true;
    } catch { return false; }
  }

  /** 持久化 meta（原子写：tmp + rename）。失败仅记日志，不影响事件主流程。 */
  _saveMeta() {
    if (!this.metaFile) return;
    try {
      const tmp = this.metaFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ seq: this.seq, rotatedSeq: this.rotatedSeq }));
      fs.renameSync(tmp, this.metaFile);
    } catch (e) {
      console.error('[events] meta save failed:', e.message);
    }
  }

  _maxSeq() {
    let max = 0;
    // 回退路径（meta 缺失/损坏）必须同时扫描 .1：若刚轮转过，当前文件为空而 .1 含全部旧 seq，
    // 只扫当前文件会把 seq 从 0 重计 → 新事件与 .1 重号 → readSince 合并出现重复/乱序。
    for (const f of [this.file + '.1', this.file]) {
      try {
        const lines = fs.readFileSync(f, 'utf8').split('\n');
        for (const l of lines) {
          if (!l.trim()) continue;
          try {
            const e = JSON.parse(l);
            if (typeof e.seq === 'number' && e.seq > max) max = e.seq;
          } catch {}
        }
      } catch {}
    }
    return max;
  }

  _rotateIfNeeded() {
    try {
      let size = 0;
      try {
        size = fs.statSync(this.file).size;
      } catch {
        return; // 文件尚不存在
      }
      if (size < this.maxBytes) return;
      const backup = this.file + '.1';
      // POSIX rename 到已存在路径是原子覆盖——不 unlink（旧实现 unlink+rename 两步
      // 在中间崩溃会丢一代事件）。直接 rename 一步到位。
      fs.renameSync(this.file, backup);
      this.rotatedSeq = this.seq;
      this._saveMeta();
    } catch (e) {
      console.error('[events] rotate failed:', e.message);
    }
  }

  /** 系统日志框架（P1b）：守卫把本事件流接入 EventHub 后，append 同步转写聚合流（守卫事件零延迟可见）。 */
  attachHub(hub) {
    this._hub = hub;
  }

  append(type, data) {
    const rec = { type, data: data ?? null };
    return this.appendRaw(rec);
  }

  /** 追加原始记录（系统日志框架 P1b：EventHub 聚合转写用）——注入 seq/ts/producer，保留其余字段。 */
  appendRaw(rec) {
    this.seq += 1;
    this._rotateIfNeeded();
    const out = Object.assign({}, rec || {});
    out.seq = this.seq;
    if (!out.ts) out.ts = new Date().toISOString();
    if (this.process && !out.producer) out.producer = { process: this.process };
    const line = JSON.stringify(out);
    let wrote = true;
    try {
      fs.appendFileSync(this.file, line + '\n');
    } catch (e) {
      wrote = false;
      console.error('[events] append failed:', e.message);
    }
    this._saveMeta();
    // 写盘失败可观测（供 EventHub 水位不推进、下轮补齐——RC5.2 契约；原实现恒吞错误使水位虚进）。
    this._lastAppendOk = wrote;
    // 守卫事件零延迟可见：若已接 EventHub，同步推入聚合流（守卫文件与聚合流同进程单写，无多写者）。
    if (this._hub && typeof this._hub.pushGuard === 'function') {
      try { this._hub.pushGuard(out); } catch (e2) { console.error('[events] hub push failed:', e2 && e2.message); }
    }
    return this.seq;
  }

  readSince(after = 0, limit = 50) {
    after = Number(after) || 0;
    limit = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const out = [];
    const scan = (file, needed) => {
      if (!needed) return;
      try {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        for (const l of lines) {
          if (!l.trim()) continue;
          try {
            const e = JSON.parse(l);
            if (e.seq > after) out.push(e);
          } catch {}
        }
      } catch {}
    };
    // 先旧后新：.1 中事件 seq <= rotatedSeq
    scan(this.file + '.1', this.rotatedSeq !== null && after < this.rotatedSeq);
    scan(this.file, true);
    return out.slice(-limit);
  }

  /** 增量尾部（系统日志框架 P1b）：返回 seq > afterSeq 的事件（双代合并），守卫 EventHub / daemon ctl 拉取用。 */
  tailSince(afterSeq) {
    afterSeq = Number(afterSeq) || 0;
    const out = [];
    const scan = (file, needed) => {
      if (!needed) return;
      try {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        for (const l of lines) {
          if (!l.trim()) continue;
          try {
            const e = JSON.parse(l);
            if (e.seq > afterSeq) out.push(e);
          } catch {}
        }
      } catch {}
    };
    scan(this.file + '.1', this.rotatedSeq !== null && afterSeq < this.rotatedSeq);
    scan(this.file, true);
    return out;
  }

  /** 全量读（系统日志框架穿透审计修正）：双代合并、无 500 上限——审计/检索/metrics/过滤型时间线的
   *  数据源（readSince 的 limit 钳只适合增量分页，不可当全量视图）。 */
  readAll() {
    const out = [];
    const scan = (file, needed) => {
      if (!needed) return;
      try {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        for (const l of lines) {
          if (!l.trim()) continue;
          try { out.push(JSON.parse(l)); } catch {}
        }
      } catch {}
    };
    scan(this.file + '.1', this.rotatedSeq !== null);
    scan(this.file, true);
    return out;
  }
}

module.exports = Events;
