'use strict';
// 反向门禁：已被否决并删除的"容器根"产物若复活，测试即失败。
// 背景与证据见 docs/adr/0002-container-root-rejected.md。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FORBIDDEN = ['libdshrootns', 'libdshrootprobe', 'libdshptraceprobe', 'ContainerRoot', 'DSH_REAL_ROOT'];
const EXT = new Set(['.kt', '.kts', '.c', '.h', '.js', '.mjs', '.cjs', '.yml', '.yaml', '.json',
  '.sh', '.gradle', '.te', '.xml', '.bp', '.rc', '.txt']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '_backup', '_tools', 'build', '.gradle', 'dist']);
const SKIP_FILES = new Set([path.resolve(__dirname, 'dead-path-gate-test.js')]);

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
    for (const f of FORBIDDEN) if (t.includes(f)) hits.push(path.relative(ROOT, p) + ' :: ' + f);
  }
})(ROOT);

if (hits.length) {
  console.log('FAIL 已删除的容器根产物复活（见 docs/adr/0002）：');
  hits.forEach(h => console.log('  ' + h));
  console.log('\n结果: 0 passed, 1 failed');
  process.exit(1);
}
console.log('PASS 无容器根残留（libdshrootns/libdshrootprobe/libdshptraceprobe/ContainerRoot/DSH_REAL_ROOT）');
console.log('结果: 1 passed, 0 failed');
