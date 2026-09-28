'use strict';

// 域：Program 原生管理（OS AppManager / InstanceManager）。
//
// 面板只做「编排与展示」；下载/校验/落位/版本指针/卸载/启停的执行体在 OS 原生。
// 本域把旧「单一载荷专用」入口泛化为 Program 描述（id/spec/version），不再写死任何名称。

const { call } = require('./_os');

function owns(pathname) {
  return pathname.startsWith('/native/');
}

function handle(ctx) {
  const { panel, req, res, pathname, identity, send, collectBody, originAllowed } = ctx;

  if (req.method === 'GET' && pathname === '/native/status') {
    return call(send, panel, 'os.programs.overview', {}, { offlineBody: { installed: false, programs: [], versionInfo: null, upgrade: null } });
  }
  if (req.method === 'POST' && pathname === '/native/check-update') {
    if (!originAllowed(req, panel.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
    req.resume();
    return call(send, panel, 'os.appmgr.checkUpdate', {});
  }
  if (req.method === 'POST' && (pathname === '/native/install' || pathname === '/native/upgrade')) {
    if (!originAllowed(req, panel.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
    const method = pathname === '/native/install' ? 'os.appmgr.install' : 'os.appmgr.upgrade';
    return collectBody(req, res, 4096, (body) => {
      let j = {};
      try { j = body ? JSON.parse(body) : {}; } catch {}
      const params = {};
      if (typeof j.id === 'string' && j.id) params.id = j.id;
      if (typeof j.version === 'string' && j.version) params.version = j.version;
      call(send, panel, method, params);
    });
  }
  if (req.method === 'POST' && pathname === '/native/uninstall') {
    if (!originAllowed(req, panel.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
    req.resume();
    return call(send, panel, 'os.appmgr.uninstall', {});
  }
  if (req.method === 'POST' && pathname === '/native/settings') {
    if (!originAllowed(req, panel.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
    return collectBody(req, res, 4096, (body) => {
      let j = {};
      try { j = body ? JSON.parse(body) : {}; } catch {}
      call(send, panel, 'os.programs.settings', j);
    });
  }
  // 带令牌的 Program Web 直连 URL：令牌是会话凭据 → 只认回环来源。
  if (req.method === 'GET' && pathname === '/native/access') {
    if (!identity.loopback) return send(403, { ok: false, error: 'Program 访问令牌仅对本机回环下发' });
    const u = new URL(req.url, 'http://localhost');
    void u;
    return send(501, { ok: false, error: 'not_supported_in_v4', note: '面板由 OS 直接承载；OS 不签发 Web 令牌' });
  }

  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };

