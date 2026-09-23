'use strict';

// 内核侧 HostBridge 客户端
//
// 内核跑在安卓容器（L0）里，所有**设备能力**（通知、打开浏览器、应用控制、UI 自动化、
// Device Policy…）都由容器层的 HostBridge 承担。本模块是内核唯一的桥客户端：
//
// 内核（:node 进程） --connect--> HostBridge（Kotlin HostBridgeService / Android Service）
//
// ## 传输
//
// Linux **抽象命名空间** Unix 域套接字：path = '\0' + socketName（前导 NUL 字节）。
// 容器侧 `LocalServerSocket("dsh_hostbridge")` 即抽象命名空间套接字，Node 22 原生支持
// `net.connect('\0dsh_hostbridge')`（已实测连通）。**严禁 TCP**（控制面不经网络暴露，见 BASE_SPEC §8）。
//
// ## 协议
//
// JSON-RPC 2.0，换行分隔的 JSON 帧。连接后内核先发 `bridge.handshake{protocol,requires}`，
// 容器回 `{protocol,capabilities,groups}`（协商结果）。之后 `call(method,params)`。
//
// ## 不变量（与内核「可降级运行」契约一致）
//
// · 桥**不可用**（未在容器内 / socket 不存在 / 连不上）→ 所有调用**快速失败且不抛错**
// （返回 null / {ok:false}），内核照常运行；调用方据此走各自降级分支。
// · 断线自动重连（下一次调用时惰性重连），避免内核因容器重启而需要自己重启。
// · 超时（默认 15s）视为失败，**绝不挂死内核事件循环**。
//
// socket 名来源：`DSH_BRIDGE_SOCKET` 环境变量（容器启动内核时注入）；默认 'dsh_hostbridge'。

const net = require('node:net');
const { PROTOCOL_VERSION, ERROR_CODES, request, notification, handshakeRequest } = require('./protocol');

const DEFAULT_SOCKET = 'dsh_hostbridge';
const DEFAULT_TIMEOUT_MS = 15000;

/** 抽象命名空间路径：前导 NUL + 名称。 */
function abstractPath(name) {
  return '\0' + name;
}

class HostBridgeClient {
  /**
   * @param {object} [o]
   * - socketName?: 抽象命名空间名（默认 env DSH_BRIDGE_SOCKET 或 'dsh_hostbridge'）
   * - requires?: string[] 期望的 bridge:* 组令牌（握手协商用）
   * - timeoutMs?: 单次调用超时
   * - onLog?: (msg:string)=>void
   */
  constructor(o) {
    o = o || {};
    this.socketName = o.socketName || process.env.DSH_BRIDGE_SOCKET || DEFAULT_SOCKET;
    this.requires = o.requires || [];
    this.timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.onLog = o.onLog || (() => {});
    this._sock = null;
    this._connecting = null;
    this._buf = '';
    this._pending = new Map(); // id -> {resolve,reject,timer}
    this._seq = 0;
    this._capabilities = null; // 握手后填充
    this._groups = null;
    this._handshakeDone = false;
  }

  /** 连接是否已建立。 */
  isConnected() {
    return !!(this._sock && !this._sock.destroyed);
  }

  /** 上次握手协商到的能力（未握手时 null）。 */
  capabilities() {
    return this._capabilities;
  }

  /** 上次握手协商到的 bridge:* 分组（未握手时 null）。 */
  groups() {
    return this._groups;
  }

  /** 建立连接（幂等）。失败时 reject，由 call() 捕获降级。 */
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
        this.onLog('host-bridge: connected -> ' + this.socketName);
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
        this.onLog('host-bridge: socket error ' + (e && e.code));
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
    // 断开时让所有在途调用立即失败（不挂死调用方）
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
    const line = JSON.stringify(obj) + '\n';
    this._sock.write(line);
  }

  /**
   * 握手（连接后自动调用一次）。返回协商结果或 null。
   * @returns {Promise<{protocol:number, capabilities:string[], groups:string[]}|null>}
   */
  async handshake() {
    try {
      await this.connect();
    } catch (e) {
      this.onLog('host-bridge: connect failed ' + (e && e.code || e));
      return null;
    }
    const resp = await this._send(handshakeRequest(++this._seq, this.requires));
    if (!resp || !resp.result) {
      this.onLog('host-bridge: handshake failed');
      return null;
    }
    this._handshakeDone = true;
    this._capabilities = resp.result.capabilities || [];
    this._groups = resp.result.groups || [];
    const missing = (this.requires || []).filter((r) => !this._groups.includes(r));
    if (missing.length) this.onLog('host-bridge: 能力缺失 ' + missing.join(','));
    return resp.result;
  }

  /**
   * 调用桥方法。
   * @returns {Promise<{ok:boolean, result?:object, error?:{code:number,message:string,data?:object}}|null>}
   * 桥不可用/超时 → null（调用方降级）；协议错误 → {ok:false,error}。
   */
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

  /** 发送通知（无 id，不等回包）。桥不可用时静默。 */
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
        this.onLog('host-bridge: 调用超时 ' + obj.method);
        resolve(null);
      }, this.timeoutMs);
      this._pending.set(obj.id, { resolve, timer });
      try { this._write(obj); } catch { clearTimeout(timer); this._pending.delete(obj.id); resolve(null); }
    });
  }

  close() {
    this._teardown();
  }
}

// 进程级单例：内核各处（notify/browser/未来域）共用一条连接与一次握手。
let _singleton = null;
function client() {
  if (!_singleton) _singleton = new HostBridgeClient();
  return _singleton;
}

/** 是否运行在容器内（有桥可用信号）。 */
function inContainer() {
  return process.env.DSH_ANDROID === '1' || process.env.DSH_PLATFORM === 'android';
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
