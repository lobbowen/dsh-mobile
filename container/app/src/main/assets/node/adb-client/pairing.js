'use strict';

// ADB 无线配对客户端（通用：任意设备 / 任意配对码）
//
// 流程（全部按 AOSP packages/modules/adb 源码核对）：
//   1. TCP 连配对端口（弹窗打开期间才监听）；
//   2. TLS 1.3 客户端握手，出示任意自签证书（服务端接受任意对端证书）；
//   3. 取 64B exporter：label = "adb-label\\0"（**含结尾 NUL**），context 不传（use_context=false）；
//   4. SPAKE2：密码 = 配对码 ASCII ‖ exporter；角色 alice；身份含 NUL（各 16B）；
//   5. HKDF-SHA256(ikm=64B, salt=空, info="adb pairing_auth aes-128-gcm key") → 16B AES key；
//   6. AES-128-GCM 分帧（nonce=LE64(seq) 补零到 12B；无 AAD；密文‖16B tag）；
//   7. 交换固定 8192B PeerInfo：客户端先发 type=0 + ADB 公钥串，设备回 type=1 + GUID。

const tls = require('node:tls');
const crypto = require('node:crypto');
const x509 = require('./x509');
const spake2 = require('./spake2');
const adbkey = require('./adbkey');

const HKDF_INFO = Buffer.from('adb pairing_auth aes-128-gcm key');
const EXPORTER_LABEL = 'adb-label\u0000';
const PEER_INFO_SIZE = 8192;
const TYPE_SPAKE2 = 0;
const TYPE_PEER_INFO = 1;

function be32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }
/** 分帧：[version=1][type][payload_len BE32] + payload。 */
function frame(type, payload) { return Buffer.concat([Buffer.from([1, type]), be32(payload.length), payload]); }
function aesKey(keyMaterial) { return Buffer.from(crypto.hkdfSync('sha256', keyMaterial, Buffer.alloc(0), HKDF_INFO, 16)); }
function seal(key, seq, data) {
  const n = Buffer.alloc(12); n.writeBigUInt64LE(BigInt(seq), 0);
  const c = crypto.createCipheriv('aes-128-gcm', key, n);
  return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
}
function aesOpen(key, seq, data) {
  const n = Buffer.alloc(12); n.writeBigUInt64LE(BigInt(seq), 0);
  const d = crypto.createDecipheriv('aes-128-gcm', key, n);
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
}

/**
 * 配对。
 * @param {{host:string, port:number, code:string, key:object, timeoutMs?:number}} o
 * @returns {Promise<{guid:string, type:number}>}
 */
function pair(o) {
  const code = String(o.code);
  const timeoutMs = o.timeoutMs || 15000;
  return new Promise((resolve, reject) => {
    const cred = x509.generateSelfSigned('dsh-pairing');
    const sock = tls.connect({
      host: o.host, port: o.port, key: cred.keyPem, cert: cred.certPem,
      rejectUnauthorized: false, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
    });
    let buf = Buffer.alloc(0), st = null, encKey = null, phase = 'spake2', settled = false;
    const timer = setTimeout(() => finish(new Error('配对超时')), timeoutMs);
    function finish(err, res) {
      if (settled) return; settled = true; clearTimeout(timer);
      try { sock.destroy(); } catch (e) { /* ignore */ }
      if (err) reject(err); else resolve(res);
    }
    sock.on('error', finish);
    sock.on('secureConnect', () => {
      const ekm = Buffer.from(sock.exportKeyingMaterial(64, EXPORTER_LABEL, undefined));
      st = spake2.generateMsg('alice', Buffer.concat([Buffer.from(code, 'ascii'), ekm]));
      sock.write(frame(TYPE_SPAKE2, st.msg));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 6) {
        const ver = buf[0], type = buf[1], len = buf.readUInt32BE(2);
        if (buf.length < 6 + len) break;
        const payload = Buffer.from(buf.subarray(6, 6 + len));
        buf = buf.subarray(6 + len);
        if (ver !== 1) return finish(new Error('配对帧版本非法: ' + ver));
        if (type === TYPE_SPAKE2 && phase === 'spake2') {
          let km; try { km = spake2.processMsg(st, payload); } catch (e) { return finish(e); }
          if (!km) return finish(new Error('SPAKE2 失败（配对码或 exporter 不一致）'));
          encKey = aesKey(km);
          const info = Buffer.alloc(PEER_INFO_SIZE);
          info[0] = 0; // ADB_RSA_PUB_KEY
          Buffer.from(adbkey.pubkeyString(o.key) + '\u0000', 'utf8').copy(info, 1);
          sock.write(frame(TYPE_PEER_INFO, seal(encKey, 0, info)));
          phase = 'peerinfo';
        } else if (type === TYPE_PEER_INFO && phase === 'peerinfo') {
          let pt; try { pt = aesOpen(encKey, 0, payload); } catch (e) { return finish(new Error('PeerInfo 解密失败（密钥不一致）: ' + e.message)); }
          if (pt.length !== PEER_INFO_SIZE) return finish(new Error('PeerInfo 长度异常: ' + pt.length));
          try { sock.end(); } catch (e) { /* ignore */ }
          return finish(null, { guid: pt.subarray(1).toString('utf8').replace(/\u0000.*/s, ''), type: pt[0] });
        }
      }
    });
  });
}

module.exports = { pair };
