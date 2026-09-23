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
 * @param {object} o { home, nodePath, nodeBinDir, npmPath, npmEntry?, minNode?, writtenBy? }
 *   npmEntry = npm-cli.js 绝对路径（容器内嵌 npm 时投放）；内核以
 *   [nodePath, npmEntry, ...npmArgs] 形态代跑 —— W^X 下 npm 不可能被直接 exec。
 *   刻意保持 schema=2 的增量字段：OTA 下来的旧内核读未知字段会忽略，
 *   bump schema 反而让它们直接拒读契约（新 APK + 旧内核是常态）。
 * @returns {object} 写入的对象
 */
function writeRuntimeJson({ home, nodePath, nodeBinDir, npmPath, npmEntry, minNode, writtenBy }) {
  const dir = path.join(home, 'supervisor');
  fs.mkdirSync(dir, { recursive: true });
  const obj = {
    schema: SCHEMA,
    nodePath,
    nodeBinDir,
    npmPath,
    ...(npmEntry ? { npmEntry } : {}),
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
