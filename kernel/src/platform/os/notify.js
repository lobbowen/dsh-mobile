'use strict';

// Android 内核通知 —— 经 **HostBridge** 下发（容器层 NotificationManager）。
//
// 原 PC 三端实现（Linux notify-send / macOS osascript / Windows PowerShell 气泡）已随桌面端删除：
// 安卓无桌面通知机制，通知经**容器层 HostBridge**（NotificationManager 通道）下发，
// 见 docs/ANDROID-PLAN.md §5.2 / §6。
//
// 桥可用（容器内且 HostBridge 在听）→ 经 `notif.post` 派发，返回 true。
// 桥不可用（不在容器内 / socket 未就绪 / 调用失败）→ 静默返回 false。
//
// 为什么**不**调用 onError：调用方（supervisor.notify）的 onError 会「停用通知 + 打 warn 日志」，
// 而「平台不支持 / 桥暂不可用」不是故障 —— 与原实现 notifyCommand 返回 null 时的语义一致（静默不派发）。
// 桥调用为**异步**，本函数保持同步签名（返回是否已发起派发），派发结果不影响内核主流程。

const hostBridge = require('../host-bridge/client');

/** 通知命令构造。**Android 恒为 null**（无本地命令行通知，派发经 HostBridge）。 */
function notifyCommand() {
  return null;
}

/** 通知（最佳努力）：桥可用时异步经 notif.post 派发。
 * @returns {boolean} true = 已发起派发；false = 桥不可用/未派发 */
function notify(title, body, onError) {
  try {
    if (!hostBridge.inContainer()) return false;
    const c = hostBridge.client();
    c.call('notif.post', { title: String(title == null ? '' : title), text: String(body == null ? '' : body) })
      .catch(() => {});
    return true;
  } catch (_e) {
    return false;
  }
}

module.exports = { notify, notifyCommand };
