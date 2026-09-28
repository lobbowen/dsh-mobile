#!/usr/bin/env node
'use strict';
// 文档门：docs/** 与根 README 里的**相对链接**必须指向存在的文件，
// 且**代码引用**（`Foo.kt:NN`）必须指得到真实文件、行号不越界。
// 动机一（死链，复检 AUD-G42）：品牌门把 docs/ 整目录白名单后，文档里的死链永远不会红。
// 动机二（引用，债表 AUD-G48）：SP-1 那轮逐条人工复核才发现四处假引用
//   （OnboardingActivity / NodeContainerApp / KernelSelfCheck / HostBridgeService）——
//   「靠人记住改哪些行」不是门禁，下一轮一定再犯。空口规矩不算门禁，必须能红。
// 用法：node scripts/doc-gate.js [--strict] [--strict-cites]
//   默认报告模式（exit 0，写 doc-gate-report.txt）；--strict 有死链即 exit 1；
//   --strict-cites 有**规范面**失效引用即 exit 1（范围住在 gate-policy 的 citations.strictScope）。
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const strict = process.argv.includes('--strict');
const strictCites = process.argv.includes('--strict-cites');
const SKIP = new Set(['node_modules', '.git', 'build', 'dist']);
function walk(d, out) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.md')) out.push(p);
  }
  return out;
}
const files = [...walk(path.join(root, 'docs'), []), path.join(root, 'README.md')];
const broken = [];
for (const f of files) {
  let t; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const base = path.dirname(f);
  for (const m of t.matchAll(/\]\(([^)]+)\)/g)) {
    let target = m[1].trim().split(/\s+/)[0];
    if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
    target = target.split('#')[0];
    if (!target) continue;
    const abs = path.resolve(base, target);
    if (!fs.existsSync(abs)) broken.push(path.relative(root, f) + ' -> ' + target);
  }
}

// ── 引用核验（债表 AUD-G48）───────────────────────────────────────────────
// 只核**代码**引用（kt/kts/js/mjs/cjs/ts/sh/py）：`state.json`、`program-manifest.json` 这类是
// 产物/数据形状的名字，不是仓内源文件，把它们算进违规只会逼人把规范改成绕过门禁的写法。
// 扩展名前必须有真实文件名：散文里光写一个 `.kt`（说「扫描到的 `.kt` 文件数」）不是引用。
const CODE_CITE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_.-]+)*\.(kts|kt|mjs|cjs|js|ts|sh|py)(:\d+(?:-\d+)?)?$/;
const sourceFiles = [];
(function collect(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) collect(p);
    else sourceFiles.push(path.relative(root, p));
  }
})(root);

// 引用规则的**数据**住在 gate-policy.json（与禁词表同一个宿主：门禁法②，脚本里不另写一份词表）。
const policy = JSON.parse(fs.readFileSync(path.join(root, '.github', 'gate-policy.json'), 'utf8'));
const citePolicy = policy.citations || {};
const STRICT_SCOPE = citePolicy.strictScope || [];
const EXTERNAL = new Set((citePolicy.external || []).map((e) => e.file));

/** 把一条引用解析成仓内相对路径；'skip' = 不该由本仓核验，null = 指不到真实文件。 */
function resolveCite(cite) {
  const file = cite.split(':')[0];
  if (/[*?<>|]/.test(file)) return 'skip'; // 通配/占位写法（`adb-*-test.js`）不是可核验的引用
  const norm = file.replace(/^\.\//, '');
  if (EXTERNAL.has(norm)) return 'skip';   // 外部包里的文件（npm-cli.js 等），按 policy 申报过就不算假引用
  if (sourceFiles.includes(norm)) return norm;
  const bySuffix = sourceFiles.filter((p) => p.endsWith('/' + norm));
  if (bySuffix.length) return bySuffix[0];
  // 只给了文件名（`SetupActivity.kt:447`）：按 basename 找。多候选时文档写的就是其中一份，
  // 取第一份让越界检查继续说话，而不是因为「有歧义」整条放过。
  const base = norm.split('/').pop();
  const byBase = sourceFiles.filter((p) => p.split('/').pop() === base);
  return byBase.length ? byBase[0] : null;
}

const lineCountCache = new Map();
function lineCount(rel) {
  if (!lineCountCache.has(rel)) {
    try { lineCountCache.set(rel, fs.readFileSync(path.join(root, rel), 'utf8').split('\n').length); }
    catch { lineCountCache.set(rel, -1); }
  }
  return lineCountCache.get(rel);
}

/** 一处引用的结论：null = 引用成立；字符串 = 违规说明。 */
function citeProblem(cite) {
  const rel = resolveCite(cite);
  if (rel === null) return '仓内没有这个源文件';
  if (rel === 'skip') return null;
  const nums = cite.split(':')[1];
  if (!nums) return null;
  const [start, end] = nums.split('-').map((n) => parseInt(n, 10));
  const max = Math.max(start, end || 0);
  const lc = lineCount(rel);
  if (lc < 0) return rel + ' 读不到';
  if (max > lc) return rel + ' 只有 ' + lc + ' 行';
  return null;
}

// 「已废止」那一支不算假引用：迁移对照表与在册残留段必须能指名**已经不存在的**旧模块，
// 那是历史证据（dead-path-gate 不把 docs 扫进违禁词，同理）。豁免要求**同一行自己声明**这件事
// 已被删/废止 —— 依据写在散文里谁都能看见，不是一条隐形后门。
const ABOLISHED = /已删|已移除|已不在仓内|随源同删|整段删除|整体删除|不再存在|已废止|废止|已否决|删除|废弃/;

const normativeCites = []; // 规范面：--strict-cites 转强制
const historicCites = [];  // 历史/对照面：报告模式，但数字必须可见
for (const f of files) {
  let t; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const relDoc = path.relative(root, f);
  const normative = STRICT_SCOPE.some((s) => relDoc === s || relDoc.startsWith(s));
  for (const line of t.split('\n')) {
    if (ABOLISHED.test(line)) continue;
    for (const m of line.matchAll(/`([^`\s]+)`/g)) {
      const cite = m[1];
      if (!CODE_CITE.test(cite)) continue;
      const problem = citeProblem(cite);
      if (!problem) continue;
      (normative ? normativeCites : historicCites).push(relDoc + ' :: ' + cite + ' -> ' + problem);
    }
  }
}

// 自证（门禁法③，双向）：坏引用抓不住 = 尺子被掏空，「零违规」是空转；
// 好引用被判红 = 逼人改文档来绕门。两条都验才算这条门能红。
const selfReal = sourceFiles.find((p) => p.endsWith('SetupActivity.kt'));
const SELF_BAD = citeProblem('NoSuchClassForSelfTest.kt:1');
const SELF_OOB = selfReal ? citeProblem('SetupActivity.kt:' + (lineCount(selfReal) + 9)) : 'selfReal 不在仓内';
const SELF_OK = selfReal ? citeProblem('SetupActivity.kt:1') : 'selfReal 不在仓内';
if (selfReal === undefined || SELF_BAD === null || SELF_OOB === null || SELF_OK !== null) {
  console.error('doc-gate: FAIL（引用核验自证失败：坏=' + JSON.stringify(SELF_BAD)
    + ' 越界=' + JSON.stringify(SELF_OOB) + ' 好=' + JSON.stringify(SELF_OK) + '）');
  process.exit(1);
}

const lines = ['# 文档门报告（' + new Date().toISOString() + '）', '',
  '扫描 md 文件：' + files.length,
  '死链：' + broken.length,
  '失效引用（规范面，--strict-cites 转强制）：' + normativeCites.length,
  '失效引用（历史/对照面，报告模式）：' + historicCites.length, '',
  '## 死链', ...broken,
  '', '## 失效引用 —— 规范面（' + STRICT_SCOPE.join(' / ') + '）', ...normativeCites,
  '', '## 失效引用 —— 历史/对照面（AUD-G48 剩余存量：文档指名已废止的旧模块）', ...historicCites,
  ''];
fs.writeFileSync(path.join(root, 'doc-gate-report.txt'), lines.join('\n') + '\n');
console.log('doc-gate: files=' + files.length + ' broken=' + broken.length
  + ' cites(规范)=' + normativeCites.length + ' cites(历史)=' + historicCites.length);
for (const b of broken.slice(0, 15)) console.log('  ' + b);
for (const c of normativeCites.slice(0, 40)) console.log('  ' + c);
if (strict && broken.length) { console.error('doc-gate: FAIL（上面的相对链接指向不存在的文件）'); process.exit(1); }
if (strictCites && normativeCites.length) { console.error('doc-gate: FAIL（规范面的 file:line 引用指不到真实位置，债表 AUD-G48）'); process.exit(1); }
process.exit(0);
