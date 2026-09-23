'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 统一子进程执行器：同步 exec 的**唯一入口**。
//
// ## 为什么存在（一次未完成的修复）
//
// 审计 P2-3 发现全仓 62 处 `execFileSync` 无 timeout —— systemctl/dbus 挂起、
// lsof 卡顿等即**无限期阻塞守卫事件循环**（API/探测/监督全部冻结，无超时自愈）。
//
// 于是建立了本模块……**但它从未被接入**。2026-09-11 复核实测：
// · 本文件被引用次数 = **0**；
// · 仍有 **22 处** `execFileSync` 没有 timeout。
//
// 即：一个自称「唯一入口」的模块，无人使用。这与「macOS 自启注释谎称由 LaunchAgent
// 代管」是**同一失效模式** —— 文字声称的纪律，代码里没有；且因为「看起来已经有了」，
// 反而阻止了后续的检查。
//
// 本次修复：接入全部调用点，并加门禁 G9（源码中不得存在无 timeout 的 execFileSync）。
//
// ## 从桌面壳学到的三条（壳的 `bounded.rs` 比本实现更完整）
//
// ① **killSignal: SIGKILL** —— `timeout` 到期默认发 SIGTERM，而挂起的进程
// （如卡在 D 状态的 systemctl、被调试器停住的进程）**可能不理会 SIGTERM**，
// 于是「有超时」形同虚设。壳用 `child.kill()`（SIGKILL 语义）保证真正有界。
// ② **windowsHide: true** —— GUI 进程调用控制台程序不弹黑框；
// 对应壳的 `CREATE_NO_WINDOW`（`bounded.rs::prepare`）。
// ③ **maxBuffer 显式化** —— 默认 1MB，超出抛 ENOBUFS；
// `systemctl status` 之类冗长输出会因此被误判为「命令失败」。
//
// ## 契约
// · `run()` —— 同步执行，默认 15s 硬超时；失败/超时返回 null（调用方自行降级）
// · `runOut()` —— 同上，返回 stdout 字符串
// · `runDetail()`—— 返回结构化结果 { ok, code, stdout, stderr, timedOut }
// · **仅限**守卫启动早期（事件循环尚无其他职责）、CLI 一次性命令，
// 或无法异步的调用点。新增调用优先考虑 `execFile` + await。
// ═══════════════════════════════════════════════════════════════════════════

const { execFileSync } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 15000;

/** 默认输出上限（8MB）：足以容纳 systemctl status / ip route 等冗长输出。 */
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/** 把调用参数规范化为 execFileSync 选项（**保证 timeout 与 killSignal 一定存在**）。 */
function options(opts) {
  const o = opts || {};
  return {
    timeout: o.timeoutMs || DEFAULT_TIMEOUT_MS,
    // 必须 SIGKILL：SIGTERM 对挂起/被停住的进程可能无效 → 「有超时」形同虚设。
    killSignal: o.killSignal || 'SIGKILL',
    maxBuffer: o.maxBuffer || DEFAULT_MAX_BUFFER,
    stdio: o.stdio || ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(o.encoding ? { encoding: o.encoding } : {}),
    ...(o.cwd ? { cwd: o.cwd } : {}),
    ...(o.env ? { env: o.env } : {}),
    ...(o.input !== undefined ? { input: o.input } : {}),
  };
}

/**
 * 有界执行：失败/超时返回 null（调用方自行降级）。
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{timeoutMs?:number, logger?:object, encoding?:string, stdio?:any}} [opts]
 * @returns {Buffer|string|null}
 */
function run(bin, args, opts) {
  const o = opts || {};
  try {
    const out = execFileSync(bin, args, options(o));
    // 2026-09-13（P0 修复）：**成功也可能返回 null** —— 这必须与「失败」区分开。
    //
    // 缺陷：execFileSync 在 stdio 不捕获 stdout（如 'ignore' 或 ['ignore','ignore','ignore']）
    // 时，**命令成功也返回 null**（不是空串、不是空 Buffer）。而本函数对外的契约是
    // 「失败/超时返回 null（调用方自行降级）」—— 于是**每一个以 !== null 判成功的调用方
    // 都把成功读成失败**。
    //
    // 实测（本机）：execFileSync('node',['--version'],{stdio:'ignore'}) === null，
    // 而 {stdio:['ignore','pipe','pipe']} 返回 Buffer —— 与命令是否成功无关。
    //
    // 修法：异常仍返回 null（=失败）；**成功一律返回非 null 值**
    // （无 stdout 可捕获时给空 Buffer / 空串）。这样 '!== null' 才真正等价于「成功」。
    if (out === null || out === undefined) {
      return o.encoding ? '' : Buffer.alloc(0);
    }
    return out;
  } catch (e) {
    if (o.logger && o.logger.warn) {
      try {
        o.logger.warn('[exec] ' + bin + ' ' + (args || []).join(' ').slice(0, 80) +
          ' failed: ' + ((e && e.message) || e));
      } catch {}
    }
    return null;
  }
}

/** 同 [`run`]，返回 stdout 字符串（失败/超时返回 null）。 */
function runOut(bin, args, opts) {
  const o = Object.assign({}, opts || {}, { encoding: 'utf8' });
  const r = run(bin, args, o);
  if (r === null) return null;
  try { return String(r); } catch { return null; }
}

/**
 * 同 [`run`]，但返回**结构化**结果（不吞错误信息）。
 *
 * 用于需要区分「命令失败」与「命令超时」的调用点 ——
 * 二者对用户的含义完全不同（前者是环境问题，后者是系统无响应）。
 *
 * @returns {{ok:boolean, code:(string|null), stdout:string, stderr:string, timedOut:boolean, error:(string|null)}}
 */
function runDetail(bin, args, opts) {
  const o = opts || {};
  try {
    const out = execFileSync(bin, args, options(Object.assign({}, o, { encoding: 'utf8' })));
    return { ok: true, code: '0', stdout: String(out || ''), stderr: '', timedOut: false, error: null };
  } catch (e) {
    // Node 的超时错误：message 含 'ETIMEDOUT'，或被信号杀死时 signal 有值。
    const timedOut = !!(e && (e.code === 'ETIMEDOUT' || e.signal === 'SIGKILL' ||
      /ETIMEDOUT|timed? ?out/i.test(String(e && e.message))));
    return {
      ok: false,
      code: (e && e.status != null) ? String(e.status) : null,
      stdout: String((e && e.stdout) || ''),
      stderr: String((e && e.stderr) || ''),
      timedOut,
      error: (e && e.message) ? String(e.message) : String(e),
    };
  }
}

module.exports = { run, runOut, runDetail, options, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BUFFER };