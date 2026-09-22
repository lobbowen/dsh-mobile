#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 第十三轮续：镜像「测试」按钮必须走同源后端（2026-09-13 P2）
//
// ## 缺陷（结构性失败被伪装成网络失败）
//
// 设置页的「测试」按钮由**浏览器直连**用户填写的任意镜像源
// （RegistryCard.tsx::testLatency → fetch(url + "/-/ping")）。
// 而该页面由**内核 HTTP 服务**下发，并附带 CSP：
//     connect-src 'self'        （src/api/index.js）
// → 浏览器**在发起请求之前**就按 CSP 拦截，fetch 立刻 reject，
//   被 catch 统一吞成 toast「探测失败」。
//
// 后果：该按钮对**任何**地址恒报「探测失败」，且换网络、换镜像都无法解决；
//   UI 无法区分「真的不可达」与「被策略阻断」——把**结构性失败伪装成网络失败**，
//   用户据此以为镜像坏了而改配置或放弃使用镜像。
//   而「测速选最快镜像」正是该卡的卖点。
//
// ## 修法
//
// 新增**同源**端点 POST /dist/registry/probe（服务端探测不受页面 CSP 约束），
// 且复用 DistributionManager::_probeRegistry（与内核选源**同一探测规格**，
// 避免「测试说可达、实际选源不同」的第二次分叉）。
//
// ## 门禁
//   A UI 源码中**不再**出现跨源裸 fetch（唯一允许在 client.ts 内）
//   B 后端存在同源探活端点，且用**同一探测规格**（复用 _probeRegistry）
//   C 前端经 supervisorApi 包装调用（不再直接 fetch）
//   D 端点已登记到 api/surface.js（可发现性）
//   E 反向：判据能识别跨源裸 fetch 形态（门禁非空转）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

(async () => {
  console.log('== A UI 不得有跨源裸 fetch ==');
  const uiFiles = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p); }
      else if (/\.(ts|tsx)$/.test(e.name)) uiFiles.push(p);
    }
  };
  walk(path.join(ROOT, 'ui', 'src'));
  const offenders = [];
  for (const f of uiFiles) {
    const rel = path.relative(ROOT, f);
    if (rel.endsWith(path.join('services', 'supervisor', 'client.ts'))) continue; // 唯一允许的 fetch 点
    const src = fs.readFileSync(f, 'utf8');
    const code = src.split('\n').filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    }).join('\n');
    if (/\bfetch\(/.test(code)) offenders.push(rel);
  }
  check('A 除 client.ts 外无裸 fetch（页面 CSP connect-src self 会拦截跨源）',
    offenders.length === 0, offenders.length ? offenders.join(', ') : '0 处');

  console.log('== B 后端同源探活端点复用同一探测规格 ==');
  {
    const api = fs.readFileSync(path.join(ROOT, 'src', 'api', 'dist.js'), 'utf8');
    check('B 存在 /dist/registry/probe 端点', api.indexOf("'/dist/registry/probe'") >= 0, '有');
    check('B 校验 origin 必须以 http(s) 开头（防 SSRF 到任意协议）',
      /\^https\?:/.test(api), '有');
    const dist = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'dist', 'index.js'), 'utf8');
    const i = dist.indexOf('async probeOrigin(');
    check('B 存在 probeOrigin 实现', i > 0, i > 0 ? '有' : '缺');
    const body = dist.slice(i, i + 700);
    check('B 复用 _probeRegistry（与内核选源同一探测规格）',
      body.indexOf('this._probeRegistry(') >= 0, '有');
  }

  console.log('== C 前端经 supervisorApi 包装调用 ==');
  {
    const card = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'features', 'supervisor', 'settings', 'RegistryCard.tsx'), 'utf8');
    check('C RegistryCard 调 supervisorApi.registryProbe', card.indexOf('supervisorApi.registryProbe(') >= 0, '有');
    const client = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'services', 'supervisor', 'client.ts'), 'utf8');
    check('C client 暴露 registryProbe 方法', client.indexOf('registryProbe:') >= 0, '有');
  }

  console.log('== D 端点已登记 surface ==');
  {
    const surface = fs.readFileSync(path.join(ROOT, 'src', 'api', 'surface.js'), 'utf8');
    check('D surface 登记 /dist/registry/probe', surface.indexOf("'/dist/registry/probe'") >= 0, '有');
  }

  console.log('== E 反向：判据能识别跨源裸 fetch ==');
  check('E 判据对跨源 fetch 形态有效',
    /\bfetch\(/.test('const r = await fetch(url + "/-/ping");'), 'hit');
  check('E 判据对 await x.y(...) 形态不误报',
    !/\bfetch\(/.test('const r = await supervisorApi.registryProbe(url);'), 'no-false-positive');

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
