'use strict';

// 域：状态与实例生命周期 API。
// 面板不自持生命周期：所有实例/会话事实经 OS 原生能力 API 读取与驱动。

const { OFFLINE, unavailable, call } = require('./_os');

function owns(pathname) {
  return pathname === '/status' || pathname.startsWith('/lifecycle') || pathname === '/healthz' || pathname === '/readyz'
    || pathname === '/events' || pathname.startsWith('/logs') || pathname === '/metrics'
    || pathname === '/session/stop' || pathname === '/session/status';
}

function handle(ctx) {
  const { panel, req, res, pathname, send, collectBody, originAllowed } = ctx;

  if (req.method === 'GET' && pathname === '/status') {
    return Promise.resolve(panel.statusSummary()).then((s) => send(200, s)).catch((e) => send(500, { error: e.message }));
  }
  if (req.method === 'GET' && pathname === '/healthz') {
    return send(200, { ok: true, panel: true, pid: process.pid });
  }
  if (req.method === 'GET' && pathname === '/readyz') {
    return send(200, { ok: true, ready: true });
  }

  // ── OS journal（打断可见，非续跑）──
  if (req.method === 'GET' && pathname === '/events') {
    let after = 0; let limit = 50; let internal = false;
    try {
      const u = new URL(req.url, 'http://localhost');
      after = Math.max(Number(u.searchParams.get('after') || 0) || 0, 0);
      limit = Math.min(Math.max(Number(u.searchParams.get('limit') || 50) || 50, 1), 500);
      internal = u.searchParams.get('internal') === '1' || u.searchParams.get('internal') === 'true';
    } catch {}
    return call(send, panel, 'os.journal.read', { after, limit, internal }, { offlineBody: { seq: 0, events: [] } });
  }
  if (req.method === 'GET' && pathname === '/logs/tail') {
    const u = new URL(req.url, 'http://localhost');
    const stream = u.searchParams.get('stream') || 'os';
    const n = Math.min(Math.max(Number(u.searchParams.get('n') || 100) || 100, 1), 2000);
    return call(send, panel, 'os.journal.logTail', { stream, n }, { offlineBody: { stream, lines: [] } });
  }
  if (req.method === 'GET' && pathname === '/logs/export') {
    const u = new URL(req.url, 'http://localhost');
    const after = Math.max(Number(u.searchParams.get('after') || 0) || 0, 0);
    const limit = Math.min(Math.max(Number(u.searchParams.get('limit') || 2000) || 2000, 1), 20000);
    return call(send, panel, 'os.journal.export', { after, limit }, { offlineBody: { seq: 0, exported: 0, lines: [] } });
  }
  if (req.method === 'GET' && pathname === '/metrics') {
    return call(send, panel, 'os.journal.metrics', {}, { offlineBody: { gseq: 0, events: 0, bySource: {}, topTypes: [], sinceLastMs: null } });
  }

  // ── 实例生命周期（统一入口；启停由 OS InstanceManager 执行）──
  if (pathname === '/lifecycle' || pathname === '/lifecycle/status') {
    return call(send, panel, 'os.instances.list', {}, { offlineBody: { modules: [] } });
  }
  if (pathname.startsWith('/lifecycle/')) {
    const rest = pathname.slice('/lifecycle/'.length);
    const parts = rest.split('/');
    const id = parts[0];
    const action = parts[1] || null;
    if (req.method === 'GET' && !action) {
      return call(send, panel, 'os.instances.get', { id });
    }
    if (req.method === 'POST' && action) {
      if (!originAllowed(req, panel.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      if (action !== 'start' && action !== 'stop' && action !== 'restart') return send(400, { error: '未知动作: ' + action + '（start|stop|restart）' });
      req.resume();
      return call(send, panel, 'os.instances.action', { id, action });
    }
    return send(400, { error: '非法请求' });
  }

  // ── 会话（容器退出握手）：面板只转发，不自停 OS ──
  if (req.method === 'GET' && pathname === '/session/status') {
    return call(send, panel, 'os.session.get', {}, { offlineBody: { sessionState: 'unknown' } });
  }
  if (req.method === 'POST' && pathname === '/session/stop') {
    if (!originAllowed(req, panel.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
    req.resume();
    return call(send, panel, 'os.session.stop', {});
  }

  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle, OFFLINE, unavailable };

