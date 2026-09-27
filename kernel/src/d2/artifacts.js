'use strict';

// D2：Android 平台件库 —— 回答**「上游按什么名字/位置找它」**，并按该声明在**本机解析**当前那份。
//
// 语义（2026-09-27 按 ADR-0009 校正）：
//   · **本体（bits）不在这里** —— rg/bash 的本体是 B 的种子、C 的内容或 npm 树里的件；
//   · 本模块只持有**件的身份 + 命名/位置声明 + 版本/哈希**（单一处：./pieces.json）；
//   · 落位方式（往哪个产品树、以什么名字落）与能力判据归 **E**（../assembler/）。
//
// 为什么必须收在一处：同一份件会被多个落位器、多个产品共用；路径散在各 impl 里时，
// 加一个产品就复制一份「路径怎么算」，而「$PREFIX 的唯一事实源是 runtime.json 的 prefix 格」
// 这条判据也就守不住了。
//
// 死词汇：本模块**不许**以环境变量 PREFIX 定位件（真机 2026-09-26 定罪：容器从未导出该键，
// 三个单元因此静默 no-op 一整代）。$PREFIX 一律从 ctx 取。

const fs = require('node:fs');
const path = require('node:path');
const TABLE = require('./pieces.json');

const PIECES = {};
for (const p of (TABLE.pieces || [])) PIECES[p.id] = p;

function fileOrNull(p) {
  try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
}
function fromEnv(key) {
  const v = process.env[key];
  return typeof v === 'string' && v.trim() ? fileOrNull(v.trim()) : null;
}

/** 该件在本机的落点（不在 = null；调用方据此判 blocked/skipped，不许猜路径）。 */
function resolve(ctx, id) {
  const p = PIECES[id];
  if (!p) return null;
  const prefix = ctx && ctx.prefix;
  if (p.placedAt === 'prefix-bin') return prefix ? fileOrNull(path.join(prefix, 'bin', p.name)) : null;
  if (p.placedAt === 'prefix-lib') return prefix ? fileOrNull(path.join(prefix, 'lib', p.name)) : null;
  if (p.placedAt === 'env') return p.env ? fromEnv(p.env) : null;
  // native-library-dir / product-node-modules 两类不由 $PREFIX 解析：
  // 前者在 APK 的 nativeLibraryDir（容器装配时以 env 告知），后者在产品树（归 E 落位）。
  return null;
}

/** 「上游按什么名字/位置找它」—— 这条声明的**可读出口**（面板/取证/排障用）。 */
function describe(id) {
  const p = PIECES[id];
  if (!p) return null;
  return { id: p.id, upstream: p.upstream, delivery: p.delivery, placedAt: p.placedAt, name: p.name || null, libName: p.libName || null, version: p.version, sha256: p.sha256 };
}

module.exports = { resolve, describe, PIECES, TABLE };
