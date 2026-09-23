#!/usr/bin/env node
'use strict';

// flock 原生垫片回归（2026-09-23，真机「发消息 → 本轮运行失败 flock is not supported
// on android-arm64」）：dsh 会话持久化硬依赖 @deepseek-ai/node-addon-system/flock 的
// tryLockExclusive（真 flock(2) 排他锁），上游无 android-arm64 预编译件。修复=CI NDK
// 现编 libdshflock.so 进 jniLibs + 容器递 DSH_FLOCK_NATIVE + 守卫幂等投放垫片。
// 本测试验证：投放/备份/幂等/定位（扁平+嵌套）、真实 node 子进程的 ESM 垫片语义
// （errno→错误面逐字一致、原生不可用时逐字委派原始实现）、manager 双重门控
// （契约 × DSH_FLOCK_NATIVE）、spawn 前自愈接线。安全门禁 A：只经 env/文件注入，
// 不 patch 任何模块导出。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-shim-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); }

const shimMod = require(path.join(ROOT, 'src', 'guard', 'native', 'flock-shim'));
const SHIM_MARKER = 'dsh-android-kernel:flock-native-shim:v1';

// vendor @deepseek-ai/node-addon-system@0.1.2 lib/flock.js 逐字副本（真机报错源），
// 固化在 fixtures —— 不依赖 /tmp 解包残留。
const VENDOR_SRC = fs.readFileSync(path.join(__dirname, 'fixtures', 'vendor-node-addon-system-flock.js'), 'utf8');

function mkVendorPkg(dir) {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/node-addon-system', version: '0.1.2', type: 'module' }));
  fs.writeFileSync(path.join(dir, 'lib', 'flock.js'), VENDOR_SRC);
  return path.join(dir, 'lib', 'flock.js');
}

// 真实 node 子进程调垫片：ESM 入口 + env 注入，stdout 单行结果
function probe(entry, env) {
  const code = `import(${JSON.stringify('file://' + entry)}).then(async (m) => {
  try { const r = await m.tryLockExclusive(7); console.log('RESOLVED' + (r === undefined ? '' : ':' + r)); }
  catch (e) { console.log('ERR:' + [e.code, e.errno, e.syscall, e.message].join(':')); }
}, (e) => console.log('IMPORT-FAIL:' + e.message));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', timeout: 15000, env: Object.assign({}, process.env, env || {}),
  });
  return (r.stdout || '').trim();
}

(async () => {
  if (!VENDOR_SRC.includes('ERR_FLOCK_UNSUPPORTED_PLATFORM')) {
    check('F0 vendor 夹具在位（test/fixtures）', false, '夹具内容异常');
    const failed0 = results.filter((x) => !x);
    console.log('\n结果: ' + (results.length - failed0.length) + ' passed, ' + failed0.length + ' failed');
    process.exit(1);
  }

  // ── F1 ensureShim：定位（扁平 + 嵌套）、投放、备份逐字、幂等、空转 ──
  const root1 = path.join(TMP, 'npmroot1');
  const flat = mkVendorPkg(path.join(root1, '@deepseek-ai', 'node-addon-system'));
  const nested = mkVendorPkg(path.join(root1, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'node-addon-system'));
  let r = shimMod.ensureShim(root1);
  check('F1 两份副本（扁平+嵌套）都被投放', r.found === 2 && r.results.filter((x) => x.status === 'applied').length === 2, JSON.stringify(r.results));
  check('F1 垫片入口带版本戳', fs.readFileSync(flat, 'utf8').includes(SHIM_MARKER) && fs.readFileSync(nested, 'utf8').includes(SHIM_MARKER));
  check('F1 原实现备份逐字保留', fs.readFileSync(path.join(path.dirname(flat), 'flock.dsh-orig.js'), 'utf8') === VENDOR_SRC);
  const after = fs.readFileSync(flat, 'utf8');
  r = shimMod.ensureShim(root1);
  check('F1 二次调用幂等（already，不重复套娃）', r.results.every((x) => x.status === 'already') && fs.readFileSync(flat, 'utf8') === after);
  check('F1 npmRoot 缺失/无包时安全空转', shimMod.ensureShim(null).found === 0 && shimMod.ensureShim(path.join(TMP, 'nope')).found === 0);

  // ── F2 真实 node 子进程语义：原生绑定 errno→错误面逐字一致；不可用时委派原始实现 ──
  // 委派夹具：把备份换成可判别桩（证明 import './flock.dsh-orig.js' 通道），投放到独立新根
  const root2 = path.join(TMP, 'npmroot2');
  const entry2 = mkVendorPkg(path.join(root2, '@deepseek-ai', 'node-addon-system'));
  shimMod.ensureShim(root2);
  fs.writeFileSync(path.join(path.dirname(entry2), 'flock.dsh-orig.js'),
    'export async function tryLockExclusive(fd) { return \'ORIGINAL_CALLED:\' + fd; }\n');
  check('F2 无 DSH_FLOCK_NATIVE（PC/旧 APK）→ 逐字委派原始实现', probe(entry2) === 'RESOLVED:ORIGINAL_CALLED:7', probe(entry2));
  check('F2 DSH_FLOCK_NATIVE 指不到可加载件 → 仍委派（旧 APK 无 .so 语义不变）', probe(entry2, { DSH_FLOCK_NATIVE: path.join(TMP, 'no-such-lib.so') }) === 'RESOLVED:ORIGINAL_CALLED:7', probe(entry2, { DSH_FLOCK_NATIVE: path.join(TMP, 'no-such-lib.so') }));

  const root3 = path.join(TMP, 'npmroot3');
  const entry3 = mkVendorPkg(path.join(root3, '@deepseek-ai', 'node-addon-system'));
  shimMod.ensureShim(root3);
  // 伪造绑定放独立目录并钉 type:commonjs —— 垫片经 createRequire 装载，目标类型须确定。
  const bindDir = path.join(TMP, 'binds');
  fs.mkdirSync(bindDir, { recursive: true });
  fs.writeFileSync(path.join(bindDir, 'package.json'), '{"type":"commonjs"}');
  const okBind = path.join(bindDir, 'fake-bind-ok.js');
  fs.writeFileSync(okBind, 'module.exports = { tryLock: (fd, cb) => cb(0) };\n');
  check('F2 原生绑定成功（errno=0）→ resolve', probe(entry3, { DSH_FLOCK_NATIVE: okBind }) === 'RESOLVED', probe(entry3, { DSH_FLOCK_NATIVE: okBind }));
  const eagainBind = path.join(bindDir, 'fake-bind-eagain.js');
  fs.writeFileSync(eagainBind, 'module.exports = { tryLock: (fd, cb) => cb(11) };\n');
  const out = probe(entry3, { DSH_FLOCK_NATIVE: eagainBind });
  check('F2 争用 errno=11 → EAGAIN 错误面与 vendor 逐字一致', out === 'ERR:EAGAIN:11:flock:EAGAIN: flock failed', out);
  const badBind = path.join(bindDir, 'fake-bind-no-trylock.js');
  fs.writeFileSync(badBind, 'module.exports = { somethingElse: () => {} };\n');
  check('F2 绑定缺 tryLock → 视为不可用（不误吞）', probe(entry2, { DSH_FLOCK_NATIVE: badBind }) === 'RESOLVED:ORIGINAL_CALLED:7', probe(entry2, { DSH_FLOCK_NATIVE: badBind }));

  // ── F3 NativeManager.ensureFlockShim：契约 × DSH_FLOCK_NATIVE 双重门控 + 事件记账 ──
  const { NativeManager } = require(path.join(ROOT, 'src', 'guard', 'native', 'manager.js'));
  const runtimeContract = require(path.join(ROOT, 'src', 'platform', 'runtime-contract'));
  const events3 = [];
  const nm = new NativeManager({ config: { command: ['node', 'dsh', 'web'], packageName: '@deepseek-ai/dsh', targetPort: 3080 }, logger: { info() {}, warn() {}, error() {} }, events: { append: (n, d) => events3.push({ n, d }) }, stateDir: path.join(TMP, 'state3'), npmRoot: root1 });
  const contractFile = runtimeContract.file();
  const savedContract = fs.existsSync(contractFile) ? fs.readFileSync(contractFile, 'utf8') : null;
  const npmEntryFile = path.join(TMP, 'fake-npm-cli.js');
  fs.writeFileSync(npmEntryFile, '//');
  const writeContract = () => { fs.mkdirSync(path.dirname(contractFile), { recursive: true }); fs.writeFileSync(contractFile, JSON.stringify({ schema: 2, nodePath: process.execPath, npmEntry: npmEntryFile, nodeBinDir: path.dirname(process.execPath) })); };
  const savedEnv = process.env.DSH_FLOCK_NATIVE;
  try {
    fs.rmSync(contractFile, { force: true });
    process.env.DSH_FLOCK_NATIVE = okBind;
    check('F3 无契约（PC）→ 不动作', nm.ensureFlockShim() === null);
    writeContract();
    delete process.env.DSH_FLOCK_NATIVE;
    const root4 = path.join(TMP, 'npmroot4');
    const entry4 = mkVendorPkg(path.join(root4, '@deepseek-ai', 'node-addon-system'));
    nm.npmRoot = root4;
    check('F3 有契约但无 DSH_FLOCK_NATIVE → 树不动（dev 语义不变）', nm.ensureFlockShim() === null && fs.readFileSync(entry4, 'utf8') === VENDOR_SRC && !fs.existsSync(path.join(path.dirname(entry4), 'flock.dsh-orig.js')));
    process.env.DSH_FLOCK_NATIVE = okBind;
    const r4 = nm.ensureFlockShim();
    check('F3 契约+env 双在 → 投放成功并记事件', r4 && r4.results.some((x) => x.status === 'applied') && events3.some((e) => e.n === 'flock_shim_applied') && nm.flockShimApplied === true, JSON.stringify(events3));
    check('F3 二次调用幂等（already 仍记 applied 状态）', (() => { const x = nm.ensureFlockShim(); return x && x.results.every((y) => y.status === 'already'); })());
  } finally {
    if (savedContract !== null) fs.writeFileSync(contractFile, savedContract); else fs.rmSync(contractFile, { force: true });
    if (savedEnv === undefined) delete process.env.DSH_FLOCK_NATIVE; else process.env.DSH_FLOCK_NATIVE = savedEnv;
  }

  // ── F4 Supervisor._androidLaunchReady：spawn 前同步投放 flock 垫片 ──
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => (String(chunk).startsWith('[stderr]') ? true : realErr(chunk, ...rest));
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const calls = { narb: 0, flock: 0 };
  const fake = Object.create(Supervisor.prototype);
  fake.logger = { info() {}, warn() {}, error() {} };
  fake.nativeManager = { ensureRequireBuiltinShim: () => { calls.narb++; }, ensureFlockShim: () => { calls.flock++; } };
  writeContract();
  try {
    const cmd = [process.execPath, path.join(TMP, 'fake-dsh-entry.js'), 'web', '--no-open'];
    const out4 = fake._androidLaunchReady(cmd);
    check('F4 spawn 前 ensureFlockShim 被调用（与 NARB 垫片同批）', calls.flock > 0 && out4[1] === '--expose-internals', JSON.stringify({ calls, out4 }));
    fs.rmSync(contractFile, { force: true });
    calls.flock = 0;
    fake._androidLaunchReady(cmd);
    check('F4 无契约（PC）→ 不触发自愈', calls.flock === 0);
  } finally {
    fs.rmSync(contractFile, { force: true });
    process.stderr.write = realErr;
  }

  const failed = results.filter((x) => !x);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
