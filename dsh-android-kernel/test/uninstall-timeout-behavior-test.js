#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// P1-F **行为级**回归：卸载挂起时必须超时收尾并释放锁
//
// 与 `uninstall-timeout-test.js`（静态断言）的分工：
//   · 静态断言证明「结构与接线存在」；
//   · 本测试证明「**行为真的发生**」—— 用一个会挂起的假 npm 触发真实的看门狗路径。
//
// ⚠ 为什么必须两者都有：静态断言无法证明超时会被触发
//   （我第一版只写静态断言，注入「看门狗永不触发」后它照样全绿 —— 那是假门禁）。
//
// 做法：
//   1. 造一个**永不退出**的假 npm（`#!/bin/sh` + `sleep 1000`）；
//   2. 把 config.uninstallTimeoutMs 设为 800ms（这就是可注入的用途）；
//   3. 调 uninstall()，断言：在远小于 sleep 时长内返回、ok=false、timedOut=true；
//   4. 断言 `manager.uninstalling === null`（锁已释放 —— 这是缺陷的核心症状）。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const { NativeManager } = require(path.join(ROOT, 'src', 'guard', 'native', 'manager.js'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

(async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1f-'));
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  // 假 npm：**永不退出**（模拟 registry 挂死 / 凭证助手等待）。
  //
  // ⚠ 2026-09-13 修复（P1）：**必须跨平台构造**。
  //   原实现写的是 '#!/bin/sh' + sleep 1000 的 **POSIX 脚本** ——
  //   Windows **无法执行**它（无 sh 解释器）→ spawn 立刻失败，
  //   「挂起」退化成「立即失败」→ timedOut=false → 本测试两条断言在 Windows 上必红
  //   （实测 v0.1.5-BETA.2 的 windows-latest leg：4ms 返回、timedOut=null→false）。
  //   修法：用 **Node 自身**当解释器（四平台都是同一个可执行），
  //   并把「挂起/正常退出」写成两份 .js —— 由 process.execPath 执行，Windows 同样可用。
  const HANG_JS = 'setTimeout(function () {}, 60000);';   // 60s 不退出（远大于 800ms 超时）
  const fakeNpmHang = path.join(tmp, 'npm-hangs.js');
  fs.writeFileSync(fakeNpmHang, HANG_JS);
  const fakeNpm = process.execPath;                        // 用真实 node 可执行当「解释器」
  const fakeNpmArg = [fakeNpmHang];                        // 由 manager 的 npmBin 支持数组

  // ⚠ 绝不用「patch 模块导出」的方式替换 npm —— 真实事故（2026-09-12）：
  //   `const { npmBin } = require(...)` 是**值绑定**，patch 无效，
  //   于是这次「伪造的挂起」实际执行了**真实 npm uninstall -g**。
  //   那次恰好 no-op（目标 prefix 无此包），但这是侥幸：若真有包就会被删。
  //   现改为**构造期依赖注入**（opts.npmBin），测试在结构上不可能触碰真实 npm。
  const mgr = new NativeManager({
    config: {
      packageName: '@deepseek-ai/dsh',
      uninstallTimeoutMs: 800, // ← 可注入：真实 15min 无法在测试里等待
      stateDir,
    },
    stateDir,
    npmBin: fakeNpm, // ← 依赖注入：绝不解析到真实 npm
    logger: { info() {}, warn() {}, error() {} },
  });

  // 结构性保险：若将来有人改坏了注入链，这里立刻失败，而不是去跑真实 npm。
  check('前置：npm 已被注入为假可执行（绝不用真实 npm）',
    mgr._npmBin === fakeNpm, String(mgr._npmBin));
  // 注入「以 node 执行该脚本」的参数（跨平台；不依赖 sh）
  mgr._npmBinArgs = fakeNpmArg;

  // 造一份 manifest（否则 uninstall 没有可清理对象；同时验证「超时保留 manifest」）
  const manifestFile = path.join(stateDir, 'native-manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({
    version: '0.0.0-test', packageDir: path.join(tmp, 'pkg'), binPath: path.join(tmp, 'bin'), dataPaths: [],
  }));

  const t0 = Date.now();
  const r = await mgr.uninstall();
  const elapsed = Date.now() - t0;


  // ── 核心断言 ──
  check('行为：挂起的 npm 被超时收尾（< 6s 返回，而非等 sleep 1000）',
    elapsed < 6000, elapsed + 'ms');
  check('行为：超时被如实上报（timedOut=true）',
    r && r.timedOut === true, JSON.stringify({ ok: r && r.ok, timedOut: r && r.timedOut }));
  check('行为：结果不是成功', r && r.ok === false, 'ok=' + (r && r.ok));
  check('行为：卸载锁**已释放**（旧实现会永久为真）',
    mgr.uninstalling === null, 'uninstalling=' + String(mgr.uninstalling));
  check('行为：超时后 manifest **保留**（可重试，K10 语义未回退）',
    fs.existsSync(manifestFile), fs.existsSync(manifestFile) ? '保留' : '被误删');

  // ── 反向：看门狗不能误伤正常完成的卸载 ──
  {
    const quickNpm = path.join(tmp, 'npm-quick');
    // 正常退出的假 npm：同样用 Node 执行（跨平台），立即退出 0。
    const quickJs = path.join(tmp, 'npm-ok.js');
    fs.writeFileSync(quickJs, 'process.exit(0);');
    mgr._npmBin = process.execPath; // 注入正常退出的假 npm（同样绝不碰真实 npm）
    mgr._npmBinArgs = [quickJs];
    mgr.uninstalling = null;
    fs.writeFileSync(manifestFile, JSON.stringify({
      version: '0.0.0-test', packageDir: path.join(tmp, 'pkg2'), binPath: path.join(tmp, 'bin2'), dataPaths: [],
    }));
    const r2 = await mgr.uninstall();
    check('反向：正常退出的 npm 不被误判为超时',
      r2 && r2.ok === true && r2.timedOut !== true, JSON.stringify({ ok: r2 && r2.ok, timedOut: r2 && r2.timedOut }));
    check('反向：正常路径也释放锁', mgr.uninstalling === null, String(mgr.uninstalling));
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('异常: ' + (e && e.stack || e)); process.exit(1); });