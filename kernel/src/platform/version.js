'use strict';

// 版本地基：统一版本源（仓库根 package.json）。
// 守卫自身版本 / DSH 已装版本读取都集中在此，避免散落多处。

const fs = require('node:fs');
const path = require('node:path');

/**
 * 内核版本（双形态）：
 *  - 打包形态：esbuild 以 --define:__DSH_VERSION__ 注入编译期字符串常量，
 *    产物自包含版本（任意 cwd 自报正确）——容器内运行时不会带着仓库 package.json；
 *  - 源码形态：回退读仓库根 package.json（源码直跑 / 未注入时）。
 */
function guardVersion() {
  // typeof 对未声明标识符是安全的；define 注入后此处编译期为 typeof "0.10.0" → 直接返回。
  if (typeof __DSH_VERSION__ !== 'undefined') return String(__DSH_VERSION__);
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

module.exports = { guardVersion };