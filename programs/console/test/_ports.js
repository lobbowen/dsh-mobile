#!/usr/bin/env node
'use strict';

// 测试用端口工具（**单一事实源**）。
//
// == 为什么需要它（真实 flake 根因）==
// 测试原先各自硬编码固定端口，且大量落在 OS ephemeral 范围（Linux 默认 32768-60999）。
// 生产代码 ports.js 明确要求「选址必须避开 OS 动态端口范围」，测试自己却违反了它。
// 后果：claimSlot 用 bind 探测判占用，而 ephemeral 内的端口会被任何进程的临时出站连接
// 短暂占用 → bind 失败 → 断言失败。表现为**偶发假失败**（复跑即过）。
//
// == 本模块的职责（只此两件）==
//   · freePort() —— 让 OS 选一个空闲端口（不关心具体数值时最稳）
//   · isSafe(p)  —— 端口是否不在动态范围、也不在生产池
//
// == 历史注记（2026-09-27 治理）==
// 曾经还有一张 SEGMENTS 分段表 + safeBase/safePort，给每个测试文件预留 10 个号。
// 实测 12 个登记文件里 **11 个从不调用它**（只留一张声明表，端口全部硬编码），
// 且对应的门禁 T2 只断言「文件里出现字符串 safePort」—— 一个未使用的 import 即可满足，
// 属**空转门禁**。该机制与真实取号脱钩，已连同 T2/T3 一起删除。
// 现在各测试文件的固定端口由 test-port-discipline 的 T1 兜底（不得落在 ephemeral / 生产池）。

// 安全段锚点：避开 Linux 动态范围（32768-60999）与生产池（20000-25999）后的中段。
const BASE = 28000;

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

module.exports = { BASE, freePort, isSafe };
