'use strict';

// 领域：守护（guardian）——开了 monitor(进程守护) 开关且目标挂了 → 决定自动拉起。
// 统一对原生与沙箱实例适用；默认关：实例未开「进程守护」开关，则绝不自动拉起。
// 本模块只做「决策/策略计算」，不触碰任何进程/实例/系统服务——守卫与实例生命周期彻底分离。
// 纯函数：输入观测/状态 → 输出决策。

/** 该目标是否开启「进程守护」开关（默认关：未显式 guardian===true 则绝不拉起）。 */
function shouldGuard(inst) {
  return !!(inst && inst.guardian === true);
}

/** 崩溃窗口 + 退避决策。
 *  @param cw  { start:number|null, restarts:number }
 *  @param now number
 *  @param cfg { crashWindowMs, crashBurst, backoff:number[], backoffLevel:number }
 *  @returns { start, restarts, backoffLevel, backoffUntil, backoffEntered } */
function bumpCrashWindow(cw, now, cfg) {
  let start = cw.start;
  let restarts = cw.restarts;
  if (start === null || now - start > cfg.crashWindowMs) {
    start = now;
    restarts = 1;
  } else {
    restarts += 1;
  }
  if (restarts >= cfg.crashBurst) {
    const level = Math.min((cfg.backoffLevel || 0) + 1, cfg.backoff.length - 1);
    return { start, restarts, backoffLevel: level, backoffUntil: now + cfg.backoff[level], backoffEntered: true };
  }
  return { start, restarts, backoffLevel: cfg.backoffLevel || 0, backoffUntil: null, backoffEntered: false };
}

/** 实例重启等待决策（简单线性退避）。
 *  @param state { lastFailAt?:number, backoffLevel?:number }
 *  @param now number
 *  @returns { waitMs:number, nextBackoffLevel:number } */
function instanceRestartDecision(state, now) {
  const crashesQuickly = !!(state.lastFailAt && now - state.lastFailAt < 60000);
  return {
    waitMs: crashesQuickly ? Math.min(60000, 5000 * ((state.backoffLevel || 0) + 1)) : 0,
    nextBackoffLevel: (state.backoffLevel || 0) + 1,
  };
}

module.exports = { shouldGuard, bumpCrashWindow, instanceRestartDecision };
