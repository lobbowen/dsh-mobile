'use strict';

// 分级日志 + 统一轮转：工业级日志地基。
// 三路独立文件（守卫 / DSH 输出 / 升级输出），同一轮转策略：
// 超过 maxBytes 改名 .1 保留一代，绝不无限增长。
// 同时镜像到 stderr —— 容器 / Android Service 侧按 logcat 收敛。

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** 轮转写入器：逐行追加，超限轮转（保留一代 .1）。 */
class Rotator {
  constructor(file, maxBytes) {
    this.file = file;
    this.maxBytes = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : 5 * 1024 * 1024;
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
      } catch {}
    }
  }

  write(line) {
    if (!this.file) return;
    try {
      let size = 0;
      try {
        size = fs.statSync(this.file).size;
      } catch {}
      if (size >= this.maxBytes) {
        const backup = this.file + '.1';
        try {
          fs.unlinkSync(backup);
        } catch {}
        fs.renameSync(this.file, backup);
      }
    } catch (e) {
      console.error('[logger] rotate failed:', e.message);
    }
    try {
      // mode 仅作用于文件首次创建：日志文件（含 dsh 输出的启动令牌 URL）权限收紧为 0600，
      // 与 state.json 一致（旧实现默认 0644，同机其他用户可读会话令牌）
      fs.appendFileSync(this.file, line + '\n', { mode: 0o600 });
    } catch (e) {
      console.error('[logger] write failed:', e.message);
    }
  }

  /** 读取日志尾部至多 n 行（空行省略；供测试/调试读取已落盘内容）。文件不存在返回空数组。 */
  tail(n) {
    if (!this.file) return [];
    try {
      const all = fs.readFileSync(this.file, 'utf8');
      const lines = all.split('\n');
      return lines.slice(-Math.max(1, Number(n) || 100)).filter(Boolean);
    } catch {
      return [];
    }
  }

}

/** 行缓冲：把任意切分的 chunk 还原成完整行再落盘（防半行日志）。 */
class LineBuffer {
  constructor(onLine) {
    this.onLine = onLine;
    this.rest = '';
  }

  push(chunk) {
    this.rest += chunk.toString();
    let idx;
    while ((idx = this.rest.indexOf('\n')) >= 0) {
      const line = this.rest.slice(0, idx);
      this.rest = this.rest.slice(idx + 1);
      if (line.trim()) this.onLine(line);
    }
  }

  flush() {
    if (this.rest.trim()) this.onLine(this.rest);
    this.rest = '';
  }
}

/**
 * 创建分级 logger。
 * @param {object} opts { file, level='info', maxBytes=5MB, mirror=true }
 * @returns {{debug,f,warn,error, writer: Rotator}}
 */
function createLogger(opts) {
  const o = opts || {};
  const threshold = LEVELS[o.level] || LEVELS.info;
  const writer = new Rotator(o.file, o.maxBytes);
  // 系统日志框架（历史设计文档）：可选 process 标识日志归属进程（additive）。
  const tag = o.process ? '[' + o.process + '] ' : '';
  const emit = (lv, msg) => {
    if ((LEVELS[lv] || 0) < threshold) return;
    const line = '[' + new Date().toISOString() + '] [' + lv.toUpperCase() + '] ' + tag + msg;
    writer.write(line);
    if (o.mirror !== false) console.error(line);
  };
  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
    writer,
  };
}

module.exports = { createLogger, Rotator, LineBuffer };
