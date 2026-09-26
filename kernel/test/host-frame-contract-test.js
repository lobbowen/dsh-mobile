#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 容器宿主帧契约门禁（2026-09-16）
//
// ## 解决的问题
//   内核面板在安卓容器里以 iframe 形式运行，需要「宿主帧」承接 dsh:kernel-update-request。
//   此前宿主帧在容器 assets/，与内核**跨源** → 内核 Origin 闸(api/index.js originAllowed 闸②)
//   拒绝一切写操作(403)；且回灌字段缺 v/ok → 面板超时。
//   现宿主帧改由**内核自身同源托管**（/__host）。
//
// ## 锁定不变量
//   U-1  /__host 路由存在，且 serveStatic 指向 host.html（index.js）
//   U-2  路由被 surface 契约的排除面「静态路由」正确归类（index.js 静态面，不在 API surface 内）
//   U-3  宿主页 iframe 同源相对路径 '/'（而非跨源绝对地址）
//   U-4  宿主页脚本外链（CSP script-src 'self' 禁内联）
//   U-5  宿主帧脚本协议版本 / 双向消息类型与 kernelUpdateBridge.ts 一致
//   U-6  更新桥只「应答」：宿主帧脚本不含任何内核写入语义（无 apply/install 写端点）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const idx = fs.readFileSync(path.join(ROOT, 'src', 'api', 'index.js'), 'utf8');
const surface = fs.readFileSync(path.join(ROOT, 'src', 'api', 'surface.js'), 'utf8');
const hostHtmlPath = path.join(ROOT, 'ui', 'public', 'host.html');
const hostJsPath = path.join(ROOT, 'ui', 'public', 'host-frame.js');
const bridgeTs = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'services', 'supervisor', 'kernelUpdateBridge.ts'), 'utf8');

// U-1 路由
check('U-1 index.js 定义 /__host 路由', /pathname === '\/__host'/.test(idx));
check('U-1 /__host 指向 host.html', /pathname === '\/__host'[\s\S]{0,120}serveStatic\(res, 'host\.html'\)/.test(idx));
check('U-1 host-frame.js 静态资源开放', /file === 'host-frame\.js'/.test(idx));

// U-2 归类正确：/__host 属 index.js 静态面（与 /、/index.html 同层），**不得**混入 API surface 清单
//     （surface.js 与 api-surface-test 的约定：index.js 的路由不登记，避免幽灵条目）。
check('U-2 /__host 不误入 API surface 清单', !/path:\s*'\/__host'/.test(surface));

// U-3 / U-4 宿主页
check('U-3 host.html 存在', fs.existsSync(hostHtmlPath));
if (fs.existsSync(hostHtmlPath)) {
  const h = fs.readFileSync(hostHtmlPath, 'utf8');
  check('U-3 iframe 同源相对路径 src="/"', /<iframe[^>]*id="kernel"[^>]*src="\/"/.test(h));
  check('U-3 不含跨源绝对地址（无 127.0.0.1:3080 等写死端口）', !/http:\/\/127\.0\.0\.1:\d+/.test(h));
  check('U-4 脚本外链 /host-frame.js', /<script[^>]*src="\/host-frame\.js"/.test(h));
  check('U-4 无内联 script（CSP 禁止）', !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.test(h.replace(/<script[^>]*src=[^>]*><\/script>/g, '')));
}

// U-5 协议一致性
check('U-5 host-frame.js 存在', fs.existsSync(hostJsPath));
if (fs.existsSync(hostJsPath)) {
  const j = fs.readFileSync(hostJsPath, 'utf8');
  check('U-5 协议版本 = 1', /PROTOCOL_VERSION\s*=\s*1\b/.test(j));
  check('U-5 转发 dsh:kernel-update-request', j.includes('dsh:kernel-update-request'));
  check('U-5 回灌 dsh:kernel-update-result', j.includes('dsh:kernel-update-result'));
  check('U-5 暴露 window.dshDeliverResult', /window\.dshDeliverResult\s*=/.test(j));
  check('U-5 经 DshNative.onRequest 交原生', /DshNative[\s\S]{0,60}onRequest/.test(j));
  // U-6 单写入者：宿主只转发，不含写内核语义
  check('U-6 宿主帧不含内核写端点语义', !/\b(self-update|applyUpdate|installKernel)\b/.test(j));
}
check('U-5 内核桥协议版本同为 1', /BRIDGE_PROTOCOL_VERSION\s*=\s*1\b/.test(bridgeTs));
check('U-5 请求类型两侧一致', bridgeTs.includes('dsh:kernel-update-request') && fs.existsSync(hostJsPath) && fs.readFileSync(hostJsPath, 'utf8').includes('dsh:kernel-update-request'));

const passed = results.filter(Boolean).length;
const failed = results.length - passed;
console.log('\n结果: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
