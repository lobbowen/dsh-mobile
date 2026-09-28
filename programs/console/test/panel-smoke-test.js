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

  // 原生件核验的落盘面：桥不可用时**不许**退化成「视为就位」——这正是 ADR-0001 那条
  // 「投放≠能力却零痕迹」的复发形状，所以单独钉一条（债 D12）。
  const cap = await get(port, '/native/capabilities');
  let cj = {};
  try { cj = JSON.parse(cap.body); } catch {}
  check('S-6b /native/capabilities 桥不可用 → 503 OS_OFFLINE（不代答就位）', cap.code === 503 && cj.code === 'OS_OFFLINE' && cj.collected === undefined, cap.code + ' ' + JSON.stringify(cj).slice(0, 60));

  // 取证两路同理：这条通道存在的意义就是「把读不到如实读成读不到」，所以它比别的域
  // 更不能代答 —— 桥断了却回 `collected:false` / `present:false`，设备上看会一模一样。
  const devs = await get(port, '/diagnostics/events');
  let devj = {};
  try { devj = JSON.parse(devs.body); } catch {}
  check('S-6c /diagnostics/events 桥不可用 → 503 OS_OFFLINE（不代答「没有记录」）', devs.code === 503 && devj.code === 'OS_OFFLINE' && devj.collected === undefined, devs.code + ' ' + JSON.stringify(devj).slice(0, 60));

  const prov = await get(port, '/diagnostics/provisioning');
  let provj = {};
  try { provj = JSON.parse(prov.body); } catch {}
  check('S-6d /diagnostics/provisioning 桥不可用 → 503 OS_OFFLINE', prov.code === 503 && provj.code === 'OS_OFFLINE' && provj.snapshot === undefined, prov.code + ' ' + JSON.stringify(provj).slice(0, 60));

  // 桥在时：查询串必须**原样**到达桥方法（取证的人给的 stage/level 被吞掉，就等于
  // 让他读了一份自己没要的东西）。用一个记账 stub 代替真桥，只验路由→方法→参数这条线。
  const seen = [];
  panel.call = async (method, params) => {
    seen.push({ method, params });
    return { ok: true, result: { collected: true, total: 0, matched: 0, events: [] } };
  };
  await get(port, '/diagnostics/events?stage=program-ota&level=fail&limit=50');
  check('S-6e /diagnostics/events 转发的方法与参数与查询串一致', seen.length === 1
    && seen[0].method === 'os.diagnostics.events'
    && seen[0].params.stage === 'program-ota' && seen[0].params.level === 'fail' && seen[0].params.limit === 50,
    JSON.stringify(seen[0] || {}));

  seen.length = 0;
  await get(port, '/diagnostics/events?limit=99999');
  check('S-6f limit 越界收到达上限而不是原样透传（桥侧还有第二道 coerce，两头都得有界）',
    seen.length === 1 && seen[0].params.limit === 2000, JSON.stringify(seen[0] || {}));

  seen.length = 0;
  await get(port, '/diagnostics/events?limit=abc');
  check('S-6g 非数字 limit 退回默认值而不是 NaN', seen.length === 1 && seen[0].params.limit === 200, JSON.stringify(seen[0] || {}));

  await panel.stop();
  check('S-7 面板可停（stop 完成）', true);

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('测试异常:', (e && e.stack) || e); console.log('\n结果: 0 passed, 1 failed'); process.exit(1); });

