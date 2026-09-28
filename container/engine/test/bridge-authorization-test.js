'use strict';

// Program 授权表（契约 §0 / 复检 AUD-G35）：握手声明 Program → 按清单 requires 授权；
// 未声明/陌生 Program → 只有 base 面；未授权组的方法被拒 -32001。

const path = require('path');
const { BridgeServer } = require('../src/bridge/server');
const makeRunner = require('./harness');

const { check, finish } = makeRunner('bridge-authorization');

const SOCK = path.join(require('os').tmpdir(), 'lobos-auth-' + process.pid + '.sock');

async function main() {
  const srv = new BridgeServer({
    socketPath: SOCK,
    deviceCapabilities: ['base', 'accessibility'],
    programRequires: { console: ['app_control', 'ui_automation'] },
  });
  const hs = (params) => srv.dispatch({ jsonrpc: '2.0', id: 1, method: 'bridge.handshake', params });

  const ok = await hs({ protocol: 1, program: 'console', requires: ['bridge:app_control', 'bridge:ui_automation'] });
  check('声明 console → 授予其 requires', ok.result.groups.includes('bridge:app_control') && ok.result.groups.includes('bridge:ui_automation'));
  check('握手回包带 program 与 authorizedGroups', ok.result.program === 'console' && Array.isArray(ok.result.authorizedGroups));

  const noProgram = await hs({ protocol: 1, requires: ['bridge:app_control'] });
  check('未声明 Program → 一组都不授予', noProgram.result.groups.length === 0);

  const stranger = await hs({ protocol: 1, program: 'stranger', requires: ['bridge:app_control'] });
  check('陌生 Program → 一组都不授予', stranger.result.groups.length === 0);

  const denied = await srv.dispatch({ jsonrpc: '2.0', id: 2, method: 'app.launch', params: { pkg: 'x' } });
  check('未授权组的方法被拒(-32001)', !!denied.error && denied.error.code === -32001);

  const allowed = await hs({ protocol: 1, program: 'console', requires: ['bridge:app_control'] });
  const launched = await srv.dispatch({ jsonrpc: '2.0', id: 3, method: 'app.launch', params: { pkg: 'x' } });
  check('重新握手为 console 后 base 面方法放行', allowed.result.groups.length === 1 && !launched.error);

  const osMethod = await srv.dispatch({ jsonrpc: '2.0', id: 4, method: 'os.state.get', params: {} });
  check('os.* 不受组授权约束（按方法自身 caps 判）', !osMethod.error || osMethod.error.code !== -32001);

  finish();
}

main().catch((e) => { console.log('FAIL ' + e.stack); process.exit(1); });
