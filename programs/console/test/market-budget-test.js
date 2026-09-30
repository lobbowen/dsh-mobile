#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 插件市场的**整体构建预算**（P2-8，2026-09-12）
//
// ## 缺陷
//
// 社区源候选约 **2468** 个，按 8 并发分批、每批各带超时 —— 最坏情况可达数十分钟；
// 而 `GET /plugins/market` 会**阻塞到构建完成**：
//   · 前端 15s 就放弃了（AbortSignal），**服务端却还在跑**；
//   · 反复点「刷新」会叠加多轮构建。
//
// ## 修法
//
// 给整次构建一个上限（默认 4 分钟，可经 `buildBudgetMs` 注入）：
//   · `buildIndex()` 置 `_deadline`，在 `finally` 清除；
//   · 各源的批次循环在发起**新批次前**检查 `_budgetExhausted()`，到点即 break；
//   · 用已采集的部分构建索引 —— 与既有的「坏构建保护」天然配合
//     （部分结果 < 旧缓存 50% 时会按 source 维度沿用旧缓存，不会冲掉）。
//
// ## 锁定不变量
//   M-a  `buildBudgetMs` 可注入（默认 4 分钟）
//   M-b  `buildIndex()` 期间 `_deadline` **已置位**（各源可观察到），结束后**清零**
//   M-c  `_budgetExhausted()` 语义正确（未置位/未到点 → false；到点 → true）
//   M-d  两个批次循环都检查预算（源码级：loop guard 在 `slice` 之前）
//   M-e  超预算时**返回部分结果**（不抛、不清缓存）
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const SRC = path.join(ROOT, 'src', 'domains', 'plugin', 'pluginmarket.js');
const src = fs.readFileSync(SRC, 'utf8');
const { PluginMarket } = require(SRC);

// ── M-a：可注入的预算 ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
  const mk = (o) => new PluginMarket(Object.assign({ cacheDir: dir, stateFile: path.join(dir, 's.json'), logger: { info() {}, warn() {}, error() {} } }, o || {}));
  check('M-a 默认预算 4 分钟', mk().buildBudgetMs === 240000, String(mk().buildBudgetMs));
  check('M-a 预算可注入（测试/特殊环境）', mk({ buildBudgetMs: 1234 }).buildBudgetMs === 1234, String(mk({ buildBudgetMs: 1234 }).buildBudgetMs));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── M-c：_budgetExhausted 语义 ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
  const m = new PluginMarket({ cacheDir: dir, stateFile: path.join(dir, 's.json'), logger: { info() {}, warn() {}, error() {} } });
  m._deadline = 0;
  check('M-c 未置位（0）→ 不视为耗尽', m._budgetExhausted() === false, 'false');
  m._deadline = Date.now() + 10000;
  check('M-c 未到点 → false', m._budgetExhausted() === false, 'false');
  m._deadline = Date.now() - 1;
  check('M-c 已到点 → true', m._budgetExhausted() === true, 'true');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── M-b / M-e：构建期间 deadline 生效，结束后清零；且返回部分结果不抛 ──
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
  const m = new PluginMarket({
    cacheDir: dir,
    stateFile: path.join(dir, 's.json'),
    buildBudgetMs: 50,
    logger: { info() {}, warn() {}, error() {} },
  });
  const seen = [];
  // 用**慢**的三源桩：每个源在被调用时记录此刻的 _deadline（应为非 0 = 构建中）
  const slow = (name, tag) => async function () {
    seen.push({ name, deadlinePositive: this._deadline > 0 });
    await new Promise((r) => setTimeout(r, 40));
    return tag ? [{ name: tag, source: name, stars: 1 }] : [];
  };
  m.indexNpm = slow('npm', 'a-npm');
  m.indexGithub = slow('github', null);
  m.indexCommunity = slow('community', null);
  // 让 saveToDisk 不真的写盘（无妨，tmp 目录）
  let cache = null, threw = null;
  try { cache = await m.buildIndex(); } catch (e) { threw = e; }
  check('M-e 构建不抛（超预算也返回部分）', threw === null, threw ? threw.message : '无异常');
  check('M-e 返回了部分结果（npm 源已采集）',
    !!(cache && (cache.plugins || []).some((p) => p.name === 'a-npm')),
    JSON.stringify((cache && cache.plugins || []).map((p) => p.name)));
  check('M-b 构建期间 _deadline 已置位（三源均可观察到）',
    seen.length === 3 && seen.every((x) => x.deadlinePositive),
    JSON.stringify(seen));
  check('M-b 构建结束后 _deadline 清零', m._deadline === 0, String(m._deadline));
  fs.rmSync(dir, { recursive: true, force: true });

  // ── M-d：两个批次循环都在发起新批次前检查预算 ──
  {
    const loops = src.match(/for \(let i = 0; i < (names|links)\.length; i \+= (batch|8)\) \{[\s\S]{0,300}?slice\(i,/g) || [];
    check('M-d 定位到两个批次循环', loops.length === 2, loops.length + ' 个');
    check('M-d 每个循环都有 _budgetExhausted 检查且在 slice 之前',
      loops.every((seg) => seg.indexOf('_budgetExhausted()') >= 0 && seg.indexOf('_budgetExhausted()') < seg.indexOf('slice(i,')),
      loops.map((s) => s.indexOf('_budgetExhausted()') + '/' + s.indexOf('slice(i,')).join(' '));
    // 反向：确认 buildIndex 用 try/finally 包裹（异常路径也清零）
    check('M-d buildIndex 用 try/finally 清零 deadline',
      /finally \{ this\._deadline = 0; \}/.test(src), '有');
  }

  // ── M-f：**预算截断的源必须与旧缓存并集**（P2-8 配套修复）──
  //
  // 缺陷：既有的「坏构建保护」判据是「本次**整源失败**」（`!freshSources.has(source)`），
  //   而被截断的源**仍在结果里**（只是不完整）→ 该保护不保留它的旧条目
  //   → 只跑到 200/2400 的 community 会**替换掉**完整的旧 community 列表。
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
    const m = new PluginMarket({
      cacheDir: dir,
      stateFile: path.join(dir, 's.json'),
      logger: { info() {}, warn() {}, error() {} },
    });
    // 预置「完整」旧缓存：100 条 community + 5 条 npm
    const oldCommunity = [];
    for (let i = 0; i < 100; i++) oldCommunity.push({ name: 'old-c-' + i, source: 'community', stars: 1 });
    const oldNpm = [];
    for (let i = 0; i < 5; i++) oldNpm.push({ name: 'old-n-' + i, source: 'npm', stars: 1 });
    m._cache = { indexedAt: Date.now(), sources: { npm: 5, github: 0, community: 100 }, total: 105, plugins: oldNpm.concat(oldCommunity) };
    m._ts = Date.now();
    // 桩：community 被预算截断（只返回 3 条并标记）
    m.indexNpm = async () => oldNpm.map((x) => ({ name: x.name, source: 'npm', stars: 1 }));
    m.indexGithub = async () => [];
    m.indexCommunity = async function () {
      this._truncatedSources.add('community');
      return [
        { name: 'new-c-1', source: 'community', stars: 1 },
        { name: 'new-c-2', source: 'community', stars: 1 },
        { name: 'new-c-3', source: 'community', stars: 1 },
      ];
    };
    const cache = await m.buildIndex();
    const names = new Set((cache.plugins || []).map((p) => p.name));
    check('M-f 截断源：新条目保留', names.has('new-c-1') && names.has('new-c-3'), [...names].filter((n) => n.startsWith('new-')).join(','));
    check('M-f 截断源：旧条目被合并回来（不被替换）',
      names.has('old-c-0') && names.has('old-c-99'), '社区总数=' + (cache.plugins || []).filter((p) => p.source === 'community').length);
    check('M-f 截断源合并后总数为 3+100（社区）',
      (cache.plugins || []).filter((p) => p.source === 'community').length === 103,
      String((cache.plugins || []).filter((p) => p.source === 'community').length));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── M-g（反向）：**未**截断的源不得合并旧条目（否则陈旧条目永不淘汰）──
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
    const m = new PluginMarket({ cacheDir: dir, stateFile: path.join(dir, 's.json'), logger: { info() {}, warn() {}, error() {} } });
    m._cache = { indexedAt: Date.now(), sources: {}, total: 1, plugins: [{ name: 'stale', source: 'community', stars: 1 }] };
    m._ts = Date.now();
    m.indexNpm = async () => [];
    m.indexGithub = async () => [];
    m.indexCommunity = async () => [{ name: 'fresh-only', source: 'community', stars: 1 }];
    const cache = await m.buildIndex();
    const names = (cache.plugins || []).map((p) => p.name);
    check('M-g 未截断的源不合并旧条目（陈旧条目正常淘汰）',
      names.length === 1 && names[0] === 'fresh-only', names.join(','));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();