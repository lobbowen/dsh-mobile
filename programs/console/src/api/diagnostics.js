'use strict';

// 域：取证 —— 诊断事件流 + 开机体检快照。
//
// 为什么单独一域：发布包不再是 debuggable 之后，`adb shell run-as` 这条路就断了；
// 而「哪一格为什么坏」的原始结论（diagnostics.txt / diag.jsonl / provisioning.json）
// 全在应用私有目录里。这条通道 = 回环 HTTP → 桥的 os.* 面（不受 Program 授权组约束），
// 只读、无副作用。
//
// 刻意**不给 offlineBody**：取证时「OS 没接线」与「设备上没有记录」是两件事 ——
// 后者由桥的 `collected/present=false` 如实表达，前者必须响亮地 503，不能被空集合冒充。

const { call } = require('./_os');

function owns(pathname) {
  return pathname.startsWith('/diagnostics');
}

function intParam(u, key, dflt, min, max) {
  const raw = u.searchParams.get(key);
  const n = raw === null || raw === '' ? dflt : Number(raw);
  return Math.min(Math.max(Number.isFinite(n) ? n : dflt, min), max);
}

function strParam(u, key) {
  const v = u.searchParams.get(key);
  return v === null ? '' : v;
}

function handle(ctx) {
  const { panel, req, pathname, send } = ctx;

  if (req.method === 'GET' && pathname === '/diagnostics/events') {
    const u = new URL(req.url, 'http://localhost');
    const params = {
      stage: strParam(u, 'stage'),
      level: strParam(u, 'level'),
      limit: intParam(u, 'limit', 200, 1, 2000),
    };
    return call(send, panel, 'os.diagnostics.events', params);
  }
  if (req.method === 'GET' && pathname === '/diagnostics/provisioning') {
    return call(send, panel, 'os.provisioning.get', {});
  }

  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
