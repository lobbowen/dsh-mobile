'use strict';
// 反向门禁：Shizuku 已于 2026-09-24 整体删除 —— 唯一特权 shell 通道 = 自带 ADB 客户端
// （决策与理由见 docs/adr/0003 的「勘误 2026-09-24」）。代码里再出现 shizuku 字样即失败。
//
// 为什么只扫代码目录、不扫 docs/**：ADR/契约文档保留历史决策原文是刻意的
// （ADR 不可改写，勘误另起一节）；把 docs 扫进来只会逼人删历史记录或绕门禁。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CODE_DIRS = [
  'container/app',            // Kotlin + assets + gradle + manifest
  'container/engine/src',     // 桥契约（methods.js / server.js mock）
  'container/engine/test',    // 门禁/测试自身也不许留示例写法（本文件除外，见 SKIP_FILES）
  'scripts',                  // 发布/校验脚本曾差一点把 shizuku 路径写回 CI
  'kernel/src', 'kernel/ui/src', // 内核侧也不得反向依赖已删除的能力名
];
const SKIP_DIRS = new Set(['node_modules', 'build', '.gradle', 'dist']);
const CODE_EXT = new Set(['.kt', '.kts', '.js', '.mjs', '.cjs', '.json', '.xml', '.yml', '.yaml', '.sh', '.py']);
const SKIP_FILES = new Set([path.resolve(__dirname, 'shizuku-gate-test.js')]);

const hits = [];
const lineHits = (t) => t.split('\n').reduce((acc, line, i) => { if (/shizuku/i.test(line)) acc.push(i + 1); return acc; }, []);
function scanText(rel, t) { for (const ln of lineHits(t)) hits.push(rel + ':' + ln); }
function scanFile(p) {
  const rel = path.relative(ROOT, p);
  if (SKIP_FILES.has(path.resolve(p))) return;
  let t;
  try { t = fs.readFileSync(p, 'utf8'); } catch { return; }
  scanText(rel, t);
}
function walkDir(d) {
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkDir(path.join(d, e.name)); continue; }
    if (CODE_EXT.has(path.extname(e.name))) scanFile(path.join(d, e.name));
  }
}
for (const dir of CODE_DIRS) walkDir(path.join(ROOT, dir));
// 根级构建脚本单独扫（settings.gradle.kts 里曾挂着 Shizuku 的 maven 仓注释）。
for (const f of ['settings.gradle.kts', 'build.gradle.kts']) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) scanFile(p);
}

// 自证（门禁法③）：匹配器连样本都抓不住 = 判据被掏空，此时"零命中"必须判红而非放行。
const blind = lineHits("implementation 'moe.shizuku:client'").length === 0;

if (blind || hits.length) {
  if (blind) console.log('FAIL 门禁自证失败：匹配器抓不住样本 "moe.shizuku:client" —— 判据已空转');
  else {
    console.log('FAIL 扫面出现 Shizuku 残留（已于 2026-09-24 删除，唯一 shell 通道 = 自带 ADB 客户端）：');
    hits.forEach((h) => console.log('  ' + h));
  }
  console.log('\n结果: 0 passed, 1 failed');
  process.exit(1);
}
console.log('PASS 代码目录无 shizuku 字样（app / engine 契约+测试 / scripts / kernel 两侧 + 根构建脚本）');
console.log('结果: 1 passed, 0 failed');
