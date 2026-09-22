#!/usr/bin/env node
'use strict';

// 测试用端口分配（**单一事实源**，2026-09-11）。
//
// == 为什么需要它（真实 flake 根因） ==
//
// 测试原先各自硬编码固定端口，且大量落在 **OS ephemeral 范围**（Linux 默认 32768-60999）。
// 生产代码 ports.js 明确要求「选址必须避开 OS 动态端口范围」，但测试自己却违反了它。
//
// 后果：claimSlot 用 bind 探测判占用，而 ephemeral 内的端口会被**任何进程的临时出站
// 连接**短暂占用 → bind 失败 → 测试跳过该端口 → 断言「应为 46000」却得到 46003。
// 表现为**偶发假失败**（复跑即过），实测出现过两次：
//   · ports-claim-test 的 instB → base+2 偶发失败
//   · router-e2e-test 与 token-boundary-test 撞用 39080 → EADDRINUSE
//
// == 分配规则 ==
//
// 安全段 = 避开 ephemeral(32768-60999) 且避开生产池(20000-25999 / 40000-43199)。
// 本模块提供：
//   · safeBase(name) / safePort(name, i) —— 按测试文件分段的固定端口（跨文件绝不撞号）
//   · freePort()                          —— 动态空闲端口（不关心具体数值时最稳）
//   · isSafe(p)                           —— 断言端口不落在危险区

// == 安全段选取（避开安卓容器 Linux 的动态端口范围与生产端口池） ==
//
// Android 内核只跑在 Linux（安卓容器 / 模拟器 / CI 容器），动态端口范围即
//   net.ipv4.ip_local_port_range 默认 32768-60999（可被 sysctl 调整）。
//
// 上界取 32767（动态范围之下），再排除生产池 (20000-25999)，
// 可用区间 26000-32767；取其中段 28000-29999 作为安全段
// （与生产池留 2000 号缓冲，且远离 32767 边界）。
//
// 每文件分配 10 个号的固定区段，避免跨文件撞号。
const BASE = 28000;

// 文件 → 段序号（新增测试文件时在此登记，段号唯一即可；删除测试文件必须同步删段）。
const SEGMENTS = {
  'adopt-token-reclaim': 0,
  'daemon-lifecycle': 1,
  'freeze-recovery': 2,
  'ports-claim': 3,
  'ports-migrate': 4,
  'ports-verify': 5,
  'precheck': 6,
  'router-e2e': 7,
  'sigterm-desired': 8,
  'smoke': 9,
  'upgrade': 10,
  'defects-batch-f': 11,
};

/** 取某测试文件的段基址（未登记则报错 —— 强制登记，避免静默撞号）。 */
function safeBase(name) {
  const seg = SEGMENTS[name];
  if (seg === undefined) {
    throw new Error('未登记的测试段: ' + name + '（请在 test/_ports.js 的 SEGMENTS 中登记）');
  }
  return BASE + seg * 10;
}

/** 某测试文件的第 i 个端口（i 从 0 起）。 */
function safePort(name, i) {
  return safeBase(name) + (i || 0);
}

/** 任一空闲端口（交给 OS 选，最稳）。 */
function freePort() {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// Linux 动态/临时端口范围（本机实际值会动态读取并叠加）。
const EPHEMERAL_UNION = [
  [32768, 60999],   // Linux 默认 ip_local_port_range
];
const PROD_POOLS = [[20000, 23999], [24000, 25999]];

/** 端口是否安全（不在动态端口范围内，也不在生产池内）。
 *
 *  Android 内核只运行于 Linux（安卓容器 / CI 容器），故只判 Linux 动态范围；
 *  本机实际的 ip_local_port_range 会动态叠加（容器里可能被改过）。
 */
function isSafe(p) {
  const ranges = EPHEMERAL_UNION.slice();
  // 叠加本机实际配置（Linux 可被 sysctl 改为自定义范围）
  try {
    const [lo, hi] = require('node:fs')
      .readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8')
      .trim()
      .split(/\s+/)
      .map(Number);
    if (Number.isFinite(lo) && Number.isFinite(hi)) ranges.push([lo, hi]);
  } catch {}
  for (const [a, b] of ranges) if (p >= a && p <= b) return false;
  for (const [a, b] of PROD_POOLS) if (p >= a && p <= b) return false;
  return true;
}

module.exports = { BASE, SEGMENTS, safeBase, safePort, freePort, isSafe };
