'use strict';

// ═══════════════════════════════════════════════════════════════════════════
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
// ═══════════════════════════════════════════════════════════════════════════

const net = require('node:net');
const tls = require('node:tls');
const adbkey = require('./adbkey');
const x509 = require('./x509');

const VERSION = 0x01000000;
const STLS_VERSION = 0x01000000;
const MAX_PAYLOAD = 256 * 1024;
const HEADER_SIZE = 24;

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

/**
 * 在已授权设备上执行一条 shell 命令。
 * @param {{host:string, port:number, key:object, cmd:string, timeoutMs?:number}} o
 * @returns {Promise<{out:string, logs:string[]}>}
 */
function shell(o) {
  const shellCmd = o.cmd;
  const timeoutMs = o.timeoutMs || 15000;
  return new Promise((resolve, reject) => {
    const raw = net.connect({ host: o.host, port: o.port });
    let cur = raw;
    let buf = Buffer.alloc(0);
    let out = Buffer.alloc(0);
    let opened = false, tlsStarted = false, settled = false;
    const logs = [];
    const timer = setTimeout(() => { logs.push('TIMEOUT'); finish(null); }, timeoutMs);
    function finish(err) {
      if (settled) return; settled = true; clearTimeout(timer);
      try { cur.destroy(); } catch (e) { /* ignore */ }
      try { raw.destroy(); } catch (e) { /* ignore */ }
      if (err) reject(err); else resolve({ out: out.toString('utf8'), logs: logs });
    }
    function send(pkt) { try { cur.write(pkt); } catch (e) { finish(e); } }

    function feed(d) {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= HEADER_SIZE) {
        const cmd = buf.toString('ascii', 0, 4);
        const a0 = buf.readUInt32LE(4);
        const dataLen = buf.readUInt32LE(12);
        if (buf.length < HEADER_SIZE + dataLen) break;
        const payload = Buffer.from(buf.subarray(HEADER_SIZE, HEADER_SIZE + dataLen));
        buf = buf.subarray(HEADER_SIZE + dataLen);
        logs.push(cmd + ' a0=' + a0 + ' len=' + dataLen);
        if (cmd === 'STLS') {
          if (tlsStarted) continue;
          tlsStarted = true;
          send(makePacket('STLS', STLS_VERSION, 0, Buffer.alloc(0)));
          raw.removeListener('data', feed);
          const cred = x509.selfSignedFromKey('adb', o.key.privatePem);
          const t = tls.connect({
            socket: raw, key: cred.keyPem, cert: cred.certPem,
            rejectUnauthorized: false, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
          });
          cur = t;
          t.on('secureConnect', () => { buf = Buffer.alloc(0); t.on('data', feed); logs.push('TLS established'); });
          t.on('error', finish);
          continue;
        }
        if (cmd === 'CNXN') {
          logs.push('CNXN banner=' + payload.toString('utf8').replace(/\u0000/g, ''));
          if (!opened) {
            opened = true;
            send(makePacket('OPEN', 1, 0, Buffer.from('shell:' + shellCmd + '\u0000', 'utf8')));
            logs.push('sent OPEN shell:' + shellCmd);
          }
        } else if (cmd === 'WRTE') {
          out = Buffer.concat([out, payload]);
        } else if (cmd === 'CLSE') {
          finish(null); return;
        }
      }
    }

    raw.on('error', finish);
    raw.on('connect', () => { raw.write(makePacket('CNXN', VERSION, MAX_PAYLOAD, Buffer.from('host::\u0000', 'utf8'))); logs.push('sent CNXN'); });
    raw.on('data', feed);
  });
}

module.exports = { shell, makePacket, checksum, commandInt, VERSION, STLS_VERSION, MAX_PAYLOAD, HEADER_SIZE };
