#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 能力探针执行器回归（native-supply-gate 的运行时对偶）
//
// 供给表门禁管的是「判据长什么样」（数据），本文件管的是「判据怎么被折成三态」（执行）。
// 两层都必须能红：判据写得再好，执行器把「不知道」折成「通过」就还是假绿。
//
// 真机 2026-09-26 定罪案底（本文件的 D 组把它钉成可执行口径）：
// sharp-image 的**投放结局**是 applied（@img/sharp-wasm32 确在依赖树内），
// 而 sharp 取不到原生绑定、read_image 全灭。所以「applied 且能力 false」是真实存在过的
// 组合，overall 必须是 false —— 不许被一排 applied 稀释成绿。
//
// 全部用注入的假 run：本文件绝不起真 node 子进程（探针要检的是设备那份 node，
// 在 CI 里 spawn 出来的结论与设备无关，跑了也只是自娱）。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NATIVE_DIR = path.join(ROOT, 'src', 'guard', 'native');
const probe = require(path.join(NATIVE_DIR, 'capability-probe'));
const { PASS, PROBE_TIMEOUT_MS, probeUnit, probeUnits, overall } = probe;

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

const CTX = { nodeBin: '/fake/bin/node', packageDir: '/fake/lib/node_modules/@deepseek-ai/dsh' };

/** 造一个假执行器：按脚本内容决定结局，并记录每次调用参数。 */
function fakeRun(scriptOutcome) {
  const calls = [];
  const run = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const script = String(args[2] || '');
    return scriptOutcome(script, calls.length - 1);
  };
  return { run, calls };
}

const okPass = (extra) => ({ ok: true, code: 0, stdout: PASS + (extra ? ' ' + extra : ''), stderr: '' });
const okEmpty = () => ({ ok: true, code: 0, stdout: '', stderr: '' });
const failRc = (msg) => ({ ok: false, code: 1, stdout: '', stderr: msg });
const notSpawnable = (err) => ({ ok: false, code: null, error: err, stdout: '', stderr: '' });
const timedOut = () => ({ ok: false, code: null, timedOut: true, stdout: '', stderr: '' });

const unit = (verify, id) => ({ id: id || 'test-unit', verify });
const NODE_SCRIPT = "require('x'); process.stdout.write('" + PASS + "')";

// 真表（判据的事实源）：D/E 两组都从它取，避免测试自己造一份判据当被测对象。
const TABLE = JSON.parse(fs.readFileSync(path.join(NATIVE_DIR, 'supply-table.json'), 'utf8'));
const TABLE_UNITS = TABLE.units || [];
const isExecutable = (u) => !!(u.verify && typeof u.verify.node === 'string' && u.verify.node.trim());
const isExcused = (u) => !!(u.verify && (u.verify.notApplicable || u.verify.deferred));

// ── A 组：三态折叠 ──
{
  const t = unit({ node: NODE_SCRIPT });
  const p = probeUnit(t, CTX, { run: () => okPass('vips 8.15.3') });
  check('A1 退 0 且打标记 -> true', p.ok === true, JSON.stringify(p.detail));
  check('A1 通过详情保留探针输出（不是光秃秃的 ok）', /vips/.test(p.detail || ''), p.detail);

  const f = probeUnit(t, CTX, { run: () => failRc('Error: Could not load the "sharp" image library') });
  check('A2 跑起来了而判据不过 -> false（不是 null）', f.ok === false, JSON.stringify(f.detail));
  check('A2 红项带退出码与末行原因', /rc=1/.test(f.detail) && /sharp/.test(f.detail), f.detail);

  const e = probeUnit(t, CTX, { run: okEmpty });
  check('A3 退 0 但没打标记 -> false（判据被改空也算这一类）', e.ok === false, e.detail);

  const en = probeUnit(t, CTX, { run: () => notSpawnable('spawn /fake/bin/node ENOENT') });
  check('A4 spawn 失败（ENOENT）-> null：容器没交付 ≠ Agent 能力坏', en.ok === null, en.detail);

  const ea = probeUnit(t, CTX, { run: () => notSpawnable('spawn EACCES') });
  check('A5 spawn 失败（EACCES）-> null', ea.ok === null, ea.detail);

  const to = probeUnit(t, CTX, { run: timedOut });
  check('A6 超时 -> null（未知不算通过，也不算能力坏）', to.ok === null && /超时/.test(to.detail), to.detail);

  const junk = probeUnit(t, CTX, { run: () => null });
  check('A7 执行器返回无法解读的结果 -> null', junk.ok === null, junk.detail);
  const junk2 = probeUnit(t, CTX, { run: () => ({ stdout: 'hi' }) });
  check('A7 缺 ok 字段的结果 -> null（不放行成 green）', junk2.ok === null, junk2.detail);

  const d = probeUnit(unit({ criterion: '起一个真 PTY 并读到退出码', deferred: { followUp: 'P-T 终端批次', verifiedAt: '2026-09-26', expiresAt: '2026-10-26' } }), CTX, { run: () => okPass() });
  check('A8 deferred -> null 且写明谁在哪之前做', d.ok === null && /P-T 终端批次/.test(d.detail) && /2026-10-26/.test(d.detail), d.detail);

  const na = probeUnit(unit({ notApplicable: '本内核不调用该件' }), CTX, { run: () => okPass() });
  check('A9 notApplicable -> null（免检不等于通过）', na.ok === null && /无需核验/.test(na.detail), na.detail);

  const none = probeUnit({ id: 'no-verify' }, CTX, { run: () => okPass() });
  check('A10 无 verify 的格 -> null（只有投放结局不能当能力读）', none.ok === null && /投放结局/.test(none.detail), none.detail);

  const drift = probeUnit(unit({ node: '   ' }), CTX, { run: () => okPass() });
  check('A11 判据写法漂移（node 空白串）-> null 而非静默 true', drift.ok === null && /漂移/.test(drift.detail), drift.detail);
}

// ── B 组：调用形态（探针必须照抄 dsh 的真实启动形态）──
{
  const t = unit({ node: NODE_SCRIPT });
  const { run, calls } = fakeRun(() => okPass());
  probeUnit(t, CTX, { run });
  check('B1 只起一次子进程', calls.length === 1, calls.length + ' 次');
  const c = calls[0] || {};
  check('B2 被检的是契约里那份 node，不是内核自己的 execPath', c.bin === CTX.nodeBin, c.bin);
  check('B3 恒带 --expose-internals 且在 -e 之前（与 main-process._androidLaunchReady 同形）',
    c.args && c.args[0] === '--expose-internals' && c.args[1] === '-e', JSON.stringify(c.args && c.args.slice(0, 2)));
  check('B4 交给子进程的正是表里那段判据脚本', c.args && c.args[2] === NODE_SCRIPT);
  check('B5 cwd = Agent 包目录（require 解析域与 dsh 一致）', c.opts && c.opts.cwd === CTX.packageDir, c.opts && c.opts.cwd);
  check('B6 默认有界超时（探针不得无限等）', c.opts && c.opts.timeoutMs === PROBE_TIMEOUT_MS && PROBE_TIMEOUT_MS > 0, String(c.opts && c.opts.timeoutMs));
  const overridden = fakeRun(() => okPass());
  probeUnit(t, CTX, Object.assign({}, overridden, { timeoutMs: 1234 }));
  check('B6 超时可由调用方收紧', overridden.calls[0].opts.timeoutMs === 1234);

  const noNode = fakeRun(() => okPass());
  const r1 = probeUnit(t, { nodeBin: null, packageDir: CTX.packageDir }, noNode);
  check('B7 缺 node 路径 -> null 且**不起**子进程', r1.ok === null && noNode.calls.length === 0, r1.detail);
  const noDir = fakeRun(() => okPass());
  const r2 = probeUnit(t, { nodeBin: CTX.nodeBin, packageDir: null }, noDir);
  check('B8 不知道 Agent 装在哪 -> null 且**不起**子进程（解析域未知跑出的是假结论）',
    r2.ok === null && noDir.calls.length === 0, r2.detail);
}

// ── C 组：批处理与汇总 ──
{
  const units = [unit({ node: 'a' }, 'u-true'), unit({ node: 'b' }, 'u-false'),
    unit({ notApplicable: '本内核不调用该件，也不需要它的字节' }, 'u-na'),
    unit({ node: 'c' }, 'u-throw')];
  const { run } = fakeRun((s) => {
    if (s === 'c') throw new Error('boom');
    return s === 'b' ? failRc('nope') : okPass();
  });
  const caps = probeUnits(units, CTX, { run });
  check('C1 每格都有条目（一格不落，空白格=未知而不是通过）',
    Object.keys(caps).join(',') === 'u-true,u-false,u-na,u-throw', Object.keys(caps).join(','));
  check('C2 某格执行器抛错只影响该格（其余格结论留着）',
    caps['u-throw'].ok === null && caps['u-true'].ok === true && caps['u-false'].ok === false,
    caps['u-throw'].detail);
  check('C3 红优先于未知：有 false 就 false', overall(caps) === false, overall(caps));
  check('C4 全 true 才是 true', overall(probeUnits([unit({ node: 'a' }, 'x')], CTX, { run: fakeRun(() => okPass()).run })) === true);
  const only = probeUnits([unit({ node: 'a' }, 'x'), unit({ notApplicable: '本内核不调用该件，也不需要它的字节' }, 'y')], CTX, { run: fakeRun(() => okPass()).run });
  check('C5 没有红但有未知 -> null（不许报全通）', overall(only) === null, overall(only));
  check('C6 没跑过（空表）-> null，不是 true', overall({}) === null && overall(null) === null);
}

// ── D 组：真表接线 + 定罪案底 ──
{
  const units = TABLE_UNITS;
  check('D1 供给表非空（表空=核验整体空转）', units.length >= 8, units.length + ' 格');

  const executable = units.filter(isExecutable);
  check('D2 真表有 5 格以上可执行判据', executable.length >= 5, executable.length + ' 格');

  const allPass = probeUnits(units, CTX, { run: fakeRun(() => okPass('1')).run });
  const passTrue = executable.filter((u) => allPass[u.id].ok === true).length;
  check('D3 恒打标记的执行器下，可执行格全部转 true（判据没有静默失效）',
    passTrue === executable.length, passTrue + '/' + executable.length);
  const excused = units.filter(isExcused);
  const naCount = excused.filter((u) => allPass[u.id].ok === null).length;
  check('D4 免检/待做的格恒为未知（执行器再宽容也不替它背书）',
    naCount === excused.length && excused.length > 0, naCount + '/' + excused.length);
  check('D5 当前真表 overall 是 null 而非 true（挂起+不适用=诚实地说不知道）',
    overall(allPass) === null, String(overall(allPass)));

  // 定罪案底：投放全绿（applied）而 sharp 能力为红 —— 两个结论必须各说各话。
  const sharp = units.find((u) => u.id === 'sharp-image');
  const sharpScript = sharp && sharp.verify ? sharp.verify.node : null;
  check('D6 sharp-image 有可执行判据（不是「文件在不在」那句老话）',
    isExecutable(sharp) && sharpScript.includes(PASS), typeof sharpScript);
  const sharpRed = probeUnits(units, CTX, {
    run: fakeRun((s) => (s === sharpScript
      ? failRc('Could not load the "sharp" image library: Cannot find module @img/sharp-android-arm64')
      : okPass('1'))).run,
  });
  const supplyOutcome = { 'sharp-image': { status: 'applied' }, ripgrep: { status: 'applied' } };
  check('D7 案底复现：投放结局 applied 而能力 false -> overall false（applied 不稀释红）',
    supplyOutcome['sharp-image'].status === 'applied' && sharpRed['sharp-image'].ok === false && overall(sharpRed) === false,
    'units=applied, caps=' + sharpRed['sharp-image'].ok + ', overall=' + overall(sharpRed));
  check('D8 除 sharp 外其余格结论不受影响（逐格独立）',
    Object.keys(sharpRed).filter((k) => sharpRed[k].ok === false).join(',') === 'sharp-image' &&
    executable.every((u) => u.id === 'sharp-image' || allPass[u.id].ok === true),
    Object.keys(sharpRed).filter((k) => sharpRed[k].ok === false).join(','));
}

// ── E 组：反向自证（这些判据必须能红）──
{
  const t = unit({ node: NODE_SCRIPT });
  const greenish = probeUnit(t, CTX, { run: () => ({ ok: true, code: 0, stdout: 'everything looks fine' }) });
  check('E1 对照组：只退 0 不打标记必须被判红（否则"退 0 即过"死灰燃）', greenish.ok === false, greenish.detail);
  const spawnFail = probeUnit(t, CTX, { run: () => notSpawnable('Error: spawn /x/node EPERM') });
  check('E2 对照组：spawn 失败正则能命中 EPERM（否则 A4/A5 是永不红的死规则）', spawnFail.ok === null, spawnFail.detail);
  const ranButFailed = probeUnit(t, CTX, { run: () => ({ ok: false, code: 2, error: 'Command failed', stdout: '', stderr: 'boom' }) });
  check('E3 对照组：跑起来了但非零退出必须是 false（有 error 文案也不许滑成 null）', ranButFailed.ok === false, ranButFailed.detail);
  check('E4 表里的判据脚本与执行器用的是同一个标记常量（不各写一把尺）',
    PASS.length > 4 && TABLE_UNITS.filter(isExecutable).every((u) => u.verify.node.includes(PASS)));
  check('E5 三态里没有第四态：所有返回值的 ok 只能是 true/false/null',
    [probeUnit(t, CTX, { run: () => okPass() }), probeUnit(t, CTX, { run: () => failRc('x') }),
      probeUnit({ id: 'none' }, CTX, { run: () => okPass() })]
      .every((r) => r.ok === true || r.ok === false || r.ok === null));
  check('E6 每格结论带时间戳（面板要说"上次核验是什么时候"）',
    typeof probeUnit(t, CTX, { run: () => okPass() }).at === 'string');
}

const failed = results.filter((x) => !x);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
