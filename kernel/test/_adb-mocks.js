'use strict';

// 本地 mock：配对服务端(bob) 与无线 adbd（STLS→TLS→shell）。仅供测试用。
const net = require('node:net');
const tls = require('node:tls');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const x509 = require(path.join(ROOT, 'src', 'adb', 'x509'));
const spake2 = require(path.join(ROOT, 'src', 'adb', 'spake2'));
const pairing = require(path.join(ROOT, 'src', 'adb', 'pairing'));
const transport = require(path.join(ROOT, 'src', 'adb', 'transport'));

/** mock 配对服务端。返回 { port, close(), lastPubkey() }。 */
function startPairingServer(o) {
  const code = String(o.code);
  const guid = o.guid || 'MOCK-GUID';
  const state = { pubkey: null };
  const cred = x509.generateSelfSigned('mock-pairing');
  const srv = tls.createServer({
    key: cred.keyPem, cert: cred.certPem, requestCert: true, rejectUnauthorized: false,
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
  }, (sock) => {
    try {
      const ekm = Buffer.from(sock.exportKeyingMaterial(64, pairing.EXPORTER_LABEL, undefined));
      const st = spake2.generateMsg('bob', Buffer.concat([Buffer.from(code, 'ascii'), ekm]));
      sock.write(pairing.frame(0, st.msg));
      let buf = Buffer.alloc(0), key = null, phase = 'spake2';
      sock.on('data', (d) => {
        try {
          buf = Buffer.concat([buf, d]);
          while (buf.length >= 6) {
            const type = buf[1], len = buf.readUInt32BE(2);
            if (buf.length < 6 + len) break;
            const payload = Buffer.from(buf.subarray(6, 6 + len)); buf = buf.subarray(6 + len);
            if (type === 0 && phase === 'spake2') { key = pairing.aesKey(spake2.processMsg(st, payload)); phase = 'peerinfo'; }
            else if (type === 1 && phase === 'peerinfo') {
              const pt = pairing.aesOpen(key, 0, payload);
              state.pubkey = pt.subarray(1).toString('utf8').replace(/\u0000.*/s, '');
              const info = Buffer.alloc(pairing.PEER_INFO_SIZE); info[0] = 1;
              Buffer.from(guid + '\u0000', 'utf8').copy(info, 1);
              sock.write(pairing.frame(1, pairing.seal(key, 0, info)));
              phase = 'done';
            }
          }
        } catch (e) { try { sock.destroy(); } catch (_) { /* ignore */ } }
      });
    } catch (e) { try { sock.destroy(); } catch (_) { /* ignore */ } }
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    port: srv.address().port, close: () => srv.close(), lastPubkey: () => state.pubkey,
  })));
}

/** mock 无线 adbd：CNXN→STLS→（客户端 STLS）→TLS→主动 CNXN→OPEN shell→WRTE/CLSE。 */
function startAdbdServer(o) {
  const output = (o && o.output) || 'uid=2000(shell)\n';
  const cred = x509.generateSelfSigned('mock-adbd');
  const srv = net.createServer((raw) => {
    let buf = Buffer.alloc(0), upgraded = false;
    function onData(d) {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= transport.HEADER_SIZE) {
        const cmd = buf.toString('ascii', 0, 4);
        const dataLen = buf.readUInt32LE(12);
        if (buf.length < transport.HEADER_SIZE + dataLen) break;
        buf = buf.subarray(transport.HEADER_SIZE + dataLen);
        if (cmd === 'CNXN' && !upgraded) {
          raw.write(transport.makePacket('STLS', transport.STLS_VERSION, 0, Buffer.alloc(0)));
        } else if (cmd === 'STLS' && !upgraded) {
          upgraded = true;
          raw.removeListener('data', onData);
          const ctx = tls.createSecureContext({ key: cred.keyPem, cert: cred.certPem });
          const ts = new tls.TLSSocket(raw, { isServer: true, secureContext: ctx, requestCert: true, rejectUnauthorized: false });
          ts.on('error', () => { /* ignore */ });
          ts.write(transport.makePacket('CNXN', 0x01000001, 390, Buffer.from('device::mock\u0000', 'utf8')));
          let acc = Buffer.alloc(0);
          ts.on('data', (d2) => {
            acc = Buffer.concat([acc, d2]);
            while (acc.length >= transport.HEADER_SIZE) {
              const c2 = acc.toString('ascii', 0, 4);
              const l2 = acc.readUInt32LE(12);
              if (acc.length < transport.HEADER_SIZE + l2) break;
              acc = acc.subarray(transport.HEADER_SIZE + l2);
              if (c2 === 'OPEN') {
                ts.write(transport.makePacket('OKAY', 1, 1, Buffer.alloc(0)));
                ts.write(transport.makePacket('WRTE', 1, 1, Buffer.from(output, 'utf8')));
                ts.write(transport.makePacket('CLSE', 1, 1, Buffer.alloc(0)));
              }
            }
          });
        }
      }
    }
    raw.on('data', onData);
    raw.on('error', () => { /* ignore */ });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() })));
}

module.exports = { startPairingServer, startAdbdServer };
