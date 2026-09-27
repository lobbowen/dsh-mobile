'use strict';

// Android 不在 sharp 的原生 switch 内，sharp 为未知平台预留 wasm 回退：
// 第 102 行 require('@img/sharp-wasm32/sharp.node')（真 libvips 编到 wasm，官方路径）。
// 该包不在 sharp 的 optionalDependencies 里，必须显式补装。
// 做法：隔离目录里装好再拷回 DSH 树，避免扰动 DSH 的依赖树。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ex = require('../../platform/exec');

const PKG = '@img/sharp-wasm32';
const SCOPES = ['@img', '@emnapi'];

function ensureSharpWasm(dshDir, opts) {
  const o = opts || {};
  const nm = path.join(dshDir, 'node_modules');
  const target = path.join(nm, '@img', 'sharp-wasm32');
  if (!fs.existsSync(path.join(nm, 'sharp'))) return { status: 'skipped', reason: 'sharp 不在树中' };
  if (fs.existsSync(target)) return { status: 'already' };
  const stage = fs.mkdtempSync(path.join(o.tmpdir || os.tmpdir(), 'dsh-sharp-'));
  try {
    const inv = o.npmInvocation || { bin: 'npm', args: [] };
    const args = inv.args.concat(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--prefix', stage, PKG]);
    ex.runOut(inv.bin, args, { env: o.env || process.env });
    const src = path.join(stage, 'node_modules');
    for (const scope of SCOPES) {
      const s = path.join(src, scope);
      if (!fs.existsSync(s)) continue;
      fs.mkdirSync(path.join(nm, scope), { recursive: true });
      for (const name of fs.readdirSync(s)) {
        const dst = path.join(nm, scope, name);
        fs.rmSync(dst, { recursive: true, force: true });
        fs.cpSync(path.join(s, name), dst, { recursive: true });
      }
    }
    return fs.existsSync(target) ? { status: 'applied' } : { status: 'failed', reason: '拷贝后仍缺 ' + PKG };
  } catch (e) {
    return { status: 'failed', reason: e.message };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { PKG, SCOPES, ensureSharpWasm };
