'use strict';

// ★ 可执行文件解析（把「逻辑名」解析为「可实际 spawn 的绝对路径」）—— Android-only ★
//
// 安卓内核跑在 L0 容器里：Node 运行时 + npm 由容器提供，PATH 由容器注入。
// 解析顺序：显式 env 覆盖 → PATH → extraDirs → 标准安装目录。
// 返回**绝对路径或 null**——绝不返回不可执行的猜测路径（调用方据此明确报「未找到」而非静默失败）。
//
// ⚠ 已删除的 PC 遗留（勿回潮）：
//   · Windows PATHEXT 展开（npm.cmd / npm.exe / .bat）—— 安卓没有扩展名语义；
//   · %APPDATA%\npm、%LOCALAPPDATA%\Programs\dsh-supervisor —— Windows 专有安装目录；
//   · macOS 的 /opt/homebrew/bin、/usr/local/bin —— Homebrew 专有。
//   因此 npmBin()/npxBin() 不再需要平台分支，恒为 'npm' / 'npx'。
//   ⚠ 但它只是**逻辑名/降级回退**：安卓 W^X 下容器 bin/ 里的 npm shim 不可 execve，
//     真正的调用形态必须经 platform/runtime-contract.npmInvocation() 解析
//     （node 代跑 npm-cli.js）。直拿本函数结果去 spawn 仅限无契约的 PC 场景。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** 候选文件名（安卓：无扩展名语义，恒为 [base]）。 */
function candidateNames(base, platform) {
  return [base];
}

function firstExecutable(dir, base, platform) {
  if (!dir) return null;
  for (const name of candidateNames(base, platform)) {
    const p = path.join(dir, name);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 不存在/无权：跳过 */ }
  }
  return null;
}

/** 标准安装目录（安卓：容器内的用户 bin 目录）。
 *  @param platform 可选（保留签名；安卓无平台分支）
 *  @param home 可选（默认 os.homedir()）
 *  @param env 可选（默认 process.env） */
function standardDirs(platform, home, env) {
  const h = home || os.homedir();
  return [path.join(h, '.local', 'bin'), path.join(h, '.npm-global', 'bin')];
}

/** PATH 内查找（兼容大小写不一的 `Path`）。 */
function inPath(base, platform, env) {
  const e = env || process.env;
  const raw = e.PATH || e.Path || '';
  for (const d of raw.split(path.delimiter)) {
    if (!d) continue;
    const hit = firstExecutable(d, base, platform);
    if (hit) return hit;
  }
  return null;
}

/**
 * 解析可执行绝对路径。
 * @param {string} base 逻辑名（如 'dsh-supervisor'）
 * @param {{envVar?:string, extraDirs?:string[], platform?:string, env?:object}} [opts]
 * @returns {string|null} 绝对路径或 null
 */
function resolveExecutable(base, opts) {
  const o = opts || {};
  const pl = o.platform;
  const env = o.env;
  const E = env || process.env;
  if (o.envVar && E[o.envVar]) {
    const v = E[o.envVar];
    try { if (fs.statSync(v).isFile()) return v; } catch { /* 覆盖路径无效：继续常规解析 */ }
  }
  const inPathHit = inPath(base, pl, env);
  if (inPathHit) return inPathHit;
  for (const d of [...(o.extraDirs || []), ...standardDirs(pl, undefined, env)]) {
    const hit = firstExecutable(d, base, pl);
    if (hit) return hit;
  }
  return null;
}

/** npx 可执行：安卓（POSIX）直接用 'npx'（容器 PATH 命中）。 */
function npxBin(opts) {
  return 'npx';
}

/** npm 可执行：安卓（POSIX）直接用 'npm'（容器 PATH 命中）。 */
function npmBin(opts) {
  return 'npm';
}

module.exports = { resolveExecutable, candidateNames, standardDirs, firstExecutable, npmBin, npxBin };
