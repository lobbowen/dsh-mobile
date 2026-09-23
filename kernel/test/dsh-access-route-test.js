#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// GET /dsh/access 行为门禁（2026-09-23 真机反馈：手机小屏面板进不了 DSH）
//
// 锁定不变量：
//   X-1 回环 + 已捕获令牌 → 200 { ok, url }，url = 回环 origin + ?token=<令牌>
//   X-2 非回环来源 → 403，且响应体绝不泄漏令牌
//   X-3 令牌未捕获 → 409 明确报错（不返回无令牌 URL 让用户吃 401）
//   X-4 端口跟随 config.targetPort（重推导后不返回旧端口）
//   X-5 真实 HTTP 贯通：createServer 分派到 lifecycle 域（owns 登记生效）
//   X-6 契约面登记：/dsh/access 在 SURFACE（api-surface 双向一致之外再钉消费者）
//   X-7 OPTIONS 预检 → 204 零 CORS 且不崩溃（shellOrigin 未声明遗留，实证曾打挂进程）
// 依赖注入方式：ctx 形状即注入点（identity/sup/tokOf 全部构造后传入）；
// 绝不 patch 任何模块导出（安全门禁 A）。
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const http = require('node:http');
const ROOT = path.join(__dirname, '..');

const lifecycle = require(path.join(ROOT, 'src', 'api', 'lifecycle.js'));
const { SURFACE } = require(path.join(ROOT, 'src', 'api', 'surface.js'));
const { createServer } = require(path.join(ROOT, 'src', 'api', 'index.js'));

const TOKEN = 'Ab0dshTk_-9x';
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

function makeSup(port) {
  return {
    config: { apiPort: 36360, apiAccessKey: null, targetHost: '127.0.0.1', targetPort: port, healthUrl: 'http://127.0.0.1:' + port + '/' },
    tokenService: { get: (id) => (id === 'main' ? TOKEN : '') },
    statusSummary: () => ({}),
  };
}

/** 直调域 handler：identity / tokOf / send 全部经 ctx 注入。 */
function callHandle({ loopback, sup, token }) {
  let out = null;
  const ctx = {
    sup,
    req: { method: 'GET', url: '/dsh/access', headers: {} },
    res: {},
    pathname: '/dsh/access',
    identity: { loopback: loopback !== false, trusted: loopback !== false },
    send: (code, obj) => { out = { code, obj }; },
    collectBody: () => {},
    originAllowed: () => true,
    tokOf: typeof token === 'string' ? (() => token) : sup.tokenService.get,
  };
  lifecycle.handle(ctx);
  return out;
}

async function main() {
  // X-1 回环 + 有令牌 → 200 + 回环 URL 带 token
  const r1 = callHandle({ loopback: true, sup: makeSup(3080) });
  check('X-1 回环已捕获令牌 → 200 ok', r1 && r1.code === 200 && r1.obj.ok === true, JSON.stringify(r1 && r1.code));
  check('X-1 url = http://127.0.0.1:<port>/?token=<令牌>', r1 && r1.obj.url === 'http://127.0.0.1:3080/?token=' + TOKEN, r1 && r1.obj.url);

  // X-2 非回环 → 403 且绝不泄漏令牌
  const r2 = callHandle({ loopback: false, sup: makeSup(3080) });
  check('X-2 非回环 → 403', r2 && r2.code === 403 && r2.obj.ok === false, JSON.stringify(r2 && r2.code));
  check('X-2 响应体不泄漏令牌', r2 && !JSON.stringify(r2.obj).includes(TOKEN), 'clean');

  // X-3 未捕获令牌 → 409 明确报错
  const r3 = callHandle({ loopback: true, sup: makeSup(3080), token: '' });
  check('X-3 无令牌 → 409 且报错可懂', r3 && r3.code === 409 && r3.obj.ok === false && /令牌/.test(r3.obj.error || ''), r3 && r3.obj.error);
  check('X-3 无令牌不返回 URL', r3 && r3.obj.url === undefined, 'clean');

  // X-4 端口跟随 config.targetPort（_applyMainPort 重推导语义）
  const r4 = callHandle({ loopback: true, sup: makeSup(3121) });
  check('X-4 端口跟随 config.targetPort', r4 && r4.obj.url === 'http://127.0.0.1:3121/?token=' + TOKEN, r4 && r4.obj.url);

  // X-5 真实 HTTP 贯通（createServer 域分派 + identity socket 事实 = 回环）
  const sup = makeSup(3080);
  const server = createServer(sup);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const body = await new Promise((res, rej) => {
    http.get('http://127.0.0.1:' + port + '/dsh/access', (r) => {
      let s = '';
      r.on('data', (d) => { s += d; });
      r.on('end', () => res({ code: r.statusCode, body: s }));
    }).on('error', rej);
  });
  const parsed = JSON.parse(body.body);
  check('X-5 真实 HTTP GET /dsh/access → 200 + URL', body.code === 200 && parsed.ok === true && parsed.url === 'http://127.0.0.1:3080/?token=' + TOKEN, body.code + ' ' + parsed.url);
  check('X-5 owns 登记生效', lifecycle.owns('/dsh/access') === true, 'ok');

  // X-7 OPTIONS 预检不得崩溃（2026-09-23 实证：曾引用未声明的 shellOrigin → 任何预检
  // ReferenceError → uncaughtException，一个浏览器 OPTIONS 即可打挂守卫 API 进程）
  const opt = await new Promise((res, rej) => {
    http.request({ host: '127.0.0.1', port, method: 'OPTIONS', path: '/status' }, (r) => {
      r.resume();
      r.on('end', () => res({ code: r.statusCode, acao: r.headers['access-control-allow-origin'] }));
    }).on('error', rej).end();
  });
  check('X-7 OPTIONS → 204 且不崩溃（本测试进程存活即为证）', opt.code === 204, String(opt.code));
  check('X-7 OPTIONS 零 CORS（不回 Allow-*）', opt.acao === undefined, 'clean');
  server.close();

  // X-6 契约面登记（消费者 = 面板「进入 DSH」）
  const e = SURFACE.find((x) => x.path === '/dsh/access');
  check('X-6 SURFACE 登记 /dsh/access', Boolean(e) && e.methods.includes('GET') && e.consumers.some((c) => /UI/.test(c)), e && e.note);

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
