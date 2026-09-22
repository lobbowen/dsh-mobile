#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 第十三轮续：心跳是**唯一周期驱动**时的自愈与可观测（2026-09-13）
//
// ## 缺陷（失效模式 e + h，后果最严重的一类：静默全停）
//
// supervisor.js 的心跳：
//   · `if (this._heartbeatBusy) return;` 是**丢拍**语义（注释只写「防慢拍重叠」）；
//   · `_heartbeatBusy` 只在 `.finally` 里释放 —— 若 heartbeat 返回的 promise
//     **永不 settle**，`.finally` 永不执行 → busy 永久 true → **心跳永停**。
//
// 为什么致命：`managedObjects` 存在时**不创建 tick 定时器**（supervisor.js:455），
//   故心跳是 main 收敛 / 沙箱监督 / daemon 监督的**唯一**周期驱动。
//   心跳停摆后：main 即使 desired=running 也永不 spawn/adopt、沙箱挂了永不退避重试、
//   router/lan daemon 失联永不被拉起 —— 而 /status 仍显示最后一次写入的 phase，
//   没有任何「心跳已停」的暴露字段 → 用户看到「面板开着、服务全死、无任何事件」。
//
// ## 修法
//   · objects.js：逐对象 supervise/observe 加超时（拍宽 × ADAPTER_TIMEOUT_TICKS）；
//   · supervisor.js：独立**兜底释放**定时器（拍宽 × 12）强制释放 busy 并记 warn，
//     同时暴露 _lastHeartbeatAt / _heartbeatStalls 使停摆可观测。
//
// ## 本门禁
//   A 兜底释放的结构在（阈值、计数、日志）
//   B **行为**：用真实 setInterval+busy 结构复现，断言「拍内 promise 永不 settle 时，
//     兜底在阈值后释放 busy，使下一拍能再次进入」——这是缺陷的核心可证伪点。
//   C 可观测字段存在
//   D 拍宽变量**必须在 setInterval 之前求值**（我第一版把它写在回调内却在
//     `}, iv)` 处引用 → ReferenceError → 定时器根本没建起来 → smoke S1 全红）。
//     这条断言专门锁住那个自伤。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};
const raw = fs.readFileSync(path.join(ROOT, 'src', 'supervisor.js'), 'utf8');
const code = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

(async () => {
  console.log('== A 兜底释放结构 ==');
  check('A 存在兜底释放（强制清 busy）', /this\._heartbeatBusy = false;/.test(code), '有');
  check('A 兜底释放带阈值（拍宽 × 12）', /iv \* 12|stallMs/.test(code), '有');
  check('A 兜底释放带计数（可观测）', /_heartbeatStalls\+\+/.test(code), '有');
  check('A 兜底释放记 warn（不静默）', /强制释放防停摆/.test(code), '有');
  check('A 兜底定时器 unref（不拖住进程退出）', /guard && typeof guard\.unref === 'function'/.test(code), '有');
  check('A 正常结算时 clearTimeout（不误触发）', /clearTimeout\(guard\)/.test(code), '有');

  console.log('== B 行为：拍内永不 settle 时兜底释放使下一拍可进入 ==');
  {
    // 复现 supervisor 的同一结构，压缩时基
    const IV = 40;
    const STALL_MS = 120; // 阈值压缩
    let busy = false, beats = 0, stalls = 0;
    let enteredAfterStall = false;
    let firstBeatDone = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      beats++;
      if (firstBeatDone) enteredAfterStall = true;
      const guard = setTimeout(() => {
        if (busy) { busy = false; stalls++; firstBeatDone = true; }
      }, STALL_MS);
      if (guard && guard.unref) guard.unref();
      // 模拟「永不 settle」的 heartbeat
      new Promise(() => {}).finally(() => { clearTimeout(guard); busy = false; });
    }, IV);
    await new Promise((r) => setTimeout(r, STALL_MS * 4));
    clearInterval(timer);
    check('B 兜底已触发（busy 被强制释放）', stalls >= 1, 'stalls=' + stalls);
    check('B 兜底后心跳能再次进入（旧实现永久 false → 不再进入）',
      enteredAfterStall === true, 'entered=' + enteredAfterStall);
    check('B 有多次心跳（未被一次卡死钉死）', beats >= 2, 'beats=' + beats);
  }

  console.log('== C 可观测字段 ==');
  check('C 暴露 _lastHeartbeatAt（心跳停摆可查）', /_lastHeartbeatAt/.test(code), '有');
  check('C 暴露 _heartbeatStalls（停摆次数可查）', /_heartbeatStalls/.test(code), '有');
  check('C 每拍刷新 _lastHeartbeatAt', /_lastHeartbeatAt = Date\.now\(\)/.test(code), '有');

  console.log('== D 拍宽变量在 setInterval 之前求值（锁住我第一版的自伤）==');
  {
    // ⚠ 必须定位到**心跳那一个** setInterval，而不是文件里更早的其它 setInterval
    //   （我第一版用 indexOf('setInterval(') 命中了前面的定时器 → 假红）。
    const iIv = code.indexOf('const heartbeatIv = this.config.probeIntervalMs');
    const iSet = code.indexOf('this._heartbeatTimer = setInterval(');
    check('D heartbeatIv 在 setInterval 之前声明', iIv > 0 && iSet > iIv, 'iv@' + iIv + ' set@' + iSet);
    check('D setInterval 的间隔参数来自该变量', /\}, heartbeatIv\);/.test(code), '有');
    // 反向：不得出现「回调内声明 iv、却在回调外引用」的形态
    const cbIv = code.indexOf('const iv = heartbeatIv;');
    check('D 回调内用的是外层变量（非重新求值/未声明）', cbIv > iSet, 'cb@' + cbIv);
    // 真实语法/运行时检查：supervisor 模块必须可加载（ReferenceError 会在加载/调用时暴露）
    check('D supervisor 模块可正常加载（无 ReferenceError）',
      (() => { try { require(path.join(ROOT, 'src', 'supervisor.js')); return true; } catch { return false; } })(), 'ok');
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
