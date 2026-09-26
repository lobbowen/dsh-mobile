'use strict';
process.stdout.write('START layout-manifest-test\n');
const fs = require('fs');
const path = require('path');

function findRoot(start) {
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'docs', 'contracts', 'layout.json'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error('layout.json not found above ' + start);
}
function countFiles(abs) {
  if (!fs.existsSync(abs)) return null;
  let n = 0; const stack = [abs];
  while (stack.length) {
    const d = stack.pop();
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) stack.push(q); else n++;
    }
  }
  return n;
}
try {
  const ROOT = findRoot(__dirname);
  const layout = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'contracts', 'layout.json'), 'utf8'));
  const ENFORCE = process.env.LAYOUT_ENFORCE === '1';
  const ex = p => fs.existsSync(path.join(ROOT, p));

  const problems = [];
  let pending = 0, done = 0, conflict = 0, missing = 0;
  const rows = [];
  for (const m of layout.moves) {
    const f = ex(m.from), t = ex(m.to);
    let state;
    if (f && !t) { state = 'pending'; pending++; }
    else if (!f && t) { state = 'done'; done++; }
    else if (f && t) { state = 'conflict'; conflict++; problems.push('conflict: ' + m.from + ' <-> ' + m.to); }
    else { state = 'missing'; missing++; problems.push('missing: ' + m.from + ' -> ' + m.to); }
    let cnt = '';
    if (m.expectFiles != null && m.kind === 'dir') {
      const c = countFiles(path.join(ROOT, m.to)) != null ? countFiles(path.join(ROOT, m.to)) : countFiles(path.join(ROOT, m.from));
      // expectFiles = 迁移基线（下限）。少于基线 = 丢件；多于 = 正常演进（如新增测试）。
      cnt = ' files=' + c + ' (floor ' + m.expectFiles + ')';
      if (state === 'done' && c < m.expectFiles) problems.push('count: ' + m.to + ' = ' + c + ' < 迁移基线 ' + m.expectFiles + '（文件丢失）');
    }
    rows.push('  ' + state.padEnd(8) + ' ' + (m.from + ' -> ' + m.to).padEnd(58) + cnt);
  }
  console.log('== moves ==');
  rows.forEach(r => console.log(r));
  const legacy = layout.legacyForbidden.filter(ex);
  if (legacy.length) problems.push('legacy present: ' + legacy.join(', '));
  const movingFrom = new Set(layout.moves.map(m => m.from.split('/')[0]));
  const top = fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => e.name !== '.git').map(e => e.name)
    .filter(n => !layout.rootAllow.includes(n) && !(!ENFORCE && movingFrom.has(n)));
  if (top.length) problems.push('undeclared root entries: ' + top.join(', '));

  // scriptsOwnership 对账（门禁法②：手维护清单必须可对账，否则必然悄悄漂移）
  const owned = Object.keys(layout.scriptsOwnership || {});
  const actual = fs.readdirSync(path.join(ROOT, 'scripts'));
  const unregistered = actual.filter(f => !owned.includes(f));
  const stale = owned.filter(f => !actual.includes(f));
  if (unregistered.length) problems.push('scriptsOwnership 未登记: ' + unregistered.join(', '));
  if (stale.length) problems.push('scriptsOwnership 登记了不存在的文件: ' + stale.join(', '));
  // 自证：同一个「未登记」判据必须能识破一个不存在的样本（防判据写坏成恒空）
  if (['__nonexistent__'].filter(f => !owned.includes(f)).length !== 1) problems.push('scriptsOwnership 判据自证失败（恒空）');
  console.log('== summary ==');
  console.log('  pending=' + pending + ' done=' + done + ' conflict=' + conflict + ' missing=' + missing);
  console.log('  legacyForbidden present: ' + (legacy.length ? legacy.join(', ') : 'none'));
  console.log('  undeclared root entries: ' + (top.length ? top.join(', ') : 'none'));
  console.log('  scriptsOwnership: ' + owned.length + ' 项 / scripts 实际 ' + actual.length + ' 个'
    + (unregistered.length || stale.length ? '  ← 漂移' : '  ✓ 一致'));
  if (ENFORCE && problems.length) {
    console.log('\n结果: 0 passed, 1 failed');
    problems.forEach(p => console.log('  FAIL ' + p));
    process.exit(1);
  }
  console.log('\n结果: 1 passed, 0 failed' + (ENFORCE ? '' : '（报告模式）'));
} catch (e) {
  console.log('THROW ' + (e && e.stack || e));
  console.log('\n结果: 0 passed, 1 failed');
  process.exit(1);
}
