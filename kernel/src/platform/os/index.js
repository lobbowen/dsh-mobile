'use strict';

// 平台抽象层（Android 内核）
//
// 原则：平台无关域（supervisor/domains/guard/api）**不得直接触碰平台 API**，
// 一律经本门面。
//
// Android-only（2026-09 重构）：本仓是**移动端内核仓**，已从 PC 监管器剥离。
// 桌面三端（linux 桌面 / darwin / win32）的能力与实现全部删除：
// · service（systemd/launchd/windows-service Provider 分派） → 已删（hostService 恒为 'none'）
// · autostart（XDG .desktop / systemd --user / launchctl / schtasks）→ 已删（自启归 APK 容器）
// · desktop（图形会话检测，原为桌面壳看护前置条件） → 已删（无桌面壳）
// 保留并经 Android 化的能力：
// · pidlookup / processControl / execPath / fileProtect —— Android 走 Linux（/proc、chmod）实现
// · notify / browser —— 桌面命令实现已删，现为 **HostBridge 占位**（见 docs/ANDROID-PLAN.md §6）
//
// 安卓判定唯一入口 = src/platform/android.js 的 isAndroid()（process.platform 在安卓仍是 'linux'，
// 无法靠平台分支区分桌面 Linux，必须显式判定）。

const os = require('node:os');
const path = require('node:path');

const PLATFORM = process.platform;
const ARCH = process.arch;

/** DSH 数据目录：~/.dsh（**被管控对象**的数据；不属于本产品状态）。 */
function dataDir() {
  return path.join(os.homedir(), require('../agent').load().homeDirName);
}

/** 本产品状态目录（**独立于 DSH**）。
 * 单一事实源 = platform/state-root.js（覆盖 DSH_SUPERVISOR_HOME）。 */
function supervisorDir() {
  return require('../state-root').supervisorDir();
}

/**
 * 平台能力档位（Android 固定档位）。
 *
 * 原为「三平台静态档位 × hasTool 实测覆写」两层；Android-only 后**不再探测 PC 工具**
 * （systemd-run / notify-send / systemctl / schtasks / taskkill），直接返回安卓档位：
 * · 多实例 / 进程树 kill / 远程暴露 —— 安卓不支持（multiInstance/processTreeKill/frpExpose=false）
 * · 自启 / 服务 / 通知 —— 归 APK 容器与 HostBridge（autostart/hostService=none、desktopNotify=false）
 *
 * @param platform 可选（保留签名兼容；Android 内核恒返回安卓档位）
 * @param arch 可选
 */
function capabilityProfile(platform, arch) {
  return {
    platform: platform || PLATFORM,
    arch: arch || ARCH,
    multiInstance: false,     // 无沙箱实例域（无 systemd-run）
    pidAdoption: true,        // /proc 可读，PID 解析仍可用
    processTreeKill: false,   // 进程树由容器 / Android Service 管理
    desktopNotify: false,     // 通知经容器层 HostBridge 下发，内核无通知通道
    autostart: false,         // 自启归 APK 容器 / Android Service
    frpExpose: false,         // 远程控制域（relay/frpc）已删
    hostService: 'none',      // 无 systemd/launchd/windows-service
  };
}

/** 平台能力矩阵 = Android 档位（无 PC 工具探测）。供面板做能力感知呈现。 */
function capabilities() {
  return capabilityProfile();
}

module.exports = {
  PLATFORM, ARCH,
  dataDir, supervisorDir, capabilities, capabilityProfile,
  processControl: require('./process'),
  pidlookup: require('./pidlookup'),
  // 跨平台可执行解析与文件保护（Android 走 Unix 路径：chmod）
  execPath: require('./exec-path'),
  fileProtect: require('./file-protect'),
  // notify 为直接可调函数（supervisor.notify 按 platform.notify(title, body, onError) 调用），
  // 不能导出模块对象——否则通知路径报 platform.notify is not a function。
  // Android：桌面命令实现已删，当前为 HostBridge 占位（no-op，见 notify.js）。
  notify: require('./notify').notify,
  browser: require('./browser'),
};
