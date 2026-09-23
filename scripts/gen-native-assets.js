#!/usr/bin/env node
'use strict';
// 从 NativeAssetRegistry.kt（唯一事实来源）生成 .github/native-assets.txt。
// CI 运行本脚本后执行 `git diff --exit-code`；本地不得执行（见 docs/runbook/testing-standard.md）。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY = path.join(ROOT, 'container/app/src/main/java/io/github/lobbowen/dshmobile/native/NativeAssetRegistry.kt');
const OUT = path.join(ROOT, '.github/native-assets.txt');

function stripKotlinComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
function parseRegistry(src) {
  const body = stripKotlinComments(src);
  const out = [];
  const re = /val\s+(\w+)\s*=\s*NativeExecutable\s*\(/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const varName = m[1];
    let i = re.lastIndex - 1, depth = 0, end = -1;
    for (; i < body.length; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    const a = body.slice(re.lastIndex, end);
    const str = (f) => { const mm = new RegExp('\\b' + f + '\\s*=\\s*"([^"]*)"').exec(a); return mm ? mm[1] : null; };
    const list = (f) => {
      const mm = new RegExp('\\b' + f + '\\s*=\\s*(?:listOf|emptyList)\\s*\\(([^)]*)\\)').exec(a);
      if (!mm) return [];
      return mm[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^"|"$/g, ''));
    };
    out.push({ varName, libName: str('libName'), requiredDeps: list('requiredDeps') });
  }
  return out;
}

const src = fs.readFileSync(REGISTRY, 'utf8');
const assets = parseRegistry(src);
const allMatch = /val\s+ALL\s*:\s*List<NativeExecutable>\s+get\(\)\s*=\s*listOf\(([^)]*)\)/.exec(stripKotlinComments(src));
if (!allMatch) throw new Error('无法从注册表解析 ALL 列表');
const byVar = new Map(assets.map((a) => [a.varName, a]));
const all = allMatch[1].split(',').map((s) => s.trim()).filter(Boolean).map((v) => byVar.get(v)).filter(Boolean);
const deps = [...new Set(all.flatMap((a) => a.requiredDeps))];
const execs = all.map((a) => a.libName).filter((n) => !deps.includes(n));

const lines = [
  '# 随包原生资产清单 —— 由 CI 与构建脚本共同读取',
  '#',
  '# ⚠ 本文件由 scripts/gen-native-assets.js 生成，**请勿手改**。',
  '#   来源：container/app/src/main/java/io/github/lobbowen/dshmobile/native/NativeAssetRegistry.kt',
  '#   CI 会运行生成器并 `git diff --exit-code` 校验。',
  '#',
  '# 格式：每行一个文件名（不含 lib/<abi>/ 前缀），空行与 # 开头的行忽略。',
  '# --- 依赖库（DT_NEEDED，必须与可执行资产同目录）---',
  ...deps,
  '# --- 可执行资产本体 ---',
  ...execs,
  '',
];
fs.writeFileSync(OUT, lines.join('\n'));
console.log('generated .github/native-assets.txt: deps=[' + deps.join(',') + '] execs=[' + execs.join(',') + ']');
