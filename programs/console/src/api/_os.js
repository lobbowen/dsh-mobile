'use strict';

// 面板 → OS 原生能力 API 的统一调用助手（单一实现，各域共用）。
//
// 不变量：桥不可用/超时（panel.call 返回 null）→ 明确 503 + OS_OFFLINE 错误码，
// 绝不把「没有 OS」伪装成正常状态。协议错误（{ok:false,error}）→ 502。

const OFFLINE = {
  ok: false,
  code: 'OS_OFFLINE',
  error: 'OS 原生能力 API 未接线（接口清单见 docs/components/console-system-api.md）',
};

function unavailable(send, code) {
  return send(code || 503, OFFLINE);
}

/**
 * 调用一个 OS 能力方法并应答。
 * @param {(code:number, obj:object)=>void} send
 * @param {object} panel
 * @param {string} method
 * @param {object} [params]
 * @param {object} [opts] { offlineCode, errCode, wrap(result), offlineBody }
 */
async function call(send, panel, method, params, opts) {
  const o = opts || {};
  const r = await panel.call(method, params || {});
  if (!r) return send(o.offlineCode || 503, o.offlineBody ? Object.assign({ ok: false, code: 'OS_OFFLINE' }, o.offlineBody) : OFFLINE);
  if (r.ok === false) {
    return send(o.errCode || 502, { ok: false, error: (r.error && r.error.message) || 'OS 调用失败', code: (r.error && r.error.code) || null });
  }
  return send(200, o.wrap ? o.wrap(r.result || {}) : Object.assign({ ok: true }, r.result || {}));
}

module.exports = { OFFLINE, unavailable, call };

