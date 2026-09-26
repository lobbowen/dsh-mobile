'use strict';

// 运行时契约 runtime.json（容器写、内核读）。对齐内核 src/platform/runtime-contract.js。
// 内核启动前由容器写入 <DSH_SUPERVISOR_HOME>/supervisor/runtime.json。

const fs = require('fs');
const path = require('path');

// 与内核 SUPPORTED_SCHEMA 一致（见 runtime-contract.js:25）。
const SCHEMA = 2;

function runtimeJsonPath(home) {
  return path.join(home, 'supervisor', 'runtime.json');
}

/**
 * 写入 runtime.json。
 * @param {object} o { home, nodePath, nodeBinDir, npmPath, npmEntry?, prefix?, minNode?, writtenBy? }
 *   npmEntry = npm-cli.js 绝对路径；内核以 [nodePath, npmEntry, ...npmArgs] 形态代跑
 *   （npm 是纯 JS，调用通路只有"交给 node"这一条）。
 *   prefix = $PREFIX 根（能力件真名的家：bin/{bash,rg,node}、lib/pty.node）。内核的
 *   原生件投放单元以它为唯一取件路径 —— 曾以 process.env.PREFIX 为门控而容器从未导出，
 *   真机上表现为 glob/grep 全灭且零日志（2026-09-26 定罪）。
 *   刻意保持 schema=2 的增量字段：OTA 下来的旧内核读未知字段会忽略，
 *   bump schema 反而让它们直接拒读契约（新 APK + 旧内核是常态）。
 * @returns {object} 写入的对象
 */
function writeRuntimeJson({ home, nodePath, nodeBinDir, npmPath, npmEntry, prefix, minNode, writtenBy }) {
  const dir = path.join(home, 'supervisor');
  fs.mkdirSync(dir, { recursive: true });
  const obj = {
    schema: SCHEMA,
    nodePath,
    nodeBinDir,
    npmPath,
    ...(npmEntry ? { npmEntry } : {}),
    ...(prefix ? { prefix } : {}),
    minNode: minNode || 'v24.12.0',
    writtenBy: writtenBy || 'android-node-container',
  };
  fs.writeFileSync(runtimeJsonPath(home), JSON.stringify(obj, null, 2), { mode: 0o600 });
  return obj;
}

function readRuntimeJson(home) {
  const p = runtimeJsonPath(home);
  if (!fs.existsSync(p)) return null;
  const o = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (o.schema !== SCHEMA) throw new Error('runtime.json schema 不匹配：期望 ' + SCHEMA + ' 实际 ' + o.schema);
  return o;
}

module.exports = { SCHEMA, runtimeJsonPath, writeRuntimeJson, readRuntimeJson };
