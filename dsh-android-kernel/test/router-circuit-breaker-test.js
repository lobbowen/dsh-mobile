#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// P1-1/P1-2/P1-3：反代实例的**请求级熔断**此前完全失效（三处叠加）
//
// ## 三个缺陷为何必须一起看
//
// 它们都作用在「坏实例能否被自动重启」这一条链上，任一失效即整链失效：
//
//   P1-1  `markUsed` 在**请求发出前**无条件清零 `_unhealthyCount`，
//         而重启阈值是「连续 ≥2 次失败」→ 计数**数学上到不了 2**。
//   P1-2  断流自愈调用的是 `prov.markNetFail(acc)` —— **该方法全仓不存在**，
//         `typeof === 'function'` 恒 false → 调用是死代码。
//   P1-3  在途请求期间的重启被记为 `_restartPending` 但**无任何读取点**，
//         且 2 分钟退避**在延迟之前**就已置位 → 坏实例至少卡死 2 分钟。
//
// 后果：稳定 5xx/400（不触发 180s 超时）的坏实例会被持续选中吃流量，
//   只能靠另一套独立的 _monitorFails（探活）兜底。
//
// ## 锁定不变量
//   R-a  清零只发生在**请求成功后**（markUsed 不得再碰 _unhealthyCount）
//   R-b  `markNetFail` 不得再出现在调用位置（改用真实存在的 markInstanceNetFail）
//   R-c  `_restartPending` 必须有**读取点**（出现在某方法的实参位置）
//   R-d  退避 `_restartAt` 只在**真正执行**重启时置位（不得在延迟分支前）
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const proxy = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'proxy.js'), 'utf8');
const fwd = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'forward-core.js'), 'utf8');

// ── R-a：清零时机 ──
{
  const m = proxy.match(/markUsed\(inst\) \{[\s\S]{0,200}?\n  \}/);
  check('R-a 定位到 markUsed', !!m, m ? 'ok' : '未找到');
  check('R-a markUsed **不再**清零 _unhealthyCount',
    !!m && !/_unhealthyCount\s*=/.test(m[0]), m ? '已移除' : '');
  check('R-a 存在 markRequestOk（成功后才清零）', /markRequestOk\(inst\)/.test(proxy), '有');
  // ⚠ 断言「调用了 markRequestOk」而不绑定具体实参名 ——
  //   P2 双事实源修复后实参已改为 instOf(...) 的结果（okInst），
  //   写死 `acc.instance` 会让「纯重构」误报（我第一版就踩了这个）。
  check('R-a forward-core 在 2xx 成功路径调用 markRequestOk',
    /markRequestOk\(\w+\)/.test(fwd), '已接入');
}

// ── R-b：markNetFail 死调用 ──
// 剥离注释后不得再有 markNetFail 的**调用**（形如 .markNetFail( ）
{
  const strip = (s) => s.split(String.fromCharCode(10))
    .filter((l) => { const t = l.trim(); return !t.startsWith('//'); })
    .join(String.fromCharCode(10));
  check('R-b forward-core 不再调用不存在的 markNetFail',
    !/\.markNetFail\s*\(/.test(strip(fwd)), '已改');
  check('R-b 改用真实存在的 markInstanceNetFail',
    /markInstanceNetFail/.test(strip(fwd)), '已改');
  check('R-b 该方法确实定义在 proxy.js',
    /markInstanceNetFail\s*\(instOrAcc\)/.test(proxy), '有定义');
}

// ── R-c：_restartPending 必须有读取点 ──
{
  // 写入点是赋值；读取点应出现在 `if (... _restartPending)` 或实参位置
  const hasRead = /if\s*\([^)]*_restartPending\s*\)/.test(proxy)
    || /flushRestartPending\([^)]*_restartPending/.test(proxy)
    || /const\s+\w+\s*=\s*inst\._restartPending/.test(proxy);
  check('R-c _restartPending 存在读取点（不再只写不读）', hasRead, '有');
  check('R-c 存在 flushRestartPending 消费方法', /flushRestartPending\(inst\)/.test(proxy), '有');
  check('R-c forward-core 在 inflight 归零时调用它',
    /prov\.flushRestartPending\(\w+\)/.test(fwd), '已接入');
}

// ── R-d：退避置位时机 ──
{
  const m = proxy.match(/restartInstance\(inst, reason\) \{[\s\S]*?\n  \}/);
  check('R-d 定位到 restartInstance', !!m, m ? 'ok' : '未找到');
  if (m) {
    const body = m[0];
    const iPending = body.indexOf('_restartPending = reason');
    const iBackoff = body.indexOf('_restartAt = Date.now()');
    check('R-d 退避置位在**在途延迟分支之后**（不再提前置位）',
      iPending >= 0 && iBackoff > iPending, 'pending@' + iPending + ' backoff@' + iBackoff);
  }
}

// ── 反向：成功路径仍要清零（防「修成永不清零」）──
check('反向：成功路径保留了清零语义（markRequestOk 内有赋值）',
  /markRequestOk\(inst\) \{[\s\S]{0,120}?_unhealthyCount\s*=\s*0/.test(proxy), '保留');
check('反向：markInstanceProblem 仍累加（熔断本身没被删）',
  /_unhealthyCount\s*=\s*\(inst\._unhealthyCount \|\| 0\) \+ 1/.test(proxy), '保留');

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);