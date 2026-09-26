'use strict';

// @vscode/ripgrep 按 @vscode/ripgrep-<platform>-<arch>/bin/rg 解析（lib/index.js 用
// require.resolve，只解析路径不加载文件）；这里把该平台包补给安装树并指向 $PREFIX/bin/rg，
// 替代对依赖的逐字节补丁。
//
// $PREFIX 从参数进来（runtime.json 契约的 prefix 格），**不再读容器环境**：
// 容器从未导出该键，真机上这个单元因此静默 no-op 了一整代，glob/grep 全灭且零日志。

const fs = require('node:fs');
const path = require('node:path');

const PKG = '@vscode/ripgrep-android-arm64';

/**
 * @param {string} npmRoot npm 全局根
 * @param {{prefix:string|null}} opts $PREFIX 根（契约值）
 * @returns {{status:'applied'|'already'|'blocked', results:Array, reason:string|null}}
 */
function ensureRipgrepPackage(npmRoot, opts) {
  const prefix = (opts && opts.prefix) || null;
  const bin = prefix ? path.join(prefix, 'bin', 'rg') : null;
  if (!npmRoot) return { status: 'blocked', reason: 'npm 全局根未知', results: [] };
  if (!bin) return { status: 'blocked', reason: '契约缺 prefix 格，找不到 ' + PKG + ' 该指向的 rg', results: [] };
  if (!fs.existsSync(bin)) return { status: 'blocked', reason: 'PREFIX 下无 rg: ' + bin, results: [] };
  const dir = path.join(npmRoot, PKG);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const pkgJson = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, JSON.stringify({ name: PKG, version: '14.1.1', private: true }, null, 2) + '\n');
  }
  const link = path.join(dir, 'bin', 'rg');
  // 幂等判据 = 链接确实指向契约里那份 rg（尺寸/时间都不算数）
  try { if (fs.readlinkSync(link) === bin) return { status: 'already', reason: null, results: [] }; } catch {}
  try { fs.rmSync(link, { force: true }); } catch {}
  fs.symlinkSync(bin, link);
  return { status: 'applied', reason: null, results: [{ file: PKG + '/bin/rg', target: bin }] };
}

module.exports = { PKG, ensureRipgrepPackage };
