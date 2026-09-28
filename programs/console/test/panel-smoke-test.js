#!/usr/bin/env node
'use strict';

// 面板冒烟：启动面板 HTTP 服务，验证「桥不可用时降级且不伪造 OS 状态」。
// 这是「可停可换」在面板侧的可验证判据之一（另一部分见 console-not-init-test.js）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.LOBOS_PANEL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lobos-panel-smoke-'));
const { Panel } = require(path.join(__dirname, '..', 'src', 'panel.js'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ code: res.statusCode, body: b }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

(async () => {
  const panel = new Panel({ config: { apiPort: 0 } });
  panel.config.apiPort = 0;
  const addr = await panel.start();
  const port = addr.port;
  check('S-1 面板监听成功', Number.isInteger(port) && port > 0, String(port));

  const status = await get(port, '/status');
  let sj = {};
  try { sj = JSON.parse(status.body); } catch {}
  check('S-2 /status 200', status.code === 200, String(status.code));
  check('S-3 /status 明确标注 OS 未接线（不伪造）', sj.osOnline === false && sj.degraded === undefined, JSON.stringify(sj.osOnline));
  check('S-4 /status 带面板自身事实', !!(sj.panel && sj.panel.id === 'console' && sj.panel.version), JSON.stringify(sj.panel || {}));

  const health = await get(port, '/healthz');
  check('S-5 /healthz 200 ok', health.code === 200 && /"ok":true/.test(health.body), health.body.slice(0, 60));

  const nat = await get(port, '/native/status');
  let nj = {};
  try { nj = JSON.parse(nat.body); } catch {}
  check('S-6 /native/status 桥不可用 → 503 OS_OFFLINE', nat.code === 503 && nj.code === 'OS_OFFLINE', nat.code + ' ' + (nj.code || ''));

  await panel.stop();
  check('S-7 面板可停（stop 完成）', true);

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('测试异常:', (e && e.stack) || e); console.log('\n结果: 0 passed, 1 failed'); process.exit(1); });

