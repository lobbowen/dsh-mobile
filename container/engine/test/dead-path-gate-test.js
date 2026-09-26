'use strict';
// 反向门禁：已被否决并删除的"容器根"产物若复活，测试即失败。
// 背景与证据见 docs/adr/0002-container-root-rejected.md。
// 扫面不含 .md：ADR 保留被否决方案的原文是刻意的（历史不可改写），扫进来只会逼人删证据或绕门禁。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FORBIDDEN = ['libdshrootns', 'libdshrootprobe', 'libdshptraceprobe', 'ContainerRoot', 'DSH_REAL_ROOT'];
// .py：scripts/ 里的门禁脚本（inject-libcxx 等）也是判据落点，必须在扫面内
const EXT = new Set(['.kt', '.kts', '.c', '.h', '.js', '.mjs', '.cjs', '.yml', '.yaml', '.json',
  '.sh', '.gradle', '.te', '.xml', '.bp', '.rc', '.txt', '.py']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '_backup', '_tools', 'build', '.gradle', 'dist']);
const SKIP_FILES = new Set([path.resolve(__dirname, 'dead-path-gate-test.js')]);

const matchTokens = (t) => FORBIDDEN.filter((f) => t.includes(f));

const hits = [];
(function walk(d) {
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name)); continue; }
    if (!EXT.has(path.extname(e.name))) continue;
    const p = path.join(d, e.name);
    if (SKIP_FILES.has(path.resolve(p))) continue;
    let t; try { t = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const f of matchTokens(t)) hits.push(path.relative(ROOT, p) + ' :: ' + f);
  }
})(ROOT);

// 自证（门禁法③）：每个违禁词先过一遍匹配器自身。连样本都抓不住 = 词表/匹配被掏空，
// 此时"零命中"是空转而非清白，必须判红。
const blind = FORBIDDEN.filter((f) => !matchTokens('probe ' + f + ' probe').includes(f));

if (blind.length) {
  console.log('FAIL 门禁自证失败，匹配器漏抓违禁词: ' + blind.join(', '));
  console.log('\n结果: 0 passed, 1 failed');
  process.exit(1);
}
if (hits.length) {
  console.log('FAIL 已删除的容器根产物复活（见 docs/adr/0002）：');
  hits.forEach(h => console.log('  ' + h));
  console.log('\n结果: 0 passed, 1 failed');
  process.exit(1);
}
console.log('PASS 无容器根残留（libdshrootns/libdshrootprobe/libdshptraceprobe/ContainerRoot/DSH_REAL_ROOT）');
console.log('结果: 1 passed, 0 failed');
