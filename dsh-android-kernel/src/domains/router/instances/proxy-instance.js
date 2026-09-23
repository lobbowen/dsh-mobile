'use strict';

// 反代实例生命周期对象：一个账号（key）= 一个实例（硬规则）。
// 状态机：registered → starting → running → frozen(带resetAt) → stopped/failed
// 关键：实例记录与进程解耦；spawn 前先按 key 查现有（不重复生产）；
//      frozen 永带 resetAt，到点由调度器释放；进程态(pid)不落盘，但 port 持久化——
//      端口与实例绑死（对齐 relay inst.wanPort 模式）：分配一次永久绑定，重启/停止复用，
//      仅删除账号才释放。

class ProxyInstance {
  constructor(opts) {
    this.key = opts.key || null;
    this.keyId = opts.keyId;
    this.maskedKey = opts.maskedKey;
    this.app = opts.app || null;
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.onEvent = opts.onEvent || null;
    this.status = 'registered';
    this.healthy = false;
    this.quota = null;
    this.registeredAt = Date.now();
    this.pid = null;
    this.port = null;
    this.version = null;
    this.startingPromise = null; // 启动并发去重：启动中复用同一 Promise，杜绝双 spawn
    this.lastUsedAt = null;      // 最近被请求使用的时刻（闲置回收窗口判断）
    this._unhealthyCount = 0;  // 连续不健康次数（运行时，不落盘——健康监护用：≥N 次自动重启）
    this._restartAt = 0;       // 自动重启退避时刻（防风暴）
    // 以下三个运行时字段原先**只在 proxy.js 里动态挂载**、未在构造器声明 ——
    // 本仓教训：未声明的字段易被误判为「不存在」，且不利于读者建立状态全貌。
    this._monitorFails = 0;    // 健康监测连续失败次数（与 _unhealthyCount **独立**，见 proxy.js 说明）
    this._lastProblem = null;  // 最近一次实例级问题原因（诊断）
    this._restartPending = null; // 在途请求期间被延后的重启原因（由 flushRestartPending 消费）
  }

  toJSON() {
    return {
      key: this.key,
      keyId: this.keyId,
      maskedKey: this.maskedKey,
      status: this.status,
      healthy: this.healthy,
      quota: this.quota,
      registeredAt: this.registeredAt,
      version: this.version || null,
      port: this.port || null, // 持久化端口绑定（重启/停止复用同一端口，防漂移）
    };
  }

  static fromJSON(o) {
    const i = new ProxyInstance({ key: o.key || null, keyId: o.keyId, maskedKey: o.maskedKey });
    // 进程态(pid)不落盘 → 重启后状态重置：非 frozen 一律 registered（由 _ensureProxyInstances 重新拉起）；
    // port 持久化：恢复绑定端口（启动时复用，防端口漂移）；frozen 保留；version 保留供 UI 展示。
    i.status = (o.status === 'frozen') ? 'frozen' : 'registered';
    i.healthy = false;
    i.quota = o.quota || null;
    i.registeredAt = o.registeredAt || Date.now();
    i.version = o.version || null;
    i.port = o.port || null;
    return i;
  }

  _set(status, extra) {
    const prev = this.status;
    this.status = status;
    if (this.onEvent) this.onEvent('proxy_instance_status', { keyId: this.keyId, from: prev, to: status, ...(extra || {}) });
  }

  /** 冻结/解冻（测试与状态机验证使用；主程序冻结语义收敛到账号级 markQuotaExhausted/applyDetection）。 */
  freeze(resetsAt) {
    this._set('frozen');
    if (resetsAt) this.quota = { ...(this.quota || {}), resetsAt };
  }

  unfreeze() {
    if (this.status === 'frozen') this._set('registered');
  }

}

module.exports = { ProxyInstance };