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
//   而 /usr/bin/env 在安卓不存在 ⇒ execve 必 ENOENT。**这条约定已由 D1 的 exec-path.c 补回**
//   （execve 前按调用方 PATH 解析 shebang），所以本模块不再手写包装：件解包到 $PREFIX/lib/toolchain/<件名>/（一件一目录 —— 共用一间时每装一件会抹掉前一件），
//   再 **symlink** 到 $PREFIX/bin（与 node 同一手法）—— 生态怎么找它，它就怎么在。
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
 *
 * 处理目录、普通文件、**符号链接**与硬链接 —— 后两者不是锦上添花：git 这类的运行期布局靠它
 *   （libexec/git-core/* 是符号链接，git-remote-https 就在里面）。只认文件与目录的解包器会把它们
 *   **悄悄丢掉**，真机上表现为「git 少了半套子命令」——这种错 CI 看不见，所以在这里就做对。
 *
 * 安全：拒绝绝对路径与含 .. 的成员；符号链接目标也拒绝绝对路径。 */
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
      else if (type === '2') {
        const link = buf.toString('utf8', off + 157, off + 257).split(String.fromCharCode(0))[0];
        if (link.charAt(0) !== '/') {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          try { fs.unlinkSync(dest); } catch (_e) { /* 不存在即可 */ }
          fs.symlinkSync(link, dest);
        }
      } else if (type === '1') {
        const hl = buf.toString('utf8', off + 157, off + 257).split(String.fromCharCode(0))[0];
        if (hl.indexOf('..') < 0 && hl.charAt(0) !== '/') {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          try { fs.unlinkSync(dest); } catch (_e) { /* 不存在即可 */ }
          fs.linkSync(path.join(destDir, hl), dest);
        }
      }
      else if (type === '0' || type === '' || type === '\u0000') {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const perm = parseInt(buf.toString('utf8', off + 100, off + 108).split(String.fromCharCode(0))[0].trim(), 8) || 0o644;
        fs.writeFileSync(dest, buf.subarray(dataOff, dataOff + size), { mode: perm });
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

/**
 * 把件暴露到 `$PREFIX/bin`：**symlink**，不是手写一层 sh 包装。
 *
 * 为什么删掉了包装（2026-09-27 清理）：包装是 shebang 约定缺失的**补偿层** —— 安卓没有 /usr/bin/env，
 *   npm 生成的 bin shim（`#!/usr/bin/env node`）不可 execve，于是我们给每件手写一层 sh 包装（把 shebang 指向安卓自带的 sh）。
 *   根因已由 D1 的 `exec-path.c` 补回（execve 前按调用方 PATH 解析 shebang 解释器与标准绝对路径），
 *   补偿层随之删除：件怎么被生态找到，就让它以什么形态在（与 node 的 symlink 同一手法）。
 *
 * 边界（如实记）：脚本类入口（`#!/usr/bin/env X`）依赖上面那条兑现；在尚未装上带 exec-path.c 的 APK 的
 *   设备上它会 ENOENT。当前清单里的件都是 native 入口（直接 exec 自带二进制），不受影响；
 *   该前提由供给表的 `env-shebang` 格在真机上判定。
 */
function binLinkOk(bin, target) {
  try { return fs.readlinkSync(bin) === target; } catch { return false; }
}
/** 一件一目录：$PREFIX/lib/toolchain/<name>。名字只来自清单（specFor），机制不猜。 */
function rootFor(prefix, name) {
  return path.join(prefix, 'lib', 'toolchain', name);
}

/** 暂存目录：与终态**同层**（同一文件系统，rename 才原子），点开头以免被当成件目录。 */
function stagingFor(prefix, name) {
  return path.join(prefix, 'lib', 'toolchain', '.' + name + '.staging');
}

/** 是不是（可能已断的）链接：existsSync 会跟随链接，断链它报 false，得用 lstat。 */
function isLinkMaybe(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch (_e) { return false; }
}

/**
 * 清掉**旧平铺布局**的残留（历史 bug：所有件共用 lib/toolchain/ 一间）。
 *
 * 纪律：只删**确切知道**属于旧布局的路径，其余一律不碰 —— 宁可留一点垃圾，也不误删别人的东西。
 *   特意**不删**：件目录（新布局）、点文件（清单水位 .manifest.json）、toolchain.lock（在 toolchain 之外）。
 */
function removeLegacyFlatLayout(prefix) {
  const tc = path.join(prefix, 'lib', 'toolchain');
  const legacy = ['bin', 'libexec', 'share', 'node_modules', 'link-farm.txt'];
  const removed = [];
  for (const n of legacy) {
    const p = path.join(tc, n);
    if (!fs.existsSync(p) && !isLinkMaybe(p)) continue;
    try { fs.rmSync(p, { recursive: true, force: true }); removed.push(n); } catch (_e) { /* 删不掉就留着 */ }
  }
  return removed;
}
/**
 * 应用件里的 link-farm.txt（每行：树内相对路径 <TAB> 符号链接目标）。
 *
 * 为什么让**件声明、设备生成**：git 的 libexec/git-core 有约 170 个子命令，全是指向同一二进制的链接。
 *   打包时若落成副本，件体积爆炸（CI 实测 1.29 GB）；只带名单 + 一个二进制则只有几 MB。
 *   链接是**可推导的**，就不该进包 —— 这跟「shebang 约定该补在 D1，而不是给每件手写包装」是同一条纪律。
 *
 * 安全：路径与目标都必须是相对路径、不含 ..（与解包器的链接规则一致）。
 */
function applyLinkFarm(rootDir) {
  let txt = '';
  try { txt = fs.readFileSync(path.join(rootDir, 'link-farm.txt'), 'utf8'); } catch (_e) { return null; }
  let applied = 0, skipped = 0;
  for (const line of txt.split('\n')) {
    const t = line.replace(/\r$/, '');
    if (!t || t.charAt(0) === '#') continue;
    const parts = t.split('\t');
    if (parts.length !== 2) { skipped += 1; continue; }
    const rel = parts[0].trim(), target = parts[1].trim();
    const bad = !rel || !target || rel.indexOf('..') >= 0 || target.indexOf('..') >= 0 || rel.charAt(0) === '/' || target.charAt(0) === '/';
    if (bad) { skipped += 1; continue; }
    const dest = path.join(rootDir, rel);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try { fs.unlinkSync(dest); } catch (_e2) { /* 不存在即可 */ }
      fs.symlinkSync(target, dest);
      applied += 1;
    } catch (_e2) { skipped += 1; }
  }
  return { applied, skipped };
}

/** 链接农场是否已就位（逐条比对 readlink），用于「已就位」路径的修补判断。 */
function linkFarmOk(rootDir) {
  let txt = '';
  try { txt = fs.readFileSync(path.join(rootDir, 'link-farm.txt'), 'utf8'); } catch (_e) { return true; }
  for (const line of txt.split('\n')) {
    const t = line.replace(/\r$/, '');
    if (!t || t.charAt(0) === '#') continue;
    const parts = t.split('\t');
    if (parts.length !== 2) continue;
    const rel = parts[0].trim(), target = parts[1].trim();
    if (!rel || !target) continue;
    try { if (fs.readlinkSync(path.join(rootDir, rel)) !== target) return false; } catch (_e2) { return false; }
  }
  return true;
}

function linkIntoPrefix(prefix, names, target) {
  let ok = true;
  // 目标要可执行（以前这由包装体自带；改 symlink 后补在这里，免得暴露出一个不可执行的入口）。
  try { fs.chmodSync(target, 0o755); } catch (_e) { /* 不可改也不致命：判据会如实报 */ }
  for (const n of names) {
    const p = path.join(prefix, 'bin', n);
    if (binLinkOk(p, target)) continue;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      try { fs.unlinkSync(p); } catch (_e) { /* 目标不存在即可 */ }
      fs.symlinkSync(target, p);
    } catch (_e) { ok = false; }
  }
  return ok;
}

/**
 * 确保一个共享工具在场（安装 + 建入口链），幂等。
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
  // 别名（件可声明一个命令的多个名字）：PEP 394 下 python3 是规范名，python 允许作为同一解释器的别名；
  // 别名的选择属于**件的内容**（清单里声明），机制只负责照单写入口 —— 不在内核里写死谁跟谁同名。
  const aliases = Array.isArray(spec.aliases) ? spec.aliases.filter((a) => typeof a === 'string' && a && a !== name) : [];
  const libBase = path.join(c.prefix, 'lib');
  // 件各住**自己的一间**（lib/toolchain/<name>/）。
  //   为什么必须分开：落位是「先清终态再 rename」，共用一间时**每装一件都会抹掉前一件**。
  //   真机实测（2026-09-28，kernel 0.1.0-android.37）：四件都报 applied，盘上只剩最后那件
  //   （sqlite3），另三件只留下 $PREFIX/bin 里的断链 —— CI 看不出来，只有真机跑多个件才暴露。
  const root = rootFor(c.prefix, name);
  const staging = stagingFor(c.prefix, name);
  const lockFile = path.join(libBase, 'toolchain.lock');
  // 取件方式决定入口在树里的相对位置：npm 装在 node_modules/<pkg>/；tarball 按包内自带布局。
  const entryRel = spec.provider === 'tarball' ? spec.entry : path.join('node_modules', spec.pkg, spec.entry);
  const entry = path.join(root, entryRel);
  const stagingEntry = path.join(staging, entryRel);
  // 完整性锚的**作用对象**不同：npm 件锚可执行文件本身；tarball 件锚压缩包（解包产物由包内布局 +
  // 原子落位保证），故入口只判「是不是文件」。
  const entrySpec = spec.provider === 'tarball' ? {} : spec;
  // 暴露名：本名 + 件声明的别名（别名属件的内容，机制照单建链）。
  const expose = [name].concat(aliases);

  // ①③ 已就位 = 工件逐字节完整**且**入口链指向它（链按目标判新鲜：换了落位就重建）。
  if (await artifactOk(entry, entrySpec)) {
    const fresh = expose.every((n) => binLinkOk(path.join(c.prefix, 'bin', n), entry)) && linkFarmOk(root);
    if (fresh) return out('already', { bin, entry });
    // 入口链或链接农场有缺项（加了子命令、或上次崩在中间）—— 一并补齐。
    const repaired = applyLinkFarm(root);
    return linkIntoPrefix(c.prefix, expose, entry) ? out('applied', { bin, entry, links: repaired ? repaired.applied : 0 }) : out('failed', { reason: '建入口链失败（见日志）' });
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
    // 件声明的链接农场：解包后按需生成（git 的子命令农场就靠它，避免把约 170 个链接打进包）。
    // 失败不致命：入口链那一关会如实报出结局。
    applyLinkFarm(root);
    try { fs.chmodSync(entry, 0o755); } catch {}
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    return out('failed', { reason: '投放异常: ' + e.message });
  } finally {
    _provisioning -= 1;
    releaseLock(lockFile);
  }
  return linkIntoPrefix(c.prefix, expose, entry) ? out('applied', { bin, entry, aliases }) : out('failed', { reason: '建入口链失败（见日志）' });
}

/** C 层供给：把全部共享工具**在启动时**投放就位（不是「谁用到谁装」的惰性补丁）。
 *  异步、非阻塞、非致命：调用方 fire-and-forget；失败只记账，真因由使用点如实报出。
 *  幂等；单写者锁保证并发调用里只有一个真装。使用点（插件域）另有一道 await 屏障。 */
async function provisionSharedTools(opts) {
  const o = opts || {};
  const out = {};
  let names;
  // 这一段（清旧残留 + 取清单）整体包在 try 里，且**绝不静默**：
  //   真机定罪（2026-09-28，kernel .38）：这里曾把 removeLegacyFlatLayout(c.prefix) 写在 `c` 定义之前 ⇒
  //   ReferenceError → async 拒绝 → 被调用方的 .catch(() => {}) 吞掉 ⇒ 整轮投放**零日志零事件**，
  //   面板上四格停在「清单尚未取回」，而线上清单明明取得到。
  try {
    const c = runtimeContract.read();
    if (!c || !c.prefix) {
      const reason = '非容器契约形态（无 runtime.json / prefix），本轮不投放';
      o.logger && o.logger.info && o.logger.info('共享工具投放：' + reason);
      if (o.events) { try { o.events.append('toolchain_tool', { name: '*', status: 'skipped', reason }); } catch (_) {} }
      if (typeof o.onSettled === 'function') { try { o.onSettled({}); } catch (_) {} }
      return out;
    }
    // 旧平铺布局的残留先清掉（本仓历史 bug 的产物）：不留暗账，也不让它继续占着 $PREFIX/bin 的指向。
    const legacyRemoved = removeLegacyFlatLayout(c.prefix);
    if (legacyRemoved.length && o.events) {
      try { o.events.append('toolchain_legacy_cleaned', { removed: legacyRemoved }); } catch (_e) {}
    }
    names = await manifest.toolNames();
  } catch (e) {
    const reason = 'C 清单不可用：' + (e && e.message ? e.message : String(e));
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

module.exports = {
  ensureSharedTool,
  provisionSharedTools,
  isProvisioning,
  rootFor,
  stagingFor,
  removeLegacyFlatLayout,
  INSTALL_TIMEOUT_MS,
  LOCK_STALE_MS,
};
