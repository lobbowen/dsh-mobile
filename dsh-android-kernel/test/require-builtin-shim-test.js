#!/usr/bin/env node
'use strict';

// NARB JS 垫片 + --expose-internals 注入回归（2026-09-22，真机 dsh 秒退 exit:1 零输出）：
// dsh ≥0.1.5-rc.2 在 app-boot 硬 require node-addon-require-builtin（无 android-arm64
// 预编译件，安装走 --ignore-scripts 也不产本地件）→ boot 必死。守卫在 spawn 前幂等
// 投放 JS 垫片并注入 --expose-internals；非零退出时收集 dsh startup-*.log 崩溃报告尾部。
// 本测试同时验证：垫片投放/幂等/真实 node 子进程的 requireBuiltin 语义（含原生委派
// 零损伤路径）、契约门控（PC 无契约行为逐字不变）、spawn 命令注入、startup 报告取证。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'narb-shim-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

const shimMod = require(path.join(ROOT, 'src', 'guard', 'native', 'require-builtin-shim'));
const SHIM_MARKER = 'dsh-android-kernel:narb-js-shim:v1';

const THROWS = 'throw new Error("No usable native binding found (simulated)")';
const NATIVE_OK = 'module.exports = { requireBuiltin: (id) => "NATIVE:" + id, isAllowedInternalId: () => true, getNativeBindingInfo: () => ({ abi: "node-v9" }) }';

function mkPkg(dir, mainRel, mainSrc) {
  fs.mkdirSync(path.join(dir, path.dirname(mainRel)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'node-addon-require-builtin', version: '0.1.6', main: mainRel }));
  fs.writeFileSync(path.join(dir, mainRel), mainSrc);
  return path.join(dir, mainRel);
}

// 真实 node 子进程调用垫片：{entry, id} → stdout 单行结果
function probe(entry, id, withFlag) {
  const code = `const m=require(${JSON.stringify(entry)});try{console.log("OK:"+String(m.requireBuiltin(${JSON.stringify(id)}).Module!==undefined))}catch(e){console.log("ERR:"+e.message)}`;
  const args = withFlag ? ['--expose-internals', '-e', code] : ['-e', code];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
  return (r.stdout || '').trim();
}
function probeNative(entry) {
  const code = `const m=require(${JSON.stringify(entry)});try{console.log("R:"+m.requireBuiltin("whatever"))}catch(e){console.log("ERR:"+e.message)}`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 15000 });
  return (r.stdout || '').trim();
}

(async () => {
  // ── S1 ensureShim：定位（扁平 + @scope 嵌套）、投放、备份、幂等 ──
  const root1 = path.join(TMP, 'npmroot1');
  const flat = mkPkg(path.join(root1, 'node-addon-require-builtin'), 'lib/index.js', THROWS);
  const nested = mkPkg(path.join(root1, '@deepseek-ai/dsh-app-boot/node_modules/node-addon-require-builtin'), 'index.js', THROWS);
  let r = shimMod.ensureShim(root1);
  check('S1 两份副本（扁平+嵌套）都被投放', r.found === 2 && r.results.filter((x) => x.status === 'applied').length === 2, JSON.stringify(r.results));
  check('S1 垫片入口带版本戳', fs.readFileSync(flat, 'utf8').includes(SHIM_MARKER) && fs.readFileSync(nested, 'utf8').includes(SHIM_MARKER));
  check('S1 原实现备份逐字保留', fs.readFileSync(path.join(path.dirname(flat), 'index.dsh-orig.js'), 'utf8') === THROWS);
  const after = fs.readFileSync(flat, 'utf8');
  r = shimMod.ensureShim(root1);
  check('S1 二次调用幂等（already，不重复套娃）', r.results.every((x) => x.status === 'already') && fs.readFileSync(flat, 'utf8') === after);
  check('S1 npmRoot 缺失/无包时安全空转', shimMod.ensureShim(null).found === 0 && shimMod.ensureShim(path.join(TMP, 'nope')).found === 0);

  // ── S2 真实 node 子进程语义：无 flag 清晰报错；有 flag 取到内部模块；原生可加载时委派 ──
  check('S2 无 --expose-internals：报可读错误（不静默）', probe(flat, 'internal/modules/cjs/loader', false).includes('without --expose-internals'), probe(flat, 'internal/modules/cjs/loader', false));
  check('S2 有 --expose-internals：requireBuiltin 取到真实内部模块', probe(flat, 'internal/modules/cjs/loader', true) === 'OK:true', probe(flat, 'internal/modules/cjs/loader', true));
  const natRoot = path.join(TMP, 'nat-root');
  const natMain = mkPkg(path.join(natRoot, 'node-addon-require-builtin'), 'lib/index.js', NATIVE_OK);
  shimMod.ensureShim(natRoot);
  check('S2 原生绑定可加载：逐字委派零损伤（无需 flag）', probeNative(natMain) === 'R:NATIVE:whatever', probeNative(natMain));

  // ── S3 NativeManager.ensureRequireBuiltinShim：契约门控 + 事件记账 ──
  const { NativeManager } = require(path.join(ROOT, 'src', 'guard', 'native', 'manager.js'));
  const runtimeContract = require(path.join(ROOT, 'src', 'platform', 'runtime-contract'));
  const events3 = [];
  const nmConfig = { command: ['node', 'dsh', 'web'], packageName: '@deepseek-ai/dsh', targetPort: 3080 };
  const nm = new NativeManager({ config: nmConfig, logger: { info() {}, warn() {}, error() {} }, events: { append: (n, d) => events3.push({ n, d }) }, stateDir: path.join(TMP, 'state3'), npmRoot: root1 });
  fs.rmSync(runtimeContract.file(), { force: true });
  check('S3 无契约（PC）→ 不动作', nm.ensureRequireBuiltinShim() === null);
  const npmEntryFile = path.join(TMP, 'fake-npm-cli.js');
  fs.writeFileSync(npmEntryFile, '//');
  const contractFile = runtimeContract.file();
  const writeContract = () => { fs.mkdirSync(path.dirname(contractFile), { recursive: true }); fs.writeFileSync(contractFile, JSON.stringify({ schema: 2, nodePath: process.execPath, npmEntry: npmEntryFile, nodeBinDir: path.dirname(process.execPath) })); };
  writeContract();
  // 还原被 S1 二次调用前的原始形态以观察 applied（重新投放到新根）
  const root3 = path.join(TMP, 'npmroot3');
  mkPkg(path.join(root3, 'node-addon-require-builtin'), 'lib/index.js', THROWS);
  nm.npmRoot = root3;
  const r3 = nm.ensureRequireBuiltinShim();
  check('S3 有契约 → 投放成功并记事件', r3 && r3.results.some((x) => x.status === 'applied') && events3.some((e) => e.n === 'narb_shim_applied'), JSON.stringify(events3));
  check('S3 ensureRequireBuiltinShim 后 npmRoot 持久生效', (() => { nm.npmRoot = root1; const x = nm.ensureRequireBuiltinShim(); return x && x.results.every((y) => y.status === 'already'); })());
  nmConfig.command = [process.execPath, flat, 'web', '--no-open'];  const inv = nm.dshCliInvocation();
  check('S3 dshCliInvocation 代跑形态带 flag', !!inv && inv.args[0] === '--expose-internals' && inv.args[1] === flat, JSON.stringify(inv || null));
  fs.rmSync(contractFile, { force: true });
  check('S3 无契约 → dshCliInvocation 退回 null（PC 逐字不变）', nm.dshCliInvocation() === null);

  // ── S3b 覆盖安装自愈（真机 2026-09-23：/data/app 随机段目录随重装消失，
  //    持久化 command[0] 变死路径 → ENOENT 60s 冷静期死循环）──
  const staleSo = path.join(TMP, 'dead-install-SvdHit', 'lib', 'arm64', 'libnode.so');
  const liveSo = path.join(TMP, 'live-install-gf2ok', 'lib', 'arm64', 'libnode.so');
  fs.mkdirSync(path.dirname(liveSo), { recursive: true }); fs.writeFileSync(liveSo, '#!/x');
  const persisted = [];
  const evb = [];
  const mkb = (cmd) => new NativeManager({ config: { command: cmd, packageName: '@deepseek-ai/dsh', targetPort: 3080 }, logger: { info() {}, warn() {}, error() {} }, events: { append: (n, d) => evb.push({ n, d }) }, stateDir: path.join(TMP, 'state3b'), persistCommand: (p) => persisted.push(JSON.parse(JSON.stringify(p))) });
  const nmPc = mkb([staleSo, flat, 'web', '--no-open']);
  check('S3b 无契约（PC）→ 绝不改命令', nmPc.repairLaunchNodePath() === false && nmPc.config.command[0] === staleSo && persisted.length === 0);
  writeContract(); // nodePath = process.execPath（存在）
  const nm1 = mkb([staleSo, flat, 'web', '--no-open']);
  check('S3b 死绝对路径 + 契约 nodePath 在场 → 修复+回写+记事件', nm1.repairLaunchNodePath() === true && nm1.config.command[0] === process.execPath && persisted.length === 1 && JSON.stringify(persisted[0].command) === JSON.stringify([process.execPath, flat, 'web', '--no-open']) && evb.some((e) => e.n === 'native_launch_node_repaired' && e.d.from === staleSo && e.d.to === process.execPath), JSON.stringify(evb.map((e) => e.n)));
  check('S3b 二次调用幂等（路径已存活）', nm1.repairLaunchNodePath() === false && persisted.length === 1);
  const nm2 = mkb(['node', 'dsh', 'web']);
  check('S3b 裸名/相对命令（PC 模板）不动', nm2.repairLaunchNodePath() === false && nm2.config.command[0] === 'node');
  const nm3 = mkb([liveSo, flat, 'web', '--no-open']);
  check('S3b command[0] 仍存在 → 不动', nm3.repairLaunchNodePath() === false && nm3.config.command[0] === liveSo);
  const nm4 = mkb([staleSo, flat, 'web', '--no-open']);
  fs.writeFileSync(contractFile, JSON.stringify({ schema: 2, nodePath: staleSo, npmEntry: npmEntryFile, nodeBinDir: path.dirname(process.execPath) }));
  nm4.repairLaunchNodePath();
  check('S3b 契约 nodePath 也失效 → 回退 process.execPath（本进程镜像即容器实际解释器）', nm4.config.command[0] === process.execPath);
  writeContract();
  check('S3b dshCliInvocation 消费前同批自愈', (() => { const nm5 = mkb([staleSo, flat, 'web', '--no-open']); const i5 = nm5.dshCliInvocation(); return i5 && i5.bin === process.execPath && nm5.config.command[0] === process.execPath; })());
  fs.rmSync(contractFile, { force: true });

  // ── S4 Supervisor._startProcess：spawn 前自愈 + flag 注入（makeFake 形态）──
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => (String(chunk).startsWith('[stderr]') ? true : realErr(chunk, ...rest));
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  check('_androidLaunchReady 已注入 Supervisor.prototype', typeof Supervisor.prototype._androidLaunchReady === 'function');
  check('_collectStartupReports 已注入 Supervisor.prototype', typeof Supervisor.prototype._collectStartupReports === 'function');
  const makeFake = (dshLogFile, shimCalls) => {
    const events = [];
    const fake = Object.create(Supervisor.prototype);
    fake.config = { dshLogFile, startTimeoutMs: 5000, command: ['stub'] };
    fake.events = { append: (n, d) => events.push({ n, d }) };
    fake.log = events;
    fake.logger = { info() {}, warn() {}, error() {} };
    fake.nativeManager = { status: () => ({ installed: true, binPath: 'x' }), ensureRequireBuiltinShim: () => { shimCalls.n++; return { found: 0, results: [] }; } };
    fake.tokenService = { feedLine: () => {} };
    fake.dshWriter = { write: () => {} };
    fake.notify = () => {};
    fake.writeState = () => {};
    fake._actNote = () => {};
    fake._reapOrphanDshLocks = () => [];
    fake._beginRestart = () => {};
    fake._stopping = false;
    let child = null; let phase = 'STOPPED';
    fake._mSetChild = (c) => { child = c; }; fake._mChild = () => child;
    fake._mSetAdopted = () => {}; fake._mSetAdoptPid = () => {};
    fake._mSetPhase = (p) => { phase = p; }; fake._mPhase = () => phase;
    fake._mSetStartDeadline = () => {}; fake._mDesired = () => 'stopped'; fake._mGuardian = () => true;
    fake._mSetFailStreak = () => {}; fake._mSetSpawnBlockedUntil = () => {};
    fake._mMissingNotified = () => false; fake._mSetMissingNotified = () => {};
    return fake;
  };
  const entryJs = path.join(TMP, 'fake-dsh-entry.js');
  fs.writeFileSync(entryJs, 'process.stdout.write("BOOT-OK\\n"); process.exit(0)');
  const shimCalls = { n: 0 };

  // PC 形态（无契约）：命令逐字不变、不调用自愈
  const f0 = makeFake(path.join(TMP, 'dsh0.log'), shimCalls);
  f0.spawnCommand = () => [process.execPath, entryJs, 'web', '--no-open'];
  const same = f0._androidLaunchReady(f0.spawnCommand());
  check('S4 无契约 → 命令原样 + 不触自愈', same[1] === entryJs && shimCalls.n === 0, JSON.stringify(same));

  writeContract();
  const f1 = makeFake(path.join(TMP, 'dsh1.log'), shimCalls);
  f1.spawnCommand = () => [process.execPath, entryJs, 'web', '--no-open'];
  check('S4 有契约 → flag 插在 node 与入口之间且只一次', (() => { const c = f1._androidLaunchReady(f1.spawnCommand()); return JSON.stringify(c) === JSON.stringify([process.execPath, '--expose-internals', entryJs, 'web', '--no-open']) && JSON.stringify(f1._androidLaunchReady(c)) === JSON.stringify(c); })());
  const c1 = f1._androidLaunchReady(f1.spawnCommand());
  check('S4 有契约 → spawn 前调用 ensureRequireBuiltinShim', shimCalls.n > 0, 'calls=' + shimCalls.n);

  const waitFor = async (fn, ms, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((x) => setTimeout(x, 50)); }
    throw new Error('超时等待: ' + label);
  };
  await f1._startProcess();
  await waitFor(() => f1.log.some((e) => e.n === 'dsh_exited'), 8000, 'dsh_exited(S4)');
  const spawnEv = f1.log.find((e) => e.n === 'spawn');
  check('S4 实际 spawn 命令带 flag', spawnEv.d.command[1] === '--expose-internals' && spawnEv.d.command[2] === entryJs, JSON.stringify(spawnEv.d.command));
  check('S4 注入 flag 后子进程正常启动退出码 0', f1.log.find((e) => e.n === 'dsh_exited').d.code === 0);

  // ── S5 非零退出取证：本轮 startup-*.log 尾部进 dsh_exited，旧报告不顶缸 ──
  const dshHome = path.join(TMP, 'dsh-home');
  fs.mkdirSync(path.join(dshHome, 'logs'), { recursive: true });
  const stale = path.join(dshHome, 'logs', 'startup-stale.log');
  fs.writeFileSync(stale, 'STALE-REPORT-MUST-NOT-APPEAR');
  const back = new Date(Date.now() - 3600e3);
  fs.utimesSync(stale, back, back);
  process.env.DSH_HOME = dshHome;
  const entryCrash = path.join(TMP, 'fake-dsh-crash.js');
  fs.writeFileSync(entryCrash, `const fs=require('node:fs'),p=require('node:path');
fs.mkdirSync(p.join(${JSON.stringify(dshHome)},'logs'),{recursive:true});
fs.writeFileSync(p.join(${JSON.stringify(dshHome)},'logs','startup-'+Date.now()+'-uuid.log'),'BOOT-STAGE: host preparation failed\\nDETAIL-MARKER-XYZ\\n');
process.exit(1);`);
  const f2 = makeFake(path.join(TMP, 'dsh2.log'), shimCalls);
  f2.spawnCommand = () => [process.execPath, entryCrash, 'web'];
  await f2._startProcess();
  await waitFor(() => f2.log.some((e) => e.n === 'dsh_exited'), 8000, 'dsh_exited(S5)');
  const ex5 = f2.log.find((e) => e.n === 'dsh_exited');
  const reports = ex5.d.startupReports || [];
  check('S5 本轮崩溃报告尾部进 dsh_exited', reports.length === 1 && reports[0].tail.some((l) => l.includes('DETAIL-MARKER-XYZ')), JSON.stringify(reports.map((x) => x.file)));
  check('S5 旧报告（mtime 早于本轮）不顶缸', !JSON.stringify(reports).includes('STALE'));
  const ex5b = reports[0] && reports[0].tail.some((l) => l.includes('host preparation failed'));
  check('S5 报告内容完整可读（含 boot 阶段行）', !!ex5b);

  const failed = results.filter((x) => !x);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
