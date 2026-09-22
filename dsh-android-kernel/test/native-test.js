#!/usr/bin/env node
'use strict';

// ⛔ 卸载类测试（项目政策，2026-08-31）：本脚本执行「控制面板对 DSH 原生的卸载」（NativeManager.uninstall 全量清理），
// 已从 npm test 自动测试链排除，仅允许作为独立脚本显式单独调用（node test/native-test.js 或 npm run test:native-uninstall）；
// 除非用户明确指令，禁止擅自运行。

// 原生 DSH 生命周期管理（NativeManager）离线测试：
// 安装状态探测 / 环境检查 / 安装清单记录 / 全量卸载清理。
// 全部使用隔离的临时 npm 全局根，绝不触碰宿主 npm 环境。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'native-test-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

(async () => {
  const { NativeManager } = require(path.join(ROOT, 'src', 'guard', 'native', 'manager'));
  const npmRoot = path.join(TMP, 'npm-root');
  fs.mkdirSync(npmRoot, { recursive: true });

  // 1. 未安装状态识别
  const nm1 = new NativeManager({ config: { command: ['node', '/nonexistent/bin/dsh', 'web'] }, stateDir: TMP, npmRoot, logger: { info(){}, warn(){}, error(){} }, events: null });
  const s1 = nm1.status();
  check('未安装状态识别', s1.installed === false && s1.state === 'uninstalled', JSON.stringify(s1));
  const env = nm1.checkEnvironment();
  check('环境检查通过（node/npm 可用）', env.ok === true, JSON.stringify(env));

  // 2. 已安装状态识别（模拟 npm 全局布局：node_modules/@deepseek-ai/dsh + bin 链接）
  const fakeBin = path.join(TMP, 'bin', 'dsh');
  fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
  const pkgDir = path.join(npmRoot, '@deepseek-ai', 'dsh');
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'lib', 'bin.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }));
  fs.symlinkSync(path.join(pkgDir, 'lib', 'bin.js'), fakeBin);
  const nm2 = new NativeManager({ config: { command: ['node', fakeBin, 'web'] }, stateDir: TMP, npmRoot, logger: { info(){}, warn(){}, error(){} }, events: null });
  const s2 = nm2.status();
  check('已安装状态识别', s2.installed === true && s2.version === '0.1.1-rc.2', JSON.stringify(s2));

  // 3. 安装清单记录 + 全量卸载
  nm2._recordManifest('0.1.1-rc.2');
  const m = nm2._manifest();
  check('清单记录（含真实 npmRoot）', m && m.version === '0.1.1-rc.2' && m.packageDir === pkgDir, JSON.stringify(m));
  const dataDir = path.join(TMP, 'dsh-data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'x'), 'y');
  m.dataPaths.push(dataDir);
  nm2._saveManifest(m);
  const u = await nm2.uninstall();
  check('卸载执行成功', u.ok === true, JSON.stringify(u).slice(0, 200));
  check('包目录被删', !fs.existsSync(pkgDir));
  check('bin 链接被删', !fs.existsSync(fakeBin));
  check('数据目录被删', !fs.existsSync(dataDir));
  check('清单被删', !fs.existsSync(nm2.manifestFile));
  const s3 = nm2.status();
  check('卸载后=uninstalled', s3.state === 'uninstalled', JSON.stringify(s3));

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
