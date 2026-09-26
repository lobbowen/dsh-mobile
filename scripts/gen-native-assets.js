#!/usr/bin/env node
'use strict';
// 从 NativeAssetRegistry.kt（唯一事实来源）生成 .github/native-assets.txt。
// CI 运行本脚本后执行 `git diff --exit-code`；本地不得执行（见 docs/standards/testing.md）。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY = path.join(ROOT, 'container/app/src/main/java/io/github/lobbowen/dshmobile/native/NativeAssetRegistry.kt');
const OUT = path.join(ROOT, '.github/native-assets.txt');
const OUT_CAPS = path.join(ROOT, '.github/native-capabilities.txt');

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

/** 解析 CAPABILITY 里的**内联** NativeExecutable(...)（它们没有 `val X =` 前缀）。 */
function parseCapability(src) {
  const body = stripKotlinComments(src);
  const m = /val\s+CAPABILITY\s*:\s*List<NativeExecutable>\s+get\(\)\s*=\s*listOf\(/.exec(body);
  if (!m) throw new Error('无法从注册表解析 CAPABILITY 列表');
  let i = m.index + m[0].length, depth = 1, end = -1;
  for (; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('CAPABILITY 括号不配平');
  const inner = body.slice(m.index + m[0].length, end);
  const out = [];
  const re = /NativeExecutable\s*\(/g;
  let mm;
  while ((mm = re.exec(inner)) !== null) {
    let j = mm.index + mm[0].length, d = 1, e = -1;
    for (; j < inner.length; j++) {
      if (inner[j] === '(') d++;
      else if (inner[j] === ')') { d--; if (d === 0) { e = j; break; } }
    }
    if (e < 0) continue;
    const a = inner.slice(mm.index + mm[0].length, e);
    const str = (f) => { const x = new RegExp('\\b' + f + '\\s*=\\s*"([^"]*)"').exec(a); return x ? x[1] : null; };
    out.push({ id: str('id'), libName: str('libName'), tier: str('buildTier') || 'self-c' });
    re.lastIndex = e;
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

// ── 小件能力件清单（CAPABILITY + 注册表外的 node-pty）──
// node-pty 刻意**不**进注册表：它不是 NativeExecutable（由 node-gyp 编成 .node 再改名投
// jniLibs），进注册表会把它纳入 NativePreparer 探针与 native-assets 投影。故在此单点声明。
const EXTRA_CAPS = [{ id: 'node-pty', libName: 'libdshpty.so', tier: 'soft' }];
const caps = [...parseCapability(src), ...EXTRA_CAPS];
const TIER_ORDER = ['self-c', 'upstream', 'soft'];
const TIER_DESC = {
  'self-c': '自有 C，NDK 现编 —— 编不出来即环境问题 ⇒ 缺件硬红',
  upstream: '上游源码配方 —— $PREFIX 依赖它且无回退 ⇒ 缺件硬红',
  soft: '上游配方有不确定性 —— 缺件只降级（不判红），不陪葬其它能力',
};
const capLines = [
  '# 小体积原生能力件清单 —— 由构建 / 打包审计脚本与测试共同读取',
  '#',
  '# ⚠ 本文件由 scripts/gen-native-assets.js 生成，**请勿手改**。',
  '#   来源：container/app/src/main/java/io/github/lobbowen/dshmobile/native/NativeAssetRegistry.kt',
  '#        的 CAPABILITY（外加注册表外的 node-pty，见生成器内的说明）。',
  '#   CI 会运行生成器并 `git diff --exit-code` 校验。',
  '#',
  '# 格式：<档位> <libName> <id>；空行与 # 开头的行忽略。',
  '# 档位 = NativeExecutable.buildTier：',
  ...TIER_ORDER.map((t) => '#   ' + t.padEnd(9) + ' ' + TIER_DESC[t]),
  '',
];
for (const t of TIER_ORDER) {
  const group = caps.filter((c) => c.tier === t);
  if (!group.length) continue;
  capLines.push('# --- ' + t + ' ---');
  for (const c of group) capLines.push([t, c.libName, c.id].join(' '));
}
capLines.push('');
fs.writeFileSync(OUT_CAPS, capLines.join('\n'));
console.log('generated .github/native-assets.txt: deps=[' + deps.join(',') + '] execs=[' + execs.join(',') + ']');
console.log('generated .github/native-capabilities.txt: ' + caps.map((c) => c.tier + ':' + c.libName).join(' '));
