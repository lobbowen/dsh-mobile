'use strict';

// 探针 up 语义回归（android.5，真机 2026-09-23 实锤）：
// 安卓 SELinux 禁 untrusted_app 读 /proc/net/tcp 与 ss netlink → findListeningPid 恒 null，
// 健康的 dsh（HTTP 正常应答）被 L1 判离线 → 30s start_timeout 反复误杀 → 重启循环。
// 修复语义：up = 端口可连 且（pid 反查到 或 HTTP 健康应答）。
// 设备形态用 monitor.probe 的 findListeningPid 注入点伪造（安全门禁 A：禁 patch 模块导出）。

const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const monitor = require('../src/guard/monitor/index');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, 'FAIL: ' + msg); pass++; console.log('ok - ' + msg); };

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const NO_PID = () => null; // 设备形态：pid 反查不可见
const FAKE_PID = () => 4242; // PC 形态：pid 反查在场

async function main() {
  // S1: HTTP 200 + pid null → up=true（修复主案）
  const srv200 = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  const p1 = await listen(srv200);
  const r1 = await monitor.probe('127.0.0.1', p1, { healthUrl: 'http://127.0.0.1:' + p1 + '/', httpTimeoutMs: 1500, findListeningPid: NO_PID });
  ok(r1.listening === true && r1.pid === null, 'S1 前置：端口可连且 pid 不可见（设备形态成立）');
  ok(r1.up === true && r1.httpOk === true && r1.httpStatus === 200, 'S1 HTTP 活应答独立支撑在线判定（up=true）');

  // S2: HTTP 401（dsh 真机形态：/ 受认证保护）→ up=true
  const srv401 = http.createServer((req, res) => { res.writeHead(401); res.end('auth'); });
  const p2 = await listen(srv401);
  const r2 = await monitor.probe('127.0.0.1', p2, { healthUrl: 'http://127.0.0.1:' + p2 + '/', httpTimeoutMs: 1500, findListeningPid: NO_PID });
  ok(r2.up === true && r2.httpStatus === 401, 'S2 401=服务在线（dsh 启动 URL 打出后守卫能收敛 RUNNING）');

  // S3: TCP 可连但 HTTP 不应答（假死）→ up=false，假死识别能力零损伤
  const srvDead = net.createServer((sock) => { sock.on('error', () => {}); });
  const p3 = await listen(srvDead);
  const r3 = await monitor.probe('127.0.0.1', p3, { healthUrl: 'http://127.0.0.1:' + p3 + '/', httpTimeoutMs: 500, findListeningPid: NO_PID });
  ok(r3.listening === true && r3.httpOk === false && r3.up === false, 'S3 端口在但 HTTP 假死 → 仍判不在线（不放松假死防线）');

  // S4: 无监听 → up=false
  const r4 = await monitor.probe('127.0.0.1', 1, { healthUrl: 'http://127.0.0.1:1/', httpTimeoutMs: 500, findListeningPid: NO_PID });
  ok(r4.listening === false && r4.up === false, 'S4 端口不可连 → up=false');

  // S5: PC 形态（pid 在场）逐字不变
  const r5 = await monitor.probe('127.0.0.1', p1, { httpProbeEnabled: false, findListeningPid: FAKE_PID });
  ok(r5.up === true && r5.httpOk === true && r5.pid === 4242, 'S5 pid 在场 + 关 HTTP 探测：up/httpOk 与旧语义一致');
  const r5b = await monitor.probe('127.0.0.1', p3, { httpProbeEnabled: false, findListeningPid: FAKE_PID });
  ok(r5b.up === true, 'S5b 关 HTTP 探测时 pid 在线判定不变（pid 由注入桩提供，仅验语义位）');

  // S6: pid null + HTTP 500（应答了但不健康）→ up=false 且 httpOk=false：
  //     只有「pid 可见」或「HTTP 健康应答」才构成在线证据；500 两者皆无 → 维持可重启判定
  const srv500 = http.createServer((req, res) => { res.writeHead(500); res.end('boom'); });
  const p6 = await listen(srv500);
  const r6 = await monitor.probe('127.0.0.1', p6, { healthUrl: 'http://127.0.0.1:' + p6 + '/', httpTimeoutMs: 1500, findListeningPid: NO_PID });
  ok(r6.up === false && r6.httpOk === false && r6.httpStatus === 500, 'S6 500=不健康：up/httpOk 双false，不误判在线');

  srv200.close(); srv401.close(); srvDead.close(); srv500.close();
  console.log('\nprobe-up-httpfallback: ' + pass + ' checks passed');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
