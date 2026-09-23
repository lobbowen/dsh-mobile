'use strict';

// 守卫自身生命周期（与实例生命周期完全分离）。
// 守卫是「监事」：它有自己的 start/drain/shutdown/ready 状态，绝不因守卫重启/启动/崩溃而影响任何实例。
// 本模块只跟踪守卫自身的生命周期标志，供 statusSummary / API 呈现与竞态防护。

class Lifecycle {
  constructor() {
    this.startedAt = null;
    this.ready = false;
    this.draining = false;
    this.stopping = false;
  }

  markStarted() {
    this.startedAt = new Date().toISOString();
    this.ready = true;
    this.draining = false;
    this.stopping = false;
    return this;
  }

  beginShutdown() {
    this.stopping = true;
    this.draining = true;
    this.ready = false;
    return this;
  }

  /** 守卫是否已就绪（供 /readyz）。 */
  isReady() {
    return this.ready === true && this.stopping === false;
  }

  summary() {
    return {
      startedAt: this.startedAt,
      ready: this.isReady(),
      draining: this.draining,
      stopping: this.stopping,
    };
  }
}

module.exports = { Lifecycle };
