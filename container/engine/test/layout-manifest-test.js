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
  for (const abs of walkFiles(path.join(ROOT, 'programs/console', 'src'), [])) {
    const t = readSafe(abs);
    if (t.indexOf('hubcdn.zll.ink/userland/') >= 0) add('C-IN-KERNEL', rel(abs));
    else if (/https:\/\/[^'"\s]+\.tar\.gz/.test(t)) add('C-IN-KERNEL', rel(abs) + '（内核里出现制品 URL）');
  }
  // 规则 3：F 的产品声明不得住内核
  if (ex('programs/console/adapters')) add('F-IN-KERNEL', 'programs/console/adapters');
  // 规则 4：D2 件清单唯一处在**原生侧**（lobos/native/NativeAssetRegistry.kt），与随包投递清单对账。
  const d2Reg = path.join(ROOT, 'container', 'app', 'src', 'main', 'java', 'lobos', 'native', 'NativeAssetRegistry.kt');
  const capsTxt = path.join(ROOT, '.github', 'native-capabilities.txt');
  if (!fs.existsSync(d2Reg)) add('D2-INVENTORY', '原生件注册表缺失（D2 无唯一件清单）');
  else if (fs.existsSync(capsTxt)) {
    const caps = fs.readFileSync(capsTxt, 'utf8');
    const reg = readSafe(d2Reg);
    const libs = [...reg.matchAll(/libName\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    for (const lib of libs) {
      if (!/^liblobos/.test(lib)) continue; // 只对账自建件；上游/运行时件不在能力件清单
      if (caps.indexOf(' ' + lib + ' ') < 0) add('D2-INVENTORY', '原生件 ' + lib + ' 不在随包清单里');
    }
  }
  // 规则 5：环境目录只有一份，且**投影在原生侧**：console 不得自持 catalog 类文件；
  // 原生侧必须有程序登记（lobos/os/AppRegistry.kt）—— 判据不点名已被删除的旧文件名（避免判据自伤）。
  const platDir = path.join(ROOT, 'programs/console', 'src', 'platform');
  const leftoverCats = fs.existsSync(platDir) ? fs.readdirSync(platDir).filter((f) => /catalog/i.test(f)) : [];
  if (leftoverCats.length) add('ENV-CATALOG', 'platform/ 下还有 catalog 类文件：' + leftoverCats.join(', '));
  const nativeEnv = path.join(ROOT, 'container', 'app', 'src', 'main', 'java', 'lobos', 'os', 'AppRegistry.kt');
  if (!fs.existsSync(nativeEnv)) add('ENV-CATALOG', '原生侧程序登记 os/AppRegistry.kt 缺失（环境状态视图没了）');
  // 规则 6：CI 工具不得住在 L0 车辆里（L0 目录里不该有构建 CLI）
  if (ex('container/engine/bin')) add('CI-TOOL-IN-L0', 'container/engine/bin');
  // 规则 7（原「D2 的件解析不得住 E 的目录」）已退役：该不变量现由内核门禁把守
  // （programs/console/test/native-supply-gate-test.js 的「D2 不再住 E 的目录」），此处若再写一遍旧路径，
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

  // 规则 9：**永久护栏** —— shebang 约定缺失的补偿层不许回潮。
  // 背景：安卓没有 /usr/bin/env，我们曾给每件手写 `#!/system/bin/sh` 包装（补偿层）；
  // 根因已由 D1 的 exec-path.c 补回（execve 前按调用方 PATH 解析 shebang），包装已删除。
  // 这条护栏留着：谁再把「给每件手写包装」当解法加回来，CI 立刻红 —— 要修的是约定，不是加壳。
  const matPath = path.join(ROOT, 'programs/console', 'src', 'supply', 'materialize.js');
  if (fs.existsSync(matPath) && readSafe(matPath).indexOf('#!/system/bin/sh') >= 0) add('SHEBANG-COMPENSATION', 'programs/console/src/supply/materialize.js 仍在手写 sh 包装');

  // 规则 10：C 的**共享供给机制**（物化器）必须住在 APK 侧共享层 —— 它服务所有产品、不属于任何一个，
  //   更不该住内核（内核只做检测 + 触发）。由来：用户 2026-09-29 复核「加到内核里就只有内核能适配，
  //   我再装一个其它 Program，这些还要再加一遍 —— 它们是共用的」。未搬完以前，用带到期日的 deliveryDebt 挂账。
  const matMechPath = path.join(ROOT, 'programs/console', 'src', 'supply', 'materialize.js');
  if (fs.existsSync(matMechPath)) add('SUPPLY-MECH-IN-KERNEL', 'programs/console/src/supply/materialize.js');

  // 规则 11：C 的供给层**必须是 Android 原生实现** —— 它已属 APK 层，职责是向下供给；
  //   再借 node/运行时等于又多欠一层依赖（用户 2026-09-29 复核：「不应该用 node，而是用安卓原生的逻辑」）。
  //   判据：APK 侧供给实现里不得出现 JS 文件（原生实现是 Kotlin/Android API）。
  const supplyNativeDir = path.join(ROOT, 'container', 'app', 'src', 'main', 'assets', 'supply');
  if (fs.existsSync(supplyNativeDir)) {
    for (const f of fs.readdirSync(supplyNativeDir)) {
      if (/\.js$/i.test(f)) add('SUPPLY-NOT-NATIVE', 'container/app/src/main/assets/supply/' + f);
    }
  }

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
