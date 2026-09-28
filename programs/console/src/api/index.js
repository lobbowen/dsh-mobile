'use strict';

// 控制面板本地 HTTP API 网关
//
// 面板是普通 Program：本网关只服务**面板自身的 API 与前端静态资源**；所有系统事实
// 都经 OS 原生能力 API（ctx.panel.call / os）取得，绝不自己持有系统状态。
//
// 安全边界：
// - 默认仅回环绑定；开启局域网访问后，局域网内设备可访问面板/API；
// - 只允许本机(回环)与 RFC1918 私有 IP 的 Host/Origin → 外部/公网主机被拒；
// - 不返回 CORS 头（面板同源托管）→ 其他网站浏览器请求读不到响应；
// - 带 Origin 的写请求必须来自本机/局域网面板来源。
//
// 路由按域拆分（lifecycle/native/diagnostics/tasks/guard/plugins/dist/adb），每域导出 owns+handle。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const API_DOMAINS = [
  require('./tasks'),
  require('./lifecycle'),
  require('./native'),
  require('./diagnostics'),
  require('./guard'),
  require('./plugins'),
  require('./dist'),
  require('./adb'),
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";

const { identify, isPrivateIpv4 } = require('./identity');

/** 有界 body 读取：超过 maxBytes 时先应答 413 再断开连接。 */
function collectBody(req, res, maxBytes, onDone) {
  let body = '';
  let over = false;
  req.on('data', (d) => {
    if (over) return;
    body += d;
    if (body.length > maxBytes) {
      over = true;
      body = '';
      try {
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'payload too large' }));
        }
      } catch {}
      req.destroy();
    }
  });
  req.on('error', () => {});
  req.on('end', () => { if (!over) onDone(body); });
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopbackHost(h) {
  if (!h) return false;
  return LOOPBACK_HOSTS.has(String(h).toLowerCase());
}

/** 是否为「本机或局域网」主机名（Host/Origin 闸的信任集合）。 */
function isLocalOrLanHost(h) {
  if (!h) return false;
  const s = String(h).toLowerCase();
  if (LOOPBACK_HOSTS.has(s)) return true;
  const bare = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  if (bare === '::1') return true;
  return isPrivateIpv4(bare);
}

/** CSRF 深化校验：请求须与本服务同源且同主机（防 DNS-rebinding + 跨站写）。 */
function originAllowed(req, apiPort) {
  const host = req.headers.host;
  if (host) {
    const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(String(host).trim());
    const hostname = m ? m[1] : String(host).trim();
    if (!isLocalOrLanHost(hostname)) return false;
  }
  const o = req.headers.origin;
  if (!o) return true;
  try {
    const u = new URL(o);
    if (!isLocalOrLanHost(u.hostname)) return false;
    const port = u.port === '' ? (u.protocol === 'https:' ? '443' : '80') : u.port;
    return port === String(apiPort);
  } catch {
    return false;
  }
}

function safeFail(res, err, where) {
  try {
    const body = JSON.stringify({ ok: false, error: (err && err.message) || String(err) });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    }
    try { res.end(body); } catch {}
  } catch {}
  try { console.error('[api] handler error (' + (where || '?') + '):', (err && err.stack) || err); } catch {}
}

function safeKeyEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requestHasAccessKey(req, key) {
  if (!key) return true;
  const ah = req.headers.authorization;
  if (typeof ah === 'string' && ah.startsWith('Bearer ') && safeKeyEqual(ah.slice(7), key)) return true;
  try {
    const q = new URL(req.url, 'http://localhost').searchParams.get('access_key');
    if (q && safeKeyEqual(q, key)) return true;
  } catch {}
  return false;
}

function createServer(panel) {
  const config = panel.config;
  return http.createServer((req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      const hdrs = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
      res.writeHead(code, hdrs);
      res.end(body);
    };

    const identity = identify(req);
    const accessKey = config.apiAccessKey || null;
    if (accessKey && !identity.loopback && req.method !== 'OPTIONS' && !requestHasAccessKey(req, accessKey)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '需要访问密钥（apiAccessKey）：请求头 Authorization: Bearer <key> 或 ?access_key=<key>' }));
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return send(400, { error: 'bad request' });
    }

    let decodedPathname;
    try {
      decodedPathname = pathname.split('/').map((seg) => {
        try { return decodeURIComponent(seg); } catch { throw new Error('bad encoding'); }
      }).join('/');
    } catch {
      return send(400, { error: 'bad request encoding' });
    }

    const ctx = { panel, os: panel.os, config, req, res, pathname: decodedPathname, identity, send, collectBody, originAllowed };

    for (const d of API_DOMAINS) {
      if (d.owns(pathname)) {
        try {
          const out = d.handle(ctx);
          if (out && typeof out.catch === 'function') out.catch((e) => safeFail(res, e, 'handler'));
        } catch (e) { safeFail(res, e, 'handler'); }
        return;
      }
    }

    if (req.method === 'GET') {
      const uiDir = panel.uiDir();
      if (pathname === '/' || pathname === '/index.html' || pathname === '/console.html') {
        return serveStatic(res, uiDir, 'console.html');
      }
      if (pathname === '/__host') {
        return serveStatic(res, uiDir, 'host.html');
      }
      const file = pathname.slice(1);
      if (file.startsWith('assets/') || file === 'lobos-logo.svg' || file === 'host-frame.js') {
        return serveStatic(res, uiDir, file);
      }
    }

    if (req.method === 'GET' || req.method === 'POST') {
      return send(404, { error: 'not found', path: pathname });
    }
    return send(405, { error: 'method not allowed' });
  });
}

function serveStatic(res, uiDir, file) {
  if (!uiDir) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('UI not built — run `npm run build` in ui/ or set LOBOS_UI_DIR');
  }
  const full = path.join(uiDir, file);
  const rel = path.relative(uiDir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const content = fs.readFileSync(full);
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  } catch (e) {
    if (e.code === 'ENOENT') {
      res.writeHead(404);
      res.end('not found');
    } else {
      res.writeHead(500);
      res.end('internal error');
    }
  }
}

module.exports = { createServer, originAllowed, isLoopbackHost };

