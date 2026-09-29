'use strict';

// 运行时契约 runtime.json（原生写、Program 读）。写读两侧都归原生（债 C3）。
// 运行时启动前由原生写入 <LOBOS_SUPERVISOR_HOME>/supervisor/runtime.json。

const fs = require('fs');
const path = require('path');

// 与内核 SUPPORTED_SCHEMA 一致（见 runtime-contract.js:25）。
const SCHEMA = 2;

function runtimeJsonPath(home) {
  return path.join(home, 'supervisor', 'runtime.json');
}

/**
 * 写入 runtime.json。
 * @param {object} o { home, nodePath, nodeBinDir, prefix?, minNode?, writtenBy? }
 *   prefix = $PREFIX 根（能力件真名的家：bin/{bash,rg,node}、lib/pty.node）。内核的
 *   原生件投放单元以它为唯一取件路径 —— 曾以 process.env.PREFIX 为门控而容器从未导出，
 *   真机上表现为 glob/grep 全灭且零日志（2026-09-26 定罪）。
 *   刻意保持 schema=2 的增量字段：OTA 下来的旧内核读未知字段会忽略，
 *   bump schema 反而让它们直接拒读契约（新 APK + 旧内核是常态）。
 *   npm 不再有键：`npmPath` 的取值就是 nodePath 的字面，`npmEntry` 是宿主代跑形状
 *   （真机 2026-09-30 现读装机 Program 全文零命中）。npm 与 git/curl 同级走 C 清单，
 *   落位后按裸名从 PATH 兑现 —— 交付契约里不描述「npm 住在哪」，只描述树根与 $PREFIX。
 * @returns {object} 写入的对象
 */
function writeRuntimeJson({ home, nodePath, nodeBinDir, prefix, minNode, writtenBy }) {
  const dir = path.join(home, 'supervisor');
  fs.mkdirSync(dir, { recursive: true });
  const obj = {
    schema: SCHEMA,
    nodePath,
    nodeBinDir,
    ...(prefix ? { prefix } : {}),
    minNode: minNode || 'v24.12.0',
    writtenBy: writtenBy || 'lobos-os',
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
