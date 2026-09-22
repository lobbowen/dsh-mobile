'use strict';

// 安卓容器 PTC 环境垫片：给 dsh-ptc-runtime-node 的子进程环境白名单补
// LD_LIBRARY_PATH。
//
// 根因（2026-09-23 真机报告 + 行级取证）：PTC/workflow 每次调用都在**全新 node
// 子进程**里执行，其 env 构造把除 STARTUP_ENVIRONMENT_NAMES（PATH/PATHEXT/
// SYSTEMROOT/WINDIR/TEMP/TMP）外的全部父变量置空（lib/index.js:956 标记 void 0，
// subprocess-local 的 targetEnvironment 将 undefined 键剔除）。Android 的 bionic
// linker 只认 LD_LIBRARY_PATH/DT_RUNPATH（NativePreparer 踩坑实录），libnode.so
// 子进程丢了它就加载不到同目录 libc++_shared.so ⇒ `__ndk1` 符号缺失、workflow
// 引擎必崩。主进程活着是因为 Kotlin 侧显式注入了该变量。
//
// 解法与 flock/link 垫片同一自愈模式：守卫在容器契约 + DSH_FLOCK_NATIVE 在场时
// 对安装树做锚点计数文本补丁（锚点命中数≠1 ⇒ 文件不动并报 failed）。补丁内容 =
// 白名单加一项：子进程本来就继承「动态链接器搜索路径」这一系统级事实，与 PATH
// 同类；PC 上该变量通常不存在 ⇒ 保留动作是语义零变化的 no-op，且 PC/dev 树根本
// 不会被触碰（门控在守卫侧）。

const fs = require('node:fs');
const path = require('node:path');

const SHIM_MARKER = 'dsh-android-kernel:ptc-env-shim:v1';
const PKG_PTC = '@deepseek-ai/dsh-ptc-runtime-node';

/** [锚点原文 → 替换文]，锚点取自 0.1.7-alpha.2 真实字节（tab 缩进/LF，
 *  夹具固化于 test/fixtures/ptc-env/，门禁钉住命中数）。 */
const REPLACEMENT = [
  'const STARTUP_ENVIRONMENT_NAMES = new Set([\n\t"PATH",\n\t"PATHEXT",',
  'const STARTUP_ENVIRONMENT_NAMES = new Set([\n\t"PATH",\n\t/* ' + SHIM_MARKER
    + '：Android linker 只认 LD_LIBRARY_PATH/DT_RUNPATH，剥掉它 libnode.so 子进程必崩 */\n\t"LD_LIBRARY_PATH",\n\t"PATHEXT",',
];

/** 在安装树里定位指定包目录：扁平优先，嵌套副本兜底（同 link-publish-shim）。 */
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

/** 对 npmRoot 下 PTC bundle 幂等投放环境白名单补丁。
 *  返回 { found, results: [{file, status: applied|already|failed, error?}] }。 */
function ensureShim(npmRoot) {
  const results = [];
  if (!npmRoot) return { found: 0, results };
  const [from, to] = REPLACEMENT;
  for (const dir of locatePackages(npmRoot, PKG_PTC)) {
    const fp = path.join(dir, 'lib/index.js');
    const tag = PKG_PTC + '/lib/index.js';
    let cur;
    try { cur = fs.readFileSync(fp, 'utf8'); } catch (e) { results.push({ file: tag, status: 'failed', error: e.message }); continue; }
    if (cur.includes(SHIM_MARKER)) { results.push({ file: tag, status: 'already' }); continue; }
    const hits = cur.split(from).length - 1;
    if (hits !== 1) { results.push({ file: tag, status: 'failed', error: '锚点命中数≠1: ' + hits }); continue; }
    const out = cur.split(from).join(to);
    try {
      const origPath = path.join(dir, 'lib', 'index.dsh-orig.js');
      if (!fs.existsSync(origPath)) fs.writeFileSync(origPath, cur);
      fs.writeFileSync(fp, out);
      results.push({ file: tag, status: 'applied' });
    } catch (e) { results.push({ file: tag, status: 'failed', error: e.message }); }
  }
  return { found: results.length, results };
}

module.exports = { SHIM_MARKER, PKG_PTC, REPLACEMENT, ensureShim, locatePackages };
