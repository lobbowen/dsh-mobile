/**
 * 容器宿主帧逻辑（内核同源托管于 /__host；外链以满足 CSP script-src 'self'）。
 *
 * 职责（单写入者契约下，宿主只「应答」，不提供任何内核写端点）：
 *   1. 接收内核面板 iframe 经 postMessage 发来的 `dsh:kernel-update-request`；
 *   2. 转交安卓原生层（WebView 注入的 `window.DshNative.onRequest`）——
 *      由容器 OTA 执行真正的内核包安装（唯一写入者）；
 *   3. 原生处理完经 `dshDeliverResult(json)` 回灌，宿主把
 *      `dsh:kernel-update-result` 投递回面板 iframe。
 *
 * 协议版本须与内核 `ui/src/services/supervisor/kernelUpdateBridge.ts` 的
 * `BRIDGE_PROTOCOL_VERSION` 一致（当前 = 1）。字段：
 *   request : { v, type:"dsh:kernel-update-request", requestId }
 *   result  : { v, type:"dsh:kernel-update-result", requestId, ok,
 *               stage?, version?, restartUncertain?, error? }
 */
(function () {
  'use strict';

  var PROTOCOL_VERSION = 1;
  var REQUEST = 'dsh:kernel-update-request';

  function kernelFrame() {
    return document.getElementById('kernel');
  }

  // 面板 → 宿主：转发更新请求给原生层。
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type !== REQUEST) return;
    // 仅接受来自内核面板 iframe 的消息（同源，宿主只嵌一个帧）。
    var f = kernelFrame();
    if (f && e.source && e.source !== f.contentWindow) return;
    try {
      if (window.DshNative && typeof window.DshNative.onRequest === 'function') {
        window.DshNative.onRequest(JSON.stringify({
          v: PROTOCOL_VERSION,
          type: REQUEST,
          requestId: d.requestId || null
        }));
      }
    } catch (err) { /* 原生层不可用：静默（面板侧会超时并有明确报错） */ }
  });

  // 原生 → 面板：把 `dsh:kernel-update-result` 回灌到面板 iframe。
  // 由原生层经 evaluateJavascript("dshDeliverResult(<json>)") 调用。
  window.dshDeliverResult = function (json) {
    try {
      var msg = typeof json === 'string' ? JSON.parse(json) : json;
      var f = kernelFrame();
      if (f && f.contentWindow) f.contentWindow.postMessage(msg, '*');
    } catch (err) { /* 忽略解析错误 */ }
  };
})();
