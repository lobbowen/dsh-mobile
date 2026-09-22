#!/usr/bin/env node
'use strict';

// link 发布垫片回归（2026-09-23，真机「EACCES: permission denied, link
// '<...>.jsonl.zstd.<rand>.tmp' -> '<...>.zstd'」）：Android 7+ SELinux 禁 app 私有
// 目录硬链接 ⇒ dsh 安装树 5 处 link(2) 独占发布全灭。修复=libdshpublish.so 的
// renameat2(RENAME_NOREPLACE) 桥 + 守卫锚点补丁（move/alias 两类语义；原生缺席逐字
// 回退真 link）。本测试钉：真实 vendor bundle 字节上的锚点命中与补丁结构、补丁后
// 三个文件语法可解析（node --check）、helper 在真实 node 子进程里的发布语义
// （EEXIST 错误面、move 移走源、alias 保源+无残留 tmp、EINVAL 回退、无原生回退
// link）、manager 双重门控、spawn 前接线。安全门禁 A：注入全部走 env + 文件。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'link-publish');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'link-shim-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); }

const shimMod = require(path.join(ROOT, 'src', 'guard', 'native', 'link-publish-shim'));
const SHIM_MARKER = 'dsh-android-kernel:link-publish-shim:v1';

const PKG_P = '@deepseek-ai/dsh-session-persistence-jsonl';
const PKG_A = '@deepseek-ai/dsh-attachment-local';

function buildTree(root) {
  const p = path.join(root, PKG_P);
  const a = path.join(root, PKG_A);
  fs.mkdirSync(path.join(p, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(a, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name: PKG_P.slice(1), version: '0.0.0', type: 'module' }));
  fs.writeFileSync(path.join(a, 'package.json'), JSON.stringify({ name: PKG_A.slice(1), version: '0.0.0', type: 'module' }));
  fs.writeFileSync(path.join(p, 'lib', 'index.js'), fs.readFileSync(path.join(FIX, 'persistence-index.js'), 'utf8'));
  fs.writeFileSync(path.join(p, 'lib', 'worker.cjs'), fs.readFileSync(path.join(FIX, 'persistence-worker.cjs'), 'utf8'));
  fs.writeFileSync(path.join(a, 'lib', 'index.js'), fs.readFileSync(path.join(FIX, 'attachment-index.js'), 'utf8'));
  return { p, a };
}
const hits = (s, needle) => s.split(needle).length - 1;

(async () => {
  // ── G1 部署器结构门禁：真实 vendor 字节上 3 文件全命中、备份逐字、幂等、锚点防呆 ──
  const root1 = path.join(TMP, 'npmroot1');
  const { p: p1, a: a1 } = buildTree(root1);
  const origI = fs.readFileSync(path.join(FIX, 'persistence-index.js'), 'utf8');
  const origW = fs.readFileSync(path.join(FIX, 'persistence-worker.cjs'), 'utf8');
  const origA = fs.readFileSync(path.join(FIX, 'attachment-index.js'), 'utf8');
  let r = shimMod.ensureShim(root1);
  check('G1 三个目标文件全部投放', r.found === 3 && r.results.every((x) => x.status === 'applied'), JSON.stringify(r.results));
  const fi = path.join(p1, 'lib', 'index.js');
  const fw = path.join(p1, 'lib', 'worker.cjs');
  const fa = path.join(a1, 'lib', 'index.js');
  check('G1 备份逐字保留（三件）', fs.readFileSync(path.join(p1, 'lib', 'index.dsh-orig.js'), 'utf8') === origI && fs.readFileSync(path.join(p1, 'lib', 'worker.dsh-orig.cjs'), 'utf8') === origW && fs.readFileSync(path.join(a1, 'lib', 'index.dsh-orig.js'), 'utf8') === origA);
  const pi = fs.readFileSync(fi, 'utf8');
  const pw = fs.readFileSync(fw, 'utf8');
  const pa = fs.readFileSync(fa, 'utf8');
  check('G1 persistence/index.js 双锚点落位', pi.startsWith('/* ' + SHIM_MARKER) && hits(pi, 'await __dshLinkShim.publishMove(tmp, finalPath);') === 1 && hits(pi, '\n\tlink: __dshLinkShim.publishMove,\n') === 1 && hits(pi, 'await link(tmp, finalPath);') === 0);
  check('G1 worker.cjs internals 默认表落位', pw.includes('link: __dshLinkShim.publishMove,') && !pw.includes('link: node_fs_promises.link,'));
  check('G1 attachment 双站落位（alias 语义）', hits(pa, 'await __dshLinkShim.publishAlias(staged.path, target);') === 1 && hits(pa, 'await __dshLinkShim.publishAlias(source, target);') === 1);
  const snap = [pi, pw, pa];
  r = shimMod.ensureShim(root1);
  check('G1 二次调用幂等（already，字节不变）', r.results.every((x) => x.status === 'already')
    && fs.readFileSync(fi, 'utf8') === snap[0] && fs.readFileSync(fw, 'utf8') === snap[1] && fs.readFileSync(fa, 'utf8') === snap[2]);
  // 锚点防呆：attachment 文件缺一个锚 ⇒ 整文件不动、无备份、报 failed
  const root2 = path.join(TMP, 'npmroot2');
  const { a: a2 } = buildTree(root2);
  const fa2 = path.join(a2, 'lib', 'index.js');
  fs.writeFileSync(fa2, fs.readFileSync(fa2, 'utf8').replace('await link(source, target);', 'await link(source, RENAMED);'));
  const before = fs.readFileSync(fa2, 'utf8');
  const r2 = shimMod.ensureShim(root2);
  const ra = r2.results.find((x) => x.file === PKG_A + '/lib/index.js');
  check('G1 锚点命中数≠1 → 整文件不动并报 failed', ra && ra.status === 'failed' && /锚点/.test(ra.error) && fs.readFileSync(fa2, 'utf8') === before && !fs.existsSync(path.join(a2, 'lib', 'index.dsh-orig.js')), JSON.stringify(ra));
  check('G1 空根/缺包安全空转', shimMod.ensureShim(null).found === 0 && shimMod.ensureShim(path.join(TMP, 'nope')).found === 0);

  // ── G1b 补丁后文件语法必须仍可解析（node --check；ESM 借 .mjs 落盘判定） ──
  for (const [tag, src, ext] of [['persistence/index.js', pi, 'mjs'], ['worker.cjs', pw, 'cjs'], ['attachment/index.js', pa, 'mjs']]) {
    const cp = path.join(TMP, 'syntax-' + tag.replace(/[/.]/g, '-') + '.' + ext);
    fs.writeFileSync(cp, src);
    const c = spawnSync(process.execPath, ['--check', cp], { encoding: 'utf8', timeout: 30000 });
    check('G1b 补丁后语法可解析: ' + tag, c.status === 0, (c.stderr || '').slice(0, 200));
  }

  // ── G2 helper 真实语义（node 子进程 + 假原生经 .js 注入通道 + 真文件系统） ──
  const helperFile = path.join(TMP, 'helper-under-test.mjs');
  fs.writeFileSync(helperFile, shimMod.helperSource() + '\nexport { __dshLinkShim };\n');
  const bindDir = path.join(TMP, 'lbinds');
  fs.mkdirSync(bindDir, { recursive: true });
  fs.writeFileSync(path.join(bindDir, 'package.json'), '{"type":"commonjs"}');
  fs.writeFileSync(path.join(bindDir, 'fake-move.js'), 'const fs=require("node:fs");module.exports={renameNoReplace:(s,d,cb)=>{try{if(fs.existsSync(d))return cb(17);fs.renameSync(s,d);cb(0)}catch(e){cb(e.code==="EEXIST"?17:(e.errno||22))}}}');
  fs.writeFileSync(path.join(bindDir, 'fake-einval.js'), 'module.exports={renameNoReplace:(s,d,cb)=>cb(22)}');
  fs.writeFileSync(path.join(bindDir, 'fake-enospc.js'), 'module.exports={renameNoReplace:(s,d,cb)=>cb(28)}');
  const work = (name) => { const d = path.join(TMP, 'work-' + name); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };
  function probe(scenario, env) {
    const d = work(scenario);
    const code = `import { __dshLinkShim as S } from ${JSON.stringify('file://' + helperFile)};
import fs from 'node:fs'; import path from 'node:path';
const D = ${JSON.stringify(d)};
const src = path.join(D, 'src.txt'), dst = path.join(D, 'dst.txt');
const mk = () => fs.writeFileSync(src, 'PAYLOAD');
const fail = (e) => console.log('ERR:' + [e.code, e.errno, e.syscall].join(':'));
try {
  if (${JSON.stringify(scenario)} === 'mv-ok') { mk(); await S.publishMove(src, dst); console.log('SRC:' + fs.existsSync(src) + ' DST:' + (fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : '-')); }
  else if (${JSON.stringify(scenario)} === 'mv-clash') { mk(); fs.writeFileSync(dst, 'OLD'); try { await S.publishMove(src, dst); console.log('NO-THROW'); } catch (e) { fail(e); console.log('SRCKEPT:' + fs.existsSync(src) + ' OLDDST:' + fs.readFileSync(dst, 'utf8')); } }
  else if (${JSON.stringify(scenario)} === 'mv-nonative') { mk(); await S.publishMove(src, dst); console.log('NLINK:' + fs.statSync(dst).nlink + ' SRC:' + fs.existsSync(src) + ' SAME:' + (fs.statSync(src).ino === fs.statSync(dst).ino)); }
  else if (${JSON.stringify(scenario)} === 'alias-ok') { mk(); fs.chmodSync(src, 0o600); await S.publishAlias(src, dst); const stray = fs.readdirSync(D).filter((n) => n.includes('.dsh-alias-')); console.log('SRC:' + fs.existsSync(src) + ' DST:' + fs.readFileSync(dst, 'utf8') + ' STRAY:' + stray.length + ' MODE:' + (fs.statSync(dst).mode & 0o777).toString(8)); }
  else if (${JSON.stringify(scenario)} === 'alias-clash') { mk(); fs.writeFileSync(dst, 'OLD'); try { await S.publishAlias(src, dst); console.log('NO-THROW'); } catch (e) { fail(e); console.log('SRC:' + fs.existsSync(src) + ' OLDDST:' + fs.readFileSync(dst, 'utf8') + ' STRAY:' + fs.readdirSync(D).filter((n) => n.includes('.dsh-alias-')).length); } }
  else if (${JSON.stringify(scenario)} === 'einval-ok') { mk(); await S.publishMove(src, dst); console.log('SRC:' + fs.existsSync(src) + ' DST:' + fs.readFileSync(dst, 'utf8')); }
  else if (${JSON.stringify(scenario)} === 'enospc') { mk(); try { await S.publishMove(src, dst); console.log('NO-THROW'); } catch (e) { fail(e); console.log('SRC:' + fs.existsSync(src)); } }
  else throw new Error('未知场景 ' + ${JSON.stringify(scenario)});
} catch (e) { console.log('TOP-ERR:' + (e && e.message)); }`;
    const base = Object.assign({}, process.env);
    delete base.DSH_PUBLISH_NATIVE; delete base.DSH_FLOCK_NATIVE;
    const rr = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30000, env: Object.assign(base, env || {}) });
    return (rr.stdout || '').trim() + ((rr.stderr || '').includes('SyntaxError') ? '\nSTDERR:' + rr.stderr.slice(0, 160) : '');
  }
  const fake = (f) => ({ DSH_PUBLISH_NATIVE: path.join(bindDir, f) });
  check('G2 假原生 move：dst 得内容、src 移走', probe('mv-ok', fake('fake-move.js')) === 'SRC:false DST:PAYLOAD', probe('mv-ok', fake('fake-move.js')));
  const cl = probe('mv-clash', fake('fake-move.js'));
  check('G2 冲突 → EEXIST 错误面（code/errno/syscall）且绝不覆盖 dst', cl.startsWith('ERR:EEXIST:17:link') && cl.includes('SRCKEPT:true OLDDST:OLD'), cl);
  const nn = probe('mv-nonative');
  check('G2 无原生 → 逐字回退真 link（双名同 inode，PC 语义零变化）', nn.startsWith('NLINK:2 SRC:true SAME:true'), nn);
  const al = probe('alias-ok', fake('fake-move.js'));
  check('G2 alias：源保留、dst 内容一致、无 stray tmp、mode 继承', al === 'SRC:true DST:PAYLOAD STRAY:0 MODE:600', al);
  const alc = probe('alias-clash', fake('fake-move.js'));
  check('G2 alias 冲突 → EEXIST、源仍在、tmp 已清', alc.startsWith('ERR:EEXIST:17:link') && alc.includes('SRC:true OLDDST:OLD STRAY:0'), alc);
  check('G2 EINVAL（fs 不支持 NOREPLACE）→ 探测+rename 成功路径', probe('einval-ok', fake('fake-einval.js')) === 'SRC:false DST:PAYLOAD', probe('einval-ok', fake('fake-einval.js')));
  check('G2 其它 errno 透传（ENOSPC）', probe('enospc', fake('fake-enospc.js')) === 'ERR:ENOSPC:28:link\nSRC:true', probe('enospc', fake('fake-enospc.js')));
  const derived = probe('mv-nonative', { DSH_FLOCK_NATIVE: path.join(bindDir, 'libdshflock.so') });
  check('G2 仅 DSH_FLOCK_NATIVE（android.7 旧 APK 无 publish 件）→ 诚实回退不崩', derived.startsWith('NLINK:2'), derived);

  // ── G3 NativeManager.ensureLinkPublishShim：契约 × 原生 env 双重门控 ──
  const { NativeManager } = require(path.join(ROOT, 'src', 'guard', 'native', 'manager.js'));
  const runtimeContract = require(path.join(ROOT, 'src', 'platform', 'runtime-contract'));
  const contractFile = runtimeContract.file();
  const savedContract = fs.existsSync(contractFile) ? fs.readFileSync(contractFile, 'utf8') : null;
  const npmEntryFile = path.join(TMP, 'fake-npm-cli.js');
  fs.writeFileSync(npmEntryFile, '//');
  const writeContract = () => { fs.mkdirSync(path.dirname(contractFile), { recursive: true }); fs.writeFileSync(contractFile, JSON.stringify({ schema: 2, nodePath: process.execPath, npmEntry: npmEntryFile, nodeBinDir: path.dirname(process.execPath) })); };
  const events3 = [];
  const nm = new NativeManager({ config: { command: ['node', 'dsh', 'web'], packageName: '@deepseek-ai/dsh', targetPort: 3080 }, logger: { info() {}, warn() {}, error() {} }, events: { append: (n, d) => events3.push({ n, d }) }, stateDir: path.join(TMP, 'state3') });
  const savedPub = process.env.DSH_PUBLISH_NATIVE, savedFlk = process.env.DSH_FLOCK_NATIVE;
  try {
    fs.rmSync(contractFile, { force: true });
    process.env.DSH_PUBLISH_NATIVE = path.join(bindDir, 'fake-move.js');
    check('G3 无契约（PC）→ 不动作', nm.ensureLinkPublishShim() === null);
    writeContract();
    delete process.env.DSH_PUBLISH_NATIVE; delete process.env.DSH_FLOCK_NATIVE;
    const root3 = path.join(TMP, 'npmroot3');
    buildTree(root3);
    nm.npmRoot = root3;
    check('G3 有契约但无原生 env → 树不动（dev 语义不变）', nm.ensureLinkPublishShim() === null && !fs.readFileSync(path.join(root3, PKG_P, 'lib', 'index.js'), 'utf8').includes(SHIM_MARKER));
    process.env.DSH_PUBLISH_NATIVE = path.join(bindDir, 'fake-move.js');
    const r3 = nm.ensureLinkPublishShim();
    check('G3 契约+PUBLISH env → 全投放并记事件', r3 && r3.results.every((x) => x.status === 'applied') && events3.filter((e) => e.n === 'link_shim_applied').length === 3 && nm.linkShimApplied === true, JSON.stringify(events3.map((e) => e.n)));
    process.env.DSH_PUBLISH_NATIVE = savedPub; process.env.DSH_FLOCK_NATIVE = savedFlk;
  } finally {
    if (savedContract !== null) fs.writeFileSync(contractFile, savedContract); else fs.rmSync(contractFile, { force: true });
    if (savedPub === undefined) delete process.env.DSH_PUBLISH_NATIVE; else process.env.DSH_PUBLISH_NATIVE = savedPub;
    if (savedFlk === undefined) delete process.env.DSH_FLOCK_NATIVE; else process.env.DSH_FLOCK_NATIVE = savedFlk;
  }

  // ── G4 Supervisor._androidLaunchReady：spawn 前同步投放 link 垫片 ──
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => (String(chunk).startsWith('[stderr]') ? true : realErr(chunk, ...rest));
  try {
    const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
    const calls = { narb: 0, flock: 0, link: 0 };
    const fake = Object.create(Supervisor.prototype);
    fake.logger = { info() {}, warn() {}, error() {} };
    fake.nativeManager = {
      ensureRequireBuiltinShim: () => { calls.narb++; },
      ensureFlockShim: () => { calls.flock++; },
      ensureLinkPublishShim: () => { calls.link++; },
    };
    writeContract();
    try {
      fake._androidLaunchReady([process.execPath, path.join(TMP, 'fake-entry.js'), 'web']);
      check('G4 spawn 前三垫片同批调用', calls.narb > 0 && calls.flock > 0 && calls.link > 0, JSON.stringify(calls));
      fs.rmSync(contractFile, { force: true });
      calls.link = 0;
      fake._androidLaunchReady([process.execPath, 'dsh', 'web']);
      check('G4 无契约（PC）→ 不触发自愈', calls.link === 0);
    } finally { fs.rmSync(contractFile, { force: true }); }
  } finally { process.stderr.write = realErr; }

  const failed = results.filter((x) => !x);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
