'use strict';

// 域：面板自身设置 + OS 环境/端口只读视图。
//
// 面板自身设置（局域网开关 / 访问密钥）落在面板自己的状态根；OS 环境与端口
// 事实经 OS 原生能力 API 读取。面板**不**分配端口（OS PortBroker 是唯一权威）。

const fs = require('node:fs');
const path = require('node:path');
const { call } = require('./_os');

function owns(pathname) {
  return pathname === '/changelog' || pathname.startsWith('/guard/')
    || pathname.startsWith('/settings/')
    || pathname === '/env/status' || pathname === '/env/programs' || pathname === '/env/node-lts'
    || pathname === '/ports';
}

function panelChangelog(res, panel) {
  const md = 'Lob OS 控制面板（console）\n\n'
    + '当前版本：' + panel.version + '\n'
    + '定位：控制面板 Program（可停可换），系统职责归 OS 原生。\n'
    + '接口清单：docs/components/console-system-api.md\n';
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  return res.end(md);
}

function handle(ctx) {
  const { panel, req, res, pathname, send, collectBody, originAllowed } = ctx;

  if (req.method === 'GET' && pathname === '/changelog') {
    return panelChangelog(res, panel);
  }
  if (req.method === 'GET' && pathname === '/guard/changelog') {
    try {
      const md = fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(md);
    } catch {
      return send(404, { error: 'changelog not found' });
    }
  }
  if (req.method === 'GET' && pathname === '/guard/version') {
    return send(200, { version: panel.version, latest: null, updateAvailable: false, source: 'program-package' });
  }
  if (req.method === 'POST' && pathname === '/guard/version/check') {
    req.resume();
    if (!originAllowed(req, panel.config.apiPort)) return send(403, { ok: false, error: 'cross-origin request rejected' });
    // 面板版本由 OS/OTA 决定（单写入者），面板不自行升级。
    return send(200, { version: panel.version, latest: null, updateAvailable: false, note: '面板更新由 OS OTA 负责' });
  }

  if (req.method === 'GET' && pathname === '/settings/lan') {
    return send(200, panel.lanStatus());
  }
  if (req.method === 'POST' && pathname === '/settings/lan') {
    if (!originAllowed(req, panel.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
    return collectBody(req, res, 1024, (body) => {
      let enabled = null;
      try { const j = body ? JSON.parse(body) : {}; if (typeof j.enabled === 'boolean') enabled = j.enabled; } catch {}
      if (enabled === null) return send(400, { ok: false, error: '需要 {"enabled":true|false}' });
      return send(200, panel.setLan(enabled));
    });
  }
  if (req.method === 'GET' && pathname === '/settings/access-key') {
    return send(200, panel.accessKeyStatus());
  }
  if (req.method === 'POST' && pathname === '/settings/access-key') {
    if (!originAllowed(req, panel.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
    return collectBody(req, res, 4096, (body) => {
      let key = null;
      try { const j = body ? JSON.parse(body) : {}; if (typeof j.key === 'string') key = j.key; } catch {}
      if (key === null) return send(400, { ok: false, error: '需要 {"key":"<访问密钥>"}（空串清除）' });
      if (key && key.length < 8) return send(400, { ok: false, error: '访问密钥至少 8 位（建议 16+ 位随机串）' });
      return send(200, panel.setAccessKey(key));
    });
  }

  if (req.method === 'GET' && pathname === '/env/status') {
    return call(send, panel, 'os.env.status', {}, { offlineBody: { platform: 'unknown', capabilities: [], catalog: [] } });
  }
  if (req.method === 'GET' && pathname === '/env/programs') {
    return call(send, panel, 'os.env.programs', {}, { offlineBody: { programs: [] } });
  }
  if (req.method === 'GET' && pathname === '/env/node-lts') {
    return call(send, panel, 'os.runtime.nodeLts', {}, { offlineBody: { current: null, latest: null, updateAvailable: false } });
  }

  if (req.method === 'GET' && pathname === '/ports') {
    return call(send, panel, 'os.ports.list', {}, { offlineBody: { fixed: {}, user: [], allocated: [] } });
  }

  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };

