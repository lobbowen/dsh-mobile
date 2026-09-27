'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// C 层（共享开发环境）的**机制**：按 **C 自己的内容清单** 把件投放就位。
//
// 分层（ADR-0009 §2.1）：
//   · **内容**（有哪些件、版本/url/sha/入口）= C 的通道里的**签名清单**（./manifest.js 取回并验签）；
//     本模块**不持有**任何件的版本/哈希 —— 那是 2026-09-27 定罪的越层（加件/升级必发内核）。
//   · **机制**（取回 → 验 → 原子落位 → 写 $PREFIX）= 本模块，住内核（L1）。
//   · **落位规则与能力判据**归 E（../assembler/supply-table.json）。
//
// 为什么不是 `npm i -g` 就完事：安卓上 npm 生成的 bin shim 是 `#!/usr/bin/env node`，
//   而 /usr/bin/env 在安卓不存在 ⇒ execve 必 ENOENT。故工具本体装在共享 $PREFIX/lib/toolchain 下，
//   入口由本模块写成 `#!/system/bin/sh` 包装；按 kind 决定 exec 什么（native = 直接 exec 自带二进制）。
//
// 三条**投放不变量**（真机定罪 2026-09-27：19.5MB/47MB 的半截 pnpm 被写成入口、静默失效）：
//   ① 完整性：工件按 sha256+size **逐字节核对**，残件一律视为没装；
//   ② 原子性：装到 staging，校验通过后 rename 换入终态 —— 绝不半截就位；
//   ③ 单写者：lib/toolchain.lock 独占；拿不到就本轮不做（别人正在装）。
//
// 内核 → C 是**依赖**，不是内核的一部分：清单取不到（离线/验签不过）时本模块只降级 ——
//   已就位的件照常可用，不做增量，绝不因此让内核启动失败。
//
// 边界：只在**容器契约形态**下动手（runtime.json 有 npmEntry 与 prefix）；
//   无契约 = skipped（PC / 测试逐字不变，不变量 C2）。失败只返回 failed/skipped，绝不抛。
// ═══════════════════════════════════════════════════════════════════════════

const manifest = require('./manifest');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const https = require('node:https');
const { spawn } = require('node:child_process');
const runtimeContract = require('../platform/runtime-contract');

// 件目录（版本/url/sha/入口）**不在本模块**：它住在 C 的通道里的签名清单，由 ./manifest.js 取回并验签。

const INSTALL_TIMEOUT_MS = 600000;
const DOWNLOAD_TIMEOUT_MS = 300000;
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

/** 取一个 https 文件到本地（跟随重定向、有界）。设备端只走 HTTPS。 */
function downloadTo(url, dest, timeoutMs, depth) {
  const d = depth || 0;
  return new Promise((resolve) => {
    let req;
    try {
      req = https.get(url, { timeout: timeoutMs }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && d < 5) {
          res.resume();
          return resolve(downloadTo(new URL(res.headers.location, url).toString(), dest, timeoutMs, d + 1));
        }
        if (res.statusCode !== 200) { res.resume(); return resolve({ ok: false, reason: 'HTTP ' + res.statusCode }); }
        const out = fs.createWriteStream(dest);
        out.on('error', (e) => resolve({ ok: false, reason: e.message }));
        out.on('finish', () => out.close(() => resolve({ ok: true })));
        res.pipe(out);
      });
    } catch (e) { return resolve({ ok: false, reason: e.message }); }
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false, reason: '取件超时 ' + timeoutMs + 'ms' }); });
    req.on('error', (e) => resolve({ ok: false, reason: e.message }));
  });
}

/** 解 tar.gz 到目标目录。为什么自带解析：设备上不保证有 tar，而交付链不该依赖 PATH 里有没有一条命令。
 *  只处理目录与普通文件，拒绝穿越路径（.. / 绝对路径）。 */
function extractTarGz(gzPath, destDir) {
  const buf = zlib.gunzipSync(fs.readFileSync(gzPath));
  let off = 0;
  while (off + 512 <= buf.length) {
    const raw = buf.toString('utf8', off, off + 100).replace(/\0[\s\S]*$/, '');
    if (!raw) { off += 512; continue; }
    const size = parseInt(buf.toString('utf8', off + 124, off + 136).replace(/\0[\s\S]*$/, '').trim(), 8) || 0;
    const type = buf.toString('utf8', off + 156, off + 157);
    const prefix = buf.toString('utf8', off + 345, off + 500).replace(/\0[\s\S]*$/, '');
    const full = (prefix ? prefix + '/' : '') + raw;
    const dataOff = off + 512;
    if (full.indexOf('..') < 0 && full.charAt(0) !== '/') {
      const dest = path.join(destDir, full);
      if (type === '5') { fs.mkdirSync(dest, { recursive: true }); }
      else if (type === '0' || type === '' || type === '\u0000') {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf.subarray(dataOff, dataOff + size), { mode: 0o755 });
      }
    }
    off = dataOff + Math.ceil(size / 512) * 512;
  }
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
 * @param {string} name 工具名（取自 C 的清单）
 * @param {{npmInvocation?:{bin:string,args:string[]}, runInstall?:Function, timeoutMs?:number}} [opts] 测试注入
 * @returns {Promise<{status:'already'|'applied'|'skipped'|'failed', name:string, bin?:string, entry?:string, reason?:string}>}
 */
async function ensureSharedTool(name, opts) {
  const o = opts || {};
  const out = (status, extra) => Object.assign({ status, name }, extra || {});
  let spec = null;
  try { spec = await manifest.specFor(name); } catch (e) {
    // 清单取不到（离线/验签不过/超时）：**降级**，不把内核拖下水（C 可缺省：已有件仍可用）。
    return out('skipped', { reason: 'C 清单不可用：' + e.message });
  }
  if (!spec) return out('skipped', { reason: '清单里没有这件（或许是别的通道/版本）: ' + name });
  const c = runtimeContract.read();
  if (!c || !c.npmEntry || !c.prefix) return out('skipped', { reason: '非容器契约形态（无 runtime.json / npmEntry / prefix）' });
  const bin = path.join(c.prefix, 'bin', name);
  const libBase = path.join(c.prefix, 'lib');
  const root = path.join(libBase, 'toolchain');
  const staging = path.join(libBase, 'toolchain.staging');
  const lockFile = path.join(libBase, 'toolchain.lock');
  // 取件方式决定入口在树里的相对位置：npm 装在 node_modules/<pkg>/；tarball 按包内自带布局。
  const entryRel = spec.provider === 'tarball' ? spec.entry : path.join('node_modules', spec.pkg, spec.entry);
  const entry = path.join(root, entryRel);
  const stagingEntry = path.join(staging, entryRel);
  // 完整性锚的**作用对象**不同：npm 件锚可执行文件本身；tarball 件锚压缩包（解包产物由包内布局 +
  // 原子落位保证），故入口只判「是不是文件」。
  const entrySpec = spec.provider === 'tarball' ? {} : spec;
  const nodeBin = path.join(c.prefix, 'bin', 'node');
  const execLine = spec.kind === 'native'
    ? 'exec "' + entry + '" "$@"'
    : 'exec "' + nodeBin + '" "' + entry + '" "$@"';
  const body = '#!/system/bin/sh' + NL
    + '# dsh toolchain 生成；安卓无 /usr/bin/env，npm 的 bin shim 不可 execve。' + NL
    + execLine + NL;

  // ①③ 已就位 = 入口在场**且工件逐字节完整**；入口按内容判新鲜。
  if (await artifactOk(entry, entrySpec)) {
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
    if (spec.provider === 'tarball') {
      // 上游没有 android 变体的件：取回 → 核对**压缩包** sha256 → 解包到暂存 → 原子落位。
      const gz = path.join(staging, '.artifact.tar.gz');
      const dl = await downloadTo(spec.url, gz, o.downloadTimeoutMs || DOWNLOAD_TIMEOUT_MS);
      if (!dl.ok) {
        fs.rmSync(staging, { recursive: true, force: true });
        return out('failed', { reason: '取件失败: ' + dl.reason + ' <- ' + spec.url });
      }
      const got = await sha256File(gz);
      if (spec.sha256 && got !== spec.sha256) {
        fs.rmSync(staging, { recursive: true, force: true });
        return out('failed', { reason: '取件完整性不过（sha256 ' + got.slice(0, 16) + '… ≠ 表锚），已丢弃 —— 不落一个可疑件' });
      }
      extractTarGz(gz, staging);
      try { fs.unlinkSync(gz); } catch {}
    } else {
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
    }
    if (!fs.existsSync(stagingEntry)) {
      fs.rmSync(staging, { recursive: true, force: true });
      return out('failed', { reason: '暂存树里没有入口（包内布局与表不符）: ' + stagingEntry });
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
  let names;
  try { names = await manifest.toolNames(); } catch (e) {
    const reason = 'C 清单不可用：' + e.message;
    o.logger && o.logger.info && o.logger.info('共享工具投放：' + reason + '（只降级，已有件仍可用）');
    if (o.events) { try { o.events.append('toolchain_tool', { name: '*', status: 'skipped', reason }); } catch (_) {} }
    if (typeof o.onSettled === 'function') { try { o.onSettled({}); } catch (_) {} }
    return out;
  }
  for (const name of names) {
    let r;
    try { r = await ensureSharedTool(name, o); } catch (e) { r = { status: 'failed', name, reason: e.message }; }
    out[name] = r;
    const line = '共享工具投放 ' + name + ': ' + r.status + (r.reason ? '（' + r.reason + '）' : '');
    // 严重度按**结局**给，不按「是不是 applied」：already（已就位）与 skipped（本轮不做，例如
    // 别人正在装/非容器形态）都是正常路径，记 info；只有 failed 才是警告 —— 否则正常启动会
    // 天天刷 WARN，把真警告淹掉（真机定罪 2026-09-27）。
    if (r.status === 'failed') { o.logger && o.logger.warn && o.logger.warn(line); }
    else { o.logger && o.logger.info && o.logger.info(line); }
    if (o.events) { try { o.events.append('toolchain_tool', { name, status: r.status, reason: r.reason || null }); } catch (_) {} }
  }
  // 投放改变了环境 ⇒ 能力结论必须重算（「同一件事两个正交结论」的纪律）：调用方据此
  // 触发一次 fresh 核验，否则面板会一直挂着投放期内那次「还没装好」的读数。
  if (typeof o.onSettled === 'function') { try { o.onSettled(out); } catch (_) {} }
  return out;
}

module.exports = { ensureSharedTool, provisionSharedTools, isProvisioning, INSTALL_TIMEOUT_MS, LOCK_STALE_MS };
