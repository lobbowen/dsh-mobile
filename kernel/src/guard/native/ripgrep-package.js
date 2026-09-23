'use strict';

// @vscode/ripgrep 按 @vscode/ripgrep-<platform>-<arch>/bin/rg 解析；
// 这里把该平台包补给安装树并指向 $PREFIX/bin/rg，替代对依赖的逐字节补丁。

const fs = require('node:fs');
const path = require('node:path');

const PKG = '@vscode/ripgrep-android-arm64';

function ensureRipgrepPackage(npmRoot) {
  const bin = process.env.PREFIX ? path.join(process.env.PREFIX, 'bin', 'rg') : null;
  if (!npmRoot || !bin || !fs.existsSync(bin)) return { found: 0, results: [] };
  const dir = path.join(npmRoot, '@vscode', 'ripgrep-android-arm64');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const pkgJson = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, JSON.stringify({ name: PKG, version: '14.1.1', private: true }, null, 2) + '\n');
  }
  const link = path.join(dir, 'bin', 'rg');
  try { fs.rmSync(link, { force: true }); } catch {}
  fs.symlinkSync(bin, link);
  return { found: 1, results: [{ file: PKG + '/bin/rg', status: 'applied', target: bin }] };
}

module.exports = { PKG, ensureRipgrepPackage };
