'use strict';

// Program 侧 OS 能力桥客户端
//
// 面板是普通 Program：它**没有**任何 Android 语义（没有 Activity/Service/Context），
// 所有系统能力（状态读取、Program 安装/启停、端口、通知、UI 自动化、截屏…）都经
// OS 原生 CapabilityBroker 暴露的 UDS 能力 API 获取。
//
// 面板（Program 子进程） --connect--> OS CapabilityBroker（Kotlin，lobos_hostbridge）
//
// ## 传输
//
// Linux **抽象命名空间** Unix 域套接字：path = '\0' + socketName（前导 NUL 字节）。
// OS 侧 `LocalServerSocket("lobos_hostbridge")` 即抽象命名空间套接字。**严禁 TCP**。
//
// ## 协议
//
// JSON-RPC 2.0，换行分隔的 JSON 帧。连接后 Program 先发 bridge.handshake{protocol,requires}，
// OS 回 {protocol,capabilities,groups}（协商结果）。之后 call(method,params)。
//
// ## 不变量（与「可停可换」契约一致）
//
// · 桥**不可用**（OS 未接线 / socket 不存在 / 连不上）→ 所有调用**快速失败且不抛错**
// （返回 null / {ok:false}），面板照常提供自身 API；调用方据此走各自降级分支。
// · 断线自动重连（下一次调用时惰性重连）。
// · 超时（默认 15s）视为失败，**绝不挂死面板事件循环**。
//
// socket 名来源：`LOBOS_BRIDGE_SOCKET` 环境变量（OS 启动面板时注入）；
// 默认 'lobos_hostbridge'（OS 命名空间，见 docs/standards/branding.md）。

const net = require('node:net');
const { PROTOCOL_VERSION, ERROR_CODES, request, notification, handshakeRequest } = require('./protocol');

const DEFAULT_SOCKET = 'lobos_hostbridge';
const DEFAULT_TIMEOUT_MS = 15000;

/** 抽象命名空间路径：前导 NUL + 名称。 */
function abstractPath(name) {
  return '\0' + name;
}

class HostBridgeClient {
  /**
   * @param {object} [o]
   * - socketName?: 抽象命名空间名（默认 env LOBOS_BRIDGE_SOCKET 或 'lobos_hostbridge'）
   * - requires?: string[] 期望的 bridge:* 组令牌（握手协商用）
   * - timeoutMs?: 单次调用超时
   * - onLog?: (msg:string)=>void
   */
  constructor(o) {
    o = o || {};
    this.socketName = o.socketName || process.env.LOBOS_BRIDGE_SOCKET || DEFAULT_SOCKET;
    this.requires = o.requires || [];
    this.program = o.program || null;
    this.timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.onLog = o.onLog || (() => {});
    this._sock = null;
    this._connecting = null;
    this._buf = '';
    this._pending = new Map();
    this._seq = 0;
    this._capabilities = null;
    this._groups = null;
    this._handshakeDone = false;
  }

  isConnected() {
    return !!(this._sock && !this._sock.destroyed);
  }

  capabilities() { return this._capabilities; }
  groups() { return this._groups; }

  connect() {
    if (this.isConnected()) return Promise.resolve(this);
    if (this._connecting) return this._connecting;

    this._connecting = new Promise((resolve, reject) => {
      const path = abstractPath(this.socketName);
      let settled = false;
      let sock;
      try {
        sock = net.connect(path);
      } catch (e) {
        this._connecting = null;
        return reject(e);
      }
      sock.setNoDelay(true);
      sock.on('connect', () => {
        settled = true;
        this._sock = sock;
        this._connecting = null;
        this.onLog('os-bridge: connected -> ' + this.socketName);
        resolve(this);
      });
      sock.on('data', (d) => this._onData(d));
      sock.on('error', (e) => {
        if (!settled) {
          settled = true;
          this._connecting = null;
          try { sock.destroy(); } catch {}
          return reject(e);
        }
        this.onLog('os-bridge: socket error ' + (e && e.code));
        this._teardown();
      });
      sock.on('close', () => this._teardown());
    });
    return this._connecting;
  }

  _teardown() {
    this._handshakeDone = false;
    this._capabilities = null;
    this._groups = null;
    const sock = this._sock;
    this._sock = null;
    if (sock) { try { sock.destroy(); } catch {} }
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this._pending.clear();
    this._buf = '';
  }

  _onData(d) {
    this._buf += d.toString('utf8');
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this._onMessage(msg);
    }
  }

  _onMessage(msg) {
    if (msg && msg.id !== undefined && msg.id !== null && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }

  _write(obj) {
    this._sock.write(JSON.stringify(obj) + '\n');
  }

  async handshake() {
    try {
      await this.connect();
    } catch (e) {
      this.onLog('os-bridge: connect failed ' + ((e && e.code) || e));
      return null;
    }
    const resp = await this._send(handshakeRequest(++this._seq, this.requires, this.program));
    if (!resp || !resp.result) {
      this.onLog('os-bridge: handshake failed');
      return null;
    }
    this._handshakeDone = true;
    this._capabilities = resp.result.capabilities || [];
    this._groups = resp.result.groups || [];
    const missing = (this.requires || []).filter((r) => !this._groups.includes(r));
    if (missing.length) this.onLog('os-bridge: 能力缺失 ' + missing.join(','));
    return resp.result;
  }

  async call(method, params) {
    if (!this._handshakeDone) {
      const hs = await this.handshake();
      if (!hs) return null;
    }
    const resp = await this._send(request(++this._seq, method, params));
    if (!resp) return null;
    if (resp.error) return { ok: false, error: resp.error };
    return { ok: true, result: resp.result };
  }

  notify(method, params) {
    if (!this.isConnected()) return false;
    try { this._write(notification(method, params)); return true; }
    catch { return false; }
  }

  _send(obj) {
    return new Promise((resolve) => {
      if (!this.isConnected()) { resolve(null); return; }
      const timer = setTimeout(() => {
        this._pending.delete(obj.id);
        this.onLog('os-bridge: 调用超时 ' + obj.method);
        resolve(null);
      }, this.timeoutMs);
      this._pending.set(obj.id, { resolve, timer });
      try { this._write(obj); } catch { clearTimeout(timer); this._pending.delete(obj.id); resolve(null); }
    });
  }

  close() { this._teardown(); }
}

let _singleton = null;
function client() {
  if (!_singleton) _singleton = new HostBridgeClient();
  return _singleton;
}

/** 是否运行在 OS 容器内（有桥可用信号）。 */
function inContainer() {
  return process.env.LOBOS_ANDROID === '1' || process.env.LOBOS_PLATFORM === 'android';
}

module.exports = {
  HostBridgeClient,
  client,
  inContainer,
  abstractPath,
  DEFAULT_SOCKET,
  PROTOCOL_VERSION,
  ERROR_CODES,
};

