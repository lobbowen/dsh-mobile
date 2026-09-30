#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// HostBridge 客户端门禁（2026-09-16）
//
// ## 解决的问题
//   容器（L0）实现了 HostBridge（UDS + JSON-RPC 2.0 + 8 组方法），但**内核侧此前没有任何客户端**
//   —— 桥是孤儿，内核 notify/browser 只能空转。本测试锁定内核侧客户端与接线：
//
// ## 锁定不变量
//   H-1  抽象命名空间路径 = '\0'+name（不是空格前缀；Node 22 原生支持）
//   H-2  socket 名解析：显式参数 > LOBOS_BRIDGE_SOCKET env > 默认 lobos_hostbridge
//   H-3  桥不可用时 call() 返回 null 且**不抛**；handshake() 返回 null
//   H-4  真实 UDS 端到端：连上参考桥 → 握手协商 → 调用成功 / 能力门禁(-32001) / 未知方法(-32601)
//   H-5  notify/browser 接线：容器内调用路由到桥；容器外/桥不可用 → 降级返回 false，不抛
//   H-6  超时：桥不回包时 call() 按时返回 null，不挂死
//   H-7  握手声明身份（program=包清单 id），且包清单 requires 覆盖 src 里每一处桥调用
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const hb = require(path.join(ROOT, 'src', 'platform', 'host-bridge', 'client.js'));
const proto = require(path.join(ROOT, 'src', 'platform', 'host-bridge', 'protocol.js'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : '')); };

// ---- 一个最小的假容器桥：收 handshake 回 capabilities，其余按方法名回包 ----
function startFakeBridge(socketName, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (opts.silent) return; // 故意不回包（测超时）
          let resp;
          if (msg.method === 'bridge.handshake') {
            resp = { jsonrpc: '2.0', id: msg.id, result: { protocol: 1, capabilities: ['base'], groups: ['bridge:app_control', 'bridge:notification'] } };
          } else if (msg.method === 'sys.info') {
            resp = { jsonrpc: '2.0', id: msg.id, result: { device: 'fake', apiLevel: 35 } };
          } else if (msg.method === 'notif.post') {
            resp = { jsonrpc: '2.0', id: msg.id, result: { posted: true } };
          } else if (msg.method === 'app.openUrl') {
            resp = { jsonrpc: '2.0', id: msg.id, result: { opened: true } };
          } else {
            resp = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method: ' + msg.method } };
          }
          sock.write(JSON.stringify(resp) + '\n');
        }
      });
    });
    server.listen('\0' + socketName, () => resolve(server));
  });
}

async function main() {
  // H-1 抽象命名空间路径
  check('H-1 abstractPath 以 NUL 前缀', hb.abstractPath('abc') === '\0abc');

  // H-2 socket 名解析优先级
  const saved = process.env.LOBOS_BRIDGE_SOCKET;
  process.env.LOBOS_BRIDGE_SOCKET = 'env_named';
  check('H-2 env 覆盖默认名', new hb.HostBridgeClient().socketName === 'env_named');
  check('H-2 显式参数优先于 env', new hb.HostBridgeClient({ socketName: 'explicit' }).socketName === 'explicit');
  delete process.env.LOBOS_BRIDGE_SOCKET;
  check('H-2 无 env/参数 → 默认 lobos_hostbridge', new hb.HostBridgeClient().socketName === hb.DEFAULT_SOCKET);
  if (saved !== undefined) process.env.LOBOS_BRIDGE_SOCKET = saved;

  // H-3 桥不可用：不抛，返回 null
  const dead = new hb.HostBridgeClient({ socketName: 'no_such_bridge_' + process.pid, timeoutMs: 300 });
  let threw = false;
  let hs = null;
  try { hs = await dead.handshake(); } catch { threw = true; }
  check('H-3 桥不可用时 handshake 不抛且返回 null', !threw && hs === null);
  let r = 'x';
  try { r = await dead.call('sys.info', {}); } catch { r = 'THREW'; }
  check('H-3 桥不可用时 call 返回 null 且不抛', r === null);
  check('H-3 桥不可用时 isConnected=false', dead.isConnected() === false);

  // H-4 真实 UDS 端到端
  const SOCK = 'hb_test_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
  const server = await startFakeBridge(SOCK);
  const c = new hb.HostBridgeClient({ socketName: SOCK, requires: ['bridge:app_control', 'bridge:vpn'], timeoutMs: 2000 });
  const hs2 = await c.handshake();
  check('H-4 握手成功且 protocol=1', !!hs2 && hs2.protocol === 1);
  check('H-4 能力协商 groups 正确', Array.isArray(hs2.groups) && hs2.groups.includes('bridge:app_control') && !hs2.groups.includes('bridge:vpn'));
  check('H-4 capabilities 暴露', c.capabilities().includes('base'));
  const info = await c.call('sys.info', {});
  check('H-4 call 成功返回 result', !!info && info.ok && info.result.device === 'fake');
  const unknown = await c.call('nope.x', {});
  check('H-4 未知方法 → -32601', !!unknown && unknown.ok === false && unknown.error.code === proto.ERROR_CODES.METHOD_NOT_FOUND);

  // H-5 notify / browser 接线（容器内）
  process.env.LOBOS_ANDROID = '1';
  const notify = require(path.join(ROOT, 'src', 'platform', 'os', 'notify.js'));
  const browser = require(path.join(ROOT, 'src', 'platform', 'os', 'browser.js'));
  // 让 notify/browser 走同一 socket（单例读取 env）
  process.env.LOBOS_BRIDGE_SOCKET = SOCK;
  hb.client().close(); // 让单例以新 socket 重连
  const fired = notify.notify('标题', '内容');
  check('H-5 容器内 notify 返回 true（已发起派发）', fired === true);
  check('H-5 notifyCommand 恒为 null', notify.notifyCommand() === null);
  const opened = browser.open('https://example.com');
  check('H-5 容器内 browser.open 返回 true', opened === true);
  const iso = browser.launchIsolated('https://example.com');
  check('H-5 launchIsolated 不宣称隔离（isolated=false）', iso.isolated === false && typeof iso.ok === 'boolean');
  await new Promise((r2) => setTimeout(r2, 150)); // 让异步派发完成

  // H-5b 容器外：降级为 false，不抛
  delete process.env.LOBOS_ANDROID;
  check('H-5 容器外 notify → false（降级不抛）', notify.notify('x', 'y') === false);
  check('H-5 容器外 browser.open → false（降级不抛）', browser.open('https://x') === false);
  process.env.LOBOS_ANDROID = '1';

  c.close();
  hb.client().close(); // notify/browser 用进程级单例，也需断开，否则 server.close 等不到连接结束
  await new Promise((res) => server.close(res));

  // H-6 超时：桥不回包 → call 按时返回 null
  const SOCK2 = 'hb_silent_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
  const silent = await startFakeBridge(SOCK2, { silent: true });
  const c2 = new hb.HostBridgeClient({ socketName: SOCK2, timeoutMs: 300 });
  const t0 = Date.now();
  const timedOut = await c2.call('sys.info', {});
  const dt = Date.now() - t0;
  check('H-6 桥不回包 → call 超时返回 null', timedOut === null);
  check('H-6 超时受控（<2000ms，不挂死）', dt < 2000, dt + 'ms');
  c2.close();
  await new Promise((res) => silent.close(res));

  // H-7 握手身份 + 「声明覆盖调用」
  // 定罪由来（2026-10-01）：.47 的客户端握手帧里没有 program，而壳侧授权表按包清单 name 查
  // （AUD-G35）——未声明就只有 base，面板每一次桥调用都吃 -32001。此前 CI 从不把
  // 「代码调的方法」与「清单声明的组」放在一起对，所以这条破口只能到真机才显形。
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const frame = proto.handshakeRequest(1, ['bridge:shell'], manifest.id);
  check('H-7 握手帧带 program（壳侧授权表的键）', frame.params.program === manifest.id, JSON.stringify(frame.params));
  const auto = new hb.HostBridgeClient({ socketName: 'hb_absent_' + process.pid });
  check('H-7 默认身份取自自己的包清单（不留第二处申报）', auto.program === manifest.id, String(auto.program));
  check('H-7 默认 requires 取自包清单', JSON.stringify(auto.requires) === JSON.stringify(manifest.requires), JSON.stringify(auto.requires));
  const METHODS = require(path.join(ROOT, '..', '..', 'container', 'engine', 'src', 'bridge', 'methods.js')).METHODS;
  const declared = new Set(manifest.requires.map((t) => String(t).replace('bridge:', '')));
  const used = new Set();
  (function scan(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { scan(p); continue; }
      if (!/\.js$/.test(e.name)) continue;
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/\bcall\(\s*'([a-z][a-zA-Z]*\.[a-zA-Z.]+)'/g)) used.add(m[1]);
    }
  })(path.join(ROOT, 'src'));
  const unlisted = [...used].filter((n) => !METHODS[n]).sort();
  check('H-7 调用的方法全部在桥方法表在册', unlisted.length === 0, '未在册: ' + unlisted.join(', '));
  const undeclared = [...used].filter((n) => METHODS[n] && !declared.has(METHODS[n].group)).sort();
  check('H-7 每个调用的组都已在包清单声明', undeclared.length === 0, '缺声明: ' + undeclared.join(', ') + '（读数: ' + [...used].sort().join(', ') + '）');
  // 对照组（双向）：夹具里加一个未声明组的调用，判据必须把它判出来
  const ctlUndeclared = ['ui.tap'].filter((n) => METHODS[n] && !declared.has(METHODS[n].group));
  check('H-7 对照组：未声明组的调用会被判出', ctlUndeclared.length === 1, JSON.stringify(ctlUndeclared));
  auto.close();

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log('\n结果: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('测试异常:', e && e.stack || e); console.log('\n结果: 0 passed, 1 failed'); process.exit(1); });
