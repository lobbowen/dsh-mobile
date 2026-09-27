'use strict';

// D2：Android 平台件库 —— **工件本体**的唯一解析处。
//
// 分层（工件 vs 落位）：
//   D2（本模块）= 件在哪、在不在：共享环境里的那一份，与产品无关；只读、无副作用。
//   E （各 impl）= 往哪个产品树、以什么名字落位：placement，写文件才发生在那里。
//
// 为什么必须分开：同一份工件会被多个落位器、多个产品共用（rg 的二进制、pty.node、
// libdshflock.so…）。工件路径散在各 impl 里时，加一个产品就复制一份「路径怎么算」，
// 而「$PREFIX 的唯一事实源是 runtime.json 的 prefix 格」这条判据也就守不住了。
//
// 死词汇：本模块**不许**以环境变量 PREFIX 定位能力件（真机 2026-09-26 定罪：
// 容器从未导出过该键，三个单元因此静默 no-op 一整代）。

const fs = require('node:fs');
const path = require('node:path');

/** 工件 id → 解析函数。新增共享件在此加一行；落位方式与它无关。 */
const RESOLVERS = {
  // 容器经 PrefixProvisioner 播到 $PREFIX/bin 的 rg 二进制。
  rg: (ctx) => underPrefix(ctx, 'bin', 'rg'),
  // 容器编好、投到 $PREFIX/lib 的 node-pty 原生绑定。
  pty: (ctx) => underPrefix(ctx, 'lib', 'pty.node'),
  // 容器经环境变量递来的 libdshflock.so（默认住在 nativeLibraryDir）。
  'flock-native': () => fromEnv('DSH_FLOCK_NATIVE'),
};

function underPrefix(ctx, ...segs) {
  const prefix = ctx && ctx.prefix;
  if (!prefix) return null;
  return fileOrNull(path.join(prefix, ...segs));
}

function fromEnv(key) {
  const p = process.env[key];
  return typeof p === 'string' && p.trim() ? fileOrNull(p.trim()) : null;
}

function fileOrNull(p) {
  try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
}

/** 解析一份共享工件；不在 = null（调用方据此判 blocked/skipped，不许猜路径）。 */
function resolve(ctx, id) {
  const fn = RESOLVERS[id];
  return fn ? fn(ctx) : null;
}

module.exports = { resolve, RESOLVERS };
