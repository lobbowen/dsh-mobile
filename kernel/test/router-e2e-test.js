#!/usr/bin/env node
'use strict';

// 智能路由转发端到端测试：直连 provider + mock 上游，验证非流式/流式转发与用量统计。

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
// 端口手工分配在安全段（避开 OS ephemeral 与生产池）；跨文件不撞号靠人工规划，T1 兜底。

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'router-e2e-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

const up = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    const j = JSON.parse(b || '{}');
    if (j.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.write('data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n');
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    }
  });
});

(async () => {
  await new Promise((r) => up.listen(28170, '127.0.0.1', r));
  const { RouterService } = require(path.join(ROOT, 'src', 'domains', 'router'));
  const svc = new RouterService({ config: {}, providerFile: path.join(TMP, 'providers.json'), portsFile: path.join(TMP, 'ports-router.json'), usageTotalsFile: path.join(TMP, 'totals.json'), logger: { info(){}, warn(){}, error(){} }, events: null });
  const r1 = svc.addDirectProvider({ name: 'Mock', baseUrl: 'http://127.0.0.1:28170/v1' });
  const dp = svc.getProvider(r1.id);
  dp.accounts.push({ key: 'sk-mock-1', keyId: 'm1', maskedKey: '...ock-1', status: 'ready', quota: { rolling: { percent: 10, status: 'ok' }, weekly: { percent: 20, status: 'ok' }, monthly: { percent: 30, status: 'ok' } }, cooldownUntil: null, registeredAt: Date.now() });
  await svc.activateProvider(r1.id); // 供应商独立端点语义：激活即开放该供应商独立 API 端口（未激活不提供服务）
  await svc.start();
  const reqOnce = (payload) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: dp.apiPort, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ code: res.statusCode, body: b })); });
    req.write(JSON.stringify(payload)); req.end();
  });
  const n = await reqOnce({ model: 'test', messages: [{ role: 'user', content: 'hi' }] });
  check('非流式转发成功', n.code === 200 && n.body.includes('ok'), n.code + ' ' + n.body.slice(0, 60));
  check('非流式用量已记录', svc.getUsage().requests >= 1 && svc.getUsage().totalTokens >= 5, JSON.stringify(svc.getUsage()));
  const s = await reqOnce({ model: 'test', messages: [{ role: 'user', content: 'hi' }], stream: true });
  check('流式转发成功', s.code === 200 && s.body.includes('DONE'), s.code + ' ' + s.body.slice(0, 60));
  check('流式用量已记录', svc.getUsage().requests >= 2 && svc.getUsage().totalTokens >= 15, JSON.stringify(svc.getUsage()));
  await svc.stop();
  up.close();
  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
