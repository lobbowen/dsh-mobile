'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// C 层（共享开发环境）物化器：产品无关的共享工具（pnpm…）的安装与可执行入口。
//
// 为什么不是 `npm i -g` 就完事：
//   · 安卓上 npm 生成的 bin shim 是 `#!/usr/bin/env node`，而 /usr/bin/env 在安卓不存在
//     ⇒ execve 必 ENOENT（本仓对 npm 自己也是恒以 `node <cli.js>` 代跑）。
//   · 故：工具本体装在共享 $PREFIX/lib/toolchain 下，可执行入口由本模块写成
//     `#!/system/bin/sh` + `exec <$PREFIX/bin/node> <entry> "$@"`。
//
// 为什么 pnpm 钉 10.x 而不是 latest：pnpm 11 起 `bin` 改为原生二进制 + 首次使用联网下载
//   （bin/pnpm.mjs → 下载 @pnpm/exe.<target>），Android 没有对应产物；10.x 的
//   bin/pnpm.cjs 是纯 JS，与本仓所有 JS 工具同一条通路。
//
// 边界：只在**容器契约形态**下动手（runtime.json 有 npmEntry 与 prefix）；
//   无契约 = skipped（PC / 测试逐字不变，不变量 C2）。
// 非致命：失败只返回 failed/blocked，绝不让调用方因供给失败而崩。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const runtimeContract = require('./runtime-contract');

/** 共享工具清单（唯一事实源）。新增一个工具 = 加一行。 */
const TOOLS = {
  pnpm: {
    version: '10.20.0',
    entry: 'bin/pnpm.cjs',
    why: 'dsh 插件管理（dsh-plugin-manager）调用 pnpm；≤10.x 才是纯 JS（11+ 是原生二进制下载器）',
  },
};

const INSTALL_TIMEOUT_MS = 600000;
const NL = String.fromCharCode(10);

/** 跑一次安装（异步、有界、整树可杀）。返回 { ok, code, tail }。 */
function runInstall(inv, args, env, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(inv.bin, inv.args.concat(args), { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) { return resolve({ ok: false, code: null, tail: e.message }); }
    let err = '';
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      finish({ ok: false, code: null, tail: '安装超时 ' + timeoutMs + 'ms' });
    }, timeoutMs);
    child.stderr.on('data', (b) => { err = (err + b.toString()).slice(-4000); });
    child.on('error', (e) => finish({ ok: false, code: null, tail: e.message }));
    child.on('exit', (code) => finish({ ok: code === 0, code, tail: err.split(NL).filter(Boolean).slice(-1)[0] || '' }));
  });
}

/**
 * 确保一个共享工具在场（安装 + 写可执行入口），幂等。
 * @param {string} name TOOLS 里的键
 * @param {{npmInvocation?:{bin:string,args:string[]}, runInstall?:Function, timeoutMs?:number}} [opts] 测试注入
 * @returns {Promise<{status:'already'|'applied'|'skipped'|'failed', name:string, bin?:string, entry?:string, reason?:string}>}
 */
async function ensureSharedTool(name, opts) {
  const o = opts || {};
  const out = (status, extra) => Object.assign({ status, name }, extra || {});
  const spec = TOOLS[name];
  if (!spec) return out('failed', { reason: '未登记的工具: ' + name });
  const c = runtimeContract.read();
  if (!c || !c.npmEntry || !c.prefix) return out('skipped', { reason: '非容器契约形态（无 runtime.json / npmEntry / prefix）' });
  const bin = path.join(c.prefix, 'bin', name);
  const libRoot = path.join(c.prefix, 'lib', 'toolchain');
  const entry = path.join(libRoot, 'node_modules', name, spec.entry);
  const nodeBin = path.join(c.prefix, 'bin', 'node');
  const body = '#!/system/bin/sh' + NL
    + '# dsh toolchain 生成；安卓无 /usr/bin/env，npm 的 bin shim 不可 execve。' + NL
    + 'exec "' + nodeBin + '" "' + entry + '" "$@"' + NL;
  // 新鲜判据 = **入口内容逐字相同**（不是存在性）：entry 路径随 $PREFIX 变化，
  // 按存在性判 already 会把安装树永远钉在第一代那个 $PREFIX 上（同 rg 平台包的教训）。
  let binFresh = false;
  try { binFresh = fs.readFileSync(bin, 'utf8') === body; } catch {}
  if (binFresh && fs.existsSync(entry)) return out('already', { bin, entry });
  if (!fs.existsSync(entry)) {
    const inv = o.npmInvocation || runtimeContract.npmInvocation();
    // --prefix 是 cli 参数，优先于 npmEnv 里为 -g 设的 npm_config_prefix（npm 语义）。
    const args = ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock',
      '--prefix', libRoot, name + '@' + spec.version];
    const env = runtimeContract.npmEnv(process.env);
    const r = typeof o.runInstall === 'function'
      ? o.runInstall(inv, args, env)
      : await runInstall(inv, args, env, o.timeoutMs || INSTALL_TIMEOUT_MS);
    if (!r || !r.ok || !fs.existsSync(entry)) {
      return out('failed', { reason: '安装 ' + name + '@' + spec.version + ' 后仍缺入口 ' + entry + (r && r.tail ? '（' + String(r.tail).slice(0, 160) + '）' : '') });
    }
  }
  try {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, body, { mode: 0o755 });
    fs.chmodSync(bin, 0o755);
  } catch (e) {
    return out('failed', { reason: '写入口失败: ' + e.message });
  }
  return out('applied', { bin, entry });
}

module.exports = { ensureSharedTool, TOOLS, INSTALL_TIMEOUT_MS };
