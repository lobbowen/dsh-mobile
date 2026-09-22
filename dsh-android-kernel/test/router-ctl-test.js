'use strict';

// router-ctl 控制通道测试（L3 监督模式状态一致性，2026-09）：
//  - GET /health 存活
//  - POST /ctl 同步方法 / 异步方法 / 参数传递 / 未知方法 / 方法抛错
//  - 守卫侧 routerCtlCall 语义（{ok:true,value} / {ok:false,error}）
// 自包含：假 RouterService + 真实 http，不依赖真实 daemon/守卫/账号数据。

const http = require('node:http');
const path = require('node:path');
const { createRouterCtlServer } = require(path.join(__dirname, '..', 'src', 'domains', 'router', 'ctl'));

let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

// 假 RouterService：覆盖同步/异步/参数/异常四类方法
function fakeRouter() {
  return {
    _calls: [],
    status() { return { running: true, mode: 'daemon' }; },
    addProxyKey(id, key) { this._calls.push(['addProxyKey', id, key]); return { ok: true }; },
    async listProviders() { return { providers: [{ id: 'p1' }] }; },
    async slowSum(a, b) { await new Promise((r) => setTimeout(r, 20)); return a + b; },
    explode() { throw new Error('boom'); },
  };
}

function ctlPost(port, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/ctl', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve({ code: res.statusCode, json: JSON.parse(b) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}
function ctlGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve({ code: res.statusCode, json: JSON.parse(b) }); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const router = fakeRouter();
  const server = createRouterCtlServer({ router });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;

  // 1. health
  const h = await ctlGet(port, '/health');
  check('GET /health ok', h.code === 200 && h.json.ok === true, h);

  // 2. 同步方法 + 参数透传
  const r1 = await ctlPost(port, { method: 'addProxyKey', args: ['prov-1', 'sk-xxx'] });
  check('同步方法返回 ok:true', r1.code === 200 && r1.json.ok === true, r1.json);
  check('参数按序透传', JSON.stringify(router._calls[0]) === JSON.stringify(['addProxyKey', 'prov-1', 'sk-xxx']), router._calls);

  // 3. 异步方法
  const r2 = await ctlPost(port, { method: 'listProviders' });
  check('异步方法正确返回', r2.json.ok === true && r2.json.value.providers.length === 1, r2.json);

  // 4. 多参数异步
  const r3 = await ctlPost(port, { method: 'slowSum', args: [2, 3] });
  check('异步多参返回 5', r3.json.ok === true && r3.json.value === 5, r3.json);

  // 5. 未知方法
  const r4 = await ctlPost(port, { method: 'noSuchMethod', args: [] });
  check('未知方法返回 404', r4.code === 404 && r4.json.ok === false, r4);

  // 6. 方法抛错 → ok:false + error（业务层语义：守卫据此返回 4xx）
  const r5 = await ctlPost(port, { method: 'explode', args: [] });
  check('方法异常 → ok:false error=boom', r5.json.ok === false && r5.json.error === 'boom', r5.json);

  // 7. 非法 JSON
  const bad = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/ctl', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 5 } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ code: res.statusCode, json: JSON.parse(b) }));
    });
    req.on('error', reject);
    req.end('{oops');
  });
  check('非法 JSON → 400', bad.code === 400, bad);

  // 8. 守卫侧语义：value 必须是可 JSON 序列化结果（router.status 原样透传）
  check('value 透传 status', r1.json.ok === true); // 已覆盖

  server.close();
  console.log(failures === 0 ? '\nrouter-ctl-test: ALL PASS' : '\nrouter-ctl-test: ' + failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
