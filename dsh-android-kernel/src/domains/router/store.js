'use strict';

// RouterStore: smart router persistence.
const fs = require('node:fs');
const path = require('node:path');

class RouterStore {
  constructor(opts) {
    this.file = opts.file;
    this.logger = (opts && opts.logger) || null;
    // 本次启动是否已成功读过盘（用于「空态立即回写」的放大效应防护）
    this.loadedOk = false;
  }
  load() {
    // ⚠ P2/P3 修复（2026-09-13，失效模式 h+a）：**不得把「解析失败」与「本来就是空」混为一谈**。
    //
    //   缺陷：原实现 catch 后静默返回 {providers: []} —— 与「文件本就是空的」不可区分；
    //     而调用方（RouterService）在启动维护阶段会**立刻 _save()**，
    //     把刚读出的「空」覆盖回文件 → 一次外部损坏/半写即导致
    //     **用户全部供应商与账号配置（含 API Key）静默清零且不可恢复**，日志无任何线索。
    //   修法：解析失败时①保留现场（改名 .corrupt-<ts> 备份）②logger.error 如实上报
    //     ③置 loadedOk=false，让调用方**跳过**这次「空态回写」（见 canPersist()）。
    this.loadedOk = false;
    let raw = null;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch { this.loadedOk = true; return { providers: [] }; } // 文件不存在：合法空态，允许后续写入
    try {
      const doc = JSON.parse(raw);
      this.loadedOk = true;
      return { providers: Array.isArray(doc.providers) ? doc.providers : [] };
    } catch (e) {
      const bak = this.file + '.corrupt-' + Date.now();
      try { fs.renameSync(this.file, bak); } catch {}
      if (this.logger && this.logger.error) {
        this.logger.error('[router] providers.json 解析失败（' + e.message + '）——已保留现场为 ' + bak +
          '，本次**不覆盖**该文件（防配置静默清零）');
      }
      // 不置 loadedOk：调用方据此跳过回写，给人修复/恢复的机会
      return { providers: [], corrupt: true, backup: bak };
    }
  }
  /** 是否允许把当前内存态落盘（解析失败后禁止，防把损坏放大成清零）。 */
  canPersist() { return this.loadedOk === true; }
  save(providers) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // ⚠ tmp 名唯一：固定 '.tmp' 会让两个进程并发写同一临时文件 → rename 出混合内容。
    const tmp = this.file + '.tmp.' + process.pid + '.' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify({ providers: providers.map((p) => p.serialize()) }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { RouterStore };
