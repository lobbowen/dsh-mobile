'use strict';

// 能力探针的**唯一执行器**：判据本身住在供给表（每格 `verify.node` 是一段要交给被检 node
// 跑的 JS），这里只负责「跑一次 + 把结果折成三态」。
//
// 为什么判据不许住在投放代码里（真机 2026-09-26 定罪）：投放结局只有
// applied/already/blocked/failed 四个词，说的全是「我们动过手没有」，而不是「用户能不能用」。
// sharp 那一格报的是 applied（@img/sharp-wasm32 确在依赖树内，见环境报告 §4.2），而 sharp 自己
// 取不到绑定、图片链路全灭 —— 把尺子的刻度当成了量出来的结果。判据拆出来后，供给表那一格
// 必须写明「什么算通」，CI 能逐条看见，改判据要改表，改动即暴露。
//
// 探针跑在**被检的那份 node** 的子进程里，不在本进程 require：一个坏的原生绑定可能直接
// abort 宿主（:node 一倒，面板与取证一起没了，而那正是我们要观察的现场）。
//
// 三态口径与设备自检/诊断一致（未知绝不算通过）：
//   true  —— 子进程退 0 **且** stdout 带通过标记
//   false —— 子进程跑起来了而判据不过（非零退出 / 没有标记）：能力是坏的
//   null  —— 探针没条件跑（缺 node 或包目录、spawn 直接失败、超时）或该格判据待做/不适用
// 分开 null 与 false 的理由：前者是「我们不知道」，后者是「它坏了」。混起来要么假绿（把
// 不知道说成正常），要么假红（把容器没交付说成 Agent 能力缺失），两种都会把人支去做错的事。

const ex = require('../../platform/exec');

/** 通过标记：判据脚本必须显式打出来。只退 0 不算通过 —— 脚本被改空、被截断都会退 0。 */
const PASS = 'DSH_PROBE_PASS';

/** 探针默认超时：设备 node 冷启动 + 一次 libvips wasm 初始化的量级，留足但不无限等。 */
const PROBE_TIMEOUT_MS = 30000;

/** spawn 层面的失败（不是被判据判红的）：这些 code/文案意味着探针根本没跑起来。 */
const NOT_RUNNABLE = /ENOENT|EACCES|EPERM|spawn/i;

/**
 * 跑一格能力判据。
 * @param {object} unit 供给表里的一格
 * @param {{nodeBin:string|null, packageDir:string|null}} ctx 被检运行时与「Agent 站在哪」
 * @param {{run?:Function, env?:object, timeoutMs?:number}} [deps] 测试注入通道
 * @returns {{id:string, ok:boolean|null, detail:string, at:string}}
 */
function probeUnit(unit, ctx, deps) {
  const d = deps || {};
  const run = d.run || ex.runDetail;
  const at = new Date().toISOString();
  const v = unit && unit.verify;
  if (!v) return out(unit.id, null, '该格没有能力判据（只有投放结局，不能当能力读）', at);
  if (v.notApplicable) return out(unit.id, null, '按处置无需核验：' + v.notApplicable, at);
  if (v.deferred) {
    return out(unit.id, null, '判据待做（' + v.deferred.followUp + '，' +
      v.deferred.expiresAt + ' 前）：' + (v.criterion || ''), at);
  }
  if (typeof v.node !== 'string' || !v.node.trim()) {
    return out(unit.id, null, '判据写法漂移：verify 既不是 notApplicable/deferred 也没有 node 脚本', at);
  }
  const nodeBin = ctx && ctx.nodeBin;
  const packageDir = ctx && ctx.packageDir;
  if (!nodeBin) return out(unit.id, null, '探针无法启动：契约没给出被检 node 的路径', at);
  if (!packageDir) return out(unit.id, null, '探针无法启动：不知道 Agent 装在哪（包目录未知）', at);

  // 恒带 --expose-internals：这不是探针的私有偏好，而是**照抄 dsh 的实际启动形态**
  // （guard/supervisor/main-process.js 的 _androidLaunchReady 在 node 与脚本入口之间注入它）。
  // 探针测的必须是「Agent 真会用的那种调用」，否则 require 内部模块那一格在探针里通、
  // 在真实启动里不通，两个结论各说各话。
  const args = ['--expose-internals', '-e', v.node];
  const r = run(nodeBin, args, {
    cwd: packageDir,
    env: d.env || process.env,
    timeoutMs: d.timeoutMs || PROBE_TIMEOUT_MS,
    encoding: 'utf8',
  });
  if (!r || typeof r.ok !== 'boolean') {
    return out(unit.id, null, '探针执行器返回了无法解读的结果（判据未能执行）', at);
  }
  const stdout = String(r.stdout || '').trim();
  const tail = (String(r.stderr || '').split('\n').filter(Boolean).pop() || stdout || '').slice(0, 200);
  if (!r.ok && r.timedOut) {
    return out(unit.id, null, '探针超时 ' + (d.timeoutMs || PROBE_TIMEOUT_MS) + 'ms 未返回（能力状态未知，不算通过）', at);
  }
  if (!r.ok && r.code === null && NOT_RUNNABLE.test(String(r.error || ''))) {
    return out(unit.id, null, '探针没能启动：' + tail, at);
  }
  if (!r.ok) return out(unit.id, false, '判据不通过（rc=' + r.code + '）：' + tail, at);
  if (stdout.indexOf(PASS) < 0) {
    return out(unit.id, false, '探针退 0 但没打通过标记（判据被改空也算这一类）：' + tail, at);
  }
  return out(unit.id, true, stdout.replace(PASS, '').trim() || '通过', at);
}

function out(id, ok, detail, at) {
  return { id, ok, detail: detail || null, at };
}

/** 跑一批（供给表的单元数组）。同步执行：每格一次有界子进程，调用方决定节奏。
 * 逐格隔离：某格的执行器抛错只把那一格记成未知，其余格的结论必须留着 ——
 * 整批交给外层 catch 会把「一格看不清」放大成「面板上一片空白」，那是第二种假绿。 */
function probeUnits(units, ctx, deps) {
  const res = {};
  for (const u of units || []) {
    try {
      res[u.id] = probeUnit(u, ctx, deps);
    } catch (e) {
      res[u.id] = out(u.id, null, '探针执行器抛错（该格结果未知，不算通过）: ' + e.message, new Date().toISOString());
    }
  }
  return res;
}

/** 三态汇总：与设备自检同一口径 —— 有红就是红，没红但有未知就不是「全通」。 */
function overall(caps) {
  const vals = Object.keys(caps || {}).map((k) => caps[k].ok);
  if (!vals.length) return null;
  if (vals.some((x) => x === false)) return false;
  if (vals.some((x) => x === null)) return null;
  return true;
}

module.exports = { PASS, PROBE_TIMEOUT_MS, probeUnit, probeUnits, overall };
