'use strict';

// 域：ADB 无线调试 —— **只读环境状态**（/adb/status）。
//
// 为什么这个域只剩透传（ADR-0007 §2.3）：ADB 配对/密钥/传输是权限通道，物理上必须留在
// L0 容器（凭据与审计不得交给 OTA 可换的内核件）。操作入口在容器 GUI 与桥方法
// （shell.pair / shell.exec / shell.forget，见 ADR-0003 勘误）；本端点仅把桥
// shell.status 的结果作为「环境状态」呈现给面板，不承载任何配置写操作。

const hostBridge = require('../platform/host-bridge/client');

function owns(pathname) {
  return pathname === '/adb/status';
}

function handle(ctx) {
  const { req, res, pathname, send } = ctx;

  if (req.method === 'GET' && pathname === '/adb/status') {
    hostBridge.client().call('shell.status', {})
      .then((r) => {
        if (r && typeof r === 'object') return send(200, { ok: true, ...r });
        return send(200, { ok: false, error: '桥不可用（非容器环境或 :main 未就绪）' });
      })
      .catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
    return undefined;
  }

  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
