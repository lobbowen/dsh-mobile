#!/usr/bin/env node
'use strict';

// 能力垫片回归（2026-09-23 全量平台门审计，真机报错
// "subprocess-local: terminal inspection is unsupported on platform android" +
// 报告「无 bash / 无 rg」）：4 处桌面硬编码接到容器 env 旋钮。本测试钉：
// 真实 vendor 字节上的锚点命中、glob 哈希名匹配（排除 .dsh-orig）、备份逐字、
// 幂等、锚点防呆、补丁后语法可解析（node --check，四包皆 ESM），并做**行为实测**：
// 从补丁后真实字节提取 createProcessInspector 在子进程复刻 —— android 必须落进
// LinuxProcessInspector 支路（终端报错的正解），darwin/win32 不变、freebsd 仍 throw；
// DSH_BASH_BIN 旋钮与 @vscode/ripgrep 的 DSH_RIPGREP_BIN 短路实测（env 缺席逐字
// 回退原语义）；manager 双重门控；spawn 前五垫片同批。安全门禁 A：注入走 env+文件。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'capability-env');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-env-shim-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); }

const shimMod = require(path.join(ROOT, 'src', 'guard', 'native', 'capability-env-shim'));
const SHIM_MARKER = 'dsh-android-kernel:capability-env-shim:v1';

const PKGS = {
  '@deepseek-ai/dsh-bash-local': ['lib', 'index.js', 'bash-local-index.js'],
  '@deepseek-ai/dsh-terminal-bash': ['lib', 'index.js', 'terminal-bash-index.js'],
  '@vscode/ripgrep': ['lib', 'index.js', 'vscode-ripgrep-index.js'],
  '@deepseek-ai/dsh-subprocess-local': ['lib', 'runner-launch-B2zsQ1Dz.js', 'subprocess-runner-launch-B2zsQ1Dz.js'],
};

function buildTree(root) {
  const map = {};
  for (const [pkg, [dir, file, fix]] of Object.entries(PKGS)) {
    const p = path.join(root, pkg);
    fs.mkdirSync(path.join(p, dir), { recursive: true });
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name: pkg.slice(1), version: '0.0.0', type: 'module' }));
    fs.writeFileSync(path.join(p, dir, file), fs.readFileSync(path.join(FIX, fix), 'utf8'));
    map[pkg] = path.join(p, dir, file);
  }
  // glob 防呆伴生件：不匹配前缀的真文件 + 匹配前缀的 .dsh-orig 残留，都必须不被触碰
  const sub = path.join(root, '@deepseek-ai', 'dsh-subprocess-local', 'lib');
  fs.writeFileSync(path.join(sub, 'runner.js'), '// 非目标文件\n');
  fs.writeFileSync(path.join(sub, 'runner-launch-DEADBEEF.dsh-orig.js'), '// orig 残留，不得作为目标\n');
  return map;
}
const hits = (s, needle) => s.split(needle).length - 1;
const childMjs = (name, code) => {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, code);
  return f;
};
const runMjs = (f, env) => spawnSync(process.execPath, [f], { encoding: 'utf8', timeout: 30000, env: env === null ? { PATH: process.env.PATH, npm_config_arch: '' } : { PATH: process.env.PATH, ...env } });

(async () => {
  // ── G1 部署器：真实 vendor 字节命中、备份逐字、幂等、锚点防呆、glob 边界 ──
  for (const t of shimMod.TARGETS) {
    const fix = PKGS[t.pkg][2];
    const cur = fs.readFileSync(path.join(FIX, fix), 'utf8');
    check('G1 夹具锚点恰命中 1 次 (' + t.pkg + ')', t.replacements.every(([from]) => hits(cur, from) === 1));
  }
  const root1 = path.join(TMP, 'npmroot1');
  const files1 = buildTree(root1);
  const origBytes = {};
  for (const [pkg, fp] of Object.entries(files1)) origBytes[pkg] = fs.readFileSync(fp, 'utf8');

  let r = shimMod.ensureShim(root1);
  check('G1 四目标全部 applied', r.found === 4 && r.results.every((x) => x.status === 'applied'), JSON.stringify(r.results));
  check('G1 glob 未误伤非目标/orig 残留', !r.results.some((x) => /runner\.js|\.dsh-orig/.test(x.file)));
  for (const [pkg, fp] of Object.entries(files1)) {
    const patched = fs.readFileSync(fp, 'utf8');
    const anchor = shimMod.TARGETS.find((t) => t.pkg === pkg).replacements[0][0];
    check('G1 补丁落位 (' + pkg + ')', hits(patched, SHIM_MARKER) === 1 && !patched.includes(anchor));
    const origPath = path.join(path.dirname(fp), path.basename(fp).replace(/\.js$/, '.dsh-orig.js'));
    check('G1 备份逐字 (' + pkg + ')', fs.readFileSync(origPath, 'utf8') === origBytes[pkg]);
  }
  const after1 = {};
  for (const [pkg, fp] of Object.entries(files1)) after1[pkg] = fs.readFileSync(fp, 'utf8');
  r = shimMod.ensureShim(root1);
  check('G1 二次调用幂等（already，字节不变）', r.results.every((x) => x.status === 'already') && Object.entries(files1).every(([pkg, fp]) => fs.readFileSync(fp, 'utf8') === after1[pkg]));

  const root2 = path.join(TMP, 'npmroot2');
  const files2 = buildTree(root2);
  const badFp = files2['@deepseek-ai/dsh-terminal-bash'];
  fs.writeFileSync(badFp, fs.readFileSync(badFp, 'utf8').replace('/bin/bash', '/bin/BROKEN'));
  const badBefore = fs.readFileSync(badFp, 'utf8');
  r = shimMod.ensureShim(root2);
  check('G1 锚点命中数≠1 → 该文件不动报 failed，其余照常', r.results.some((x) => x.status === 'failed' && /锚点/.test(x.error || '') && x.file.includes('terminal-bash')) && fs.readFileSync(badFp, 'utf8') === badBefore && !fs.existsSync(path.join(path.dirname(badFp), 'index.dsh-orig.js')) && r.results.filter((x) => x.status === 'applied').length === 3, JSON.stringify(r.results));
  check('G1 空根/缺包安全空转', shimMod.ensureShim(null).found === 0 && shimMod.ensureShim(path.join(TMP, 'nope')).found === 0);

  // ── G1b 补丁后语法可解析（四包皆 ESM，借 .mjs 判定） ──
  let syn = true; const synErr = [];
  for (const [pkg, fp] of Object.entries(files1)) {
    const cp = path.join(TMP, 'syntax-' + pkg.replace(/[^a-z]/g, '_') + '.mjs');
    fs.writeFileSync(cp, fs.readFileSync(fp, 'utf8'));
    const cc = spawnSync(process.execPath, ['--check', cp], { encoding: 'utf8', timeout: 30000 });
    if (cc.status !== 0) { syn = false; synErr.push(pkg + ': ' + (cc.stderr || '').slice(0, 120)); }
  }
  check('G1b 四个补丁后文件语法可解析', syn, synErr.join(' | '));

  // ── G2 行为实测（全部从补丁后真实字节提取，不复制粘贴逻辑） ──
  const subPatched = fs.readFileSync(files1['@deepseek-ai/dsh-subprocess-local'], 'utf8');
  const fnSrc = subPatched.match(/function createProcessInspector\(platform = process\.platform, arch = process\.arch, internals = DEFAULT_INTERNALS\) \{[\s\S]*?\n\}/);
  check('G2 可从补丁后字节提取 createProcessInspector', !!fnSrc);
  {
    const f = childMjs('inspector-sem.mjs', `
class LinuxProcessInspector { constructor() { this.kind = 'linux'; } }
class MacProcessInspector { constructor() { this.kind = 'mac'; } }
function createWindowsProcessInspector() { return { kind: 'win' }; }
const DEFAULT_INTERNALS = {};
${fnSrc[0]}
const t = (p) => { try { return createProcessInspector(p, 'arm64', {}).kind; } catch (e) { return 'throw'; } };
console.log(JSON.stringify({ android: t('android'), linux: t('linux'), darwin: t('darwin'), win32: t('win32'), freebsd: t('freebsd') }));`);
    const rr = runMjs(f, {});
    let o = {}; try { o = JSON.parse(rr.stdout.trim()); } catch {}
    check('G2 android 走 LinuxProcessInspector（终端报错正解）', o.android === 'linux', rr.stdout + (rr.stderr || '').slice(0, 200));
    check('G2 linux/darwin/win32 支路不变', o.linux === 'linux' && o.darwin === 'mac' && o.win32 === 'win', rr.stdout);
    check('G2 其它平台仍 throw（不静默放行）', o.freebsd === 'throw', rr.stdout);
  }
  {
    const bashPatched = fs.readFileSync(files1['@deepseek-ai/dsh-bash-local'], 'utf8');
    const m = bashPatched.match(/process\.env\.DSH_BASH_BIN \|\| "bash"/);
    const f = childMjs('bash-knob.mjs', 'console.log(' + (m ? m[0] : '"bash"') + ');');
    const on = runMjs(f, { DSH_BASH_BIN: '/native/libbash.so' });
    const off = runMjs(f, {});
    check('G2 DSH_BASH_BIN 置位 → argv[0] 用注入路径', on.stdout.trim() === '/native/libbash.so', on.stdout);
    check('G2 env 缺席 → 逐字回退 "bash"（PC 语义零变化）', off.stdout.trim() === 'bash', off.stdout);
    const tbPatched = fs.readFileSync(files1['@deepseek-ai/dsh-terminal-bash'], 'utf8');
    const line = tbPatched.match(/const DEFAULT_BASH_SHELL = [^\n]*DSH_BASH_BIN[^\n]*;/);
    const g = childMjs('tb-knob.mjs', (line ? line[0] : 'const DEFAULT_BASH_SHELL = "/bin/bash";') + '\nconsole.log(DEFAULT_BASH_SHELL);');
    check('G2 terminal-bash 默认 shell 旋钮（置位/缺席）', runMjs(g, { DSH_BASH_BIN: '/x/bash' }).stdout.trim() === '/x/bash' && runMjs(g, {}).stdout.trim() === '/bin/bash');
  }
  {
    const rgSrc = fs.readFileSync(files1['@vscode/ripgrep'], 'utf8');
    const rgFile = path.join(TMP, 'rg-patched.mjs');
    fs.writeFileSync(rgFile, rgSrc);    const on = runMjs(childMjs('rg-on.mjs', `const m = await import(${JSON.stringify(rgFile)}); console.log('RG:' + m.rgPath);`), { DSH_RIPGREP_BIN: '/native/libdshrg.so' });
    check('G2 DSH_RIPGREP_BIN 置位 → rgPath 短路为注入路径', on.stdout.trim() === 'RG:/native/libdshrg.so', on.stdout + (on.stderr || '').slice(0, 150));
    const off = runMjs(childMjs('rg-off.mjs', `try { const m = await import(${JSON.stringify(rgFile)}); console.log('RG:' + m.rgPath); } catch (e) { console.log('ERR:' + e.message); }`), {});
    check('G2 env 缺席 → 逐字走 require.resolve 原路径诚实失败（不退 none）', off.stdout.startsWith('ERR:Could not find @vscode/ripgrep-'), off.stdout.slice(0, 150));
  }

  // ── G3 NativeManager.ensureCapabilityEnvShim：契约 × 设备标记双重门控 ──
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
    check('G3 无契约（PC）→ 不动作', nm.ensureCapabilityEnvShim() === null);
    writeContract();
    delete process.env.DSH_FLOCK_NATIVE;
    const root3 = path.join(TMP, 'npmroot3');
    const files3 = buildTree(root3);
    nm.npmRoot = root3;
    check('G3 有契约但无设备标记 env → 树不动', nm.ensureCapabilityEnvShim() === null && !fs.readFileSync(files3['@deepseek-ai/dsh-bash-local'], 'utf8').includes(SHIM_MARKER));
    process.env.DSH_FLOCK_NATIVE = '/data/app/fake/lib/arm64/libdshflock.so';
    const r3 = nm.ensureCapabilityEnvShim();
    check('G3 契约+设备标记 → 全投放并记事件', r3 && r3.results.every((x) => x.status === 'applied') && events3.filter((e) => e.n === 'cap_shim_applied').length === 4 && nm.capShimApplied === true, JSON.stringify(events3.map((e) => e.n)));
  } finally {
    if (savedContract !== null) fs.writeFileSync(contractFile, savedContract); else fs.rmSync(contractFile, { force: true });
    if (savedFlk === undefined) delete process.env.DSH_FLOCK_NATIVE; else process.env.DSH_FLOCK_NATIVE = savedFlk;
  }

  // ── G4 Supervisor._androidLaunchReady：spawn 前五垫片同批 ──
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const calls = { narb: 0, flock: 0, link: 0, ptc: 0, cap: 0 };
  const fake = Object.create(Supervisor.prototype);
  fake.logger = { info() {}, warn() {}, error() {} };
  fake.nativeManager = {
    ensureRequireBuiltinShim: () => { calls.narb++; },
    ensureFlockShim: () => { calls.flock++; },
    ensureLinkPublishShim: () => { calls.link++; },
    ensurePtcEnvShim: () => { calls.ptc++; },
    ensureCapabilityEnvShim: () => { calls.cap++; },
  };
  writeContract();
  try {
    fake._androidLaunchReady([process.execPath, path.join(TMP, 'fake-entry.js'), 'web']);
    check('G4 spawn 前五垫片同批调用', calls.narb > 0 && calls.flock > 0 && calls.link > 0 && calls.ptc > 0 && calls.cap > 0, JSON.stringify(calls));
    fs.rmSync(contractFile, { force: true });
    calls.cap = 0;
    fake._androidLaunchReady([process.execPath, 'dsh', 'web']);
    check('G4 无契约（PC）→ 不触发自愈', calls.cap === 0);
  } finally { fs.rmSync(contractFile, { force: true }); }

  const failed = results.filter((x) => !x);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
