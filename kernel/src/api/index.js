'use strict';

// 本地 HTTP API 网关（默认 127.0.0.1:3100；面板「局域网访问」开关可改 0.0.0.0）。
// 安全边界：
// - 默认仅回环绑定；开启局域网访问后，局域网内设备可访问面板/API；
// - 只允许本机(回环)与 RFC1918 私有 IP 的 Host/Origin → 外部/公网主机被拒（挡公网）；
// - 不返回 CORS 头（面板同源托管）→ 其他网站浏览器请求读不到响应；
// - 带 Origin 的写请求必须来自本机/局域网面板来源 → 外部网页无法驱动 start/stop/upgrade。
// 路由按域拆分至同目录（tasks/lifecycle/native/guard/router/plugins/dist）：
// 每域模块导出 owns(pathname) + handle(ctx)；本网关做安全门卫后按域分派，未归属请求落静态/404。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const API_DOMAINS = [
  require('./tasks'),
  require('./lifecycle'),
  require('./native'),
  require('./guard'),
  require('./router'),
  require('./plugins'),
  require('./dist'),
  require('./adb'),
];

// 前端静态资源目录解析（React UI 全面接管，同源托管）。
// 候选（按优先级，命中 supervisor.html 即用）：
// 0) $DSH_UI_DIR — 显式注入（容器/测试/特殊部署）
// 1) <repo 根>/ui/dist — 开发/构建态（ui 源码 `npm run build` 产物；
// 安卓内核的面板由容器经 OTA 注入此目录）
// 已删除的 PC 候选（勿回潮）：ui-react（launcher 统一形态 / 单文件分发 / 子包 / 源码镜像）
// —— 安卓内核无 Tauri 壳、无 SEA 单文件、无 npm 子包发布，面板只来自 ui/dist + DSH_UI_DIR。
function resolveUiDir() {
  const candidates = [
    process.env.DSH_UI_DIR || null,
    require('node:path').join(__dirname, '..', '..', 'ui', 'dist'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try { if (fs.existsSync(require('node:path').join(dir, 'supervisor.html'))) return dir; } catch {}
  }
  return null;
}
const UI_DIR = resolveUiDir();
if (!UI_DIR) {
  console.error('[ui] 未找到 React UI 产物（期望 supervisor.html；候选：ui/dist / $DSH_UI_DIR）。');
  console.error('[ui] 请在 ui 目录执行 `npm run build`（产物落入 ui/dist），或由容器经 OTA 注入 $DSH_UI_DIR。');
}
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


// 安全信任根（P0-1 结构性修复）：访问者身份 = socket 层事实（req.socket.remoteAddress），
// 唯一判定实现见 ./identity.js。请求头（Host/Origin）只做浏览器语义的深化校验，
// 绝不参与身份/鉴权判定——详见 identity.js 头注与 DESIGN.md 安全边界契约。
// P1-E：`isPrivateIpv4` 与 identity 同一份 RFC1918 判定（Host/Origin 闸复用，不重写）。
const { identify, isPrivateIpv4 } = require('./identity');

/**
 * 本地 HTTP API（默认 127.0.0.1:3100；面板「局域网访问」开关可改为 0.0.0.0）。
 * 安全边界（三层，职责单一）：
 * 1. 身份层（identity.js，socket 事实）：回环/私有网段判定——token 下发、access-key
 * 豁免只消费该层；公网来源连不上（远端地址非 RFC1918/回环）。
 * 2. CSRF 深化层（originAllowed）：带 Origin 的写请求须与本服务同源——防"用户浏览器
 * 里的恶意网页"驱动 API；身份层不覆盖该威胁（浏览器发起的请求源 IP 是合法的）。
 * 3. 访问密钥层（apiAccessKey，可选）：非回环请求须携带 Bearer/?access_key=。
 * 不返回 CORS 头（面板同源托管，零合法跨源消费者）→ 其他网站浏览器读不到响应。
 */

/** 有界 body 读取：超过 maxBytes 时先应答 413 再断开连接。
 * 旧实现直接 req.destroy() 且不响应，客户端会永久挂起；这里保证任何输入都有终态应答。 */
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
// CSRF 深化校验（第二层）：请求须与本服务**同源且同主机**。
//
// 2026-09-11 修复（安全，K6）：旧实现**只比较端口** ——
// 恶意页可从 `http://任意域:36360` 发起请求：Origin 端口匹配即放行；
// 而 socket 层看到的是回环（浏览器代发）→ identity.loopback=true →
// 连 apiAccessKey 都被豁免。CORS 只挡**读取**，不挡 CSRF 的**副作用**，
// 于是 stop / upgrade / uninstall / restart-guard / settings 全可被驱动。
//
// 同时 identity.js:7-8 明确声称「Host 头：仅用于防 DNS-rebinding 的深化校验」，
// 但**实现里从未读取过 req.headers.host** —— 又一处「注释声称、代码没有」。
//
// 现按声称补齐双闸（P1-E 修复后，信任集合 = 回环 ∪ RFC1918 私有网段）：
// ① Host 头（若有）必须是**本机或局域网**名 —— 防 DNS-rebinding
// （攻击者把 evil.com 解析到 127.0.0.1，浏览器会带 `Host: evil.com` → 被拒）；
// ② Origin（只影响带 Origin 的请求）：
// · 面板由内核自身同源托管（http://127.0.0.1:<apiPort>），不存在「壳内 webview 跨源」；
// · 其余必须是**本机/局域网**名 + 本服务端口。
//
// 2026-09-12（P1-E）：此处曾只查回环，与上方的「只允许本机与 RFC1918」声明白相矛盾 ——
// 开启局域网访问后面板能开、写操作全 403。详见 isLocalOrLanHost 的说明。
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 是否为本机回环主机名（含 IPv6 方括号形态）。 */
function isLoopbackHost(h) {
  if (!h) return false;
  return LOOPBACK_HOSTS.has(String(h).toLowerCase());
}

/**
 * 是否为「本机或局域网」主机名 —— Host/Origin 闸的**信任集合**（P1-E 修复，2026-09-12）。
 *
 * 为什么必须有它：本文件头部（与本函数上方注释）**明文声称**
 * 「只允许本机(回环)与 **RFC1918 私有 IP** 的 Host/Origin」，
 * 而闸①②此前只查 `LOOPBACK_HOSTS` —— 于是开启「局域网访问」（apiHost=0.0.0.0）后，
 * 局域网浏览器带的 `Host: 192.168.x.x:36360` 一律被拒：
 * · 面板 GET 能打开（静态资源不走 originAllowed）；
 * · 但**所有写操作静默 403** —— 与注释承诺的行为**完全相反**。
 *
 * 实测（直调 originAllowed）：LAN Host + LAN Origin = DENY；LAN 无 Origin = DENY。
 *
 * 修法：复用 identity.js 的 **RFC1918 判定**（那里已有 `isPrivateIpv4`），
 * 而不是在此重写一遍 —— 「同一事实两处实现」正是本仓反复出现的失效模式
 * （`identity.socketIsTrusted` 早已实现同一语义，只是 Host 闸从未消费它）。
 *
 * 安全影响：这不放宽对**公网**的拒绝 —— 私有网段之外的 Host（如 evil.com）仍被拒；
 * DNS-rebinding 防护依赖的是「Host 不是本机/局域网名」，语义不变。
 * 局域网来源仍须通过第三层（apiAccessKey，非回环请求强制）；
 * 且写请求仍须 Origin 同源（闸②）。
 */
function isLocalOrLanHost(h) {
  if (!h) return false;
  const s = String(h).toLowerCase();
  if (LOOPBACK_HOSTS.has(s)) return true;
  // IPv6 方括号形态 → 去掉括号再判
  const bare = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  if (bare === '::1') return true;
  // RFC1918 私有 IPv4（与 identity.socketIsTrusted 同一份判定）
  return isPrivateIpv4(bare);
}

function originAllowed(req, apiPort) {
  // ── 闸 ①：Host 头（防 DNS-rebinding）──
  // 浏览器会把 URL 里的域名放进 Host；若它不是回环名，
  // 说明请求来自「被解析到 127.0.0.1 的外部域名」→ 拒绝。
  const host = req.headers.host;
  if (host) {
    // Host 形如 `127.0.0.1:36360` / `[::1]:36360` / `evil.com`
    const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(String(host).trim());
    const hostname = m ? m[1] : String(host).trim();
    // P1-E：接受「本机或 RFC1918 私有网段」—— 与文件头声明的信任集合一致。
    if (!isLocalOrLanHost(hostname)) return false;
  }

  // ── 闸 ②：Origin（哪些页面能驱动本 API）──
  const o = req.headers.origin;
  if (!o) return true; // curl / CLI / 同源 GET 无 Origin
  try {
    const u = new URL(o);
    // P1-E：Origin 同样接受私有网段（局域网设备的浏览器就是合法面板来源）。
    if (!isLocalOrLanHost(u.hostname)) return false;
    const port = u.port === '' ? (u.protocol === 'https:' ? '443' : '80') : u.port;
    return port === String(apiPort);
  } catch {
    return false;
  }
}

/** 请求级失败的统一兜底：只应答一次（头已发则仅断开），并记录一条错误事件。
 * 绝不把异常抛给进程层（对比：bin 的 uncaughtException 策略是 3 次自杀重启）。 */
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

/** 常数时间字符串比较（防时序侧信道）。 */
function safeKeyEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** 请求是否携带正确的出回环访问密钥（apiAccessKey，F2 定案）：
 * Authorization: Bearer <key> 或 ?access_key=<key> 二选一（常数时间比较）。
 * 无密钥配置时恒放行（本函数不调用：调用侧仅在配置了 key 且非回环请求时才走门卫）。 */
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

/**
 * GET /status → 状态摘要
 * GET /events?after=&limit=→ 增量事件
 * POST /start → desired=running
 * POST /stop → desired=stopped（停 DSH 并保持不拉起）
 * POST /restart → 立即重启一次（不改变 desired）
 * GET /version → 已安装/最新版本
 * GET /upgrade/status → 升级状态机详情
 * POST /version/check → 触发一次版本检查
 * POST /upgrade {version?} → 一键升级（先停后装，失败自动回滚）
 * GET / → 控制面板首页（React UI：ui/dist 的 supervisor.html）
 */
function createServer(sup) {
  return http.createServer((req, res) => {
    // 面板由内核自身同源托管（GET / 返回面板页），因此**零 CORS**：
    // 不给任何 Origin 发 Access-Control-Allow-* —— 防外部网页读取内核 API。
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      const hdrs = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
      res.writeHead(code, hdrs);
      res.end(body);
    };

    // 每实例的 DSH 访问令牌（随实例重启轮换）只有一个权威来源：唯一令牌节点
    // DshTokenService（原生与沙箱共用同一套获取/分发，见 src/platform/token.js）。生成直连认证 URL
    // 时按目标查取，绝不跨实例借用（主实例令牌套到沙箱实例 → 401 “dsh web authentication required”）。
    const tokOf = (id) => {
      try { if (sup.tokenService && typeof sup.tokenService.get === 'function') return sup.tokenService.get(id) || ''; } catch {}
      return '';
    };

    // ── 访问者身份（第一层，socket 事实）：唯一判定入口见 ./identity.js ──
    // token 下发 / access-key 豁免一律消费 identity.loopback——绝不从请求头推断来源。
    const identity = identify(req);

    // ── 访问密钥门卫（第三层，apiAccessKey 可选配置）──
    // 非回环请求（0.0.0.0 局域网 / FRP 通道）必须携带 Authorization: Bearer <key>
    // 或 ?access_key=<key>；回环豁免——CLI/同机面板语义必需。
    // OPTIONS 预检豁免（浏览器跨源探测不发自定义头，给 204 而非 401）。
    const accessKey = (sup && sup.config && sup.config.apiAccessKey) || null;
    if (accessKey && !identity.loopback && req.method !== 'OPTIONS' && !requestHasAccessKey(req, accessKey)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '需要访问密钥（apiAccessKey）：请求头 Authorization: Bearer <key> 或 ?access_key=<key>' }));
    }

    // OPTIONS 预检：一律 204 空响应（零 CORS —— 面板同源托管，不存在合法的跨源消费者，
    // 预检方读不到任何 Allow-* 也就驱动不了写操作）。
    // 2026-09-23 实证修复：此分支曾引用**从未声明**的 `shellOrigin`（PC 壳白名单遗留）——
    // 任何 OPTIONS 请求都 ReferenceError → uncaughtException（守卫 bin 策略 3 次自杀重启），
    // 一个浏览器预检即可打挂 API。门禁钉在 dsh-access-route-test.js（X-7）。
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


    // 路径段安全解码（单点）：畸形百分号编码 → 400。域 handler 只拿已解码的
    // 干净字符串，任何域不得自行 decodeURIComponent（异常边界唯一化的组成部分）。
    let decodedPathname;
    try {
      decodedPathname = pathname.split('/').map((seg) => {
        try { return decodeURIComponent(seg); } catch { throw new Error('bad encoding'); }
      }).join('/');
    } catch (e) {
      return send(400, { error: 'bad request encoding' });
    }

    const ctx = { sup, req, res, pathname: decodedPathname, identity, send, collectBody, originAllowed, tokOf };

    // 按域分派（每域 owns 为粗前缀超集；域内未匹配由该域 handle 兜底 404/405）。
    // 统一异常边界：handler 同步抛错 / 返回的 Promise reject 一律在此兜底为 500——
    // 请求级错误绝不穿透为进程级 uncaughtException（异常处理层级归位，RC3）。
    for (const d of API_DOMAINS) {
      if (d.owns(pathname)) {
        try {
          const out = d.handle(ctx);
          if (out && typeof out.catch === 'function') out.catch((e) => safeFail(res, e, 'handler'));
        } catch (e) { safeFail(res, e, 'handler'); }
        return;
      }
    }

    // 静态文件（新 React UI 产物：assets/ 哈希文件开放）
    if (req.method === 'GET') {
      if (pathname === '/' || pathname === '/index.html' || pathname === '/supervisor.html') {
        return serveStatic(res, 'supervisor.html');
      }
      // 容器宿主帧：安卓 WebView 加载此页，页内 iframe 嵌面板（同源）。
      // 与面板同源 ⇒ Origin 闸(originAllowed 闸②)放行，面板写操作不再 403。
      // 见 ui/public/host.html（Vite 原样拷到 ui/dist/host.html）。
      if (pathname === '/__host') {
        return serveStatic(res, 'host.html');
      }
      const file = pathname.slice(1); // 去掉前导 /
      if (file.startsWith('assets/') || file === 'dsh-logo.svg' || file === 'host-frame.js') {
        return serveStatic(res, file);
      }
    }

    // 404
    if (req.method === 'GET' || req.method === 'POST') {
      return send(404, { error: 'not found', path: pathname });
    }
    return send(405, { error: 'method not allowed' });
  });
}

function serveStatic(res, file) {
  if (!UI_DIR) {
    // UI 缺失（未构建/部署裁剪）：显式 503，绝不抛 TypeError 触发守卫自杀重启
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('UI not built — run `npm run build` in ui/ or set DSH_UI_DIR');
  }
  const full = path.join(UI_DIR, file);
  // 路径穿越防护：relative 必须落在 UI_DIR 内部
  const rel = path.relative(UI_DIR, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const content = fs.readFileSync(full);
    const ext = path.extname(file);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
    };
    // 面板资源一律不缓存（no-store）：前端改动立即生效——避免浏览器缓存旧版
    // 导致的渲染异常（如卡片锁定状态不显示等）
    headers['Cache-Control'] = 'no-store';
    res.writeHead(200, headers);
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

// `originAllowed` 一并导出：**供测试直接做行为断言**。
// 仅做源码正则断言不够 —— 本仓已有「注释声称、代码没有」的先例（K6 本身），
// 正则同样可能被注释里的示例骗过。行为断言才是不变量 C5 要求的证据形式。
module.exports = { createServer, originAllowed, isLoopbackHost };
