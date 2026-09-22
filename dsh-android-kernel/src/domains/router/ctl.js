'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// router-ctl —— router-daemon 的守卫控制通道（L3 监督模式状态一致性，2026-09）。
//
// 背景：router 解耦为独立 daemon 后，providers.json 由 daemon 独占写；守卫进程内仍
// 持有一个 RouterService 实例（persist 关闭）用于内嵌回退路径。此前守卫 API 的
// /router/* 读写都打到守卫本地副本 → 视图陈旧（读）且写操作只改守卫内存（监督模式下
// 不落盘、daemon 无感知）——「双脑」不一致（HANDOFF #4）。
//
// 本模块给 daemon 一个 127.0.0.1 回环控制口：守卫把 /router/* 的方法调用经
// POST /ctl {method, args} 转发到 daemon 的 RouterService（唯一事实源），
// 读即最新、写即生效。守卫侧为透明门面（见 supervisor.routerApi()）。
//
// 安全：仅绑定 127.0.0.1；与守卫 3100 API 同级信任（回环内）。不改 43011 业务口。
// ═══════════════════════════════════════════════════════════════════════════

const http = require('node:http');

const DEFAULT_CTL_PORT = 43107;

/**
 * 创建 ctl HTTP server。
 * @param {object} o { router: RouterService 实例, logger: 可选, events?: Events 实例 }
 *   系统日志框架（P1b）：events 存在时暴露内置 eventsTail(afterSeq) —— 守卫 EventHub 拉 daemon 事件增量。
 * @returns {http.Server}
 */
function createRouterCtlServer({ router, logger, events } = {}) {
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      let body;
      try { body = JSON.stringify(obj); } catch { body = JSON.stringify({ ok: false, error: 'response not serializable' }); }
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };

    if (req.method === 'GET' && req.url === '/health') {
      return send(200, { ok: true, pid: process.pid });
    }
    if (req.method !== 'POST' || req.url !== '/ctl') {
      return send(404, { ok: false, error: 'not found' });
    }

    let body = '';
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      body += c;
      if (body.length > 1 << 20) { // 1MB 上限
        settled = true;
        send(413, { ok: false, error: 'payload too large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (settled) return;
      let m = null;
      try { m = JSON.parse(body || '{}'); } catch { return send(400, { ok: false, error: 'bad json' }); }
      const method = m && typeof m.method === 'string' ? m.method : null;
      const args = Array.isArray(m && m.args) ? m.args : [];
      // 系统日志框架（P1b）：内置 eventsTail(afterSeq) 供守卫 EventHub 增量拉取事件（不依赖 router 实例方法）。
      if (method === 'eventsTail' && events && typeof events.tailSince === 'function') {
        const afterSeq = Number(args[0]) || 0;
        let list = [];
        try { list = events.tailSince(afterSeq); } catch (e2) { return send(200, { ok: false, error: (e2 && e2.message) || String(e2) }); }
        return send(200, { ok: true, value: { seq: events.seq, events: list } });
      }
      if (!method || !router || typeof router[method] !== 'function') {
        return send(404, { ok: false, error: 'unknown method: ' + method });
      }
      const started = Date.now();
      Promise.resolve()
        .then(() => router[method].apply(router, args))
        .then((value) => {
          if (logger && logger.debug) logger.debug('[router-ctl] ' + method + ' ok in ' + (Date.now() - started) + 'ms');
          send(200, { ok: true, value });
        })
        .catch((e) => {
          if (logger && logger.warn) logger.warn('[router-ctl] ' + method + ' error: ' + ((e && e.message) || e));
          send(200, { ok: false, error: (e && e.message) || String(e) });
        });
    });
    req.on('error', () => { try { res.end(); } catch {} });
  });
  server.on('error', (e) => { if (logger) logger.error('[router-ctl] server error: ' + e.message); });
  // 2026-09 复检根治：守卫(Node≥19 globalAgent keepAlive=true 连接池化)复用长连调用 ctl；
  // Node http server 默认 keepAliveTimeout=5s 会回收空闲池化连接 → 守卫下次复用已关 socket →
  // 间歇 'socket hang up' → routerProviders 回退守卫陈旧本地视图 → 前端账号状态与 daemon 分裂闪烁
  //（实测 3100 /router/providers 在 daemon 真值 与 陈旧副本 间交替，Kbobt7/MxULq9 旧态复现）。
  // 与 router 供应商端点对齐（index.js server.keepAliveTimeout=65000），长连不因空闲被服务端回收。
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 120000;
  return server;
}

module.exports = { createRouterCtlServer, DEFAULT_CTL_PORT };
