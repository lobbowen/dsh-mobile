'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// C 层（共享开发环境）物化器：产品无关的共享工具（pnpm…）的安装与可执行入口。
//
// 为什么不是 `npm i -g` 就完事：
//   · 安卓上 npm 生成的 bin shim 是 `#!/usr/bin/env node`，而 /usr/bin/env 在安卓不存在
//     ⇒ execve 必 ENOENT（本仓对 npm 自己也是恒以 `node <cli.js>` 代跑）。
//   · 故：工具本体装在共享 $PREFIX/lib/toolchain 下，入口由本模块写成
//     `#!/system/bin/sh` 包装；按 kind 决定 exec 什么（native = 直接 exec 自带二进制）。
//
// 三条**投放不变量**（真机定罪 2026-09-27：19.5MB/47MB 的半截 pnpm 被写成入口、静默失效）：
//   ① 完整性：工件按 sha256+size **逐字节核对**，残件一律视为没装；
//   ② 原子性：装到 staging，校验通过后 rename 换入终态 —— 绝不半截就位；
//   ③ 单写者：lib/toolchain.lock 独占；拿不到就本轮不做（别人正在装）。
//
// 为什么 pnpm 钉 12.7.0：官方自 12.4.0 起为 Android/bionic 发 aarch64 原生可执行文件
//   （@pnpm/exe.android-arm64，含 /system/bin/linker64）。本机实测：直接 exec 输出 12.7.0。
//
// 边界：只在**容器契约形态**下动手（runtime.json 有 npmEntry 与 prefix）；
//   无契约 = skipped（PC / 测试逐字不变，不变量 C2）。失败只返回 failed/skipped，绝不抛。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const runtimeContract = require('./runtime-contract');

/** 共享工具清单（唯一事实源）。新增一个工具 = 加一行。
 *  pkg/entry = 要装的包与它在 node_modules 里的可执行相对路径；kind 决定怎么 exec；
 *  sha256/size = 工件完整性锚（装完必须逐字节对上）。 */
const TOOLS = {
  pnpm: {
    version: '12.7.0',
    pkg: '@pnpm/exe.android-arm64',
    entry: 'pnpm',
    kind: 'native',
    size: 47033992,
    sha256: 'ce0b5e064552f60ec5b153d767b464f8d64f7659dbc2c58780679ac7e5bdfe78',
    why: 'dsh 插件管理调用 pnpm；官方 12.4.0 起发 Android/bionic aarch64 原生产物',
  },
};

const INSTALL_TIMEOUT_MS = 600000;
const LOCK_STALE_MS = 15 * 60 * 1000;
const NL = String.fromCharCode(10);

let _provisioning = 0;
/** 是否有投放正在进行（核验侧据此避让：与重 IO 的投放抢 CPU 会把探针饿成超时）。 */
function isProvisioning() { return _provisioning > 0; }

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (d) => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** 工件是否**完整**（不是存在）：size + sha256 逐字节核对。 */
async function artifactOk(file, spec) {
  try { const st = fs.statSync(file); if (!st.isFile()) return false; if (spec.size && st.size !== spec.size) return false; } catch { return false; }
  if (!spec.sha256) return true;
  try { return (await sha256File(file)) === spec.sha256; } catch { return false; }
}

function acquireLock(lockFile) {
  const take = () => { const fd = fs.openSync(lockFile, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); };
  try { take(); return true; } catch (e) {
    if (e.code !== 'EEXIST') return false;
    try { const st = fs.statSync(lockFile); if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lockFile); take(); return true; } } catch {}
    return false;
  }
}
function releaseLock(lockFile) { try { fs.unlinkSync(lockFile); } catch {} }

/** 跑一次安装（异步、有界、整树可杀）。返回 { ok, code, tail }。 */
function runInstall(inv, args, env, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(inv.bin, inv.args.concat(args), { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) { return resolve({ ok: false, code: null, tail: e.message }); }
    let err = '';
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      finish({ ok: false, code: null, tail: '安装超时 ' + timeoutMs + 'ms' });
    }, timeoutMs);
    child.stderr.on('data', (b) => { err = (err + b.toString()).slice(-4000); });
    child.on('error', (e) => finish({ ok: false, code: null, tail: e.message }));
    child.on('exit', (code) => finish({ ok: code === 0, code, tail: err.split(NL).filter(Boolean).slice(-1)[0] || '' }));
  });
}

function writeWrapper(bin, body) {
  try { fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.writeFileSync(bin, body, { mode: 0o755 }); fs.chmodSync(bin, 0o755); return true; }
  catch (e) { return false; }
}

/**
 * 确保一个共享工具在场（安装 + 写可执行入口），幂等。
 * @param {string} name TOOLS 里的键
 * @param {{npmInvocation?:{bin:string,args:string[]}, runInstall?:Function, timeoutMs?:number}} [opts] 测试注入
 * @returns {Promise<{status:'already'|'applied'|'skipped'|'failed', name:string, bin?:string, entry?:string, reason?:string}>}
 */
async function ensureSharedTool(name, opts) {
  const o = opts || {};
  const out = (status, extra) => Object.assign({ status, name }, extra || {});
  const spec = TOOLS[name];
  if (!spec) return out('failed', { reason: '未登记的工具: ' + name });
  const c = runtimeContract.read();
  if (!c || !c.npmEntry || !c.prefix) return out('skipped', { reason: '非容器契约形态（无 runtime.json / npmEntry / prefix）' });
  const bin = path.join(c.prefix, 'bin', name);
  const libBase = path.join(c.prefix, 'lib');
  const root = path.join(libBase, 'toolchain');
  const staging = path.join(libBase, 'toolchain.staging');
  const lockFile = path.join(libBase, 'toolchain.lock');
  const entry = path.join(root, 'node_modules', spec.pkg, spec.entry);
  const stagingEntry = path.join(staging, 'node_modules', spec.pkg, spec.entry);
  const nodeBin = path.join(c.prefix, 'bin', 'node');
  const execLine = spec.kind === 'native'
    ? 'exec "' + entry + '" "$@"'
    : 'exec "' + nodeBin + '" "' + entry + '" "$@"';
  const body = '#!/system/bin/sh' + NL
    + '# dsh toolchain 生成；安卓无 /usr/bin/env，npm 的 bin shim 不可 execve。' + NL
    + execLine + NL;

  // ①③ 已就位 = 入口在场**且工件逐字节完整**；入口按内容判新鲜。
  if (await artifactOk(entry, spec)) {
    let binFresh = false;
    try { binFresh = fs.readFileSync(bin, 'utf8') === body; } catch {}
    if (binFresh) return out('already', { bin, entry });
    return writeWrapper(bin, body) ? out('applied', { bin, entry }) : out('failed', { reason: '写入口失败（见日志）' });
  }

  if (!acquireLock(lockFile)) return out('skipped', { reason: '另一个投放正在进行（锁被占）' });
  _provisioning += 1;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    const inv = o.npmInvocation || runtimeContract.npmInvocation();
    const args = ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock',
      '--prefix', staging, spec.pkg + '@' + spec.version];
    const env = runtimeContract.npmEnv(process.env);
    const r = typeof o.runInstall === 'function'
      ? o.runInstall(inv, args, env)
      : await runInstall(inv, args, env, o.timeoutMs || INSTALL_TIMEOUT_MS);
    if (!r || !r.ok) {
      fs.rmSync(staging, { recursive: true, force: true });
      return out('failed', { reason: '安装 ' + spec.pkg + '@' + spec.version + ' 失败' + (r && r.tail ? '（' + String(r.tail).slice(0, 160) + '）' : '') });
    }
    if (!(await artifactOk(stagingEntry, spec))) {
      fs.rmSync(staging, { recursive: true, force: true });
      return out('failed', { reason: '工件完整性校验不过（sha256/size 不符），已丢弃暂存树: ' + stagingEntry });
    }
    // ② 原子落位：单写者已持锁，先清终态再 rename（窗口极小且无读方在写）。
    fs.rmSync(root, { recursive: true, force: true });
    fs.renameSync(staging, root);
    try { fs.chmodSync(entry, 0o755); } catch {}
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    return out('failed', { reason: '投放异常: ' + e.message });
  } finally {
    _provisioning -= 1;
    releaseLock(lockFile);
  }
  return writeWrapper(bin, body) ? out('applied', { bin, entry }) : out('failed', { reason: '写入口失败（见日志）' });
}

/** C 层供给：把全部共享工具**在启动时**投放就位（不是「谁用到谁装」的惰性补丁）。
 *  异步、非阻塞、非致命：调用方 fire-and-forget；失败只记账，真因由使用点如实报出。
 *  幂等；单写者锁保证并发调用里只有一个真装。使用点（插件域）另有一道 await 屏障。 */
async function provisionSharedTools(opts) {
  const o = opts || {};
  const out = {};
  for (const name of Object.keys(TOOLS)) {
    let r;
    try { r = await ensureSharedTool(name, o); } catch (e) { r = { status: 'failed', name, reason: e.message }; }
    out[name] = r;
    const line = '共享工具投放 ' + name + ': ' + r.status + (r.reason ? '（' + r.reason + '）' : '');
    if (r.status === 'applied') { o.logger && o.logger.info && o.logger.info(line); }
    else { o.logger && o.logger.warn && o.logger.warn(line); }
    if (o.events) { try { o.events.append('toolchain_tool', { name, status: r.status, reason: r.reason || null }); } catch (_) {} }
  }
  // 投放改变了环境 ⇒ 能力结论必须重算（「同一件事两个正交结论」的纪律）：调用方据此
  // 触发一次 fresh 核验，否则面板会一直挂着投放期内那次「还没装好」的读数。
  if (typeof o.onSettled === 'function') { try { o.onSettled(out); } catch (_) {} }
  return out;
}

module.exports = { ensureSharedTool, provisionSharedTools, isProvisioning, TOOLS, INSTALL_TIMEOUT_MS, LOCK_STALE_MS };
