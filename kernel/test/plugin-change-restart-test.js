#!/usr/bin/env node
'use strict';

// 卸载类测试（项目政策，2026-08-31）：本脚本含插件卸载（PluginManager.uninstall）场景，涉及卸载类操作，
// 已从 npm test 自动测试链排除，仅允许作为独立脚本显式单独调用（node test/plugin-change-restart-test.js 或 npm run test:plugin-change-restart）；
// 除非用户明确指令，禁止擅自运行。

// 插件管理（**Android 内核：单一目标 = 原生主干 native**）核心行为测试：
// - 卸载：官方 CLI + bundles 清理 + 跨层残留（home 补丁层/原生 overlay/profile 补丁层）清理
// + 运行中原生 DSH 经 supervisor 回调重启；job 级核算
// - 停用/启用：官方补丁层机制（$DSH_HOME/cordis.patch.yml）热载面，不动 bundles（防 reconcile 击穿），
// 无需重启；启用顺带清理 legacy overlay
// - 更新：检测（registry 最高版 vs 已装版）+ 执行（update/add）+ 重启生效；本地/git 型拒绝
// 全部用桩（stub CLI / dshRunning 探针 / registry），profile 目录用真实临时目录验证文件级行为。
//
// 已删除的场景（勿回潮）：沙箱实例目标（`inst-a` / `kind:'sandbox'` / `instances` 桩
// `probeInstance|stopInstance|startInstance`）—— 沙箱实例域已整体移除，插件只有一个安装目标。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');
const { PluginManager } = require(path.join(ROOT, 'src', 'domains', 'plugin', 'plugins'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJob(pm, jobId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const j = pm.installStatus(jobId);
    if (j && (j.state === 'done' || j.state === 'failed')) return j;
    await sleep(15);
  }
  return pm.installStatus(jobId);
}

function initProfileDir(dir, deps, bundles) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir && path.join(dir, 'package.json'), JSON.stringify({
    name: 'profile', private: true, dependencies: deps || {},
    dsh: { profile: { bundles: bundles || ['@deepseek-ai/dsh-base'] } }
  }, null, 2) + String.fromCharCode(10));
}

/** 真实临时 profile 目录 + 桩 CLI / dshRunning 探针 / registry。
 * opts: running/pnpmResult/pnpmError/bundlesClean/nativeRestart/distLatest */
function makePM(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-pm-'));
  const nativeProfile = path.join(tmp, 'native', 'profiles', 'web');
  initProfileDir(nativeProfile, { '@x/p': '^1.0.0' }, ['@deepseek-ai/dsh-base', '@x/p']);
  const overlayFile = path.join(tmp, 'plugin-states.patch.yml');
  fs.writeFileSync(overlayFile, JSON.stringify([{ id: 'include:p', disabled: true }], null, 2));

  const events = [];
  const calls = [];                                  // 调用记录（替代旧 instances.calls）
  const NATIVE = { id: 'native', name: '原生实例', kind: 'native', profileDir: nativeProfile, profileName: 'web' };
  const pm = new PluginManager({
    dshBin: 'dsh', profileName: 'web', profileDir: nativeProfile, overlayFile,
    dshPort: 3080, tasks: null, logger: { info() {}, warn() {}, error() {} },
    events: { append: (t, d) => events.push({ t, d }) },
    // 原生 DSH 运行态探针（守卫注入的等价物）
    dshRunning: () => opts.running !== false,
    onNativeRestart: opts.nativeRestart || (() => { calls.push('native-restart'); return { ok: true }; }),
    dist: { fetchNpmLatest: async (n) => (opts.distLatest !== undefined ? opts.distLatest[n] : '2.0.0') },
  });
  // Android 内核只有 native 一个目标：`all` 与 `native` 等价，其余一律报错。
  pm.resolveTargets = (str) => {
    const s = String(str === undefined || str === null || '' === str ? 'native' : str);
    if (s === 'native' || s === 'all') return { ok: true, targets: [NATIVE] };
    return { ok: false, error: '未知安装目标: ' + s + '（Android 内核只有 native 一个安装目标）' };
  };
  pm.installedOn = () => [{ name: '@x/p', version: '1.0.0', source: '@x/p', bundle: true }];
  pm._runCli = async (target, args) => {
    calls.push('cli:' + target.id + ':' + args.join(' '));
    const preset = typeof opts.pnpmResult === 'function' ? opts.pnpmResult(target, args) : opts.pnpmResult;
    if (preset) return { ok: true, error: null };
    return { ok: false, error: (opts.pnpmError !== undefined ? opts.pnpmError : '退出码 1') };
  };
  pm.inventory = async () => ({ entries: [{ entryId: 'e1', moduleName: '@x/p-something' }] });
  pm.saveOverlayEntries = (entries) => fs.writeFileSync(overlayFile, JSON.stringify(entries, null, 2) + String.fromCharCode(10));
  return { pm, calls, events, tmp, nativeProfile, overlayFile };
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const homePatchFile = (profileDir) => path.join(path.dirname(path.dirname(profileDir)), 'cordis.patch.yml');
const eventsOf = (arr, type) => (arr || []).some((e) => e.t === type);

(async () => {
  // ── A. 卸载成功 + 运行中 → 经 supervisor 回调重启；bundles 移除 ──
  {
    const { pm, calls, events, nativeProfile } = makePM({ running: true, pnpmResult: true });
    const before = (readJson(path.join(nativeProfile, 'package.json')).dsh.profile.bundles || []).slice();
    const r = await pm.uninstall('@x/p', 'native');
    const job = await waitJob(pm, r.jobId, 3000);
    const after = (readJson(path.join(nativeProfile, 'package.json')).dsh.profile.bundles || []);
    check('A1 卸载 job done', job.state === 'done', job.state);
    check('A2 运行中经回调重启', calls.includes('native-restart'), calls.join(','));
    check('A3 已发 plugin_uninstall_done', eventsOf(events, 'plugin_uninstall_done'), '');
    check('A4 bundles 移除', before.includes('@x/p') && !after.includes('@x/p'), JSON.stringify(after));
    check('A5 重启日志入列', (job.targets[0].log || []).some((l) => /重启/.test(l)), JSON.stringify(job.targets[0].log));
  }
  // ── B. 卸载成功 + 未运行 → 不重启 ──
  {
    const { pm, calls } = makePM({ running: false, pnpmResult: true });
    const r = await pm.uninstall('@x/p', 'native');
    const job = await waitJob(pm, r.jobId, 3000);
    check('B1 卸载 job done', job.state === 'done', job.state);
    check('B2 未运行不重启', !calls.includes('native-restart'), calls.join(','));
    check('B3 提示下次启动生效', (job.targets[0].log || []).some((l) => /下次启动/.test(l)), JSON.stringify(job.targets[0].log));
  }
  // ── C. pnpm 报「依赖已不存在」+ bundles 已清理 → 视为成功并重启 ──
  {
    const { pm, calls } = makePM({
      running: true, pnpmResult: false,
      pnpmError: "ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS Cannot remove '@x/p': no such dependency found", bundlesClean: true
    });
    pm._removeFromProfileBundles = () => true;
    const r = await pm.uninstall('@x/p', 'native');
    const job = await waitJob(pm, r.jobId, 3000);
    check('C1 依赖已移除判定为成功', job.state === 'done', job.state);
    check('C2 成功路径仍重启', calls.includes('native-restart'), calls.join(','));
  }
  // ── D. 硬失败（无 bundles 变更）→ job failed，不重启 ──
  {
    const { pm, calls } = makePM({ running: true, pnpmResult: false, pnpmError: 'registry timeout', bundlesClean: false });
    pm._removeFromProfileBundles = () => false;
    const r = await pm.uninstall('@x/p', 'native');
    const job = await waitJob(pm, r.jobId, 3000);
    check('D1 硬失败 job failed', job.state === 'failed', job.state);
    check('D2 失败不重启', !calls.includes('native-restart'), calls.join(','));
  }
  // ── E. native 目标变更 + 运行中 → onNativeRestart；不直接碰服务管理器 ──
  {
    let nativeRestartCalls = 0;
    const { pm, calls } = makePM({ running: true, pnpmResult: true, nativeRestart: () => { nativeRestartCalls++; return { ok: true }; } });
    const r = await pm.uninstall('@x/p', 'native');
    const job = await waitJob(pm, r.jobId, 3000);
    check('E1 原生卸载 job done', job.state === 'done', job.state);
    check('E2 原生走 supervisor 重启回调', nativeRestartCalls === 1, 'calls=' + nativeRestartCalls);
    check('E3 未直接操作实例/服务管理器', !calls.some((c) => /^(stop|start):/.test(c)), calls.join(','));
  }
  // ── E9. 目标解析：只有 native / all，其余报错（沙箱目标已删）──
  {
    const { pm } = makePM({ running: true });
    check('E9.1 native 解析成功', pm.resolveTargets('native').ok === true, '');
    check('E9.2 all 等价 native（单目标）',
      pm.resolveTargets('all').ok === true && pm.resolveTargets('all').targets.length === 1
      && pm.resolveTargets('all').targets[0].id === 'native', '');
    const bad = pm.resolveTargets('inst-a');
    check('E9.3 沙箱目标被拒绝', bad.ok === false && /只有 native/.test(bad.error), bad.error);
  }
  // ── F0. 行保留回归：禁用/启用不得误删补丁层中的非 disabled 用户行/insert 行（2026-09 审计修复）──
  {
    const { pm, nativeProfile } = makePM({ running: true });
    const hpFile = homePatchFile(nativeProfile);
    fs.writeFileSync(hpFile, JSON.stringify([
      { id: '@x/p', enabled: true },                    // 用户手动配置行（非 disabled）
      { insert: [{ id: 'x-util', name: '@x/p' }] },      // insert 型行（引用该插件）
      { id: '@y/q', disabled: true },                    // 其它插件禁用行（不得受影响）
    ], null, 2));
    await pm.setBundleEnabled('@x/p', false, 'native');
    let hp = readJson(hpFile) || [];
    const ownRow = hp.find((e) => e && e.id === '@x/p');
    check('F0.1 禁用后本插件行 disabled=true', !!ownRow && ownRow.disabled === true, JSON.stringify(hp));
    check('F0.2 禁用保留 insert 型行', hp.some((e) => Array.isArray(e.insert) && e.insert.some((r) => r.name === '@x/p')), JSON.stringify(hp));
    check('F0.3 禁用保留其它插件禁用行', hp.some((e) => e.id === '@y/q' && e.disabled === true), JSON.stringify(hp));
    await pm.setBundleEnabled('@x/p', true, 'native');
    hp = readJson(hpFile) || [];
    check('F0.4 启用后无本插件 disabled 行', !hp.some((e) => e && e.id === '@x/p'), JSON.stringify(hp));
    check('F0.5 启用保留 insert 型行', hp.some((e) => Array.isArray(e.insert) && e.insert.some((r) => r.name === '@x/p')), JSON.stringify(hp));
    check('F0.6 启用保留其它插件行', hp.some((e) => e.id === '@y/q'), JSON.stringify(hp));
  }
  // ── F1. 禁用：写 home 补丁层，不动 bundles，不重启（热应用）──
  {
    const { pm, calls, events, nativeProfile } = makePM({ running: true });
    const res = await pm.setBundleEnabled('@x/p', false, 'native');
    const hp = readJson(homePatchFile(nativeProfile)) || [];
    const bundles = (readJson(path.join(nativeProfile, 'package.json')).dsh.profile.bundles || []);
    const disabledRow = hp.find((e) => e.id === '@x/p');
    check('F1.1 返回 rows=1', res.ok === true && res.rows === 1, JSON.stringify(res));
    check('F1.2 home 补丁层写入 disabled 行', !!disabledRow && disabledRow.disabled === true, JSON.stringify(hp));
    check('F1.3 不动 bundles（防 reconcile 击穿）', bundles.includes('@x/p'), JSON.stringify(bundles));
    check('F1.4 不重启（热应用）', !calls.includes('native-restart'), calls.join(','));
    check('F1.5 事件 plugin_disabled', eventsOf(events, 'plugin_disabled'), '');
  }
  // ── F2. 启用：移除禁用行 ──
  {
    const { pm, nativeProfile } = makePM({ running: true });
    await pm.setBundleEnabled('@x/p', false, 'native');
    const res2 = await pm.setBundleEnabled('@x/p', true, 'native');
    const hp = readJson(homePatchFile(nativeProfile)) || [];
    check('F2.1 启用后禁用行移除', res2.rows === 1 && !hp.some((e) => e.id === '@x/p'), JSON.stringify(hp));
  }
  // ── G. 安装成功 + 运行中 → 不自动重启，仅提示 ──
  {
    const { pm, calls } = makePM({ running: true, pnpmResult: true });
    const r = await pm.install('@x/p', { target: 'native' });
    const job = await waitJob(pm, r.jobId, 3000);
    check('G1 安装 job done', job.state === 'done', job.state);
    check('G2 安装不自动重启', !calls.includes('native-restart'), calls.join(','));
    check('G3 提示重启后加载', (job.targets[0].log || []).some((l) => /重启/.test(l)), JSON.stringify(job.targets[0].log));
  }
  // ── H. all（= native 单目标）：CLI 失败 → job failed ──
  {
    const { pm, calls } = makePM({ running: true, pnpmResult: () => false, pnpmError: 'registry timeout', bundlesClean: false });
    pm._removeFromProfileBundles = () => false;
    const r = await pm.uninstall('@x/p', 'all');
    const job = await waitJob(pm, r.jobId, 5000);
    check('H1 失败 job failed', job.state === 'failed', job.state);
    check('H2 失败目标 error 记录', (job.targets.find((t) => t.id === 'native') || {}).error === 'registry timeout', '');
    check('H3 失败不重启', !calls.includes('native-restart'), calls.join(','));
    check('H4 all 只解析出 1 个目标（无沙箱）', job.targets.length === 1, String(job.targets.length));
  }
  // ── I. _removeFromProfileBundles 真实写盘：幂等 ──
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-rm-'));
    const profileDir = path.join(tmp, 'profile');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@x/p'] } } }, null, 2));
    const pm = new PluginManager({ dshBin: 'x', profileName: 'web', profileDir: '/nonexistent', overlayFile: '/nonexistent', dshPort: 1, logger: console });
    const removed = pm._removeFromProfileBundles({ profileDir }, '@x/p');
    const after = readJson(path.join(profileDir, 'package.json'));
    check('I1 bundles 移除返回 true', removed === true, String(removed));
    check('I2 插件从 bundles 消失', !(after.dsh.profile.bundles || []).includes('@x/p'), '');
    check('I3 二次移除返回 false（幂等）', pm._removeFromProfileBundles({ profileDir }, '@x/p') === false, '');
  }
  // ── J. 卸载残留清理（home 补丁层 / overlay / profile 补丁层 JSON）──
  {
    const { pm, nativeProfile } = makePM({ running: true, pnpmResult: true });
    const hpFile = homePatchFile(nativeProfile);
    fs.writeFileSync(hpFile, JSON.stringify([{ id: '@x/p', disabled: true }], null, 2) + String.fromCharCode(10));
    fs.writeFileSync(path.join(nativeProfile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'x-util', name: '@x/p' }] }], null, 2) + String.fromCharCode(10));
    const r = await pm.uninstall('@x/p', 'native');
    const job = await waitJob(pm, r.jobId, 3000);
    const hpAfter = readJson(hpFile) || [];
    const ppAfter = readJson(path.join(nativeProfile, 'cordis.patch.yml')) || [];
    check('J1 卸载 job done', job.state === 'done', job.state);
    check('J2 home 补丁层残留已清', !hpAfter.some((e) => e.id === '@x/p'), JSON.stringify(hpAfter));
    check('J3 profile 补丁层 insert 残留已清（纯 JSON 可安全改写）', !ppAfter.some((e) => (e.insert || []).some((row) => row.name === '@x/p')), JSON.stringify(ppAfter));
    check('J4 日志含清理记录', (job.targets[0].log || []).some((l) => /残留|补丁层/.test(l)), JSON.stringify(job.targets[0].log));
  }
  // ── K. 启用 native：清 legacy overlay 禁用行 ──
  {
    const { pm, overlayFile } = makePM({ running: true });
    const before = readJson(overlayFile) || [];
    if (before.some((e) => e.id === 'include:p')) {
      const res = await pm.setBundleEnabled('@x/p', true, 'native');
      const after = readJson(overlayFile) || [];
      check('K1 启用时清理 legacy overlay', res.rows >= 1 && !after.some((e) => e.id === 'include:p'), JSON.stringify(after));
    } else { check('K1 启用时清理 legacy overlay', false, 'seed missing'); }
  }
  // ── L. 更新：检测 + 执行 + 重启 ──
  {
    const { pm, calls, events } = makePM({ running: true, pnpmResult: true, distLatest: { '@x/p': '2.0.0' } });
    const chk = await pm.checkUpdates();
    const uc = (chk.plugins || []).find((x) => x.name === '@x/p');
    check('L1 检测到可更新', !!uc && uc.updateAvailable === true && uc.specType === 'npm', JSON.stringify(uc));
    check('L2 检测目标明细只有 native', !!uc && uc.targets.length === 1 && uc.targets[0].id === 'native', JSON.stringify(uc && uc.targets));
    const r = await pm.update('@x/p', 'native');
    const job = await waitJob(pm, r.jobId, 3000);
    check('L3 更新 job done', job.state === 'done', job.state);
    check('L4 更新走官方 update 命令', calls.some((c) => c.startsWith('cli:native:update @x/p@2.0.0')), calls.join(','));
    check('L5 更新后重启', calls.includes('native-restart'), calls.join(','));
    check('L6 更新事件', eventsOf(events, 'plugin_update_done'), '');
  }
  // ── M. 更新已是最新 → 跳过不执行 ──
  {
    const { pm, calls } = makePM({ running: true, distLatest: { '@x/p': '1.0.0' } });
    const r = await pm.update('@x/p', 'native');
    const job = await waitJob(pm, r.jobId, 3000);
    check('M1 已最新 job done', job.state === 'done', job.state);
    check('M2 不执行更新命令', !calls.some((c) => c.startsWith('cli:native:update')), calls.join(','));
    check('M3 不重启', !calls.includes('native-restart'), calls.join(','));
  }
  // ── N. 本地型插件更新 → 拒绝并失败 ──
  {
    const { pm, calls } = makePM({ running: true, distLatest: { '@x/p': '2.0.0' } });
    pm.installedOn = () => [{ name: '@x/p', version: '1.0.0', source: 'file:/home/me/dev/x', bundle: true }];
    const r = await pm.update('@x/p', 'native');
    const job = await waitJob(pm, r.jobId, 3000);
    check('N1 本地型更新 job failed', job.state === 'failed', job.state + ' / ' + (job.error || ''));
    check('N2 本地型不执行 CLI', !calls.some((c) => c.startsWith('cli:native:update')), calls.join(','));
  }

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
