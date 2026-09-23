#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// ADB 无线配对 —— 端到端自洽回归（本地 mock pairing server，无真机）
//
// mock 扮演设备侧（bob）：TLS 1.3（要客户端证书、接受任意）→ exporter → SPAKE2
// → HKDF+AES-GCM → PeerInfo 交换。客户端走真实的 src/adb/pairing。
// 覆盖：成功配对 / 客户端公钥串一致 / 错码必须失败。
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const tls = require('node:tls');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

const x509 = require(path.join(ROOT, 'src', 'adb', 'x509'));
const spake2 = require(path.join(ROOT, 'src', 'adb', 'spake2'));
const adbkey = require(path.join(ROOT, 'src', 'adb', 'adbkey'));
const pairing = require(path.join(ROOT, 'src', 'adb', 'pairing'));

const GUID = 'SELFTEST-GUID-1234';
const CODE = '123456';
const serverState = { pubkey: null };

const cred = x509.generateSelfSigned('selftest-server');
const server = tls.createServer({
  key: cred.keyPem, cert: cred.certPem,
  requestCert: true, rejectUnauthorized: false,
  minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
}, (sock) => {
  try {
    const ekm = Buffer.from(sock.exportKeyingMaterial(64, pairing.EXPORTER_LABEL, undefined));
    const st = spake2.generateMsg('bob', Buffer.concat([Buffer.from(CODE, 'ascii'), ekm]));
    sock.write(pairing.frame(0, st.msg));
    let buf = Buffer.alloc(0), key = null, phase = 'spake2';
    sock.on('data', (d) => {
      try {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 6) {
          const type = buf[1], len = buf.readUInt32BE(2);
          if (buf.length < 6 + len) break;
          const payload = Buffer.from(buf.subarray(6, 6 + len));
          buf = buf.subarray(6 + len);
          if (type === 0 && phase === 'spake2') {
            key = pairing.aesKey(spake2.processMsg(st, payload));
            phase = 'peerinfo';
          } else if (type === 1 && phase === 'peerinfo') {
            const pt = pairing.aesOpen(key, 0, payload);
            serverState.pubkey = pt.subarray(1).toString('utf8').replace(/\u0000.*/s, '');
            const info = Buffer.alloc(pairing.PEER_INFO_SIZE);
            info[0] = 1; // ADB_DEVICE_GUID
            Buffer.from(GUID + '\u0000', 'utf8').copy(info, 1);
            sock.write(pairing.frame(1, pairing.seal(key, 0, info)));
            phase = 'done';
          }
        }
      } catch (e) { try { sock.destroy(); } catch (_) { /* ignore */ } }
    });
  } catch (e) { try { sock.destroy(); } catch (_) { /* ignore */ } }
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const key = adbkey.generate('selftest@host');

  // P1/P2：正确配对码
  const r = await pairing.pair({ host: '127.0.0.1', port: port, code: CODE, key: key });
  check('P1 正确配对码 → 拿到设备 GUID', r.guid === GUID, r.guid);
  check('P2 设备回的是 ADB_DEVICE_GUID(1)', r.type === 1);
  check('P3 客户端上报的公钥串 == 本地生成', serverState.pubkey === adbkey.pubkeyString(key),
    serverState.pubkey ? ('len=' + serverState.pubkey.length) : 'null');

  // P4：错误配对码必须失败（两端派生密钥不一致）
  let rejected = false;
  try { await pairing.pair({ host: '127.0.0.1', port: port, code: '999999', key: key, timeoutMs: 8000 }); }
  catch (e) { rejected = true; }
  check('P4 错误配对码必须失败', rejected);

  server.close();
  const failed = results.filter((x) => !x).length;
  console.log('\n结果: ' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
