#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// ADB 门面（src/adb/index.js）回归：密钥落盘 → 配对持久化 → 直连 shell。
// 用本地 mock pairing server + mock adbd，跑完整链路（无真机）。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

const adbkey = require(path.join(ROOT, 'src', 'adb', 'adbkey'));
const idx = require(path.join(ROOT, 'src', 'adb', 'index'));
const mocks = require('./_adb-mocks');

(async () => {
  const key = idx.ensureKey('test@host');
  check('I1 密钥落盘且权限 0600',
    fs.existsSync(idx.keyPath()) && (fs.statSync(idx.keyPath()).mode & 0o777) === 0o600, idx.keyPath());

  const s0 = idx.status();
  check('I2 未配对时 paired=false 且公钥可读',
    s0.paired === false && s0.pubkey === adbkey.pubkeyString(key));

  const adbd = await mocks.startAdbdServer({ output: 'uid=2000(shell)\n' });
  const psrv = await mocks.startPairingServer({ code: '123456', guid: 'GUID-ABC' });

  const r = await idx.pair({ host: '127.0.0.1', pairPort: psrv.port, code: '123456', connectPort: adbd.port });
  check('I3 配对成功', r.guid === 'GUID-ABC' && r.type === 1, r.guid);
  check('I4 设备收到的公钥 == 本地密钥', psrv.lastPubkey() === adbkey.pubkeyString(key));

  const s1 = idx.status();
  check('I5 配对端点已持久化', s1.paired === true && s1.host === '127.0.0.1' && s1.connectPort === adbd.port && s1.guid === 'GUID-ABC');

  const sh = await idx.shell({ cmd: 'id', timeoutMs: 8000 });
  check('I6 用持久化端点直连 shell（无需再传地址）', sh.out.includes('uid=2000'), JSON.stringify(sh.out));

  idx.forget();
  check('I7 forget 清除配对端点', idx.status().paired === false);

  psrv.close(); adbd.close();
  const failed = results.filter((x) => !x).length;
  console.log('\n结果: ' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
