'use strict';

// 域：统一任务视图（OS Journal 的任务投影）。
// 任务注册/推进是 OS 的职责；面板只读展示。

const { call } = require('./_os');

function owns(pathname) {
  return pathname === '/tasks' || pathname.startsWith('/tasks/');
}

function handle(ctx) {
  const { panel, req, res, pathname, send } = ctx;

  if (pathname === '/tasks') {
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
    const kind = new URL(req.url, 'http://localhost').searchParams.get('kind') || null;
    return call(send, panel, 'os.journal.tasks', { kind }, { offlineBody: { tasks: [], current: {} } });
  }
  if (pathname.startsWith('/tasks/')) {
    const segs = pathname.slice('/tasks/'.length).split('/');
    if (req.method === 'GET' && segs.length === 1) {
      return call(send, panel, 'os.journal.task', { id: segs[0] });
    }
    if (req.method === 'GET' && segs.length === 2 && segs[1] === 'current') {
      return call(send, panel, 'os.journal.tasks', { kind: segs[0], running: true }, { offlineBody: { items: [] } });
    }
    return send(404, { error: 'not found' });
  }
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };

