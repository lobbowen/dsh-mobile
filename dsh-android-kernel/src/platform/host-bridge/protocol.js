'use strict';

// HostBridge 协议常量与编解码（内核侧）。
//
// 本文件是容器侧 `container-engine/src/bridge/protocol.js` 的**内核镜像**：两仓独立，
// 但协议必须逐字节一致（PROTOCOL_VERSION / 错误码 / 帧字段）。任一侧语义变更须同步递增
// PROTOCOL_VERSION（与 ui/src/services/supervisor/kernelUpdateBridge.ts 的 BRIDGE_PROTOCOL_VERSION 同源）。

const PROTOCOL_VERSION = 1;

// 错误码（BRIDGE_PROTOCOL §5）：标准 JSON-RPC 区间 + 桥自定义区间（-32000 起）。
const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  ERR_RUNTIME: -32000,
  ERR_CAPABILITY_MISSING: -32001,
  ERR_TIMEOUT: -32002,
};

function request(id, method, params) {
  return { jsonrpc: '2.0', id, method, params: params || {} };
}
function response(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function error(id, code, message, data) {
  const e = { jsonrpc: '2.0', id, error: { code, message } };
  if (data !== undefined) e.error.data = data;
  return e;
}
function notification(method, params) {
  return { jsonrpc: '2.0', method, params: params || {} };
}

/** 握手：内核连接后主动发 bridge.handshake{ protocol, requires }。 */
function handshakeRequest(id, requires) {
  return request(id, 'bridge.handshake', { protocol: PROTOCOL_VERSION, requires: requires || [] });
}

/** 协商能力：requires（bridge:* 组令牌）与容器实际可用分组的交集/差集。 */
function negotiateGroups(requires, availableGroups) {
  const granted = (requires || []).filter((r) => availableGroups.includes(r));
  const missing = (requires || []).filter((r) => !availableGroups.includes(r));
  return { granted, missing };
}

module.exports = {
  PROTOCOL_VERSION,
  ERROR_CODES,
  request,
  response,
  error,
  notification,
  handshakeRequest,
  negotiateGroups,
};
