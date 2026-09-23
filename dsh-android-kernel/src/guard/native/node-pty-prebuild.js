'use strict';

// node-pty 只认 prebuilds/<platform>-<arch>/pty.node；把容器构建产物复制到该位置。
// 不改 node-pty 代码，也不改 DSH：只补它 loader 会去找的那个文件。

const fs = require('node:fs');
const path = require('node:path');

const PLATFORM_DIR = 'android-arm64';

function ensureNodePtyPrebuild(dshDir, srcPath) {
  const ptyDir = path.join(dshDir, 'node_modules', 'node-pty');
  if (!fs.existsSync(ptyDir)) return { status: 'skipped', reason: 'node-pty 不在树中' };
  if (!srcPath || !fs.existsSync(srcPath)) return { status: 'skipped', reason: '构建产物缺失' };
  const dst = path.join(ptyDir, 'prebuilds', PLATFORM_DIR, 'pty.node');
  const size = fs.statSync(srcPath).size;
  if (fs.existsSync(dst) && fs.statSync(dst).size === size) return { status: 'already' };
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(srcPath, dst);
  return { status: 'applied', path: dst };
}

module.exports = { PLATFORM_DIR, ensureNodePtyPrebuild };
