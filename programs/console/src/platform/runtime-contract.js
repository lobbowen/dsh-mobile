'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 运行期启动契约读取器（**容器写、内核读**）—— 与安卓容器（HostBridge 侧）成对。
//
// 契约文件：`<状态根>/supervisor/runtime.json`（schema 2），由容器在启动内核前写。
//
// ## 为什么内核要读它（根因）
//
//   内核自身也要执行 npm（装 DSH / 装插件 / 升级）。旧实现用 ambient PATH 的裸 `npm`
//   与 `process.env`。而服务环境的 PATH 常不含 nvm/fnm 的 npm 目录 ——
//   于是出现「容器能装、内核自己装不了」的分叉。同一台设备上 npm 是**一个**事实，
//   必须只有一处解析：容器（供给层）解析并投放，内核消费产物。
//
// ## 缺失/损坏时的行为（不变量 C2：内核可降级运行）
//
//   契约不可用时返回 null / 退回调用方给的 ambient 解析 —— **绝不因此启动失败**。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 本内核理解的契约 schema。 */
const SUPPORTED_SCHEMA = 2;

/** 契约文件路径。 */
function file() {
  return path.join(require('./state-root').supervisorDir(), 'runtime.json');
}

/** 读取契约（缺失/损坏返回 null）。兼容 schema 1（仅有 nodePath/nodeVersion/minNode）。 */
function read() {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const node = (j.node && typeof j.node === 'object') ? j.node : {};
  const npm = (j.npm && typeof j.npm === 'object') ? j.npm : {};
  return {
    schema: Number(j.schema) || 1,
    nodePath: j.nodePath || node.path || null,
    nodeBinDir: j.nodeBinDir || node.binDir || null,
    npmPath: j.npmPath || npm.path || null,
    // npm-cli.js 绝对路径（schema 2 的**新增可选键**，容器投放 npm 后写）。
    // 为什么可选而不升 schema：新 APK + 旧内核是常态，升 schema 会让 OTA 出去的
    // 旧内核拒绝整份契约；未知键按契约规则忽略。
    npmEntry: j.npmEntry || npm.entry || null,
    // $PREFIX 根（能力件的家：bin/{bash,rg}、lib/pty.node），容器由 PrefixProvisioner.root
    // 派生并写进来。与 npmEntry 同理是**可选键、不升 schema**：新 APK + 旧内核是常态。
    // 为什么必须进契约而不是只靠进程环境：投放单元曾以 process.env.PREFIX 为门控，
    // 而容器从未导出过这个键 ⇒ 真机上 glob/grep 与终端全灭且零日志（2026-09-26 定罪）。
    prefix: j.prefix || null,
    minNode: j.minNode || null,
    writtenBy: j.writtenBy || null,
    raw: j,
  };
}

/** node 可执行：契约优先（安卓下即 libnode.so 绝对路径）；缺失退回 fallback。 */
function nodeBin(fallback) {
  const c = read();
  if (c && c.nodePath) {
    try { if (fs.existsSync(c.nodePath)) return c.nodePath; } catch {}
  }
  return fallback || 'node';
}

/** $PREFIX 根（能力件的家）；无契约或旧容器无此格 ⇒ null，由调用方如实报缺口。 */
function prefixRoot() {
  const c = read();
  return (c && c.prefix) || null;
}

/**
 * npm 调用的**唯一形态**：恒返回 `{bin, args}`，调用方把自己的参数拼在 args 之后
 * （`spawn(inv.bin, inv.args.concat([...]))`）。
 *
 * 三种来源按优先级：
 *   ① 契约 npmEntry —— `{bin: nodePath, args: [npm-cli.js]}`（安卓 W^X 下 npm
 *      shim 脚本不可 execve，只能由 node 代跑）；
 *   ② 契约 npmPath —— 旧容器只投了可执行绝对路径，直接用；
 *   ③ 无契约 —— 退回调用方的 ambient 解析（PC 形态，不变量 C2 降级运行）。
 * @param {string|(()=>string)} [fallback] ambient 时的回退（函数则调用取值）
 * @returns {{bin:string, args:string[]}}
 */
function npmInvocation(fallback) {
  const c = read();
  if (c) {
    if (c.npmEntry) {
      try {
        if (fs.existsSync(c.npmEntry)) {
          return { bin: c.nodePath || process.execPath, args: [c.npmEntry] };
        }
      } catch {}
    }
    if (c.npmPath) {
      try { if (fs.existsSync(c.npmPath)) return { bin: c.npmPath, args: [] }; } catch {}
    }
  }
  const fb = typeof fallback === 'function' ? fallback() : fallback;
  return { bin: fb || 'npm', args: [] };
}

/** 在给定 env 上注入契约 PATH（nodeBinDir 首位）；无契约时原样返回副本。 */
function withPath(env) {
  const e = Object.assign({}, env || {});
  const c = read();
  if (c && c.nodeBinDir) {
    const cur = e.PATH || e.Path || '';
    e.PATH = c.nodeBinDir + path.delimiter + cur;
  }
  return e;
}

/**
 * npm 子进程的标准环境：契约 PATH + （容器投放 npmEntry 时）显式全局前缀。
 *
 * 为什么必须显式 prefix：容器里的 node 是只读 nativeLibraryDir 下的 libnode.so，
 * npm 默认 prefix 由它推导 → `install -g` 必然写只读目录失败。
 * `$HOME/.npm-global`（容器 HOME=filesDir，可写）与 exec-path.standardDirs、
 * 插件域 _pathExtra 的候选目录一致。PC（无契约）行为不变。
 *
 * 为什么容器形态**无条件覆盖**：设备上有且只有一个正确答案。ambient 值可能来自
 * 任何污染源（实测：经 npm scripts 启动的开发链路会注入 npm_config_prefix=/usr/local），
 * 让它悄悄赢会把安装写进不存在/不可写的目录。需要非默认前缀的调用方走 `--prefix`
 * 命令行参数（npm 语义：cli 参数 > env），本函数不与之冲突。
 */
function npmEnv(baseEnv) {
  const e = withPath(baseEnv);
  const c = read();
  if (c && c.npmEntry) {
    e.npm_config_prefix = path.join(os.homedir(), '.npm-global');
  }
  return e;
}

module.exports = { SUPPORTED_SCHEMA, file, read, nodeBin, npmInvocation, npmEnv, withPath, prefixRoot };
