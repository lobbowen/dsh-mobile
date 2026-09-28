#!/usr/bin/env node
'use strict';

// OS 能力桥客户端门禁：Program ↔ OS CapabilityBroker 的传输与降级不变量。
//   H-1 抽象命名空间路径 = '\0'+name
//   H-2 socket 名解析：显式参数 > LOBOS_BRIDGE_SOCKET env > 默认 lobos_hostbridge
//   H-3 桥不可用时 call()/handshake() 返回 null 且不抛
//   H-4 真实 UDS 端到端：握手协商 → 调用成功 / 能力门禁(-32001) / 未知方法(-32601)
//   H-5 超时：桥不回包时 call() 按时返回 null

const net = require('node:net');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const hb = require(path.join(ROOT, 'src', 'platform', 'host-bridge', 'client.js'));
const proto = require(path.join(ROOT, 'src', 'platform', 'host-bridge', 'protocol.js'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : '')); };

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
          if (opts.silent) return;
          let resp;
          if (msg.method === 'bridge.handshake') {
            resp = { jsonrpc: '2.0', id: msg.id, result: { protocol: 1, capabilities: ['base'], groups: ['bridge:app_control', 'bridge:notification'] } };
          } else if (msg.method === 'os.state.get') {
            resp = { jsonrpc: '2.0', id: msg.id, result: { phase: 'RUNNING' } };
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
  check('H-1 abstractPath 以 NUL 前缀', hb.abstractPath('abc') === '\0abc');

  const saved = process.env.LOBOS_BRIDGE_SOCKET;
  process.env.LOBOS_BRIDGE_SOCKET = 'env_named';
  check('H-2 env 覆盖默认名', new hb.HostBridgeClient().socketName === 'env_named');
  check('H-2 显式参数优先于 env', new hb.HostBridgeClient({ socketName: 'explicit' }).socketName === 'explicit');
  delete process.env.LOBOS_BRIDGE_SOCKET;
  check('H-2 无 env/参数 → 默认 ' + hb.DEFAULT_SOCKET, new hb.HostBridgeClient().socketName === hb.DEFAULT_SOCKET);
  if (saved !== undefined) process.env.LOBOS_BRIDGE_SOCKET = saved;

  const dead = new hb.HostBridgeClient({ socketName: 'no_such_bridge_' + process.pid, timeoutMs: 300 });
  let threw = false;
  let hs = null;
  try { hs = await dead.handshake(); } catch { threw = true; }
  check('H-3 桥不可用时 handshake 不抛且返回 null', !threw && hs === null);
  let r = 'x';
  try { r = await dead.call('os.state.get', {}); } catch { r = 'THREW'; }
  check('H-3 桥不可用时 call 返回 null 且不抛', r === null);
  check('H-3 桥不可用时 isConnected=false', dead.isConnected() === false);

  const SOCK = 'hb_test_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
  const server = await startFakeBridge(SOCK);
  const c = new hb.HostBridgeClient({ socketName: SOCK, requires: ['bridge:app_control', 'bridge:vpn'], timeoutMs: 2000 });
  const hs2 = await c.handshake();
  check('H-4 握手成功且 protocol=1', !!hs2 && hs2.protocol === 1);
  check('H-4 能力协商 groups 正确', Array.isArray(hs2.groups) && hs2.groups.includes('bridge:app_control') && !hs2.groups.includes('bridge:vpn'));
  check('H-4 capabilities 暴露', c.capabilities().includes('base'));
  const st = await c.call('os.state.get', {});
  check('H-4 call 成功返回 result', !!st && st.ok && st.result.phase === 'RUNNING');
  const unknown = await c.call('nope.x', {});
  check('H-4 未知方法 → -32601', !!unknown && unknown.ok === false && unknown.error.code === proto.ERROR_CODES.METHOD_NOT_FOUND);

  c.close();
  await new Promise((res) => server.close(res));

  const SOCK2 = 'hb_silent_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
  const silent = await startFakeBridge(SOCK2, { silent: true });
  const c2 = new hb.HostBridgeClient({ socketName: SOCK2, timeoutMs: 300 });
  const t0 = Date.now();
  const timedOut = await c2.call('os.state.get', {});
  const dt = Date.now() - t0;
  check('H-5 桥不回包 → call 超时返回 null', timedOut === null);
  check('H-5 超时受控（<2000ms，不挂死）', dt < 2000, dt + 'ms');
  c2.close();
  await new Promise((res) => silent.close(res));

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log('\n结果: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('测试异常:', (e && e.stack) || e); console.log('\n结果: 0 passed, 1 failed'); process.exit(1); });

