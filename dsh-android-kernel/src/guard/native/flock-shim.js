'use strict';

// 安卓容器 flock 垫片：@deepseek-ai/node-addon-system 的 flock 入口 → 原生 .so 桥。
//
// 根因（2026-09-23 真机定位）：dsh 会话持久化（dsh-session-persistence-jsonl 的
// SessionWriteLease）硬依赖 `@deepseek-ai/node-addon-system/flock` 的 tryLockExclusive
// （真正的 flock(2) 排他锁，进程死亡由内核自动释放——O_EXCL 锁文件模拟崩溃后残留，
// 属砍能力，不可用）。该包只发 linux(glibc/musl)/darwin 预编译件；设备
// process.platform === 'android' ⇒ loadBinding 抛 ERR_FLOCK_UNSUPPORTED_PLATFORM，
// 发消息即「本轮运行失败 flock is not supported on android-arm64」。
//
// 解法（与 require-builtin-shim 同一模式）：fast-apk CI 用 NDK 把 vendor 自带的
// src/flock.c（BSD-3，见 native/flock/PROVENANCE.md）编成 libdshflock.so 放进
// jniLibs → 容器经 DSH_FLOCK_NATIVE 环境变量把 nativeLibraryDir 路径递给守卫 →
// 守卫在安装前/spawn 前幂等把安装树里的 lib/flock.js 替换为 JS 垫片：
// DSH_FLOCK_NATIVE 可 dlopen 时走真 flock(2)（错误面与 vendor 逐字一致），
// 否则动态 import 原始实现逐字委派（PC 语义零变化，能力零损伤）。

const fs = require('node:fs');
const path = require('node:path');

const PKG_NAME = '@deepseek-ai/node-addon-system';
const SHIM_MARKER = 'dsh-android-kernel:flock-native-shim:v1';
const ORIG_BASENAME = 'flock.dsh-orig.js';
const TARGET_REL = path.join('lib', 'flock.js');

function shimSource() {
  return `/* ${SHIM_MARKER} —— 守卫投放；勿手改（重装 dsh 后会被重新覆盖）。
   vendor 原始 flock.js 备份于同目录 ${ORIG_BASENAME}：
   DSH_FLOCK_NATIVE（APK jniLibs 里 NDK 现编的 libdshflock.so）可加载时走真
   flock(2)，否则动态 import 原始实现逐字委派 —— 原生支持的平台语义不变。 */
import { createRequire } from 'node:module';
import { getSystemErrorName } from 'node:util';

// undefined=未探测；null=不可用（回退原始实现）；object=原生绑定。
let nativeState;
function loadNativeBinding() {
  if (nativeState !== undefined) return nativeState;
  const p = process.env.DSH_FLOCK_NATIVE;
  if (typeof p !== 'string' || !p) { nativeState = null; return null; }
  try {
    if (p.endsWith('.js')) {
      // 测试注入通道：伪造绑定（CJS 导出 tryLock）经 require 装载。
      nativeState = createRequire(import.meta.url)(p);
    } else {
      const mod = { exports: {} };
      process.dlopen(mod, p);
      nativeState = mod.exports;
    }
  } catch { nativeState = null; }
  if (!nativeState || typeof nativeState.tryLock !== 'function') nativeState = null;
  return nativeState;
}

export async function tryLockExclusive(fd) {
  const binding = loadNativeBinding();
  if (!binding) {
    const orig = await import('./${ORIG_BASENAME}');
    return orig.tryLockExclusive(fd);
  }
  const errno = await new Promise((resolve) => binding.tryLock(fd, resolve));
  if (errno === 0) return;
  const code = getSystemErrorName(-errno);
  throw Object.assign(new Error(\`\${code}: flock failed\`), {
    code,
    errno,
    syscall: 'flock',
  });
}
`;
}

/** 在安装树里定位 node-addon-system 包目录：扁平 @deepseek-ai 处优先，
 *  @deepseek-ai/* 依赖下嵌套副本兜底（npm 版本冲突时的压平行为）。可多份。 */
function locatePackages(root) {
  const out = [];
  const direct = path.join(root, PKG_NAME);
  try { if (fs.statSync(path.join(direct, 'package.json')).isFile()) out.push(direct); } catch {}
  const scopeDir = path.join(root, '@deepseek-ai');
  try {
    for (const e of fs.readdirSync(scopeDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'node-addon-system') continue;
      const nested = path.join(scopeDir, e.name, 'node_modules', PKG_NAME);
      try { if (fs.statSync(path.join(nested, 'package.json')).isFile()) out.push(nested); } catch {}
    }
  } catch {}
  return out;
}

/** 对 npmRoot 下所有 node-addon-system 副本幂等投放 flock 垫片。
 *  返回 { found, results: [{dir, status: applied|already|failed, error?}] }。
 *  只写文件、不改内存；任何单包失败只影响该包（调用方汇总告警）。 */
function ensureShim(npmRoot) {
  const results = [];
  if (!npmRoot) return { found: 0, results };
  const dirs = locatePackages(npmRoot);
  for (const dir of dirs) {
    const entry = path.join(dir, TARGET_REL);
    let cur;
    try { cur = fs.readFileSync(entry, 'utf8'); } catch (e) { results.push({ dir, status: 'failed', error: e.message }); continue; }
    if (cur.includes(SHIM_MARKER)) { results.push({ dir, status: 'already' }); continue; }
    try {
      const orig = path.join(path.dirname(entry), ORIG_BASENAME);
      if (!fs.existsSync(orig)) fs.writeFileSync(orig, cur);
      fs.writeFileSync(entry, shimSource());
      results.push({ dir, status: 'applied' });
    } catch (e) { results.push({ dir, status: 'failed', error: e.message }); }
  }
  return { found: dirs.length, results };
}

module.exports = { PKG_NAME, SHIM_MARKER, ORIG_BASENAME, ensureShim, locatePackages, shimSource };
