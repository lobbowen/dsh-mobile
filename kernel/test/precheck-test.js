#!/usr/bin/env node
'use strict';

// 前置条件测试：原生 DSH 未安装时，_startProcess 必须走「未安装」分支
// （不启动、不重试、不计数崩溃），而非当作启动失败无限重试。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
// 端口手工分配在安全段（避开 OS ephemeral 与生产池）；跨文件不撞号靠人工规划，T1 兜底。

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-precheck-'));

(async () => {
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const cfg = {
    command: ['node', '/nonexistent/bin/dsh', 'web'],
    healthUrl: 'http://127.0.0.1:28160/',
    apiHost: '127.0.0.1', apiPort: 28161,
    stateFile: path.join(TMP, 'state.json'),
    logFile: path.join(TMP, 'events.log'),
    supervisorLogFile: path.join(TMP, 'sup.log'),
    dshLogFile: path.join(TMP, 'dsh.log'),
    upgradeLogFile: path.join(TMP, 'upg.log'),
  };
  const cfgPath = path.join(TMP, 'cfg.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const sup = new Supervisor(cfg, cfgPath);
  sup.phase = 'STOPPED';
  sup._startProcess();
  const ok = sup.phase === 'STOPPED' && sup.spawnBlockedUntil !== null && sup.restartCount === 0 && sup.missingNotified === true;
  console.log((ok ? 'PASS' : 'FAIL') + ' 未安装时不启动不重试（phase=STOPPED, 冷静期生效, restartCount=0）');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
