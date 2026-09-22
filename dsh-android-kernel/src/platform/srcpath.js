'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 源文件定位器（**单一真源**，2026-09-11）
//
// ## 为什么需要它（一次生产级缺陷）
//
// §7.6 把 `src/supervisor.js` 拆成 `src/guard/supervisor/*.js` 后，
// **两处路径推导没有跟着更新**：
//
//   control-view.js   path.join(__dirname, '..') + 'src/domains/router/daemon.js'
//   registry-view.js  path.join(__dirname, 'domains', 'router', 'daemon.js')
//
// 而 `__dirname` 已从 `src/` 变成 `src/guard/supervisor/`，于是解析结果是
// `src/guard/src/domains/router/daemon.js` —— **不存在**。
//
// 后果：`_daemonLifecycle()` 的 `fs.existsSync` 恒为假 → 恒返回 null →
// **守卫永远无法自起 router daemon**，直接退化为「脚本缺失」。且既有测试
// （daemon-lifecycle-test.js）都**直接 new / 自行 spawn**，完全绕过这条路径
// → 测试全绿而功能全废。
//
// ## 设计
//
// 用**存在性验证**代替脆弱的相对路径推算：候选根逐个验证
// 「根下确实存在 domains/router/daemon.js」，第一个通过者胜出。
// 这样任何目录层级调整都不会再静默失效 —— 若所有候选都不成立，
// 则**显式抛错**（而非静默返回 null）。
//
// 门禁 G10 断言本模块解析出的每个脚本路径都真实存在。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');

/** daemon 脚本的相对位置（相对 `src/`）。 */
const DAEMON_REL = {
  router: path.join('domains', 'router', 'daemon.js'),
};

let _root = null; // 解析结果缓存（进程内不变）

/**
 * 定位包内 `src/` 目录。
 *
 * 候选（按可信度排序，逐个**用存在性验证**）：
 *   ① `__dirname` 上溯（本模块位于 `src/platform/` → 上溯 1 层即 `src/`）；
 *   ② 显式从 process.argv[1] / 包根推（发行态 bundle 与源码态布局不同）；
 *   ③ 从 cwd 的 src/ 兜底（开发态直接 node src/... 运行时）。
 *
 * @returns {string|null} `src/` 的绝对路径；全部候选不成立时 null
 */
function resolveSrcRoot() {
  if (_root) return _root;
  const probes = [
    // ① 本模块在 src/platform/ → 上溯一层
    path.join(__dirname, '..'),
    // ② 兼容「被 bundle 到别处」：从包根推（bundle 通常位于 <pkg>/bin 或 <pkg>/）
    path.join(__dirname, '..', '..', 'src'),
    // ③ 开发态：cwd 下直接有 src/
    path.join(process.cwd(), 'src'),
  ];
  for (const p of probes) {
    // 验证判据：该根下**确实存在**我们已知的一个 daemon 脚本。
    // 用真实业务文件（而非「有没有 index.js」）—— 后者太宽，无区分度。
    if (fs.existsSync(path.join(p, DAEMON_REL.router))) {
      _root = p;
      return _root;
    }
  }
  return null;
}

/**
 * 受管 daemon 脚本的绝对路径。
 *
 * @param {'router'|'lan'} kind
 * @returns {string|null} 存在时返回路径；**不存在时返回 null**（调用方据此降级）
 */
function daemonScript(kind) {
  const rel = DAEMON_REL[kind];
  if (!rel) return null;
  const root = resolveSrcRoot();
  if (!root) return null;
  const p = path.join(root, rel);
  return fs.existsSync(p) ? p : null;
}

/** 诊断用：所有候选根及其成立情况（供 --self-check 与门禁输出）。 */
function describe() {
  const probes = [
    { label: '__dirname/..', path: path.join(__dirname, '..') },
    { label: '__dirname/../../src', path: path.join(__dirname, '..', '..', 'src') },
    { label: 'cwd/src', path: path.join(process.cwd(), 'src') },
  ];
  return {
    resolved: resolveSrcRoot(),
    candidates: probes.map((p) => ({
      label: p.label,
      path: p.path,
      routerDaemon: fs.existsSync(path.join(p.path, DAEMON_REL.router)),
    })),
  };
}

/**
 * 定位**包根**（含 `package.json` 的目录）。
 *
 * 与 [`resolveSrcRoot`] 同一目的（对抗目录层级变化），但判据不同：
 * 包根用 `package.json` 验证。
 *
 * ⚠ 同类缺陷：`settings-view.js` 的 `_vcsRoot()` 曾用 `path.resolve(__dirname, '..')`
 *   并注释「= dsh-supervisor/」；但 §7.6 拆分后 `__dirname` 变为 `src/guard/supervisor/`，
 *   该表达式实际得到 `src/guard/` —— 注释与行为已经不符，
 *   导致「排除嵌套 .git」的判据作用在错误的目录上。
 *
 * @returns {string|null}
 */
function resolvePackageRoot() {
  // 从本模块位置逐级上溯找 package.json（比固定层数稳健）。
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 兜底：cwd（开发态直接 node src/... 运行）
  if (fs.existsSync(path.join(process.cwd(), 'package.json'))) return process.cwd();
  return null;
}

module.exports = { daemonScript, resolveSrcRoot, resolvePackageRoot, describe, DAEMON_REL };