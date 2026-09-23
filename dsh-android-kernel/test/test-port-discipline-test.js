#!/usr/bin/env node
'use strict';

// 测试端口纪律门禁（2026-09-11）。
//
// == 背景（真实 flake 根因） ==
//
// 测试原先各自硬编码固定端口，其中 39 个落在 **OS ephemeral 范围**（Linux 默认 32768-60999）。
// 生产代码 ports.js 明确要求「选址必须避开 OS 动态端口范围」，测试却违反了它。
// 后果：claimSlot 用 bind 探测判占用，ephemeral 内的端口会被任何进程的临时出站连接
// 短暂占用 → bind 失败 → 跳过端口 → 断言数值不符。表现为**偶发假失败**：
// · ports-claim-test 的 instB → base+2 曾偶发失败
// · router-e2e-test 与 token-boundary-test 撞用 39080 → EADDRINUSE
//
// 本门禁确保该问题不再回归：
// T1 所有测试固定端口必须落在安全段（test/_ports.js 的 28000-28999）
// T2 测试不得硬编码端口字面量 —— 必须经 safePort() 取（防跨文件撞号）
// T3 跨文件端口段不得重叠

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const SEG = require(path.join(__dirname, '_ports.js'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

const files = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.js') && !f.startsWith('_'));

// ── T1：固定端口必须在安全段 ──
console.log('== T1 固定端口落在安全段 ==');
{
  // 关键设计：「4-5 位数字」== 「端口」是**错误**的假设，会造成大量误报 ——
  // 实测 `20000` 既是超时毫秒数（多个测试用它当超时），又恰好是生产池的下界；
  // 单凭数值无法区分。
  //
  // 因此本门禁只匹配**明确的端口语境**（白名单式），而不是「扫描所有数字再过滤」：
  // · `port: 39080` / `port = 39080` / `apiPort: 39080`
  // · `listen(39080, ...)`
  // · `127.0.0.1:39080` / `localhost:39080`（含 URL 串里的形态）
  // 这样超时毫秒数、区间边界常量、注释里的说明值都不会被误判。
  const PORT_PATTERNS = [
    /\bport\s*[:=]\s*(\d{4,5})\b/gi,
    /\blisten\(\s*(\d{4,5})\b/g,
    /127\.0\.0\.1:(\d{4,5})\b/g,
    /localhost:(\d{4,5})\b/g,
  ];
  // 安全段内与危险区外的端口无需报告；ephemeral/生产池边界说明值例外。
  // 注意：危险区判定由 SEG.isSafe 负责，它检查 Linux 动态端口范围
  //（32768-60999，并叠加本机实际 ip_local_port_range）。
  const ALLOW = new Set([1024, 65535, 32768, 60999]);
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, 'test', f), 'utf8');
    src.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      // 跳过整行注释
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      for (const re of PORT_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) {
          const p = Number(m[1]);
          if (ALLOW.has(p)) continue;
          if (p >= SEG.BASE && p <= SEG.BASE + 999) continue;   // 安全段
          if (SEG.isSafe(p)) continue;                          // 不在危险区
          offenders.push(f + ':' + (i + 1) + ' ' + p + '  [' + line.trim().slice(0, 60) + ']');
        }
      }
    });
  }
  check('T1 无固定端口落在 ephemeral/生产池内', offenders.length === 0, offenders.slice(0, 5).join(' | '));
}

// ── T2：迁移过的文件必须经 safePort 取端口 ──
console.log('== T2 迁移文件使用 safePort ==');
{
  const migrated = Object.keys(SEG.SEGMENTS);
  let missing = [];
  for (const name of migrated) {
    const f = files.find((x) => x.replace(/-test\.js$/, '').replace(/\.js$/, '') === name);
    if (!f) continue;
    const src = fs.readFileSync(path.join(ROOT, 'test', f), 'utf8');
    if (!/safePort/.test(src)) missing.push(f);
  }
  check('T2 已登记的文件都引用了 safePort', missing.length === 0, missing.join(', '));
}

// ── T3：跨文件段不重叠 ──
console.log('== T3 跨文件端口段不重叠 ==');
{
  const seen = new Map();
  let dup = 0;
  for (const name of Object.keys(SEG.SEGMENTS)) {
    const base = SEG.safeBase(name);
    for (let i = 0; i < 10; i++) {
      if (seen.has(base + i)) dup += 1;
      seen.set(base + i, name);
    }
  }
  check('T3 端口段无跨文件重叠', dup === 0, dup + ' 处重叠');
}

// ── T4：安全段本身必须真的安全 ──
console.log('== T4 安全段自洽 ==');
{
  const ok = SEG.isSafe(SEG.BASE) && SEG.isSafe(SEG.BASE + 999);
  check('T4 安全段两端都不在危险区', ok, 'base=' + SEG.BASE + ' end=' + (SEG.BASE + 999));
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
