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
//   H-2  socket 名解析：显式参数 > DSH_BRIDGE_SOCKET env > 默认 dsh_hostbridge
//   H-3  桥不可用时 call() 返回 null 且**不抛**；handshake() 返回 null
//   H-4  真实 UDS 端到端：连上参考桥 → 握手协商 → 调用成功 / 能力门禁(-32001) / 未知方法(-32601)
//   H-5  notify/browser 接线：容器内调用路由到桥；容器外/桥不可用 → 降级返回 false，不抛
//   H-6  超时：桥不回包时 call() 按时返回 null，不挂死
// ═══════════════════════════════════════════════════════════════════════════

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
  const saved = process.env.DSH_BRIDGE_SOCKET;
  process.env.DSH_BRIDGE_SOCKET = 'env_named';
  check('H-2 env 覆盖默认名', new hb.HostBridgeClient().socketName === 'env_named');
  check('H-2 显式参数优先于 env', new hb.HostBridgeClient({ socketName: 'explicit' }).socketName === 'explicit');
  delete process.env.DSH_BRIDGE_SOCKET;
  check('H-2 无 env/参数 → 默认 dsh_hostbridge', new hb.HostBridgeClient().socketName === hb.DEFAULT_SOCKET);
  if (saved !== undefined) process.env.DSH_BRIDGE_SOCKET = saved;

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
  const c = new hb.HostBridgeClient({ socketName: SOCK, requires: ['bridge:app_control', 'bridge:device_policy'], timeoutMs: 2000 });
  const hs2 = await c.handshake();
  check('H-4 握手成功且 protocol=1', !!hs2 && hs2.protocol === 1);
  check('H-4 能力协商 groups 正确', Array.isArray(hs2.groups) && hs2.groups.includes('bridge:app_control') && !hs2.groups.includes('bridge:device_policy'));
  check('H-4 capabilities 暴露', c.capabilities().includes('base'));
  const info = await c.call('sys.info', {});
  check('H-4 call 成功返回 result', !!info && info.ok && info.result.device === 'fake');
  const unknown = await c.call('nope.x', {});
  check('H-4 未知方法 → -32601', !!unknown && unknown.ok === false && unknown.error.code === proto.ERROR_CODES.METHOD_NOT_FOUND);

  // H-5 notify / browser 接线（容器内）
  process.env.DSH_ANDROID = '1';
  const notify = require(path.join(ROOT, 'src', 'platform', 'os', 'notify.js'));
  const browser = require(path.join(ROOT, 'src', 'platform', 'os', 'browser.js'));
  // 让 notify/browser 走同一 socket（单例读取 env）
  process.env.DSH_BRIDGE_SOCKET = SOCK;
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
  delete process.env.DSH_ANDROID;
  check('H-5 容器外 notify → false（降级不抛）', notify.notify('x', 'y') === false);
  check('H-5 容器外 browser.open → false（降级不抛）', browser.open('https://x') === false);
  process.env.DSH_ANDROID = '1';

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

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log('\n结果: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('测试异常:', e && e.stack || e); console.log('\n结果: 0 passed, 1 failed'); process.exit(1); });
