#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 门禁清单「完整性」门禁（Android 内核版）
//
// ## 修复的缺陷（失效模式 c：声明了但零调用点 / 门禁存在却不跑）
//
// 内核的 `scripts.test` 是**硬编码的 && 串联名单**，而 `test/` 下的测试文件更多。
// 历史上有三个**真实测试从未进入 CI**（api-contract / native / plugin-change-restart），
// 各有独立 npm script 但没人跑 → 永不执行。这是"门禁静默不跑"。
//
// ## Android 内核版政策（见 package.json._uninstallTests）
// 主链 = 全部测试，**仅排除**由独立入口（`test:<name>` 脚本）承载的卸载类测试。
// 排除集合**从 package.json 推导**，不手抄第二份（手抄的表必然与真实清单漂移）；
// 新增排除必须同时改 package.json 与 _uninstallTests 政策，否则 N-b 会红。
//
// ## 锁定不变量
// N-a `test/` 下每个测试文件要么在 `scripts.test` 链中，要么在**排除表**中并写明理由
// N-b 排除表里的文件必须真实存在且理由充分（防排除表腐化为死引用 / 万能借口）
// N-c 助手/fixture（`_` 前缀或非测试命名的 .js）不被误报、也不在链中
// N-d 链中每一项都真实存在（防链引用已删文件 → npm test 直接崩）
// N-e 反向：判据能识别"未入链的测试"与"链中的死引用"（门禁非空转）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

/** 独立入口集合：**从 package.json 推导**（`test:<name>` 脚本指向的测试文件）。
 * 只允许「真实卸载」这一类；加入任何其它项都要同时改 package.json 与政策，否则 N-b 会红。 */
const EXCLUDED = {};
{
  const pkg = require(path.join(ROOT, 'package.json'));
  for (const [k, v] of Object.entries(pkg.scripts)) {
    if (k === 'test' || !k.startsWith('test:')) continue;
    // 命令行形如 `node --require ./test/_preload.js test/<x>.js` —— 取非 _ 前缀的那个文件。
    const files = [...v.matchAll(/(?:^|\s)(test\/[\w.-]+\.js)/g)]
      .map((m) => m[1]).filter((f) => !/_/.test(f.replace(/^test\//, '')));
    if (files.length === 1) EXCLUDED[files[0]] = '独立入口 npm run ' + k + '（刻意不进自动链）';
  }
}

function chainFiles() {
  const s = require(path.join(ROOT, 'package.json')).scripts.test;
  // 每条为 `node --require ./test/_preload.js test/<x>.js`（隔离预载）——剥掉前缀取文件名。
  return s.split(' && ').map((x) => x.replace(/^node (--require \S+ )?/, '').trim());
}

/** 命名约定：`*-test.js` 为标准测试名。
 * 历史遗留两个**不带 -test 后缀**但在链中当测试跑的**门禁**（不改名，避免大范围改动）：
 * · test/smoke.js —— 启动冒烟
 * · test/ports-verify.js —— 端口纪律校验
 * 它们由 `IN_CHAIN_LEGACY` 显式承认，从而与"助手"区分开。 */
const IN_CHAIN_LEGACY = ['smoke.js', 'ports-verify.js'];
function isTestFile(name) {
  return name.endsWith('-test.js') || IN_CHAIN_LEGACY.includes(name);
}

// ── N-a：每个测试文件要么在链中，要么被显式排除 ──
{
  const inChain = chainFiles();
  const all = fs.readdirSync(path.join(ROOT, 'test')).filter(isTestFile).map((f) => 'test/' + f);
  const orphans = all.filter((f) => !inChain.includes(f) && !Object.prototype.hasOwnProperty.call(EXCLUDED, f));
  check('N-a 每个测试文件都在 scripts.test 链中或被显式排除',
    orphans.length === 0,
    orphans.length ? ('未入链且未排除: ' + orphans.join(', ')) : (all.length + ' 个测试文件全部有归属'));
  check('N-a 链中无重复项', new Set(inChain).size === inChain.length,
    inChain.length + ' 项');
}

// ── N-b：排除表引用真实存在且理由充分 ──
{
  const bad = Object.keys(EXCLUDED).filter((f) => !fs.existsSync(path.join(ROOT, f)));
  check('N-b 排除表引用的文件都真实存在', bad.length === 0, bad.length ? bad.join(', ') : Object.keys(EXCLUDED).length + ' 条');
  const noReason = Object.entries(EXCLUDED).filter(([, r]) => !r || String(r).trim().length < 16);
  check('N-b 每条排除都写了理由（>=16 字）', noReason.length === 0, noReason.map((x) => x[0]).join(', ') || 'ok');
  const inChain = chainFiles();
  const wronglyExcluded = Object.keys(EXCLUDED).filter((f) => inChain.includes(f));
  check('N-b 排除项不在链中（不重复计入）', wronglyExcluded.length === 0, wronglyExcluded.join(', ') || 'ok');
  // 推导出来的集合必须仍被**书面政策**覆盖 —— 防"悄悄加个独立入口就绕过主链"。
  const policy = require(path.join(ROOT, 'package.json'))._uninstallTests || '';
  const undocumented = Object.keys(EXCLUDED).filter((f) => !policy.includes(f.replace('test/', '')));
  check('N-b 每条独立入口都在 _uninstallTests 政策里被点名',
    undocumented.length === 0, undocumented.join(', ') || 'ok');
}

// ── N-c：助手/fixture 不被误报 ──
{
  const helpers = fs.readdirSync(path.join(ROOT, 'test'))
    .filter((f) => !isTestFile(f) && f.endsWith('.js') && !f.startsWith('_'));
  const wronglyInChain = helpers.filter((h) => chainFiles().includes('test/' + h));
  check('N-c 助手/fixture 不被当作测试跑（也不在链中）',
    wronglyInChain.length === 0, wronglyInChain.length ? wronglyInChain.join(', ') : helpers.length + ' 个助手');
  check('N-c _ 前缀助手被视为非测试',
    ['_ports.js', '_workflow.js'].every((h) => !isTestFile(h)), 'ok');
  check('N-c 历史遗留门禁（smoke/ports-verify）被承认为测试',
    isTestFile('smoke.js') && isTestFile('ports-verify.js'), 'ok');
}

// ── N-d：链中每一项都真实存在（防链引用已删文件 → npm test 直接崩）──
{
  const missing = chainFiles().filter((f) => !fs.existsSync(path.join(ROOT, f)));
  check('N-d 链中每一项都真实存在', missing.length === 0, missing.length ? missing.join(', ') : chainFiles().length + ' 项');
}

// ── N-e：反向（判据必须能识别两类问题）──
{
  const inChain = chainFiles();
  const fake = ['test/__nonexistent-gate-test.js'];
  const orphanDetected = fake.filter((f) => !inChain.includes(f)
    && !Object.prototype.hasOwnProperty.call(EXCLUDED, f)).length === 1;
  check('N-e 反向：判据能识别未入链的测试', orphanDetected, 'hit');
  const deadRef = ['test/api-contract-test.js']; // 已随 PC 三域删除的文件名
  const deadDetected = deadRef.filter((f) => !fs.existsSync(path.join(ROOT, f))).length === 1;
  check('N-e 反向：判据能识别链中的死引用', deadDetected, 'hit');
  check('N-e 反向：链中每一项都能被 isTestFile 识别为测试（防链里混入非测试）',
    inChain.every((f) => isTestFile(f.replace(/^test\//, ''))), 'ok');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
