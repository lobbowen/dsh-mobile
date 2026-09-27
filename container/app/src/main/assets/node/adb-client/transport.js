'use strict';

// ADB 无线连接传输层（配对成功之后用）
//
// 与 USB ADB 不同，无线调试的连接端口会强制把连接升级到 TLS：
//   1. 发 CNXN（普通）→ adbd 回 STLS（arg0=A_STLS_VERSION=0x01000000）；
//   2. **客户端回一个 STLS**，再把**同一条 socket** 升级为 TLS 1.3 客户端；
//      证书必须由 **ADB 私钥**签发（adbd 用证书公钥与已授权 adb_keys 比对）；
//   3. 握手成功后设备发 CNXN；随后 OPEN shell:<cmd> → WRTE 输出 → CLSE。
//   （TLS 模式下 AUTH 被忽略，不再走签名认证。）
//
// 本文件只做传输，不做配对；配对见 ./pairing。
//
// ── 为什么改成"常驻 + 多路复用"（2026-09-27 真机定罪）──────────────────────────
// 旧实现每次 shell() 都 net.connect() 新建 socket → STLS → TLS1.3 → 跑命令 →
// finish() 里 destroy 硬断。adbd 侧于是每次都 Initializing adbwifi TlsConnection /
// Handshake succeeded / timeout expired while flushing socket closing —— 探针每
// 10s 一次，这台机器就一直在"连接—断开"里空转。
//
// 新形态：**一条 TLS 会话**按递增 local-id 多路复用 OPEN/WRTE/CLSE，命令跑完只
// 关流（CLSE）不关连接；真断了才指数退避重连。正在途中的调用在断连时**一律以
// 错误收口**（绝不 resolve 部分输出——那会把"挂死"伪装成"成功但空"）。主动收尾
// 前对每条在途流发 CLSE 并等 OKAY，让 adbd 把 TlsConnection 正常放掉而不是超时清。

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const x509 = require('./x509');

const VERSION = 0x01000000;
const STLS_VERSION = 0x01000000;
const MAX_PAYLOAD = 256 * 1024;
const HEADER_SIZE = 24;

// 重连退避：adbd 重启 / 无线调试端口轮换时，别让每个调用各打一次瞬时重试把 adbd 打崩。
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;
const CONNECT_TIMEOUT_MS = 8000;
// 主动收尾时等在途流 OKAY 的上界：adbd 不回也不能无限等。
const CLOSE_GRACE_MS = 600;
const LOG_CAP = 200;

function checksum(p) { let s = 0; for (const b of p) s = (s + b) >>> 0; return s >>> 0; }
function commandInt(cmd) {
  return cmd.charCodeAt(0) | (cmd.charCodeAt(1) << 8) | (cmd.charCodeAt(2) << 16) | (cmd.charCodeAt(3) << 24);
}
/** 组装 ADB 报文：24B 头 + payload（magic = command xor 0xffffffff）。 */
function makePacket(cmd, a0, a1, payload) {
  payload = payload || Buffer.alloc(0);
  const h = Buffer.alloc(HEADER_SIZE);
  h.write(cmd, 0, 'ascii');
  h.writeUInt32LE(a0 >>> 0, 4);
  h.writeUInt32LE(a1 >>> 0, 8);
  h.writeUInt32LE(payload.length, 12);
  h.writeUInt32LE(checksum(payload), 16);
  h.writeUInt32LE((commandInt(cmd) ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([h, payload]);
}

/** 凭据指纹：同一 host:port 换了密钥（重新配对/换目录）时不能复用旧 TLS 会话。 */
function fingerprint(o) {
  const pem = o && o.key && o.key.privatePem;
  if (!pem) return 'nokey';
  return crypto.createHash('sha1').update(pem).digest('hex').slice(0, 16);
}
function keyOf(o) { return o.host + ':' + o.port; }

// 每个 host:port 一条常驻会话（同一 serve 进程内全局共享）。
// 失败对象**留在池里**：它承载 nextAttemptAt/backoffMs，下次调用才会真正按退避重试。
const pool = new Map();

class AdbConnection {
  constructor(o) {
    this.host = o.host;
    this.port = o.port;
    this.key = o.key;
    this.pemFingerprint = fingerprint(o);
    this.connectTimeoutMs = o.connectTimeoutMs || CONNECT_TIMEOUT_MS;
    this.socket = null;
    this.raw = null;
    this.buf = Buffer.alloc(0);
    this.ready = false;
    this.connecting = null;
    this.tlsStarted = false;
    this.handshakeDone = false;
    this.nextLocalId = 1;
    this.pending = new Map();
    this.closeWaiters = new Map();
    this.logs = [];
    this.backoffMs = 0;
    this.nextAttemptAt = 0;
    this.down = true;
    this.downHandled = false;
    this.dialTimer = null;
    this.dialResolve = null;
    this.dialReject = null;
    this.intentionalClose = false;
  }

  log(m) {
    this.logs.push(m);
    if (this.logs.length > LOG_CAP) this.logs.splice(0, this.logs.length - LOG_CAP);
  }

  snapshotLogs(extra) { return this.logs.concat(extra || []); }

  /** 未就绪则（必要时先退避等待）建连；并发调用共享同一次建连。 */
  ensureConnected(deadlineMs) {
    if (this.ready && !this.down) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const now = Date.now();
    const waitMs = Math.max(0, this.nextAttemptAt - now);
    if (deadlineMs && now + waitMs >= deadlineMs) {
      return Promise.reject(new Error('adb 通道处于重连退避中（' + waitMs + 'ms 后重试）'));
    }
    const run = () => this._dial();
    const p = waitMs > 0 ? new Promise((r) => setTimeout(r, waitMs)).then(run) : run();
    this.connecting = p;
    const clear = () => { if (this.connecting === p) this.connecting = null; };
    p.then(clear, clear);
    return p;
  }

  _dial() {
    return new Promise((resolve, reject) => {
      this.down = false;
      this.downHandled = false;
      this.ready = false;
      this.tlsStarted = false;
      this.handshakeDone = false;
      this.intentionalClose = false;
      this.buf = Buffer.alloc(0);
      let settled = false;
      const clearTimer = () => { if (this.dialTimer) { clearTimeout(this.dialTimer); this.dialTimer = null; } };
      const finishOk = () => {
        if (settled) return; settled = true; clearTimer();
        this.ready = true; this.down = false;
        this.backoffMs = 0; this.nextAttemptAt = 0;
        this.dialResolve = null;
        this.dialReject = null;
        resolve();
      };
      const finishErr = (e) => {
        if (settled) return; settled = true; clearTimer();
        this.dialResolve = null;
        this.dialReject = null;
        this._socketDown(e);
        reject(e);
      };
      this.dialResolve = finishOk;
      this.dialReject = finishErr;

      let raw;
      try { raw = net.connect({ host: this.host, port: this.port }); }
      catch (e) { finishErr(e); return; }
      this.raw = raw;
      this.socket = raw;
      this.log('connecting ' + this.host + ':' + this.port);
      this.dialTimer = setTimeout(
        () => finishErr(new Error('adb 连接超时（' + this.connectTimeoutMs + 'ms）@' + this.host + ':' + this.port)),
        this.connectTimeoutMs,
      );
      const onError = (e) => { if (this.ready) this._socketDown(e); else finishErr(e); };
      raw.on('connect', () => {
        try { raw.write(makePacket('CNXN', VERSION, MAX_PAYLOAD, Buffer.from('host::\u0000', 'utf8'))); this.log('sent CNXN'); }
        catch (e) { finishErr(e); }
      });
      raw.on('data', (d) => this._feed(d));
      raw.on('error', onError);
      raw.on('close', () => { if (!this.ready) finishErr(new Error('adb 连接在握手完成前被关闭')); });
    });
  }

  _feed(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= HEADER_SIZE) {
      const cmd = this.buf.toString('ascii', 0, 4);
      const a0 = this.buf.readUInt32LE(4);
      const a1 = this.buf.readUInt32LE(8);
      const dataLen = this.buf.readUInt32LE(12);
      if (this.buf.length < HEADER_SIZE + dataLen) break;
      const payload = Buffer.from(this.buf.subarray(HEADER_SIZE, HEADER_SIZE + dataLen));
      this.buf = this.buf.subarray(HEADER_SIZE + dataLen);
      try { this._onPacket(cmd, a0, a1, payload); }
      catch (e) { this.log('packet error: ' + e.message); }
    }
  }

  // 入站流报文按 **arg1（本端 local-id）** 路由：OKAY/WRTE/CLSE 的 arg0 是 adbd 的
  // 流号。单命令时代忽略 a1 也能跑，多路复用必须认它。
  _onPacket(cmd, a0, a1, payload) {
    if (cmd === 'STLS') { this._upgradeTls(); return; }
    if (cmd === 'CNXN') {
      if (this.handshakeDone) return;
      this.handshakeDone = true;
      this.log('CNXN banner=' + payload.toString('utf8').replace(/\u0000/g, ''));
      const done = this.dialResolve;
      if (done) done();
      return;
    }
    if (cmd === 'OKAY') {
      const entry = this.pending.get(a1);
      if (entry) entry.remoteId = a0;
      const waiter = this.closeWaiters.get(a1);
      if (waiter) { this.closeWaiters.delete(a1); waiter(); }
      return;
    }
    if (cmd === 'WRTE') {
      const entry = this.pending.get(a1);
      if (entry) {
        entry.remoteId = a0;
        entry.out = Buffer.concat([entry.out, payload]);
        entry.logs.push('WRTE len=' + payload.length);
      }
      // 收到 WRTE 必须回 OKAY，否则 adbd 会停在等确认上（长输出尤甚）。
      this._send(makePacket('OKAY', a1, a0, Buffer.alloc(0)));
      return;
    }
    if (cmd === 'CLSE') {
      const entry = this.pending.get(a1);
      if (entry) {
        this.pending.delete(a1);
        entry.remoteId = a0;
        entry.ok();
      }
      return;
    }
  }

  _upgradeTls() {
    if (this.tlsStarted) return;
    this.tlsStarted = true;
    this._send(makePacket('STLS', STLS_VERSION, 0, Buffer.alloc(0)));
    const raw = this.raw;
    const leftover = this.buf;
    this.buf = Buffer.alloc(0);
    if (raw) raw.removeAllListeners('data'); // 之后这条 socket 上的字节由 TLS 层解释
    if (leftover && leftover.length) this.log('TLS 升级前缓冲残余 ' + leftover.length + 'B（按既有实现丢弃）');
    const cred = x509.selfSignedFromKey('adb', this.key.privatePem);
    const t = tls.connect({
      socket: raw, key: cred.keyPem, cert: cred.certPem,
      rejectUnauthorized: false, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
    });
    this.socket = t;
    const onError = (e) => {
      if (this.ready) { this._socketDown(e); return; }
      const r = this.dialReject;
      if (r) r(e);            // 握手期 TLS 错误要立刻把建连 promise 打 reject，不能等到超时
      else this._socketDown(e);
    };
    t.on('secureConnect', () => { this.log('TLS established'); t.on('data', (d) => this._feed(d)); });
    t.on('error', onError);
    t.on('close', () => { if (this.ready && !this.intentionalClose) this._socketDown(new Error('TLS 连接关闭')); });
  }

  _send(pkt) {
    const s = this.socket;
    if (!s || s.destroyed) return;
    try { s.write(pkt); } catch (e) { this._socketDown(e); }
  }

  /** 断连统一出口：在途调用一律 reject（绝不部分 resolve），并排下一次退避。 */
  _socketDown(err) {
    if (this.downHandled) return;
    this.downHandled = true;
    const wasReady = this.ready;
    this.ready = false;
    this.down = true;
    const s = this.socket, r = this.raw;
    this.socket = null;
    this.raw = null;
    try { if (s) s.destroy(); } catch (e) { /* ignore */ }
    try { if (r && r !== s) r.destroy(); } catch (e) { /* ignore */ }
    const e = err || new Error('adb 连接断开');
    for (const [, entry] of this.pending) {
      try { entry.fail(e); } catch (x) { /* ignore */ }
    }
    this.pending.clear();
    this.closeWaiters.clear();
    if (!this.intentionalClose) {
      this.backoffMs = this.backoffMs > 0 ? Math.min(this.backoffMs * 2, RECONNECT_MAX_MS) : RECONNECT_BASE_MS;
      this.nextAttemptAt = Date.now() + this.backoffMs;
    }
    if (wasReady) this.log('connection down: ' + e.message);
  }

  /**
   * 在同一条会话上跑一条 shell：OPEN(localId, 0, shell:<cmd>) → 等 CLSE。
   * 超时只取消这一条流（发 CLSE），连接继续服务别的命令。
   */
  shell(cmd, timeoutMs) {
    const t = timeoutMs || 15000;
    const deadline = Date.now() + t + this.connectTimeoutMs;
    return this.ensureConnected(deadline).then(() => new Promise((resolve, reject) => {
      if (!this.ready || !this.socket) { reject(new Error('adb 连接不可用')); return; }
      const localId = this.nextLocalId++;
      const entry = { out: Buffer.alloc(0), remoteId: 0, logs: [], settled: false, timer: null };
      entry.ok = () => {
        if (entry.settled) return; entry.settled = true;
        clearTimeout(entry.timer);
        resolve({ out: entry.out.toString('utf8'), logs: this.snapshotLogs(entry.logs) });
      };
      entry.fail = (e) => {
        if (entry.settled) return; entry.settled = true;
        clearTimeout(entry.timer);
        this.pending.delete(localId);
        reject(e);
      };
      entry.timer = setTimeout(() => {
        if (entry.remoteId) this._send(makePacket('CLSE', localId, entry.remoteId, Buffer.alloc(0)));
        entry.fail(new Error('adb shell 超时（' + t + 'ms），输出不完整'));
      }, t);
      this.pending.set(localId, entry);
      entry.logs.push('sent OPEN shell:' + cmd);
      this._send(makePacket('OPEN', localId, 0, Buffer.from('shell:' + cmd + '\u0000', 'utf8')));
    }));
  }

  /** 主动收尾：对在途流发 CLSE 等 OKAY（让 adbd 正常放掉 TlsConnection），再关 socket。 */
  close(gracefulMs) {
    const grace = gracefulMs == null ? CLOSE_GRACE_MS : gracefulMs;
    this.intentionalClose = true;
    const ids = [...this.pending.keys()];
    if (!ids.length || !this.socket) {
      this.downHandled = false;
      this._socketDown(new Error('adb 连接已关闭'));
      return Promise.resolve();
    }
    const waits = ids.map((id) => new Promise((res) => {
      this.closeWaiters.set(id, res);
      const entry = this.pending.get(id);
      this._send(makePacket('CLSE', id, (entry && entry.remoteId) || 0, Buffer.alloc(0)));
    }));
    return Promise.race([
      Promise.all(waits),
      new Promise((res) => setTimeout(res, grace)),
    ]).then(() => {
      this.downHandled = false;
      this._socketDown(new Error('adb 连接已关闭'));
    });
  }
}

/** 当前是否有就绪会话（供探针读连接状态，绝不新建连接）。 */
function readyEndpoint() {
  for (const conn of pool.values()) {
    if (conn.ready && !conn.down) return { host: conn.host, port: conn.port };
  }
  return null;
}

function connectionFor(o) {
  const k = keyOf(o);
  const fp = fingerprint(o);
  let conn = pool.get(k);
  if (conn && conn.pemFingerprint !== fp) {
    pool.delete(k);
    conn.close().catch(() => {});
    conn = null;
  }
  if (!conn) { conn = new AdbConnection(o); pool.set(k, conn); }
  return conn;
}

/**
 * 在已授权设备上执行一条 shell 命令（复用常驻会话）。
 * @param {{host:string, port:number, key:object, cmd:string, timeoutMs?:number}} o
 * @returns {Promise<{out:string, logs:string[]}>}
 */
function shell(o) {
  return connectionFor(o).shell(o.cmd, o.timeoutMs);
}

/** 一次性语义：建连 → 跑一条 → 收尾关连接（保留给"绝不共享"的调用方）。 */
async function shellOnce(o) {
  const conn = new AdbConnection(o);
  try {
    await conn.ensureConnected(Date.now() + (o.timeoutMs || 15000) + (o.connectTimeoutMs || CONNECT_TIMEOUT_MS));
    return await conn.shell(o.cmd, o.timeoutMs);
  } finally {
    await conn.close().catch(() => {});
  }
}

/** 收干净全部常驻会话：一次性 CLI 打印结果前调用，事件循环才能自然退出。 */
async function closeAll() {
  const conns = [...pool.values()];
  pool.clear();
  await Promise.all(conns.map((c) => c.close().catch(() => {})));
}

module.exports = {
  shell, shellOnce, closeAll, readyEndpoint,
  makePacket, checksum, commandInt, VERSION, MAX_PAYLOAD, HEADER_SIZE,
};
