'use strict';

// 浏览器打开：Android-only 内核下经 **HostBridge** 承担（容器层 ACTION_VIEW Intent）。
//
// 内核跑在安卓容器（L0）里：没有桌面浏览器二进制、没有 XDG / 显示服务，
// 因此「拉起外部浏览器」只能由 HostBridge 侧的安卓 Intent（ACTION_VIEW）承担 —— 桥方法 `app.openUrl`。
//
//   · open(url)           → 桥可用时经 app.openUrl 异步打开，返回 true；桥不可用 false
//   · launchIsolated(..)  → 桥可用且打开成功时 { ok:true, bin:null, isolated:false }；
//                            否则 { ok:false, bin:null, isolated:false }（调用方走「无可用浏览器」分支）
//
// ⚠ 已删除的 PC 遗留（勿回潮）：xdg-open / open -na / cmd start 命令拼装、
//    Chrome 隔离 profile 候选链（microsoft-edge / chrome / chromium / firefox）、
//    X11/Wayland/D-Bus 图形环境变量注入。安卓上这些全部不成立。

const hostBridge = require('../host-bridge/client');

/** 打开 URL。桥可用时异步经 app.openUrl 打开。
 *  @returns {boolean} true = 已发起打开；false = 桥不可用/未打开 */
function open(url) {
  try {
    if (!hostBridge.inContainer()) return false;
    hostBridge.client().call('app.openUrl', { url: String(url) }).catch(() => {});
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * 以隔离 profile + 无痕打开浏览器（OAuth 反指纹登录用）。
 *
 * 安卓容器内不存在可隔离的桌面浏览器：隔离语义由容器决定（可能是系统浏览器或容器内置 WebView），
 * 内核无从保证「无痕 + 独立 profile」。故**不宣称隔离**：isolated 恒为 false，
 * 仅当桥可用且已发起打开时 ok=true —— 调用方据 isolated=false 走非隔离分支。
 * @param {string} url
 * @param {{profileDir?:string, antiArgs?:string[], antiEnv?:object, sysEnv?:object, onExit?:Function}} [o]
 * @returns {{ok:boolean, bin:string|null, isolated:boolean}}
 */
function launchIsolated(url, o) {
  const started = open(url);
  return { ok: started, bin: null, isolated: false };
}

module.exports = { open, launchIsolated };
