#!/usr/bin/env node
'use strict';

// ADB API 域（src/api/adb.js）回归：直接驱动域 handle（轻量 fake ctx），
// 覆盖状态 / 配对 / shell / 参数校验 / owns 边界。
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

const domain = require(path.join(ROOT, 'src', 'api', 'adb'));
const idx = require(path.join(ROOT, 'src', 'adb', 'index'));
const mocks = require('./_adb-mocks');

/** 用一个极简 ctx 驱动一次请求，返回 { statusCode, body }。 */
function invoke(method, pathname, body) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ statusCode: 0, body: { error: 'no-response' } }), 8000);
    const send = (code, obj) => { clearTimeout(timer); resolve({ statusCode: code, body: obj }); };
    const ctx = {
      sup: { config: { apiPort: 3100 } },
      req: { method: method, resume() {} },
      res: {},
      pathname: pathname,
      send: send,
      collectBody: (rq, rs, max, onDone) => onDone(body === undefined ? '' : JSON.stringify(body)),
      originAllowed: () => true,
    };
    domain.handle(ctx);
  });
}

(async () => {
  check('A1 owns 边界', domain.owns('/adb/status') && domain.owns('/adb/pair') && !domain.owns('/adb/other') && !domain.owns('/adb'));

  idx.ensureKey('api@host'); // status() 是只读，需先确保密钥存在
  const s = await invoke('GET', '/adb/status');
  check('A2 GET /adb/status → 200 且带 pubkey', s.statusCode === 200 && s.body.ok === true && typeof s.body.pubkey === 'string');

  const bad = await invoke('POST', '/adb/pair', { host: '127.0.0.1', pairPort: 1 });
  check('A3 /adb/pair 缺 code → 400', bad.statusCode === 400);

  const adbd = await mocks.startAdbdServer({ output: 'uid=2000(shell)\n' });
  const psrv = await mocks.startPairingServer({ code: '246810', guid: 'API-GUID' });
  const pr = await invoke('POST', '/adb/pair', { host: '127.0.0.1', pairPort: psrv.port, code: '246810', connectPort: adbd.port });
  check('A4 /adb/pair → 200 且 GUID 正确', pr.statusCode === 200 && pr.body.guid === 'API-GUID', JSON.stringify(pr.body));

  const sh = await invoke('POST', '/adb/shell', { cmd: 'id' });
  check('A5 /adb/shell → 200 且输出 uid=2000', sh.statusCode === 200 && String(sh.body.out || '').includes('uid=2000'), JSON.stringify(sh.body));

  const shBad = await invoke('POST', '/adb/shell', {});
  check('A6 /adb/shell 缺 cmd → 400', shBad.statusCode === 400);

  const fg = await invoke('POST', '/adb/forget');
  check('A7 /adb/forget → 200 且清除配对', fg.statusCode === 200 && idx.status().paired === false);

  psrv.close(); adbd.close();
  const failed = results.filter((x) => !x).length;
  console.log('\n结果: ' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
