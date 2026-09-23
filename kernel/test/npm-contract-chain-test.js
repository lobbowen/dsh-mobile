#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// npm/dsh 调用链行为门禁（容器契约 → 内核全部子进程走 node 代跑形态）
//
// ## 锁定的三段链路（方案 ②+③ 的行为级证据，静态断言无法证明这三点）
//   C-1 dist.runNpmInstall：spawn(node, [npm-cli.js, install, -g, --ignore-scripts, ...])，
//       env 带显式 npm_config_prefix（容器只读前缀下 -g 必失败的根治）。
//   C-2 NativeManager：checkEnvironment 经契约探测；安装清单落盘前把 config.command
//       写回 [node绝对, 入口脚本绝对, 'web', '--no-open'] 并经 persistCommand 落盘。
//   C-3 PluginManager._runCli：经 resolveDshCli 用与主干同代的 node 代跑形态。
//
// ## 安全设计（test-safety-gate 的 B 规约）
//   PATH 被收缩为 TMP：ambient 'npm'/'dsh' **结构上不可能被命中** ——
//   一旦契约解析回退到逻辑名，spawn 直接 ENOENT、测试红，而不是碰真实 npm。
//   所有「可执行」都是 process.execPath 跑 fake *.js。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : '')); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'npmchain-'));
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH, DSH_SUPERVISOR_HOME: process.env.DSH_SUPERVISOR_HOME };
process.env.DSH_SUPERVISOR_HOME = TMP;              // 契约根：<TMP>/supervisor/runtime.json
process.env.HOME = TMP; process.env.USERPROFILE = TMP; // prefix 断言点：os.homedir() → TMP
process.env.PATH = TMP;                              // 见「安全设计」

const SUP = path.join(TMP, 'supervisor');
fs.mkdirSync(SUP, { recursive: true });
const NPM_ROOT = path.join(TMP, 'npm-global');       // fake `npm root -g` 的返回值
const FAKE_CLI_LOG = path.join(TMP, 'npm-calls.jsonl');
const DSH_CLI_LOG = path.join(TMP, 'dsh-calls.jsonl');

const fakeNpmCli = path.join(TMP, 'npm-cli.js');
fs.writeFileSync(fakeNpmCli,
  'const fs=require("fs");\n' +
  'const T=' + JSON.stringify(TMP) + ';\n' +
  'const argv=process.argv.slice(2);\n' +
  'fs.appendFileSync(T+"/npm-calls.jsonl",JSON.stringify({argv,prefix:process.env.npm_config_prefix||null})+"\\n");\n' +
  'if(argv[0]==="--version"){console.log("11.19.0-fake");process.exit(0);}\n' +
  'if(argv[0]==="root"){console.log(T+"/npm-global");process.exit(0);}\n' +
  'process.exit(0);\n');

// dsh 入口的 recorder 内容：写死绝对 TMP（spawn 的 cwd 与被谁执行无关，只记录 argv）。
const DSH_RECORDER =
  'const fs=require("fs");\n' +
  'fs.appendFileSync(' + JSON.stringify(TMP) + '+"/dsh-calls.jsonl",JSON.stringify({argv:process.argv.slice(2)})+"\\n");\n' +
  'process.exit(0);\n';

// 容器形态契约：nodePath 直接用测试自己的 execPath（可执行），npmEntry 指 fake cli。
fs.writeFileSync(path.join(SUP, 'runtime.json'), JSON.stringify({
  schema: 2, writtenBy: 'npmchain-test',
  nodePath: process.execPath, nodeBinDir: TMP, npmPath: fakeNpmCli, npmEntry: fakeNpmCli, minNode: 'v22.12.0',
}), null, 2);

const reads = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const loggerStub = { info() {}, warn() {}, error() {} };
const distMod = require(path.join(ROOT, 'src', 'domains', 'dist', 'index.js'));
const { NativeManager } = require(path.join(ROOT, 'src', 'guard', 'native', 'manager.js'));
const { PluginManager } = require(path.join(ROOT, 'src', 'domains', 'plugin', 'plugins.js'));

async function main() {
  // ── C-1 安装执行器：契约形态 + ignore-scripts + 显式 prefix ──
  const dist = new distMod.DistributionManager({ logger: loggerStub });
  const res = await dist.runNpmInstall({ pkg: '@deepseek-ai/dsh', version: '9.9.9', timeoutMs: 30000, onLine: () => {} });
  check('C-1 runNpmInstall 经 node 代跑 fake npm-cli 成功', res.ok === true, JSON.stringify(res.error || res.output));
  const calls = reads(FAKE_CLI_LOG);
  const inst = calls.filter((c) => c.argv[0] === 'install').pop();
  check('C-1 fake npm-cli 收到 install 调用（bin/args 来自契约）', !!inst, JSON.stringify(calls));
  if (inst) {
    check('C-1 argv 为 install -g 且含 --ignore-scripts', inst.argv[0] === 'install' && inst.argv.includes('-g') && inst.argv.includes('--ignore-scripts'), JSON.stringify(inst.argv));
    check('C-1 argv 尾项是 pkg@version', inst.argv[inst.argv.length - 1] === '@deepseek-ai/dsh@9.9.9', JSON.stringify(inst.argv));
    check('C-1 env 注入显式 npm_config_prefix=$HOME/.npm-global', inst.prefix === path.join(TMP, '.npm-global'), String(inst.prefix));
  }

  // ── C-2 NativeManager：契约环境检查 + 启动命令写回 ──
  const config = { command: ['node', 'dsh', 'web'], packageName: '@deepseek-ai/dsh', targetPort: 3080, healthUrl: 'http://127.0.0.1:3080/' };
  const patches = [];
  const nm = new NativeManager({
    config, dist: null, logger: loggerStub, events: null,
    stateDir: path.join(TMP, 'state'),
    persistCommand: (p) => patches.push(p),
  });
  const env = nm.checkEnvironment();
  check('C-2 checkEnvironment 经契约探测全绿', env.ok === true, JSON.stringify(env.errors));
  check('C-2 npmRoot 来自契约形态的 root -g', env.npmRoot === NPM_ROOT, String(env.npmRoot));

  // 伪造「安装成功后的全局包」：package.json bin.dsh → bin/dsh.js。
  const pkgDir = path.join(NPM_ROOT, '@deepseek-ai/dsh');
  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9', bin: { dsh: 'bin/dsh.js' } }));
  fs.writeFileSync(path.join(pkgDir, 'bin', 'dsh.js'), DSH_RECORDER);

  nm._recordManifest('9.9.9');
  const entryAbs = path.join(pkgDir, 'bin', 'dsh.js');
  check('C-2 config.command 写回 [node绝对, 入口绝对, web, --no-open]',
    JSON.stringify(config.command) === JSON.stringify([process.execPath, entryAbs, 'web', '--no-open']), JSON.stringify(config.command));
  check('C-2 写回经 persistCommand 落盘（重启沿用）', patches.length === 1 && JSON.stringify(patches[0].command) === JSON.stringify(config.command), JSON.stringify(patches));
  check('C-2 installedVersion 从写回后的 command[1] 反查成功', nm.installedVersion() === '9.9.9', String(nm.installedVersion()));
  const cli = nm.dshCliInvocation();
  check('C-2 dshCliInvocation 返回 node 代跑形态（含 --expose-internals）', !!cli && cli.bin === process.execPath && cli.args[0] === '--expose-internals' && cli.args[1] === entryAbs, JSON.stringify(cli));

  // ── C-3 PluginManager：dsh 子命令走同一形态 ──
  const pm = new PluginManager({
    dshBin: 'dsh', profileDir: path.join(TMP, 'profile'), overlayFile: path.join(TMP, 'overlay.yml'),
    resolveDshCli: () => nm.dshCliInvocation(), logger: loggerStub, events: null, dist: null,
  });
  const cliRes = await pm._runCli(pm._nativeTarget(), ['list'], { timeoutMs: 30000 });
  check('C-3 _runCli 经 node 代跑 fake dsh 入口成功', cliRes.ok === true, JSON.stringify(cliRes.error || null));
  const dshCalls = reads(DSH_CLI_LOG);
  const last = dshCalls[dshCalls.length - 1];
  check('C-3 dsh 入口收到 plugin 子命令 argv', !!last && last.argv[0] === 'plugin' && last.argv.includes('list'), JSON.stringify(dshCalls));

  // ── C-4 降级反向：删掉契约的 npmEntry 键 → 逻辑名形态在 PATH 收缩下 ENOENT（而非误跑真 npm）──
  fs.writeFileSync(path.join(SUP, 'runtime.json'), JSON.stringify({
    schema: 2, writtenBy: 'npmchain-test', nodePath: process.execPath, nodeBinDir: TMP, minNode: 'v22.12.0',
  }), null, 2);
  const res2 = await dist.runNpmInstall({ pkg: '@deepseek-ai/dsh', version: '0.0.1', timeoutMs: 15000 });
  check('C-4 无 npmEntry/npmPath 契约退回 ambient 且结构上不可能命中真 npm', res2.ok === false, JSON.stringify(res2.error || null));
}

main().catch((e) => { check('chain threw: ' + e.message, false); }).then(() => {
  Object.assign(process.env, { HOME: savedEnv.HOME, USERPROFILE: savedEnv.USERPROFILE, PATH: savedEnv.PATH });
  if (savedEnv.DSH_SUPERVISOR_HOME === undefined) delete process.env.DSH_SUPERVISOR_HOME; else process.env.DSH_SUPERVISOR_HOME = savedEnv.DSH_SUPERVISOR_HOME;
  fs.rmSync(TMP, { recursive: true, force: true });
  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
});
