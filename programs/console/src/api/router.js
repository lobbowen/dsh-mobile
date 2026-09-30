'use strict';

// 域：智能路由（中转服务）API——ports/status/生命周期/providers/proxy 登录与更新/账号管理。
function owns(pathname) {
  return pathname.startsWith('/router/');
}

function handle(ctx) {
  const { sup, req, res, pathname, identity, send, collectBody, originAllowed, tokOf } = ctx;

    // 智能路由（中转服务）生命周期
    // R4 域摘要：daemon 监督模式读目录 router-daemon 项 domainSummary（监督拍缓存，≤1 个 fetch 周期陈旧）；
    // 非 daemon 模式（内嵌）回退本地实例实时摘要。目录只存引用，账号明细/令牌仍只走实时 /router/*。
    if (req.method === 'GET' && pathname === '/router/domain-summary') {
      return send(200, sup.routerDomainSummary());
    }
    if (req.method === 'GET' && pathname === '/router/ports') {
      // 资源端口视图（阶段迁移 S1）：router 段由 daemon 自供（ctl），守卫仅转发；降级走内嵌副本同方法
      return Promise.resolve(sup.routerApi().portsView()).then((r) => send(200, r)).catch((e) => send(200, { records: [], error: e && e.message }));
    }
    if (req.method === 'GET' && pathname === '/router/status') {
      // daemon 监督模式：实时状态来自 daemon（异步）；否则本地视图（同步）
      return Promise.resolve(sup.routerStatusView()).then((r) => send(200, r)).catch((e) => send(200, { running: false, error: e.message }));
    }
    if (req.method === 'POST' && pathname.startsWith('/router/')) {
      if (!originAllowed(req, sup.config.apiPort)) {
        req.resume();
        return send(403, { ok: false, error: 'cross-origin request rejected' });
      }
      const action = pathname.slice('/router/'.length);
      req.resume();
      if (action === 'start') {
        return Promise.resolve(sup.setRouterRunning(true)).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
      }
      if (action === 'stop') {
        return Promise.resolve(sup.setRouterRunning(false)).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
      }
    }

    // 局域网访问开关
    if (req.method === 'GET' && pathname === '/router/providers') {
      // routerProviders 在 daemon 监督模式返回 Promise（daemon 实时状态）；本地模式同步对象
      return Promise.resolve(sup.routerProviders()).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }
    if (req.method === 'POST' && pathname === '/router/providers/add') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 65536, (body) => {
        let j = {};
        try { j = body ? JSON.parse(body) : {}; } catch {}
        if (j.kind === 'proxy') {
          Promise.resolve(sup.routerApi().addProxyProvider({ name: j.name, appId: j.appId, keys: j.keys || [] })).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
          return;
        }
        return Promise.resolve(sup.routerApi().addDirectProvider({ name: j.name, presetId: j.presetId, keys: j.keys || [] })).then((r) => send(r && r.ok === false ? 400 : 200, r)).catch((e) => send(500, { ok: false, error: e.message }));
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/proxy/login/start') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      Promise.resolve(sup.routerApi().commandcodeLoginStart()).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
      return;
    }
    if (req.method === 'POST' && pathname === '/router/proxy/login/wait') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => { const j = {}; try { j.t = body ? JSON.parse(body).timeoutMs : 180000; } catch {}; const t = Math.min(Math.max(Number(j.t) || 180000, 5000), 300000); Promise.resolve(sup.routerApi().commandcodeLoginWait(t)).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: e.message })); });
      return;
    }

    if (req.method === 'POST' && pathname === '/router/proxy/update/check') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      Promise.resolve(sup.routerApi().refreshProxyUpdateInfo(true)).then((r) => send(200, { ok: true, versions: r })).catch((e) => send(500, { ok: false, error: e.message }));
      return;
    }
    if (req.method === 'POST' && pathname === '/router/proxy/update/apply') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => { try { const j = body ? JSON.parse(body) : {}; Promise.resolve(sup.routerApi().applyProxyUpdate(j.appId, j)).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) })); } catch { return send(400, { ok: false }); } });
      return;
    }
    // 反代更新进度查询（job 模型，前端轮询消除黑盒）
    if (req.method === 'GET' && pathname === '/router/proxy/update/status') {
      const u = new URL(req.url, 'http://localhost');
      return Promise.resolve(sup.routerApi().proxyUpdateStatus(u.searchParams.get('appId') || '')).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }
    if (req.method === 'POST' && pathname === '/router/providers/proxy/key') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 65536, (body) => { try { const j = JSON.parse(body); Promise.resolve(sup.routerApi().addProxyKey(j.id, j.key)).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) })); } catch { return send(400, { ok: false }); } });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/providers/proxy/select') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => { try { const j = JSON.parse(body); Promise.resolve(sup.routerApi().setSelectedProxyKey(j.id, j.keyId)).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) })); } catch { return send(400, { ok: false }); } });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/providers/proxy/key/remove') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => { try { const j = JSON.parse(body); Promise.resolve(sup.routerApi().removeProxyKey(j.id, j.keyId)).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) })); } catch { return send(400, { ok: false }); } });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/providers/keys/set') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 65536, (body) => {
        try {
          const j = JSON.parse(body);
          if (!j.id) return send(400, { ok: false, error: 'need id' });
          return Promise.resolve(sup.routerApi().setProviderKeys(j.id, { removeMasked: j.removeMasked || [], add: j.add || [] })).then((r) => send(r && r.ok === false ? 400 : 200, r)).catch((e) => send(500, { ok: false, error: e.message }));
        } catch { return send(400, { ok: false }); }
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/providers/remove') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => {
        try {
          const j = body ? JSON.parse(body) : {};
          return Promise.resolve(sup.routerApi().removeProvider(j.id)).then((r) => send(r && r.ok === false ? 400 : 200, r)).catch((e) => send(500, { ok: false, error: e.message }));
        } catch { return send(400, { ok: false }); }
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/providers/key/use') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => {
        try {
          const j = body ? JSON.parse(body) : {};
          if (!j.id || !j.fingerprint) return send(400, { ok: false, error: 'need id + fingerprint' });
          // switchToKey 为 async：必须 await，否则 Promise 被序列化为 {}（历史未暴露：p2p-api 测试此前从未跑通）
          return Promise.resolve(sup.routerApi().switchToKey(j.id, j.fingerprint)).then((r) => send(r && r.ok ? 200 : 400, r || { ok: false, error: 'unknown' })).catch((e) => send(500, { ok: false, error: e.message }));
        } catch { return send(400, { ok: false }); }
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/providers/account/confirm') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => { try { const j = JSON.parse(body); Promise.resolve(sup.routerApi().confirmAccount(j.id, j.keyId)).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) })); } catch { return send(400, { ok: false }); } });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/providers/account/discard') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => { try { const j = JSON.parse(body); Promise.resolve(sup.routerApi().discardAccount(j.id, j.keyId)).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) })); } catch { return send(400, { ok: false }); } });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/providers/refresh') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => { try { const j = body ? JSON.parse(body) : {}; if (!j.id) return send(400, { ok: false }); Promise.resolve(sup.routerApi().refreshProviderQuota(j.id)).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) })); } catch { return send(400, { ok: false }); } });
      return;
    }
    // 激活/停用供应商：激活=启动该供应商独立 API 端点（未激活不提供服务）；
    // 停用=关闭端点并回收其反代实例（apiPort 绑定保留，再激活复用）
    if (req.method === 'POST' && pathname === '/router/providers/activate') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => { try { const j = body ? JSON.parse(body) : {}; if (!j.id) return send(400, { ok: false, error: 'need id' }); Promise.resolve(sup.routerApi().activateProvider(j.id)).then((r) => send(r && r.ok ? 200 : 400, r || { ok: false })).catch(() => send(400, { ok: false })); } catch { return send(400, { ok: false }); } });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/providers/deactivate') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => { try { const j = body ? JSON.parse(body) : {}; if (!j.id) return send(400, { ok: false, error: 'need id' }); return Promise.resolve(sup.routerApi().deactivateProvider(j.id)).then((r) => send(r && r.ok === false ? 400 : 200, r)).catch((e) => send(500, { ok: false, error: e.message })); } catch { return send(400, { ok: false }); } });
      return;
    }
  // 域内未匹配(方法/子路径) → 全局兜底语义(与单文件时代一致)
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
