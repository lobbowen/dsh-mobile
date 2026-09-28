'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Lob OS 控制面板状态根（与任何载荷的数据目录完全独立）
//
// 面板是一个普通 Program：它自己的偏好/缓存只能落在自己的状态根，绝不与被
// 管理的 Program 数据混放。载荷（agent Program）的数据目录由 OS 供给，不在此处。
//
// 覆盖优先级：
//   · LOBOS_PANEL_HOME 容器/OS 启动面板时注入（测试/特殊部署同此）
//   · $XDG_STATE_HOME/lobos-panel
//   · ~/.local/state/lobos-panel （安卓容器的 HOME 即应用数据目录）
//
// 目录：<root>/panel（面板偏好 / 市场缓存 / 日志）。
// ═══════════════════════════════════════════════════════════════════════════

const os = require('node:os');
const path = require('node:path');

/** 契约 schema（与 OS 侧握手；门禁锁定）。 */
const SCHEMA = 1;

/** 面板状态根（绝对路径）。 */
function root() {
  const override = process.env.LOBOS_PANEL_HOME;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  const xdg = process.env.XDG_STATE_HOME;
  return xdg && String(xdg).trim()
    ? path.join(String(xdg).trim(), 'lobos-panel')
    : path.join(os.homedir(), '.local', 'state', 'lobos-panel');
}

/** 面板状态目录（config/settings/market/log）。 */
function stateDir() {
  return path.join(root(), 'panel');
}

module.exports = { SCHEMA, root, stateDir };

