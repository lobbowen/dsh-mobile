'use strict';

// 域：镜像源分发 API（/dist/registry*，DistributionManager 统一管理）。
function owns(pathname) {
  return pathname.startsWith('/dist/');
}

function handle(ctx) {
  const { sup, req, res, pathname, identity, send, collectBody, originAllowed, tokOf } = ctx;

    // 全局统一分发：镜像源配置由 DistributionManager 统一管理（DSH 自升级 + 反代共用）——仅 /dist/registry*。
    if (req.method === 'GET' && pathname === '/dist/registry') {
      Promise.resolve(sup.dist.registryInfo()).then((r) => send(200, { ok: true, ...r })).catch((e) => send(500, { ok: false, error: e.message }));
      return;
    }
    if (req.method === 'POST' && pathname === '/dist/registry/set') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 8192, (body) => { try { const j = body ? JSON.parse(body) : {}; Promise.resolve(sup.dist.setRegistryConfig(j)).then((r) => send(200, { ok: true, ...r })).catch((e) => send(500, { ok: false, error: e.message })); } catch (e) { return send(400, { ok: false }); } });
      return;
    }
    if (req.method === 'POST' && pathname === '/dist/registry/refresh') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      sup.dist.selectRegistry(true).then(() => sup.dist.registryInfo()).then((r) => send(200, { ok: true, ...r })).catch((e) => send(500, { ok: false, error: e.message }));
      return;
    }
    // ⚠ 2026-09-13（P2 修复）：**同源镜像探活端点**。
    //
    //   缺陷：设置页的「测试」按钮由**浏览器**直连用户填写的任意镜像源
    //     （RegistryCard.tsx::testLatency 的跨源 fetch），而本页由内核伺服并带
    //     `connect-src 'self'`（见 index.js 的 CSP）→ 浏览器**在发起前即按 CSP 拦截**，
    //     fetch 立刻 reject，catch 统一 toast「探测失败」。
    //   后果：该按钮对**任何**地址恒报「探测失败」，且换网络也无法解决 ——
    //     用户据此以为镜像坏了；UI 无法区分「真的不可达」与「被策略阻断」。
    //   修法：走**同源**后端探活（服务端 fetch 不受页面 CSP 约束），
    //     并由 DistributionManager 用**与契约一致的探测规格**探测
    //     （探针路径取自 distribution 的 _probeRegistry，确保与内核选源判据同源）。
    if (req.method === 'POST' && pathname === '/dist/registry/probe') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      return collectBody(req, res, 4096, (body) => {
        let j = {};
        try { j = body ? JSON.parse(body) : {}; } catch {}
        const origin = String(j.origin || '').trim();
        if (!/^https?:\/\//.test(origin)) return send(400, { ok: false, error: 'origin 必须以 http(s):// 开头' });
        Promise.resolve(sup.dist.probeOrigin(origin))
          .then((r) => send(200, { ok: true, ...r }))
          .catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
      });
    }

  // 域内未匹配(方法/子路径) → 全局兜底语义(与单文件时代一致)
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
