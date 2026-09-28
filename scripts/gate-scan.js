#!/usr/bin/env node
'use strict';
// Lob OS 门禁扫描：命名/品牌/结构（禁词 + 品牌）——单一策略文件 .github/gate-policy.json
// 用法：node scripts/gate-scan.js [--strict]
//   · 默认：报告模式（始终 exit 0），把结果写 brand-scan-report.txt 并打印摘要
//   · --strict 或 policy.enforce=true：有命中即 exit 1
// 纪律：策略是数据；扫描器只做"读策略 → 遍历 → 计数 → 报告"，不内置任何词表。

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const policy = JSON.parse(fs.readFileSync(path.join(root, '.github/gate-policy.json'), 'utf8'));
const strict = process.argv.includes('--strict') || policy.enforce === true;

const ignoreSeg = new Set(policy.ignoreSegments || []);
const ignoreExt = new Set(policy.ignoreExt || []);
const ignoreFiles = new Set(policy.ignoreFiles || []);
// 白名单按**词条**授予：整文件豁免会让该文件对其它规则也隐形（旧形态就是这个洞）。
const allowFiles = new Map((policy.allowFiles || []).map((e) => [e.file, new Set(e.terms)]));

function rel(p) { return path.relative(root, p).split(path.sep).join('/'); }
function allowed(relPath, term) {
  const granted = allowFiles.get(relPath);
  if (granted && granted.has(term.id)) return true;
  for (const a of term.allow || []) if (relPath === a || relPath.startsWith(a)) return true;
  return false;
}
// term.paths：把规则收在**声明面**内（如只禁交付面用旧名），仓内散文不受管。
function inScope(relPath, term) {
  const p = term.paths || [];
  if (p.length === 0) return true;
  for (const a of p) if (relPath === a || relPath.startsWith(a)) return true;
  return false;
}
function makesRegex(term) {
  const flags = 'g' + (term.caseInsensitive ? 'i' : '');
  const esc = term.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (term.word) return new RegExp('(?:^|[^A-Za-z0-9_])' + esc + '(?:[^A-Za-z0-9_]|$)', flags);
  return new RegExp(esc, flags);
}
function isTextFile(p) {
  const ext = path.extname(p).toLowerCase();
  if (ignoreExt.has(ext)) return false;
  try { const st = fs.statSync(p); if (st.size > 2 * 1024 * 1024 || st.size === 0) return false; } catch { return false; }
  try { const fd = fs.openSync(p, 'r'); const b = Buffer.alloc(1024); const n = fs.readSync(fd, b, 0, 1024, 0); fs.closeSync(fd); return !b.subarray(0, n).includes(0); } catch { return false; }
}
const hits = [];   // {file, term, count, samples:[]}
const liveSurface = new Map(); // termId → 该规则真正覆盖到的文件数（0 = 死规则）
function walk(dir) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (ignoreSeg.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.isFile() || !isTextFile(p)) continue;
    const relPath = rel(p);
    if (ignoreFiles.has(relPath) || ignoreFiles.has(e.name)) continue;
    let text; try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const term of policy.terms) {
      if (!inScope(relPath, term)) continue;
      if (allowed(relPath, term)) continue; // 负向判据：按设计引用违禁词的**具体词条**
      liveSurface.set(term.id, (liveSurface.get(term.id) || 0) + 1);
      const re = makesRegex(term);
      let m, count = 0; const samples = [];
      while ((m = re.exec(text)) !== null) {
        count++;
        if (samples.length < 3) {
          const line = text.slice(0, m.index).split('\n').length;
          samples.push('L' + line + ': ' + text.split('\n')[line - 1].trim().slice(0, 100));
        }
        if (m.index === re.lastIndex) re.lastIndex++;
        if (count > 500) break;
      }
      if (count) hits.push({ file: relPath, id: term.id, term: term.term, count, samples });
    }
  }
}
walk(root);

// ── 死规则自检 ───────────────────────────────────────────────────────────────
// 一条规则若覆盖面为 0（词条被白名单/豁免全吃掉，或 paths 作用域里根本没人），它永远不会红，
// 于是「门禁通过」变成假证据。这里按零覆盖直接判红，逼规则要么有用要么删掉。
const deadTerms = policy.terms.filter((t) => (liveSurface.get(t.id) || 0) === 0).map((t) => t.id);


// ── Kotlin 未解析 import 检查（捕捉"引用了但从未定义"的编译断点）──────────────
// 起因：D1b 期间 AccessibilityAnchor / PostPairingAutoFlow 被多处 import，但定义文件从不存在
// （真机/CI 编译才会炸）。这里用"import 名在本包语料里有无定义"做静态兜底。
function kotlinImportCheck() {
  const srcDir = path.join(root, 'container/app/src');
  if (!fs.existsSync(srcDir)) return { imports: 0, missing: [] };
  const kt = [];
  (function walkKt(d) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walkKt(p); else if (p.endsWith('.kt')) kt.push(p); }
  })(srcDir);
  const corpus = kt.map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
  const imports = new Set();
  for (const f of kt) {
    let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of t.matchAll(/^import\s+(lobos(?:\.\w+)+)\s*$/gm)) imports.add(m[1]);
  }
  const missing = [];
  for (const imp of imports) {
    const n = imp.split('.').pop();
    if (n === 'R' || n === 'BuildConfig') continue; // 构建期生成
    const re = new RegExp('(class|object|interface|enum class|data class|sealed class|typealias|fun|val|const val)\\s+' + n + '\\b');
    if (!re.test(corpus)) missing.push(imp);
  }
  return { imports: imports.size, missing };
}

const ktCheck = kotlinImportCheck();
const total = hits.reduce((s, h) => s + h.count, 0);
const byTerm = {};
for (const h of hits) byTerm[h.id] = (byTerm[h.id] || 0) + h.count;
const lines = [];
lines.push('# Lob OS 门禁扫描报告（' + new Date().toISOString() + '）');
lines.push('');
lines.push('模式：' + (strict ? '**强制**' : '报告（enforce=false）'));
lines.push('Kotlin 未解析 import：' + ktCheck.imports + ' 个 import，缺失 ' + ktCheck.missing.length + (ktCheck.missing.length ? ' → ' + ktCheck.missing.join(', ') : ''));
lines.push('死规则（覆盖面 0，永不变红）：' + (deadTerms.length ? deadTerms.join(', ') : '无'));
lines.push('');
lines.push('命中文件数：' + new Set(hits.map(h => h.file)).size + ' · 命中总数：' + total);
lines.push('');
lines.push('## 按词条');
for (const [id, c] of Object.entries(byTerm).sort((a, b) => b[1] - a[1])) lines.push('- ' + id + ': ' + c);
lines.push('');
lines.push('## 明细（最多 200 行）');
for (const h of hits.slice(0, 200)) lines.push('- ' + h.file + ' [' + h.id + ' x' + h.count + '] ' + (h.samples[0] || ''));
fs.writeFileSync(path.join(root, policy.reportFile), lines.join('\n') + '\n');

console.log('gate-scan: kt-imports=' + ktCheck.imports + ' kt-missing=' + ktCheck.missing.length);
console.log('gate-scan: hit-files=' + new Set(hits.map(h => h.file)).size + ' hits=' + total + ' dead-terms=' + deadTerms.length + ' mode=' + (strict ? 'strict' : 'report'));
for (const t of policy.terms) console.log('  coverage[' + t.id + ']= ' + (liveSurface.get(t.id) || 0) + ' files');
for (const [id, c] of Object.entries(byTerm).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log('  ' + id + ': ' + c);
if (strict && deadTerms.length > 0) { console.error('gate-scan: FAIL（死规则，覆盖面 0：' + deadTerms.join(', ') + '）—— 门禁不能只看起来在跑'); process.exit(1); }
if (strict && ktCheck.missing.length > 0) { console.error('gate-scan: FAIL（未解析 Kotlin import：' + ktCheck.missing.join(', ') + '）'); process.exit(1); }
if (strict && total > 0) { console.error('gate-scan: FAIL（上面命中项必须先清零）'); process.exit(1); }
process.exit(0);
