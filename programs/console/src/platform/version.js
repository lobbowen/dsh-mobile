'use strict';

// 版本地基：统一版本源（本 Program 的 package.json）。
// 面板自身版本读取集中在此，避免散落多处。

const fs = require('node:fs');
const path = require('node:path');

/**
 * 面板版本（双形态）：
 *  - 打包形态：esbuild 以 --define:__LOBOS_PANEL_VERSION__ 注入编译期字符串常量，
 *    产物自包含版本（任意 cwd 自报正确）；
 *  - 源码形态：回退读本 Program 的 package.json。
 */
function panelVersion() {
  if (typeof __LOBOS_PANEL_VERSION__ !== 'undefined') return String(__LOBOS_PANEL_VERSION__);
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

module.exports = { panelVersion };

