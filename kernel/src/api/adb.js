'use strict';

// 域：ADB 无线调试（/adb/*）—— 状态 / 配对 / shell / 清除端点。
// 真实逻辑在 src/adb/index.js（门面：密钥与端点落盘、pairing、transport）；
// 本域只做 HTTP 包装与 CSRF 写保护（与其它域一致）。
const adb = require('../adb');

function owns(pathname) {
  return pathname === '/adb/status' || pathname === '/adb/pair' || pathname === '/adb/shell' || pathname === '/adb/forget';
}

function handle(ctx) {
  const { sup, req, res, pathname, send, collectBody, originAllowed } = ctx;

  if (req.method === 'GET' && pathname === '/adb/status') {
    return send(200, { ok: true, ...adb.status() });
  }

  if (req.method === 'POST' && pathname === '/adb/pair') {
    if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
    return collectBody(req, res, 8192, (body) => {
      let j = {};
      try { j = body ? JSON.parse(body) : {}; } catch { return send(400, { ok: false, error: 'bad json' }); }
      const host = String(j.host || '').trim();
      const pairPort = Number(j.pairPort);
      const code = String(j.code || '').trim();
      const connectPort = j.connectPort ? Number(j.connectPort) : undefined;
      if (!host || !(pairPort > 0) || !code) return send(400, { ok: false, error: '需要 host / pairPort / code' });
      Promise.resolve(adb.pair({ host, pairPort, code, connectPort, name: j.name }))
        .then((r) => send(200, { ok: true, ...r }))
        .catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
    });
  }

  if (req.method === 'POST' && pathname === '/adb/shell') {
    if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
    return collectBody(req, res, 8192, (body) => {
      let j = {};
      try { j = body ? JSON.parse(body) : {}; } catch { return send(400, { ok: false, error: 'bad json' }); }
      const cmd = String(j.cmd || '').trim();
      if (!cmd) return send(400, { ok: false, error: '需要 cmd' });
      Promise.resolve(adb.shell({ cmd, host: j.host, connectPort: j.connectPort, timeoutMs: j.timeoutMs }))
        .then((r) => send(200, { ok: true, ...r }))
        .catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
    });
  }

  if (req.method === 'POST' && pathname === '/adb/forget') {
    if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
    adb.forget();
    return send(200, { ok: true });
  }

  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
