'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 显式意图登记簿（IntentLedger）—— RC2 结构性修复核心。
//
// 问题背景（审计 P1-1/P1-3/P1-4 共同根因）：
// 用户/系统的"显式动作"（点启动、点重启、执行升级、退出管家）过去靠
// `_explicitAction` 布尔时间窗 + 异步竞态表达——动作发生时置位、下一拍消费、
// 或干脆依赖 process.exit 前的碰运气执行。三个 P1 都是这一结构缺陷的投影。
//
// 结构语义：
// - 意图是**一等公民状态**：动作发生处 register，意图消费处 consume，
// 两者通过词表强约束（不存在"忘了消费"的悬空意图——consume 仅在收敛点调用）；
// - 一次性语义：consume 即清除；同意图重复 register 覆盖（最新意图权威）；
// - 无时间窗：意图不因拍数流逝而失效——守卫收敛循环兜底保证最终消费
// （与旧 `_explicitAction` 的"下一拍清零"相比，消除了"拍间隔漏消费"类竞态）。
//
// 词表（INTENTS，收敛循环消费的完整集合；新增动作必须显式扩展词表）：
// start 用户点"启动 DSH"——穿透守护开关拉起一次
// restart 用户点"重启"——真重启（停旧拉新，不计崩溃）
// upgrade-resume 升级完成后恢复运行——升级本身即用户显式意图
//
// 定位（阶段 2 意图单源，契约（docs/ANDROID-PLAN.md） §6）：
// 本登记簿是**瞬态加速器**（同一次运行内的即时动作），**不是**恢复依据。
// 「是否应运行」的持久权威是 desired（managed-objects.json）——守卫重启后由 desired 恢复，
// 绝不依赖本登记簿（内存态、重启即空）。任何「靠意图解锁首次拉起」的逻辑都是错误的
// （已由 desired 无条件拉起取代）。
// ═══════════════════════════════════════════════════════════════════════════

const INTENTS = ['start', 'restart', 'upgrade-resume'];

class IntentLedger {
  constructor() {
    this._pending = new Map(); // intent -> payload（最新意图权威）
  }

  /** 登记一次显式意图。intent 必须在词表内；payload 可选（消费时取回）。 */
  register(intent, payload) {
    if (!INTENTS.includes(intent)) throw new Error('未知意图: ' + intent + '（词表: ' + INTENTS.join(',') + '）');
    this._pending.set(intent, payload === undefined ? null : payload);
    return this;
  }

  /** 消费一次意图：存在 → 返回 payload 并清除；不存在 → 返回 undefined。 */
  consume(intent) {
    const p = this._pending.get(intent);
    if (this._pending.has(intent)) this._pending.delete(intent);
    return p;
  }

  /** 非破坏性查询：某意图是否待消费（收敛循环决策用）。 */
  has(intent) {
    return this._pending.has(intent);
  }

  /** 是否存在任一待消费意图（守护 gate 的"显式动作穿透"判定）。 */
  any() {
    return this._pending.size > 0;
  }

  /** 清空全部（仅测试/守卫 shutdown 用）。 */
  clear() {
    this._pending.clear();
  }
}

module.exports = { IntentLedger, INTENTS };
