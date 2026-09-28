'use strict';

// 域：ADB 无线调试 —— **只读环境状态**（/adb/status）。
//
// ADB 配对/密钥/传输是权限通道，物理上必须留在 OS 原生（凭据与审计不得交给
// 可 OTA 替换的 Program）。本端点仅把桥 shell.status 的结果作为「环境状态」呈现，
// 不承载任何配置写操作。

const hostBridge = require('../platform/host-bridge/client');

function owns(pathname) {
  return pathname === '/adb/status';
}

function handle(ctx) {
  const { req, send } = ctx;

  if (req.method === 'GET' && ctx.pathname === '/adb/status') {
    hostBridge.client().call('shell.status', {})
      .then((r) => {
        if (r && typeof r === 'object') return send(200, { ok: true, ...r });
        return send(200, { ok: false, error: 'OS 能力桥不可用（非容器环境或 OS 未就绪）' });
      })
      .catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
    return undefined;
  }

  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: ctx.pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };

