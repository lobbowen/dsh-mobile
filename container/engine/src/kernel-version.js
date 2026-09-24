'use strict';

// 内核版本比较 —— **唯一规则**，与设备端 Kotlin 的 kernel/KernelVersions.compare 同语义
// （用例表由 kernel-version-crosslang-test.js 双向钉住）。
//
// 规则：按 \d+ 与 \D+ 切 token，数字段按数值比较，其余按字符串比较。
//   · 0.1.0-android.10 > 0.1.0-android.2
//   · 0.2.0 > 0.1.0-android.11
//   · 0.1.0-android.11 > 0.1.0            （⚠ 前缀更短者更小：纯发布号 < 带后缀号）
//
// 最后一条是**坑**：内核版本必须保持同一套写法（要么都带 -android.N 且 N 递增，
// 要么都不带）。否则"发一个纯 X.Y.Z"会被设备判为**更旧**从而永不升级 —— 静默失效。
// CI 的 kernel-ota 版本前进门禁用本函数拦这类发布。

const TOKEN = /\d+|\D+/g;

function tokens(v) {
  return String(v == null ? '' : v).match(TOKEN) || [];
}

function compare(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  const n = Math.max(ta.length, tb.length);
  for (let i = 0; i < n; i += 1) {
    const x = ta[i];
    const y = tb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    let c;
    if (nx !== null && ny !== null) c = nx === ny ? 0 : (nx > ny ? 1 : -1);
    else if (nx !== null) c = 1;
    else if (ny !== null) c = -1;
    else c = x === y ? 0 : (x > y ? 1 : -1);
    if (c !== 0) return c;
  }
  return 0;
}

/** 远端是否**确实更新**（严格大于）。相等或更旧都返回 false —— 绝不降级。 */
function isNewer(remote, current) {
  if (!current) return true;
  return compare(remote, current) > 0;
}

module.exports = { compare, isNewer };
