'use strict';

// 域：原生 DSH 生命周期 API（唯一通道）。
function owns(pathname) {
  return pathname.startsWith('/native/');
}

function handle(ctx) {
  const { sup, req, res, pathname, identity, send, collectBody, originAllowed, tokOf } = ctx;

    // 原生 DSH 生命周期（唯一通道）：状态(含版本) / 检测更新 / 安装 / 升级 / 卸载
    if (req.method === 'GET' && pathname === '/native/status') {
      return send(200, {
        ...(sup.nativeManager ? sup.nativeManager.status() : { installed: false }),
        versionInfo: sup.nativeManager ? sup.nativeManager.versionInfo() : null,
        upgrade: sup.nativeManager ? sup.nativeManager.upgradeStatus() : null,
      });
    }
    if (req.method === 'POST' && pathname === '/native/check-update') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      sup.nativeManager.checkUpdate().then((r) => send(200, { ok: true, ...r })).catch((e) => send(500, { ok: false, error: e.message }));
      return;
    }
    if (req.method === 'POST' && pathname === '/native/install') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      collectBody(req, res, 1024, (body) => {
        let version = null;
        try { const j = body ? JSON.parse(body) : {}; if (typeof j.version === 'string' && j.version) version = j.version; } catch {}
        // 异步任务模式：同步前置检查拒绝 → 400；通过 → 202，进度经 /native/status 轮询（前端不再真空）
        const r = sup.nativeManager.startInstall(version);
        if (r && r.ok === false) return send(400, r);
        return send(202, { ok: true, accepted: true, state: 'installing' });
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/native/upgrade') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      collectBody(req, res, 4096, (body) => {
        let requested = null;
        try { const j = body ? JSON.parse(body) : {}; if (j && typeof j.version === 'string' && j.version) requested = j.version; } catch {}
        if (sup.nativeManager.busy()) {
          return send(409, { error: 'upgrade already in progress', state: sup.nativeManager.upgradeState });
        }
        sup.nativeManager.upgrade(requested).catch(() => {}); // 异步升级，前端轮询 /native/status.upgrade
        send(202, { ok: true, accepted: true });
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/native/uninstall') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      // 异步任务模式：同步前置检查拒绝 → 400；通过 → 202，进度经 /native/status 轮询
      const r = sup.nativeManager.startUninstall();
      if (r && r.ok === false) return send(400, r);
      return send(202, { ok: true, accepted: true, state: 'uninstalling' });
    }
    // ── 原生主干(main)设置（概念清分 2026-09-06）：main 的设置不再经 /instances（沙箱域）；
    //    统一走本主干入口。白名单：guardian(守护自动拉起) / remoteEnabled(远程控制) / frp。
    if (req.method === 'POST' && pathname === '/native/settings') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      collectBody(req, res, 4096, (body) => {
        try {
          const j = body ? JSON.parse(body) : {};
          if (sup.patchDshMain && typeof sup.patchDshMain === 'function') {
            const r = sup.patchDshMain(j);
            return send(r && r.ok === false ? 400 : 200, r);
          }
          return send(500, { ok: false, error: '守卫未实现 patchDshMain' });
        } catch (e) { return send(400, { ok: false, error: e.message }); }
      });
      return;
    }
  // 域内未匹配(方法/子路径) → 全局兜底语义(与单文件时代一致)
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
