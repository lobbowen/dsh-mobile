#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 第十三轮续：壳投放的镜像契约必须能**重载**（2026-09-13 P1）
//
// ## 缺陷（失效模式 b + f + i）
//
// `registryContract.read()` 与 `DistributionManager._loadRegistryConfig()` 原先
// **只在构造器各调用一次**，无任何 reload / watch。
// 而壳会在**运行中**重写 registry.json（真实触发点：mirror.rs::export_on_boot
// 每次壳启动、commands/mod.rs:514 的 mirror_set、node.rs:146 选中镜像后落盘）。
//
// 后果：内核进程生命周期内永远看不到壳的新 catalog / **探测规格** / selected / mode：
//   · 用**旧探测方法**自己重测 → 正是 registry-contract.js:23-28 声称已修复的
//     「两侧选源不一致」（用户看到面板显示一个源、实际用另一个）；
//   · 手动设 manual 后内核仍按 auto 走；
//   · 主进程与 router-daemon 若启动时刻不同 → 两侧契约长期不一致（一台机器两个决策）。
//
// ## 修法
// 在读入口（selectRegistry / registryInfo）加 TTL 重载（60s）。
//
// ## 门禁
//   A 结构：存在 TTL 重载入口，且读入口确实调用它
//   B 行为：TTL 内不重载、TTL 过后重载（并拿到新的 catalog 与 **probe 规格**）
//   C 反向：不因每次调用都重读而回归（TTL 内多次调用只读一次盘）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

/** 比生产 TTL（60s）略大的守卫值：确保「拨回过去」后必然过期，又不依赖具体实现数值。 */
const CONTRACT_TTL_GUARD = 61 * 1000;

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

(async () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'dist', 'index.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  console.log('== A 结构 ==');
  check('A 存在 TTL 常量', /CONTRACT_TTL_MS\s*=/.test(code), '有');
  check('A 存在重载入口 _reloadContractIfStale', /_reloadContractIfStale\(\)\s*\{/.test(code), '有');
  check('A selectRegistry 读入口调用重载', /async selectRegistry[\s\S]{0,400}?_reloadContractIfStale\(\)/.test(code), '有');
  check('A registryInfo 读入口调用重载', /async registryInfo\(\)\s*\{\s*\n\s*this\._reloadContractIfStale\(\);/.test(code), '有');

  console.log('== B 行为：TTL 内不重载 / TTL 过后重载 ==');
  {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r13rc-'));
    const rf = path.join(TMP, 'registry.json');
    const write = (cat, probe) => fs.writeFileSync(rf, JSON.stringify({
      schema: 2, writtenBy: 'shell', mode: 'auto',
      catalog: [cat], probe: { kind: 'package-metadata', pathTemplate: probe, timeoutMs: 6000 },
    }));
    write('https://boot.example', 'pkg-a');
    const { DistributionManager } = require(path.join(ROOT, 'src', 'domains', 'dist', 'index.js'));
    const dm = new DistributionManager({ registryFile: rf, registries: ['https://boot.example'] });
    check('B 构造时读到启动契约', dm.contract.catalog[0] === 'https://boot.example', JSON.stringify(dm.contract.catalog));

    // 壳在运行中重写
    write('https://new.example', 'pkg-b');
    await dm.registryInfo();
    check('B TTL 内**不**重载（避免每次请求都读盘）',
      dm.contract.catalog[0] === 'https://boot.example', JSON.stringify(dm.contract.catalog));

    // 把载入时刻拨回 TTL 之前
    dm._contractLoadedAt = Date.now() - (CONTRACT_TTL_GUARD);
    await dm.registryInfo();
    check('B TTL 过后**重载**并获得新 catalog（旧实现永远 boot）',
      dm.contract.catalog[0] === 'https://new.example', JSON.stringify(dm.contract.catalog));
    check('B 新**探测规格**也生效（这正是「两侧选源不一致」的根因）',
      dm.contract.probe && dm.contract.probe.pathTemplate === 'pkg-b',
      JSON.stringify(dm.contract.probe && dm.contract.probe.pathTemplate));

    // C 反向：TTL 内多次调用不应反复读盘
    dm._contractLoadedAt = Date.now();
    write('https://third.example', 'pkg-c');
    await dm.registryInfo();
    await dm.selectRegistry(true).catch(() => {});
    check('C 反向：TTL 内后续调用不重复读盘（仍是 new）',
      dm.contract.catalog[0] === 'https://new.example', JSON.stringify(dm.contract.catalog));

    fs.rmSync(TMP, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
