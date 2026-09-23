#!/usr/bin/env node
'use strict';

// 原生 DSH 端口运行时再推导回归（2026-09 修复）：mock DSH 以 --port N 运行（用户改端口），
// 守卫配置端口无监听但进程在跑 -> _findManagedDshPort 推真实端口 -> _applyMainPort 更正注册。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'main-port-'));
const MOCK = path.join(ROOT, 'test', 'fixtures', 'dsh-mock.js');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = http.createServer(); s.on('error', () => res(0)); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const { shared: ports } = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'ports'));
  const realPort = await freePort();
  const cfgPort = await freePort();
  const child = spawn(process.execPath, [MOCK, 'web', '--port', String(realPort)], { stdio: 'ignore' });
  const cfg = {
    command: [process.execPath, MOCK, 'web', '--port', String(cfgPort)],
    targetHost: '127.0.0.1', targetPort: cfgPort,
    healthUrl: 'http://127.0.0.1:' + cfgPort + '/',
    apiHost: '127.0.0.1', apiPort: await freePort(),
    stateFile: path.join(TMP, 'state.json'),
    logFile: path.join(TMP, 'events.log'),
    supervisorLogFile: path.join(TMP, 'sup.log'),
    dshLogFile: path.join(TMP, 'dsh.log'),
    upgradeLogFile: path.join(TMP, 'upg.log'),
    probeIntervalMs: 5000, probeTimeoutMs: 2000,
  };
  const cfgPath = path.join(TMP, 'cfg.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  await new Promise((resolve) => { const t0 = Date.now(); const t = () => { http.get({ host: '127.0.0.1', port: realPort, path: '/', timeout: 500 }, (s) => { s.resume(); resolve(); }).on('error', () => { if (Date.now() - t0 > 5000) resolve(); else setTimeout(t, 150); }); }; t(); });
  const sup = new Supervisor(cfg, cfgPath);
  // 概念清分(2026-09-06)：main 是守卫核心服务，不再登记为沙箱实例；端口唯一事实源 = config.targetPort。
  const found = sup._findManagedDshPort();
  check('从进程推导出真实端口 ' + realPort, found && found.port === realPort, JSON.stringify(found));
  const applied = sup._applyMainPort(found.port, found.pid);
  check('应用真实端口成功', applied === true, String(applied));
  check('config.targetPort 已更正', sup.config.targetPort === realPort, String(sup.config.targetPort));
  check('dsh-main 注册已更正', ports.get('dsh-main') === realPort, String(ports.get('dsh-main')));
  const mainView = (sup.dshMainView && typeof sup.dshMainView === 'function') ? sup.dshMainView() : null;
  check('main(守卫核心视图)端口已跟随', !!mainView && mainView.port === realPort, JSON.stringify(mainView && mainView.port));
  check('healthUrl 已跟随', String(sup.config.healthUrl).indexOf(':' + realPort) >= 0, sup.config.healthUrl);
  try { child.kill('SIGKILL'); } catch {}
  try { if (sup.stop) await sup.stop(); } catch {}
  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', (e && e.stack) || e); process.exit(1); });