'use strict';

// 工作流文件读取（**行尾归一化**，跨平台一致）。
//
// 为什么需要它（真实 Windows CI 事故，2026-09-11）：
// Windows runner 的 git 检出会把 build.yml 转成 CRLF（core.autocrlf）。
// 测试里用 `\n` 锚定的正则（如 `/\n ([a-z]+):\n/` 提取 job 段）在 CRLF 下**完全失配**
// —— 因为 job 名后紧跟的是 `\r` 而非 `\n`。
// 结果：断言取到空串 → 5 个断言失败；而同一份代码在 Linux/macOS（LF）全绿。
// 表现为「只在 Windows 红」，极难排查（本次排查耗时较长即因此）。
//
// 因此：凡要按行解析 workflow 的测试**必须**经本模块读取，禁止直接 fs.readFileSync。
// 由 test/workflow-parse-test.js 门禁强制（含 CRLF 夹具实测）。

const fs = require('node:fs');
const path = require('node:path');

/** 行尾归一化：CRLF / CR → LF。所有下游正则因此只需处理 `\n`。 */
function normalize(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

/** 读取仓库内文件并归一化行尾（相对仓库根）。 */
function readNormalized(relPath, root) {
  const base = root || path.join(__dirname, '..');
  return normalize(fs.readFileSync(path.join(base, relPath), 'utf8'));
}

/** 读取 .github/workflows 下的 workflow（行尾归一化）。 */
function readWorkflow(name, root) {
  return readNormalized(path.join('.github', 'workflows', name), root);
}

/** 去掉整行注释（用于「只看可执行内容」的断言）。 */
function stripComments(text) {
  return normalize(text).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

/**
 * 按 job 名提取该 job 的文本段（行尾无关）。
 *
 * YAML 顶层 job 缩进 2 空格，其子键缩进 4+ 空格，故 `\n <name>:\n` 只命中顶层 job。
 * 入参 text 会先做行尾归一化，因此在 CRLF 检出下同样正确。
 */
function jobSection(text, name) {
  for (const [n, body] of jobsOf(text)) if (n === name) return body;
  return '';
}

/**
 * 列出 workflow 的全部 job（`[[名, 正文]]`，注释已剥、行尾归一）。
 * 判据要扫「每一个 job」时必须走这里，别在调用方再抄一遍切分正则 —— 那是第二把尺子。
 */
function jobsOf(text) {
  const parts = stripComments(text).split(/\n  ([a-z][a-z0-9_-]*):\n/);
  const out = [];
  // split 带捕获组 → [前置, 名1, 体1, 名2, 体2, ...]
  for (let i = 1; i < parts.length; i += 2) out.push([parts[i], parts[i + 1] || '']);
  return out;
}

module.exports = { normalize, readNormalized, readWorkflow, stripComments, jobSection, jobsOf };
