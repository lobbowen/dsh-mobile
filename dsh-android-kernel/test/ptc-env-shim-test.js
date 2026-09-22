#!/usr/bin/env node
'use strict';

// PTC 环境垫片回归（2026-09-23，真机报告「新启动的 Node 子进程全部崩溃：
// libnode.so 符号 __ndk1… 缺失」）：dsh-ptc-runtime-node 把除
// STARTUP_ENVIRONMENT_NAMES 外的全部父 env 置空剔除，Android linker 只认
// LD_LIBRARY_PATH/DT_RUNPATH ⇒ libnode.so 子进程加载不到 libc++_shared.so 必崩。
// 修复=白名单文本补丁（守卫锚点投放）。本测试钉：真实 vendor 字节上的锚点命中
// 与补丁结构、幂等、锚点防呆、补丁后语法可解析（node --check）、**从补丁后文件
// 提取真实 Set 源码在子进程实测过滤语义**（LD_LIBRARY_PATH 幸存、无关机密仍剔除）、
// manager 双重门控、spawn 前接线。安全门禁 A：注入全部走 env + 文件。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'ptc-env');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ptc-env-shim-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); }

const shimMod = require(path.join(ROOT, 'src', 'guard', 'native', 'ptc-env-shim'));
const SHIM_MARKER = 'dsh-android-kernel:ptc-env-shim:v1';
const PKG = '@deepseek-ai/dsh-ptc-runtime-node';

function buildTree(root) {
  const p = path.join(root, PKG);
  fs.mkdirSync(path.join(p, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name: PKG.slice(1), version: '0.0.0', type: 'module' }));
  fs.writeFileSync(path.join(p, 'lib', 'index.js'), fs.readFileSync(path.join(FIX, 'ptc-runtime-node-index.js'), 'utf8'));
  return p;
}
const hits = (s, needle) => s.split(needle).length - 1;

(async () => {
  // ── G1 部署器：真实 vendor 字节命中、备份逐字、幂等、锚点防呆 ──
  const orig = fs.readFileSync(path.join(FIX, 'ptc-runtime-node-index.js'), 'utf8');
  check('G1 夹具锚点在原始字节恰命中 1 次', hits(orig, shimMod.REPLACEMENT[0]) === 1);
  const root1 = path.join(TMP, 'npmroot1');
  const p1 = buildTree(root1);
  const fp = path.join(p1, 'lib', 'index.js');
  let r = shimMod.ensureShim(root1);
  check('G1 投放成功', r.found === 1 && r.results[0].status === 'applied', JSON.stringify(r.results));
  const patched = fs.readFileSync(fp, 'utf8');
  check('G1 白名单含 LD_LIBRARY_PATH 且 marker 落位', hits(patched, SHIM_MARKER) === 1 && /"LD_LIBRARY_PATH",/.test(patched));
  check('G1 备份逐字保留', fs.readFileSync(path.join(p1, 'lib', 'index.dsh-orig.js'), 'utf8') === orig);
  r = shimMod.ensureShim(root1);
  check('G1 二次调用幂等（already，字节不变）', r.results.every((x) => x.status === 'already') && fs.readFileSync(fp, 'utf8') === patched);
  const root2 = path.join(TMP, 'npmroot2');
  const p2 = buildTree(root2);
  const fp2 = path.join(p2, 'lib', 'index.js');
  fs.writeFileSync(fp2, fs.readFileSync(fp2, 'utf8').replace('"PATHEXT",', '"PATHEXT2",'));
  const before2 = fs.readFileSync(fp2, 'utf8');
  const r2 = shimMod.ensureShim(root2);
  check('G1 锚点命中数≠1 → 整文件不动并报 failed', r2.results[0].status === 'failed' && /锚点/.test(r2.results[0].error) && fs.readFileSync(fp2, 'utf8') === before2 && !fs.existsSync(path.join(p2, 'lib', 'index.dsh-orig.js')), JSON.stringify(r2.results));
  check('G1 空根/缺包安全空转', shimMod.ensureShim(null).found === 0 && shimMod.ensureShim(path.join(TMP, 'nope')).found === 0);

  // ── G1b 补丁后语法可解析（ESM 借 .mjs 判定） ──
  const cp = path.join(TMP, 'syntax-check.mjs');
  fs.writeFileSync(cp, patched);
  const cc = spawnSync(process.execPath, ['--check', cp], { encoding: 'utf8', timeout: 30000 });
  check('G1b 补丁后语法可解析', cc.status === 0, (cc.stderr || '').slice(0, 200));

  // ── G2 语义实测：从补丁后**真实字节**提取 Set 源码，在子进程复刻 env 构造管线 ──
  const setSrc = patched.match(/const STARTUP_ENVIRONMENT_NAMES = new Set\(\[[\s\S]*?\]\);/);
  check('G2 可从补丁后文件提取 Set 源码', !!setSrc);
  const code = `${setSrc[0]}
const parent = { PATH: '/p', HOME: '/h', TMP: '/t', LD_LIBRARY_PATH: '/nativeroot', DEEPSEEK_API_KEY: 'sk-x', DSH_FLOCK_NATIVE: '/a/b', SHELL: '/bin/sh' };
const env = Object.fromEntries(Object.keys(parent).filter((key) => !STARTUP_ENVIRONMENT_NAMES.has(key.toUpperCase()) && key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE').map((key) => [key, void 0]));
// targetEnvironment 的剔除语义：undefined 值键被最终环境丢弃
const merged = { ...parent, ...env };
const final = Object.fromEntries(Object.entries(merged).filter((e) => e[1] !== void 0));
console.log(JSON.stringify(Object.keys(final).sort()));`;
  const child = path.join(TMP, 'semantics.mjs');
  fs.writeFileSync(child, code);
  const rr = spawnSync(process.execPath, [child], { encoding: 'utf8', timeout: 30000 });
  let keys = [];
  try { keys = JSON.parse(rr.stdout.trim()); } catch {}
  check('G2 补丁后 LD_LIBRARY_PATH 在子进程幸存', keys.includes('LD_LIBRARY_PATH'), rr.stdout + (rr.stderr || '').slice(0, 200));
  check('G2 非白名单机密仍被剔除（DEEPSEEK_API_KEY/DSH_*/SHELL/HOME）', !keys.includes('DEEPSEEK_API_KEY') && !keys.includes('DSH_FLOCK_NATIVE') && !keys.includes('SHELL') && !keys.includes('HOME'), rr.stdout);
  check('G2 PATH/TMP 保留语义不变', keys.includes('PATH') && keys.includes('TMP'), rr.stdout);

  // ── G3 NativeManager.ensurePtcEnvShim：契约 × 设备标记双重门控 ──
  const { NativeManager } = require(path.join(ROOT, 'src', 'guard', 'native', 'manager.js'));
  const runtimeContract = require(path.join(ROOT, 'src', 'platform', 'runtime-contract'));
  const contractFile = runtimeContract.file();
  const savedContract = fs.existsSync(contractFile) ? fs.readFileSync(contractFile, 'utf8') : null;
  const npmEntryFile = path.join(TMP, 'fake-npm-cli.js');
  fs.writeFileSync(npmEntryFile, '//');
  const writeContract = () => { fs.mkdirSync(path.dirname(contractFile), { recursive: true }); fs.writeFileSync(contractFile, JSON.stringify({ schema: 2, nodePath: process.execPath, npmEntry: npmEntryFile, nodeBinDir: path.dirname(process.execPath) })); };
  const events3 = [];
  const nm = new NativeManager({ config: { command: ['node', 'dsh', 'web'], packageName: '@deepseek-ai/dsh', targetPort: 3080 }, logger: { info() {}, warn() {}, error() {} }, events: { append: (n, d) => events3.push({ n, d }) }, stateDir: path.join(TMP, 'state3') });
  const savedFlk = process.env.DSH_FLOCK_NATIVE;
  try {
    fs.rmSync(contractFile, { force: true });
    process.env.DSH_FLOCK_NATIVE = path.join(TMP, 'fake-libdshflock.so');
    check('G3 无契约（PC）→ 不动作', nm.ensurePtcEnvShim() === null);
    writeContract();
    delete process.env.DSH_FLOCK_NATIVE;
    const root3 = path.join(TMP, 'npmroot3');
    const p3 = buildTree(root3);
    nm.npmRoot = root3;
    check('G3 有契约但无设备标记 env → 树不动', nm.ensurePtcEnvShim() === null && !fs.readFileSync(path.join(p3, 'lib', 'index.js'), 'utf8').includes(SHIM_MARKER));
    process.env.DSH_FLOCK_NATIVE = '/data/app/fake/lib/arm64/libdshflock.so';
    const r3 = nm.ensurePtcEnvShim();
    check('G3 契约+设备标记 → 投放并记事件', r3 && r3.results[0].status === 'applied' && events3.filter((e) => e.n === 'ptc_env_shim_applied').length === 1 && nm.ptcEnvShimApplied === true, JSON.stringify(events3.map((e) => e.n)));
  } finally {
    if (savedContract !== null) fs.writeFileSync(contractFile, savedContract); else fs.rmSync(contractFile, { force: true });
    if (savedFlk === undefined) delete process.env.DSH_FLOCK_NATIVE; else process.env.DSH_FLOCK_NATIVE = savedFlk;
  }

  // ── G4 Supervisor._androidLaunchReady：spawn 前四垫片同批 ──
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const calls = { narb: 0, flock: 0, link: 0, ptc: 0 };
  const fake = Object.create(Supervisor.prototype);
  fake.logger = { info() {}, warn() {}, error() {} };
  fake.nativeManager = {
    ensureRequireBuiltinShim: () => { calls.narb++; },
    ensureFlockShim: () => { calls.flock++; },
    ensureLinkPublishShim: () => { calls.link++; },
    ensurePtcEnvShim: () => { calls.ptc++; },
  };
  writeContract();
  try {
    fake._androidLaunchReady([process.execPath, path.join(TMP, 'fake-entry.js'), 'web']);
    check('G4 spawn 前四垫片同批调用', calls.narb > 0 && calls.flock > 0 && calls.link > 0 && calls.ptc > 0, JSON.stringify(calls));
    fs.rmSync(contractFile, { force: true });
    calls.ptc = 0;
    fake._androidLaunchReady([process.execPath, 'dsh', 'web']);
    check('G4 无契约（PC）→ 不触发自愈', calls.ptc === 0);
  } finally { fs.rmSync(contractFile, { force: true }); }

  const failed = results.filter((x) => !x);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
