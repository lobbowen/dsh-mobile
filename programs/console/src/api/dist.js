'use strict';

// 域：镜像源 / 分发配置（执行体在 OS 原生 registry/AppManager）。
// 面板只做展示与编排；选源/探活是对 OS 能力 API 的调用。

const { call } = require('./_os');

function owns(pathname) {
  return pathname.startsWith('/dist/');
}

function handle(ctx) {
  const { panel, req, res, pathname, send, collectBody, originAllowed } = ctx;

  if (req.method === 'GET' && pathname === '/dist/registry') {
    return call(send, panel, 'os.registry.info', {});
  }
  if (req.method === 'POST' && pathname === '/dist/registry/set') {
    if (!originAllowed(req, panel.config.apiPort)) { req.resume(); return send(403, { ok: false }); }
    return collectBody(req, res, 8192, (body) => {
      let j = {};
      try { j = body ? JSON.parse(body) : {}; } catch { return send(400, { ok: false }); }
      call(send, panel, 'os.registry.set', j);
    });
  }
  if (req.method === 'POST' && pathname === '/dist/registry/refresh') {
    if (!originAllowed(req, panel.config.apiPort)) { req.resume(); return send(403, { ok: false }); }
    req.resume();
    return call(send, panel, 'os.registry.refresh', {});
  }
  if (req.method === 'POST' && pathname === '/dist/registry/probe') {
    if (!originAllowed(req, panel.config.apiPort)) { req.resume(); return send(403, { ok: false }); }
    return collectBody(req, res, 4096, (body) => {
      let j = {};
      try { j = body ? JSON.parse(body) : {}; } catch {}
      const origin = String(j.origin || '').trim();
      if (!/^https?:\/\//.test(origin)) return send(400, { ok: false, error: 'origin 必须以 http(s):// 开头' });
      call(send, panel, 'os.registry.probe', { origin });
    });
  }

  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };

