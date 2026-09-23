'use strict';

// 安卓容器自愈垫片：node-addon-require-builtin（NARB）→ 纯 JS 实现。
//
// 根因（2026-09-22 真机定位）：dsh ≥0.1.5-rc.2 在 dsh-app-boot 的 internalModules()
// 与 profile-resolution-bootstrap 里**硬 require** NARB；NARB 只带 darwin/win32/
// linux-gnu|musl 预编译件，其主入口在 require 时即 loadEntry → 无 android-arm64
// 可用绑定 → 抛错 → dsh 在 host preparation 阶段 exit:1（且经管道看不到崩溃栈）。
// 容器安装走 --ignore-scripts，本地编译路径也不成立。
//
// 解法：把已安装树里的 NARB 主入口替换为 JS 垫片 —— 原实现可加载时优先委派
// （能力零损伤），否则用 createRequire + --expose-internals 等价提供 requireBuiltin
// （dsh 自家 cordis-plugin-loader 本就支持该 no-native 路径）。
// 守卫在 spawn 前幂等调用本模块（自愈：覆盖安装/内核升级后无需重装 dsh）。

const fs = require('node:fs');
const path = require('node:path');

const PKG_NAME = 'node-addon-require-builtin';
const SHIM_MARKER = 'dsh-android-kernel:narb-js-shim:v1';
const ORIG_SUFFIX = '.dsh-orig.js';

function shimSource(origFile) {
  return `'use strict';
/* ${SHIM_MARKER} —— 守卫 spawn 前自动投放；勿手改（重装 dsh 后会被重新覆盖）。
   原 NARB 入口备份于同目录 ${origFile}：native 绑定可加载时逐字委派，
   否则回退 createRequire + --expose-internals（dsh cordis loader 官方 no-native 路径）。 */
const { createRequire } = require('node:module');
const hasInternals = process.execArgv.includes('--expose-internals');
let nativeApi = null;
try { nativeApi = require('./${origFile}'); } catch {}
const native = !!(nativeApi && typeof nativeApi.requireBuiltin === 'function');

function jsRequireBuiltin(moduleId) {
  if (!hasInternals) {
    throw new Error('narb-js-shim: node started without --expose-internals, cannot load internal module ' + moduleId);
  }
  return createRequire(process.argv[1] || __filename)(moduleId);
}

function requireBuiltin(moduleId) {
  if (native) {
    try { return nativeApi.requireBuiltin(moduleId); }
    catch (e) { if (!hasInternals) throw e; }
  }
  return jsRequireBuiltin(moduleId);
}

function isAllowedInternalId(moduleId) {
  if (native && typeof nativeApi.isAllowedInternalId === 'function') {
    try { return nativeApi.isAllowedInternalId(moduleId); } catch {}
  }
  return typeof moduleId === 'string' && moduleId.length > 0 && !moduleId.startsWith('node:');
}

function getNativeBindingInfo() {
  if (native && typeof nativeApi.getNativeBindingInfo === 'function') {
    try { return nativeApi.getNativeBindingInfo(); } catch {}
  }
  return { mode: 'shim', product: 'js-shim', backend: 'js', abi: 'js', nodeAbi: 'node-v' + process.versions.modules };
}

module.exports = { requireBuiltin, isAllowedInternalId, getNativeBindingInfo, getBindingInfo: getNativeBindingInfo };
module.exports.default = module.exports;
`;
}

/** 在安装树里定位 NARB 包目录：全局扁平处优先，@deepseek-ai/* 嵌套 node_modules 兜底
 *  （npm 版本冲突时把副本压到依赖包下）。同一次安装可能有多份，全部返回。 */
function locatePackages(root) {
  const out = [];
  const direct = path.join(root, PKG_NAME);
  try { if (fs.statSync(path.join(direct, 'package.json')).isFile()) out.push(direct); } catch {}
  const scopeDir = path.join(root, '@deepseek-ai');
  try {
    for (const e of fs.readdirSync(scopeDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const nested = path.join(scopeDir, e.name, 'node_modules', PKG_NAME);
      try { if (fs.statSync(path.join(nested, 'package.json')).isFile()) out.push(nested); } catch {}
    }
  } catch {}
  return out;
}

function mainEntryOf(pkgDir) {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const rel = typeof pj.main === 'string' && pj.main ? pj.main : 'index.js';
    const abs = path.resolve(pkgDir, rel);
    return fs.statSync(abs).isFile() ? abs : null;
  } catch { return null; }
}

/** 对 npmRoot 下所有 NARB 副本幂等投放垫片。
 *  返回 { found, results: [{dir, status: applied|already|failed, error?}] }。
 *  只写文件、不改内存；任何单包失败只影响该包（调用方汇总告警）。 */
function ensureShim(npmRoot) {
  const results = [];
  if (!npmRoot) return { found: 0, results };
  const dirs = locatePackages(npmRoot);
  for (const dir of dirs) {
    const entry = mainEntryOf(dir);
    if (!entry) { results.push({ dir, status: 'failed', error: 'main entry not found' }); continue; }
    let cur;
    try { cur = fs.readFileSync(entry, 'utf8'); } catch (e) { results.push({ dir, status: 'failed', error: e.message }); continue; }
    if (cur.includes(SHIM_MARKER)) { results.push({ dir, status: 'already' }); continue; }
    const origFile = path.basename(entry, path.extname(entry)) + ORIG_SUFFIX;
    try {
      fs.writeFileSync(path.join(path.dirname(entry), origFile), cur);
      fs.writeFileSync(entry, shimSource(origFile));
      results.push({ dir, status: 'applied' });
    } catch (e) { results.push({ dir, status: 'failed', error: e.message }); }
  }
  return { found: dirs.length, results };
}

module.exports = { PKG_NAME, SHIM_MARKER, ensureShim, locatePackages, shimSource };
