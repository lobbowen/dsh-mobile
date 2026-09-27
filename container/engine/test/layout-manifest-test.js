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
const WALK_SKIP = new Set(['.git', 'node_modules', 'build', '.gradle']);
function walkFiles(absDir, out) {
  if (!fs.existsSync(absDir)) return out;
  let es; try { es = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    if (WALK_SKIP.has(e.name)) continue;
    const q = path.join(absDir, e.name);
    if (e.isDirectory()) walkFiles(q, out); else out.push(q);
  }
  return out;
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
  // ── 交付维（六层）对账 ──
  // 为什么必须机器查：此前 layout.json 只编码发布维，六层只活在 ADR 文字里 —— 于是
  // 「C 的内容住进内核」「产品声明留在内核」这类越层一路绿灯。规则如下，未登记即红。
  const DL = (layout.deliveryLayers || {});
  const DEBT = (layout.deliveryDebt || []);
  const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
  const readSafe = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return ''; } };
  const violations = [];
  const add = (rule, detail) => violations.push({ rule, detail: detail || '' });

  // 规则 1：每层声明的目标路径必须存在
  for (const k of Object.keys(DL)) {
    if (k.startsWith('_')) continue;
    for (const p of (DL[k].paths || [])) if (!ex(p)) add('LAYER-PATH-MISSING', k + ':' + p);
  }
  // 规则 2：C 的内容不得住内核（内容清单只在 C 通道；内核只留通道锚 + 装配动作）
  for (const abs of walkFiles(path.join(ROOT, 'kernel', 'src'), [])) {
    if (readSafe(abs).indexOf('hubcdn.zll.ink/userland/') >= 0) add('C-IN-KERNEL', rel(abs));
  }
  // 规则 3：F 的产品声明不得住内核
  if (ex('kernel/adapters')) add('F-IN-KERNEL', 'kernel/adapters');
  // 规则 4：D2 件清单唯一处 —— 目录必须在，且**与随包投递清单对账**（带 libName 的件必须出现）。
  // 知识一处（D2 件清单）、投递一处（随包能力件清单）；两边漂移即红。
  const d2Pieces = path.join(ROOT, 'kernel', 'src', 'd2', 'pieces.json');
  const capsTxt = path.join(ROOT, '.github', 'native-capabilities.txt');
  if (!fs.existsSync(d2Pieces)) add('D2-INVENTORY', 'kernel/src/d2/pieces.json 缺失（D2 无唯一件清单）');
  else if (fs.existsSync(capsTxt)) {
    const caps = fs.readFileSync(capsTxt, 'utf8');
    let cat = null; try { cat = JSON.parse(fs.readFileSync(d2Pieces, 'utf8')); } catch { cat = null; }
    for (const p of (cat && cat.pieces) || []) {
      if (p.libName && caps.indexOf(' ' + p.libName + ' ') < 0) add('D2-INVENTORY', 'D2 件 ' + p.id + ' 的 ' + p.libName + ' 不在随包清单里');
    }
  }
  // 规则 5：环境目录单一来源
  const stPath = path.join(ROOT, 'kernel', 'src', 'assembler', 'supply-table.json');
  const envUnits = fs.existsSync(stPath) ? (JSON.parse(readSafe(stPath)).envUnits || []) : [];
  if (ex('kernel/src/platform/env-catalog.js') && envUnits.length > 0) add('ENV-CATALOG', 'env-catalog.js 与 supply-table#envUnits 同时在场');
  // 规则 6：CI 工具不得住在 L0 车辆里（L0 目录里不该有构建 CLI）
  if (ex('container/engine/bin')) add('CI-TOOL-IN-L0', 'container/engine/bin');
  // 规则 7（原「D2 的件解析不得住 E 的目录」）已退役：该不变量现由内核门禁把守
  // （kernel/test/native-supply-gate-test.js 的「D2 不再住 E 的目录」），此处若再写一遍旧路径，
  // 反而会被规则 8 判成本身就是残留 —— 判据不该有两把尺子。

  // 规则 8：**已迁移的旧路径不得再被引用** —— 连续写法与**分段写法**都要查。
  // 为什么加：步骤 A 搬迁后 CI 红过两次，根因都是把路径**拆成多段**的写法（path.join(ROOT, '容器段', …)）；
  // 批量文本替换只能改连续字符串，改不到分段拼接，测试于是静默指向不存在的目录（本仓文档早有同类前科）。
  // 豁免：layout.json（迁移台账本身）与 docs/plans/（历史方案记录，讨论迁移时合法引用旧路径）。
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const segRe = (p) => p.split('/').map((x) => "'" + escRe(x) + "'").join("\\s*,\\s*");
  const residueScope = walkFiles(ROOT, []).filter((abs) => {
    const rp = rel(abs);
    return rp !== 'docs/contracts/layout.json' && !rp.startsWith('docs/plans/');
  });
  for (const m of (layout.moves || [])) {
    if (!m.from || m.from.indexOf('/') < 0) continue;
    const reCont = new RegExp(escRe(m.from));
    const reSeg = new RegExp(segRe(m.from));
    for (const abs of residueScope) {
      const t = readSafe(abs);
      if (reCont.test(t) || reSeg.test(t)) add('MOVED-PATH-RESIDUE', rel(abs) + ' 仍引用 ' + m.from);
    }
  }
  // 对照组自证：分段判据必须能识破人造的分段写法
  if (!new RegExp(segRe('a/b/c')).test("path.join(ROOT, 'a', 'b', 'c')")) problems.push('MOVED-PATH-RESIDUE 分段判据自证失败（恒空）');

  // 台账自净：① 未登记的违规 → 红；② 已消失的债务 → 红（防僵尸豁免）；③ 过期/缺字段 → 红
  const coveredBy = (v) => DEBT.some((d) => d.rule === v.rule && (!d.path || v.detail === d.path || v.detail.endsWith(d.path)));
  for (const v of violations) if (!coveredBy(v)) problems.push('交付分层违规（未登记）: ' + v.rule + ' ' + v.detail);
  for (const d of DEBT) {
    const hit = violations.some((v) => v.rule === d.rule && (!d.path || v.detail === d.path || v.detail.endsWith(d.path)));
    if (!hit) problems.push('deliveryDebt 僵尸条目（违规已消失，必须销账）: ' + d.id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.expiresAt || '') || new Date(d.expiresAt + 'T23:59:59Z') < new Date()) {
      problems.push('deliveryDebt 过期或缺到期日: ' + d.id);
    }
    if (!d.what || !d.fix) problems.push('deliveryDebt 缺少 what/fix（债要说清是什么、怎么还）: ' + d.id);
  }
  // 对照组自证：判据必须能识破人造违规，否则是永不红的死规则
  if (coveredBy({ rule: '__no_such_rule__', detail: '' })) problems.push('deliveryDebt 匹配判据自证失败（把未知规则判成已覆盖）');

  console.log('== 交付维（六层）==');
  for (const k of Object.keys(DL)) {
    if (k.startsWith('_')) continue;
    const ps = (DL[k].paths || []);
    console.log('  ' + k.padEnd(3) + ' ' + String(DL[k].title || '').padEnd(16) + ' vehicle=' + String(DL[k].vehicle || '?').padEnd(8)
      + ' paths=' + (ps.length ? ps.map((p) => (ex(p) ? '✓' : '✗') + p).join(' ') : '(无仓内路径)'));
  }
  console.log('  违规 ' + violations.length + ' 条 / 已登记债务 ' + DEBT.length + ' 条');
  for (const d of DEBT) console.log('    debt ' + String(d.id).padEnd(24) + ' rule=' + String(d.rule).padEnd(20) + ' 到期 ' + d.expiresAt);

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
