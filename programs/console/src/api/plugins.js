'use strict';

// 域：Program 市场展示 + 已装第三方组件视图。
// v4：组件/扩展是 **Program 自己**的 npm 依赖，执行体不在 OS（OS 面无 plugin 方法）。
// 这里给显式 501 + 原因，不再转发到一个永不实现/已移出的桥方法。

const { call } = require('./_os');

function owns(pathname) {
  return pathname.startsWith('/plugins/');
}

function handle(ctx) {
  const { panel, req, res, pathname, send, collectBody, originAllowed } = ctx;

  if (req.method === 'GET' && pathname === '/plugins/market') {
    const force = req.url.indexOf('refresh=1') >= 0;
    return panel.pluginMarket.getIndex(force).then(
      (r) => send(200, r),
      (e) => send(500, { ok: false, error: e.message })
    );
  }
  if (req.method === 'GET' && pathname === '/plugins/installed') {
    return call(send, panel, 'os.programs.list', { role: 'component' }, { offlineBody: { programs: [] } });
  }
  if (req.method === 'GET' && pathname === '/plugins/check-updates') {
    const force = req.url.indexOf('refresh=1') >= 0;
    void force;
    return send(501, { ok: false, error: 'not_supported_in_v4', note: '组件更新检测归 Program 侧（OS 面无 plugin 方法）' });
  }
  if (req.method === 'GET' && pathname === '/plugins/install-status') {
    const u = new URL(req.url, 'http://localhost');
    void u;
    return send(501, { ok: false, error: 'not_supported_in_v4', note: '作业状态由 Program 侧自持' });
  }
  if (req.method === 'POST' && pathname.startsWith('/plugins/')) {
    if (!originAllowed(req, panel.config.apiPort)) {
      req.resume();
      return send(403, { ok: false, error: 'cross-origin request rejected' });
    }
    const action = pathname.slice('/plugins/'.length);
    if (!['install', 'uninstall', 'enable', 'disable', 'update'].includes(action)) return send(404, { error: 'not found' });
    return collectBody(req, res, 65536, (body) => {
      let j = {};
      try { j = body ? JSON.parse(body) : {}; } catch {}
      const params = { action };
      for (const k of ['name', 'spec', 'target']) if (typeof j[k] === 'string') params[k] = j[k];
      if (typeof j.enabled === 'boolean') params.enabled = j.enabled;
      void params;
      send(501, { ok: false, error: 'not_supported_in_v4', note: '扩展的安装/启停归 Program 自己（npm 依赖），不经 OS' });
    });
  }

  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };

