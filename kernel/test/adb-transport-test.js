#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// ADB 无线连接传输层回归（本地 mock adbd，无真机）
//
// mock 复刻 adbd 的无线调试行为：CNXN → 回 STLS → 客户端回 STLS 并把同一
// socket 升级 TLS 1.3（客户端证书由 ADB 私钥签发）→ **设备侧主动发 CNXN**
// → 处理 OPEN shell 并回 WRTE/CLSE。
// 覆盖：报文编码（magic/长度/校验和）+ STLS→TLS→shell 端到端。
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

const adbkey = require(path.join(ROOT, 'src', 'adb', 'adbkey'));
const x509 = require(path.join(ROOT, 'src', 'adb', 'x509'));
const transport = require(path.join(ROOT, 'src', 'adb', 'transport'));

// ── T1–T3：报文编码（纯函数）──
{
  const payload = Buffer.from('hi');
  const p = transport.makePacket('WRTE', 7, 9, payload);
  check('T1 头字段（command/arg0/arg1/dataLength）',
    p.toString('ascii', 0, 4) === 'WRTE' && p.readUInt32LE(4) === 7 && p.readUInt32LE(8) === 9 && p.readUInt32LE(12) === 2);
  const cmd = transport.commandInt('WRTE') >>> 0;
  check('T2 magic == command xor 0xffffffff', (p.readUInt32LE(20) >>> 0) === ((cmd ^ 0xffffffff) >>> 0));
  check('T3 checksum == 各字节无符号和', p.readUInt32LE(16) === transport.checksum(payload));
}

// ── T4–T5：mock adbd 端到端 ──
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
        // 设备侧 TLS 成功后主动发 CNXN
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
              ts.write(transport.makePacket('WRTE', 1, 1, Buffer.from('uid=2000(shell)\n', 'utf8')));
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

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const key = adbkey.generate('mock@host');
  const r = await transport.shell({ host: '127.0.0.1', port: port, key: key, cmd: 'id', timeoutMs: 8000 });
  check('T4 STLS→TLS→shell 拿到输出', r.out.includes('uid=2000'), JSON.stringify(r.out));
  check('T5 确实走了 TLS 升级路径', r.logs.some((l) => l.indexOf('TLS established') >= 0), r.logs.join(' | '));
  srv.close();
  const failed = results.filter((x) => !x).length;
  console.log('\n结果: ' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
