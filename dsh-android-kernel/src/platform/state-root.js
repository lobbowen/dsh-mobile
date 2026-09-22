'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 产品状态根（**与 DSH 的 ~/.dsh 完全独立**）—— Android-only
//
// ## 为什么独立
//
//   我们是「管控 Agent 的内核」，却把全部状态（config/state/ports/logs/events）
//   放在**被管控对象** DSH 的数据目录下 → 概念错位：DSH 卸载/清理/迁移数据目录时会把我们一并带走。
//
// ## 安卓下的落点（覆盖优先级）
//
//   · DSH_SUPERVISOR_HOME          容器启动内核时注入（测试/特殊部署同此）
//   · $XDG_STATE_HOME/dsh-supervisor
//   · ~/.local/state/dsh-supervisor （安卓容器的 HOME 即应用数据目录，可直接落在其下）
//
//   目录：<root>/supervisor（内核状态）。
//   DSH **自身**的数据（~/.dsh/profiles、DSH_HOME）不在此列 —— 那是被管控对象的数据。
//
// ## 单一事实源
//
//   本模块是内核侧唯一入口；容器（安卓壳）侧经同一 env 约定对接，由 runtime.json 契约握手锁定。
//
// ⚠ 已删除的 PC 遗留（勿回潮）：
//   · Windows %LOCALAPPDATA%\dsh-supervisor、macOS ~/Library/Application Support/dsh-supervisor
//   · 桌面壳状态目录 shellDir()（identity/mirrors/shell.log）—— 桌面壳已删
//   · migrateLegacy()：从 ~/.dsh/supervisor 的一次性迁移 —— 本仓是全新安卓内核仓，
//     不存在需要从 PC 布局迁移的存量数据。
// ═══════════════════════════════════════════════════════════════════════════

const os = require('node:os');
const path = require('node:path');

/** 契约 schema（与容器侧握手；门禁锁定）。 */
const SCHEMA = 1;

/** 产品状态根（绝对路径）。 */
function root() {
  const override = process.env.DSH_SUPERVISOR_HOME;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  const xdg = process.env.XDG_STATE_HOME;
  return xdg && String(xdg).trim()
    ? path.join(String(xdg).trim(), 'dsh-supervisor')
    : path.join(os.homedir(), '.local', 'state', 'dsh-supervisor');
}

/** 内核状态目录（config/state/ports/logs/events/契约）。 */
function supervisorDir() {
  return path.join(root(), 'supervisor');
}

module.exports = { SCHEMA, root, supervisorDir };
