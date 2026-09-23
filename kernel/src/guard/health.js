'use strict';

// 健康地基：/healthz /readyz。
// healthz=进程活着；readyz=守卫已完成初始化且未在停机。

const { Lifecycle } = require('./lifecycle/guard-self');

class Health {
  constructor(lifecycle) {
    this.lifecycle = lifecycle || new Lifecycle();
  }

  /** 存活探针：进程本身在跑即活。 */
  live() {
    return { ok: true, pid: process.pid, uptimeMs: process.uptime() * 1000 };
  }

  /** 就绪探针：守卫已初始化完成且未停机。 */
  ready() {
    const ok = this.lifecycle.isReady();
    return { ok, ready: ok, lifecycle: this.lifecycle.summary() };
  }
}

module.exports = { Health };
