'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// D1：把「安卓读不到的 Linux 语义」补回给 Node —— 由容器经 NODE_OPTIONS=--require 预载。
//
// 只补 `os.cpus()`：Android/SELinux 下 uv_cpu_info 取不到，返回 0 长数组，于是按
// `os.cpus().length` 决定线程 / worker 池大小的库会拿到 0（环境报告 P2-2）。
// `os.availableParallelism()` 是同机上正确的读数，本垫片**只在空时**用它合成；
// 非空（PC / 已修好的运行时）一律不动 —— 垫片不许改写既有正确事实。
//
// 预载垫片的第一纪律：**绝不能让进程起不来**。整段包 try/catch，任何失败静默让路。
// ═══════════════════════════════════════════════════════════════════════════

try {
  const os = require('node:os');
  const real = os.cpus;
  if (typeof real === 'function') {
    let sample = null;
    try { sample = real.call(os); } catch (_) { sample = null; }
    if (Array.isArray(sample) && sample.length === 0) {
      let n = 1;
      try {
        if (typeof os.availableParallelism === 'function') n = os.availableParallelism() || 1;
      } catch (_) { n = 1; }
      os.cpus = function () {
        const out = [];
        for (let i = 0; i < n; i += 1) {
          out.push({
            model: 'android',
            speed: 0,
            times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
          });
        }
        return out;
      };
    }
  }
} catch (_) { /* 静默让路：可选语义垫片不得成为启动失败点 */ }
