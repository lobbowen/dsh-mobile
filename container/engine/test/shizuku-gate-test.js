'use strict';
// 反向门禁：Shizuku 已于 2026-09-24 整体删除 —— 唯一特权 shell 通道 = 自带 ADB 客户端
// （决策与理由见 docs/adr/0003 的「勘误 2026-09-24」）。代码里再出现 shizuku 字样即失败。
//
// 为什么只扫代码目录、不扫 docs/**：ADR/契约文档保留历史决策原文是刻意的
// （ADR 不可改写，勘误另起一节）；把 docs 扫进来只会逼人删历史记录或绕门禁。
//
// 能红的证明：删掉本仓任一文件的过滤前，先 grep 确认当前零命中 —— 若未来有人
// 把 shell 通道"改回" Shizuku（依赖、Manifest provider、Kotlin 类、methods.js
// 的 cap），任何一个 reintroduce 都会让这条门禁变红。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CODE_DIRS = [
  'container/app',            // Kotlin + assets + gradle + manifest
  'container/engine/src',     // 桥契约（methods.js / server.js mock）
  'kernel/src', 'kernel/ui/src', // 内核侧也不得反向依赖已删除的能力名
];
const SKIP_DIRS = new Set(['node_modules', 'build', '.gradle', 'dist']);
const CODE_EXT = new Set(['.kt', '.kts', '.js', '.mjs', '.cjs', '.json', '.xml', '.yml', '.yaml', '.sh']);
// 根级构建脚本单独扫（settings.gradle.kts 里曾挂着 Shizuku 的 maven 仓注释）。
const ROOT_FILES = ['settings.gradle.kts', 'build.gradle.kts'];

const hits = [];
function scanFile(p) {
  let t;
  try { t = fs.readFileSync(p, 'utf8'); } catch { return; }
  if (/shizuku/i.test(t)) {
    for (const [i, line] of t.split('\n').entries()) {
      if (/shizuku/i.test(line)) hits.push(path.relative(ROOT, p) + ':' + (i + 1));
    }
  }
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
for (const f of ROOT_FILES) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) scanFile(p);
}

if (hits.length) {
  console.log('FAIL 代码目录出现 Shizuku 残留（已于 2026-09-24 删除，唯一 shell 通道 = 自带 ADB 客户端）：');
  hits.forEach((h) => console.log('  ' + h));
  console.log('\n结果: 0 passed, 1 failed');
  process.exit(1);
}
console.log('PASS 代码目录无 shizuku 字样（container/app, engine/src, kernel/src, kernel/ui/src + 根构建脚本）');
console.log('结果: 1 passed, 0 failed');
