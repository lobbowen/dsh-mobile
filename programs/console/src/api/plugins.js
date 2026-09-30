'use strict';

// 域：插件管理 API。
function owns(pathname) {
  return pathname.startsWith('/plugins/');
}

function handle(ctx) {
  const { sup, req, res, pathname, identity, send, collectBody, originAllowed, tokOf } = ctx;

    // 插件管理
    if (req.method === 'GET' && pathname === '/plugins/market') {
      const force = req.url.indexOf('refresh=1') >= 0;
      return sup.pluginMarket.getIndex(force).then(
        (r) => send(200, r),
        (e) => send(500, { ok: false, error: e.message })
      );
    }
    if (req.method === 'GET' && pathname === '/plugins/installed') {
      return sup.pluginManager.listInstalled().then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }
    // 已装插件更新检测（npm 型查统一镜像 registry 最高版；git/local 型标注类型）
    if (req.method === 'GET' && pathname === '/plugins/check-updates') {
      const force = req.url.indexOf('refresh=1') >= 0;
      return sup.pluginManager.checkUpdates(force).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }
    if (req.method === 'GET' && pathname === '/plugins/install-status') {
      const u = new URL(req.url, 'http://localhost');
      return send(200, sup.pluginManager.installStatus(u.searchParams.get('job')));
    }
    if (req.method === 'POST' && pathname.startsWith('/plugins/')) {
      if (!originAllowed(req, sup.config.apiPort)) {
        req.resume();
        return send(403, { ok: false, error: 'cross-origin request rejected' });
      }
      const action = pathname.slice('/plugins/'.length);
      collectBody(req, res, 65536, (body) => {
        let name = null;
        let spec = null;
        let enabled = null;
        let target = null;
        try {
          const j = body ? JSON.parse(body) : {};
          if (typeof j.name === 'string') name = j.name;
          if (typeof j.spec === 'string') spec = j.spec;
          if (typeof j.enabled === 'boolean') enabled = j.enabled;
          if (typeof j.target === 'string') target = j.target;
        } catch {}
        if (action === 'disable' && name) return sup.pluginManager.setBundleEnabled(name, false, target).then((r) => send(r.ok ? 200 : 400, r));
        if (action === 'enable' && name) return sup.pluginManager.setBundleEnabled(name, true, target).then((r) => send(r.ok ? 200 : 400, r));
        // 卸载：按目标（native / all / 指定实例 id）检测并卸载——不同实例各自检测
        if (action === 'uninstall' && name) return sup.pluginManager.uninstall(name, target).then((r) => send(r.ok ? 200 : 400, r));
        // 安装：目标无效直接 400（resolveTargets 报错，不再静默降级）
        if (action === 'install' && spec) return sup.pluginManager.install(spec, { target }).then((r) => send(r.ok ? 200 : 400, r));
        // 更新：官方 pnpm update（bundle 层变更 ⇒ 自动重启运行中目标）
        if (action === 'update' && name) return sup.pluginManager.update(name, target).then((r) => send(r.ok ? 200 : 400, r));
        return send(404, { error: 'not found' });
      });
      return;
    }
  // 域内未匹配(方法/子路径) → 全局兜底语义(与单文件时代一致)
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
