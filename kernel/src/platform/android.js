'use strict';

// Android 平台判定（唯一入口）
// 平台抽象层铁律（docs/components/kernel-android-plan.md）：域层不得直接碰 systemctl/launchctl/schtasks/
// notify-send/osascript/xdg-open；一切平台差异经 src/platform/os/* 收敛。本文件是「是否为安卓」
// 的唯一真源——安卓上 Node 的 process.platform === 'linux'、arch === 'arm64'，
// **与桌面 Linux 无法仅靠 process.platform 区分**，必须显式判定（不能只靠平台分支）。
//
// 安卓的「壳」= 冻结 APK 容器 / Android Service（容器层经 HostBridge 与内核通信），
// 不是桌面 Tauri 壳；因此自启/服务/桌面通知/远程控制全部归容器层 —— 内核侧不做占位也不做降级，
// 一律真删（无 platform/os/service.js、autostart.js、desktop.js，无 /autostart 与 /self-update/*）。
//
// 判定（构建期或运行期注入其一即可）：
// - process.env.DSH_ANDROID === '1' 运行期，容器启动内核时设置（推荐）
// - process.env.DSH_PLATFORM === 'android' 显式覆盖
// - process.env.ANDROID_ROOT !== undefined 安卓系统环境变量（/system 等存在）
const isAndroid = () => {
  try {
    if (process.env.DSH_ANDROID === '1') return true;
    if (process.env.DSH_PLATFORM === 'android') return true;
    if (process.env.ANDROID_ROOT !== undefined) return true;
  } catch {}
  return false;
};

module.exports = { isAndroid };
