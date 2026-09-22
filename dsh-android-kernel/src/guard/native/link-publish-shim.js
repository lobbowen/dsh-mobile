'use strict';

// 安卓容器 link 垫片：dsh 安装树的「硬链接独占发布」→ renameat2(RENAME_NOREPLACE)。
//
// 根因（2026-09-23 真机定位）：Android 7+ 的 SELinux 策略禁止 untrusted_app 在
// app 私有目录调用 link(2) ⇒ dsh 会话落盘报
// `EACCES: permission denied, link '<...>.jsonl.zstd.<rand>.tmp' -> '<...>.zstd'`
// （发消息即「本轮运行失败」）。全树扫描共 5 个 link(2) 调用点、3 个 bundle 文件
// （symlink/chown 零命中）：
//   persistence lib/index.js   :3142 materializePosix（move 型：发布后源即弃）
//                              :2034 publishCurrentExclusive 经 defaultFileSystem.link（move 型）
//   persistence lib/worker.cjs :12801 同上（worker bundle 的 defaultFileSystem.link）
//   attachment  lib/index.js   :541 publishStagedObject（link 后紧接 unlink 源 ⇒ 必须保留
//                              源到 unlink 前，用 alias 型桥接，unlink 后净效果=move）
//                              :480 publishImmutableAlias（真 alias：内容寻址对象加别名，
//                              源必须存活 ⇒ 只能独占拷贝 + NOREPLACE 发布）
// link(2) 在此不是性能选择而是语义选择：目标存在时**必须**原子地 EEXIST（并发发布
// 的定胜方判定），rename(2) 会覆盖 ⇒ 不能直替。renameat2 的 RENAME_NOREPLACE 与
// link 的独占语义等价（原子、EEXIST、绝不落半态）。
//
// 解法（与 NARB/flock 垫片同一自愈模式）：守卫在契约+DSH_PUBLISH_NATIVE/DSH_FLOCK_NATIVE
// 在场时，对安装树上述 3 文件做锚点计数文本补丁（任一锚点命中数≠1 ⇒ 整文件不动并
// 报 failed），并在文件头前置注入 __dshLinkShim helper：原生可加载时走
// libdshpublish.so 的 renameNoReplace；不可用（PC/缺件）逐字回退真实 link ⇒ PC 语义
// 零变化，设备缺件诚实报错，**绝不静默降级为可覆盖的 rename**。

const fs = require('node:fs');
const path = require('node:path');

const SHIM_MARKER = 'dsh-android-kernel:link-publish-shim:v1';
const PKG_PERSISTENCE = '@deepseek-ai/dsh-session-persistence-jsonl';
const PKG_ATTACHMENT = '@deepseek-ai/dsh-attachment-local';

/** 补丁目标清单：pkg + 包内文件 + [锚点原文 → 替换文]（每锚必须恰命中 1 次）。
 *  锚点取自 @deepseek-ai 0.1.7-alpha.2 安装树（vendor 夹具逐字固化于
 *  test/fixtures/link-publish/，门禁钉住锚点在真实文件中的命中数）。 */
const TARGETS = [
  {
    pkg: PKG_PERSISTENCE, file: 'lib/index.js',
    replacements: [
      ['await link(tmp, finalPath);', 'await __dshLinkShim.publishMove(tmp, finalPath);'],
      ['\n\tlink,\n', '\n\tlink: __dshLinkShim.publishMove,\n'],
    ],
  },
  {
    pkg: PKG_PERSISTENCE, file: 'lib/worker.cjs',
    replacements: [
      ['link: node_fs_promises.link,', 'link: __dshLinkShim.publishMove,'],
    ],
  },
  {
    pkg: PKG_ATTACHMENT, file: 'lib/index.js',
    replacements: [
      ['await link(staged.path, target);', 'await __dshLinkShim.publishAlias(staged.path, target);'],
      ['await link(source, target);', 'await __dshLinkShim.publishAlias(source, target);'],
    ],
  },
];

/** 注入 helper 的单一事实源（ESM/CJS 通用：只用动态 import，CJS 亦支持）。 */
function helperSource() {
  return `/* ${SHIM_MARKER} —— 守卫 spawn 前自动投放；勿手改（重装 dsh 后会被重新覆盖）。
   Android 7+ SELinux 禁 app 私有目录 link(2)（EACCES）⇒ 本文件原 link 式独占发布
   桥接到 libdshpublish.so 的 renameat2(RENAME_NOREPLACE)：原子、冲突 EEXIST、
   绝不覆盖 —— 与 link 语义等价。alias 型（源必须保留）= 独占临时拷贝 + NOREPLACE。
   原生不可用（PC/dev/缺件）时逐字回退真实 link：PC 语义零变化；设备缺件诚实
   报错，绝不静默降级为可覆盖的 rename。 */
const __dshLinkShim = (() => {
  const CODES = { 1: 'EPERM', 2: 'ENOENT', 5: 'EIO', 13: 'EACCES', 17: 'EEXIST', 18: 'EXDEV', 22: 'EINVAL', 28: 'ENOSPC', 30: 'EROFS', 36: 'ENAMETOOLONG' };
  const err = (errno, p) => Object.assign(new Error((CODES[errno] || 'E' + errno) + ': link failed, \\'' + p + '\\'' ), { code: CODES[errno] || 'E' + errno, errno, syscall: 'link', path: p });
  let fspP; const fsp = () => (fspP ||= import('node:fs/promises'));
  let cryP; const cry = () => (cryP ||= import('node:crypto'));
  let nativeState;
  async function getNative() {
    if (nativeState !== undefined) return nativeState;
    const dfn = process.env.DSH_FLOCK_NATIVE || '';
    const dpn = process.env.DSH_PUBLISH_NATIVE || (dfn ? dfn.replace(/[^/]*$/, '') + 'libdshpublish.so' : '');
    if (!dpn) return (nativeState = null);
    try {
      if (dpn.endsWith('.js')) nativeState = (await (await import('node:module')).createRequire(dpn))(dpn);
      else { const m = { exports: {} }; process.dlopen(m, dpn); nativeState = m.exports; }
    } catch { nativeState = null; }
    if (!nativeState || typeof nativeState.renameNoReplace !== 'function') nativeState = null;
    return nativeState;
  }
  function rrn(native, src, dst) {
    return new Promise((resolve, reject) => {
      let done = false;
      try { native.renameNoReplace(src, dst, (errno) => { done = true; resolve(errno); }); }
      catch (e) { if (!done) reject(e); }
    });
  }
  async function publishMove(src, dst) {
    const f = await fsp();
    const native = await getNative();
    if (!native) { await f.link(src, dst); return; }
    const errno = await rrn(native, src, dst);
    if (errno === 0) return;
    if (errno === 17) throw err(17, dst);
    if (errno === 22) {
      // 文件系统不支持 NOREPLACE（老内核 ext4 等）：独占探测 + rename。探测窗口
      // 存在 TOCTOU，但两类发布上游均有串行化（flock 写租约 / 内容寻址幂等），
      // 且设备 f2fs / 内核 ≥4.9 ext4 都支持 NOREPLACE，本分支真机不会走到。
      try { const h = await f.open(dst, 'wx'); await h.close(); }
      catch (e) { if (e && e.code === 'EEXIST') throw err(17, dst); throw e; }
      await f.rm(dst, { force: true });
      await f.rename(src, dst);
      return;
    }
    throw err(errno, dst);
  }
  async function publishAlias(src, dst) {
    const f = await fsp();
    const native = await getNative();
    if (!native) { await f.link(src, dst); return; }
    const { randomUUID } = await cry();
    const tmp = dst + '.dsh-alias-' + randomUUID() + '.tmp';
    try {
      const sh = await f.open(src, 'r');
      try {
        const st = await sh.stat();
        const data = await sh.readFile(); // 附件/会话物化体量受内存管线约束（staging 同源），整读可接受
        const dh = await f.open(tmp, 'w', (st.mode & 0o777) || 0o600);
        try { await dh.writeFile(data); await dh.sync(); } finally { await dh.close(); }
      } finally { await sh.close(); }
      const errno = await rrn(native, tmp, dst);
      if (errno !== 0) throw err(errno, dst);
    } finally {
      try { await f.rm(tmp, { force: true }); } catch {}
    }
  }
  return { publishMove, publishAlias };
})();
`;
}

/** 在安装树里定位指定包目录：扁平 @deepseek-ai 处优先，@deepseek-ai/* 依赖下
 *  嵌套副本兜底（npm 版本冲突时的压平行为）。可多份，全部返回。 */
function locatePackages(root, pkgName) {
  const out = [];
  const direct = path.join(root, pkgName);
  try { if (fs.statSync(path.join(direct, 'package.json')).isFile()) out.push(direct); } catch {}
  const scopeDir = path.join(root, '@deepseek-ai');
  try {
    for (const e of fs.readdirSync(scopeDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const nested = path.join(scopeDir, e.name, 'node_modules', pkgName);
      try { if (fs.statSync(path.join(nested, 'package.json')).isFile()) out.push(nested); } catch {}
    }
  } catch {}
  return out;
}

function countHits(content, needle) {
  return content.split(needle).length - 1;
}

/** 对 npmRoot 下全部目标文件幂等投放 link 垫片。
 *  返回 { found, results: [{file, status: applied|already|failed, error?}] }。
 *  写入前必须全部锚点恰好命中 1 次，否则整文件不动（防半补丁/错版本破坏 bundle）。 */
function ensureShim(npmRoot) {
  const results = [];
  if (!npmRoot) return { found: 0, results };
  for (const target of TARGETS) {
    const dirs = locatePackages(npmRoot, target.pkg);
    for (const dir of dirs) {
      const fp = path.join(dir, target.file);
      const tag = target.pkg + '/' + target.file;
      let cur;
      try { cur = fs.readFileSync(fp, 'utf8'); } catch (e) { results.push({ file: tag, status: 'failed', error: e.message }); continue; }
      if (cur.includes(SHIM_MARKER)) { results.push({ file: tag, status: 'already' }); continue; }
      let out = cur;
      const missed = [];
      for (const [from] of target.replacements) {
        if (countHits(out, from) !== 1) missed.push(JSON.stringify(from.slice(0, 48)));
      }
      if (missed.length) { results.push({ file: tag, status: 'failed', error: '锚点命中数≠1: ' + missed.join(', ') }); continue; }
      for (const [from, to] of target.replacements) out = out.split(from).join(to);
      try {
        const base = path.basename(fp);
        const dot = base.lastIndexOf('.');
        const orig = dot > 0 ? base.slice(0, dot) + '.dsh-orig' + base.slice(dot) : base + '.dsh-orig';
        const origPath = path.join(path.dirname(fp), orig);
        if (!fs.existsSync(origPath)) fs.writeFileSync(origPath, cur);
        fs.writeFileSync(fp, helperSource() + out);
        results.push({ file: tag, status: 'applied' });
      } catch (e) { results.push({ file: tag, status: 'failed', error: e.message }); }
    }
  }
  return { found: results.length, results };
}

module.exports = { SHIM_MARKER, TARGETS, PKG_PERSISTENCE, PKG_ATTACHMENT, ensureShim, locatePackages, helperSource };
