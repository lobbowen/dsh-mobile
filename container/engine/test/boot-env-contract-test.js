'use strict';
// 双管线漂移门禁（生产 GuestAdapter.kt ⇄ 测试夹具 boot-fixture.js）
//
// 修复的缺陷（架构收敛 C，ADR-0006）：「装配环境 → spawn 内核」曾有两份实现
// （Kotlin ProcessBuilder 内联块 + engine 侧装配代码），靠注释互指"对齐"——
// 实际 TMPDIR（cacheDir vs os.tmpdir()）、DSH_BRIDGE_SOCKET（只有一侧注入）、
// PATH（Kotlin 侧被写两次互相覆盖）全都漂转过，后果是只在真机复现的静默断链。
//
// 现在的收敛：生产装配只剩 GuestAdapter 一处；boot-fixture.js 降级为 e2e 测试夹具。
// 本门禁把"夹具不得发明生产没有的语义"变成可执行的判定：
//   1) boot-fixture.js 注入的**每一个**环境键必须在 GuestAdapter 里存在（反向新增=红）；
//   2) 双侧共有的核心键逐字节一致（socket 名、PATH 组装次序、TMPDIR 单源）；
//   3) 漂移的三大历史现场各设一条专项回归断言，指名道姓。
//
// 能红的证明：给 boot-fixture.js 加一个 GuestAdapter 没有的 FOO=1，断言 1 立刻 FAIL；
// 把 boot-fixture.js 的 socket 名改一个字母，专项断言 FAIL。这不是过滤后恒真的检查。

const fs = require('fs');
const path = require('path');
const makeRunner = require('./harness');
const { check, finish } = makeRunner('boot-env-contract');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GUEST_KT = path.join(ROOT, 'container', 'app', 'src', 'main', 'java', 'io', 'github',
  'lobbowen', 'dshmobile', 'runtime', 'GuestAdapter.kt');
const RUNTIME_KT = path.join(ROOT, 'container', 'app', 'src', 'main', 'java', 'io', 'github',
  'lobbowen', 'dshmobile', 'runtime', 'NodeRuntimeService.kt');
const BRIDGE_KT = path.join(ROOT, 'container', 'app', 'src', 'main', 'java', 'io', 'github',
  'lobbowen', 'dshmobile', 'bridge', 'HostBridgeService.kt');
const FIXTURE_JS = path.join(__dirname, 'boot-fixture.js');

const guest = fs.readFileSync(GUEST_KT, 'utf8');
const boot = fs.readFileSync(FIXTURE_JS, 'utf8');

// ── 解析 GuestAdapter 的全部环境键（kernelPlan 的 put("K" 与 baseEnv 的 "K" to）──
const ktKeys = new Set();
for (const m of guest.matchAll(/put\(\s*"([A-Z_][A-Z0-9_]*)"/g)) ktKeys.add(m[1]);
for (const m of guest.matchAll(/"([A-Z_][A-Z0-9_]*)"\s+to\s/g)) ktKeys.add(m[1]);
check('GuestAdapter 键集解析非空（≥12 个，防空转）', ktKeys.size >= 12, 'size=' + ktKeys.size);

// ── 解析 boot-fixture.js 注入的环境键（env 对象字面量里的 KEY:）──
const envBlock = boot.slice(boot.indexOf('const env = Object.assign'), boot.indexOf('const child = spawn'));
check('boot-fixture.js env 块定位成功（防切片空转）', envBlock.length > 200 && envBlock.includes('DSH_ANDROID'));
const jsKeys = new Set();
for (const m of envBlock.matchAll(/^\s*([A-Z][A-Z0-9_]+):/gm)) jsKeys.add(m[1]);
check('boot-fixture.js 键集解析非空（≥8 个，防空转）', jsKeys.size >= 8, 'size=' + jsKeys.size);

// ── 判定 1：夹具不得发明生产没有的键 ──
const invented = [...jsKeys].filter((k) => !ktKeys.has(k));
check('boot-fixture.js 的每个环境键都在 GuestAdapter 中（夹具发明键=红）', invented.length === 0, invented.join(', '));

// ── 判定 2：双侧共有的核心语义逐条一致 ──
// socket 名：GuestAdapter.BRIDGE_SOCKET ⇄ boot-fixture.js 默认值 ⇄ HostBridgeService（经别名）
const ktSocket = (guest.match(/const val BRIDGE_SOCKET = "([^"]+)"/) || [])[1];
const jsSocket = (boot.match(/DSH_BRIDGE_SOCKET:\s*o\.bridgeSocket\s*\|\|\s*'([^']+)'/) || [])[1];
check('socket 名字面量双侧一致（GuestAdapter ⇄ boot-fixture.js）', !!ktSocket && ktSocket === jsSocket,
  `kotlin=${ktSocket} js=${jsSocket}`);
const bridgeSrc = fs.readFileSync(BRIDGE_KT, 'utf8');
check('HostBridgeService.SOCKET_NAME 取自 GuestAdapter（不再各写一份字面量）',
  /const val SOCKET_NAME = GuestAdapter\.BRIDGE_SOCKET/.test(bridgeSrc));

// PATH 单点组装：GuestAdapter 里 put("PATH" 只许出现一次（旧实现在 Kotlin 服务里写两次互相覆盖）
const pathWrites = (guest.match(/put\(\s*"PATH"/g) || []).length + (guest.match(/"PATH"\s+to/g) || []).length;
check('GuestAdapter 内 PATH 组装点唯一', pathWrites >= 1 && pathWrites <= 2,
  '出现 ' + pathWrites + ' 次（baseEnv 一份 + kernelPlan 覆盖一份，允许多至 2）');
const runtimeSrc = fs.readFileSync(RUNTIME_KT, 'utf8');
check('NodeRuntimeService 不再内联组装任何环境键（spawn 装配只剩 GuestAdapter）',
  !/environment\(\)\s*\.apply/.test(runtimeSrc) && !/put\("(DSH_|PATH|TMPDIR|LD_LIBRARY_PATH|NODE_PATH)/.test(runtimeSrc));

// TMPDIR 单源：Kotlin = cacheDir；boot-fixture.js 夹具经 o.cacheDir 同构（曾写 os.tmpdir() 独走）。
check('GuestAdapter.TMPDIR = cacheDir（单一事实）', /"TMPDIR" to base\.cacheDir\.absolutePath/.test(guest));
check('boot-fixture.js.TMPDIR 优先 o.cacheDir（os.tmpdir 仅桌面回落）', /TMPDIR:\s*o\.cacheDir\s*\|\|\s*os\.tmpdir\(\)/.test(boot));

// NODE_PATH 双段（内核自带在前、共享安装在后）—— 旧两侧各一段。
check('GuestAdapter NODE_PATH 双段次序（kernelDir 前）',
  /put\(\s*"NODE_PATH"[\s\S]{0,220}?kernelDir[\s\S]{0,160}?filesDir/.test(guest));
check('boot-fixture.js NODE_PATH 双段次序（kernelDir 前）',
  /NODE_PATH:\s*\[\s*path\.join\(kernelDir,\s*'node_modules'\),\s*path\.join\(o\.kernelHome,\s*'node_modules'\)/.test(boot));

// 命令形态：两侧都是 [nodeBin, entry, 'daemon']（探针模式仅生产有，不比对）。
check('GuestAdapter command = nodeBin + entry + daemon',
  /command = listOf\(\s*i\.base\.nodeBin\.absolutePath,\s*i\.kernelEntry\.absolutePath,\s*"daemon"/.test(guest));
check('boot-fixture.js spawn = nodeBin + [entry, daemon]', /spawn\(o\.nodeBin,\s*\[entry,\s*'daemon'\]/.test(boot));

// ── 判定 3：端口常量单一来源 ──
check('GuestAdapter 端口常量齐备（36360 控制面 / 3080 探针）',
  /const val KERNEL_CONTROL_PORT = 36360/.test(guest) && /const val PROBE_PORT = 3080/.test(guest));
check('NodeRuntimeService 不再自带端口常量（读 GuestAdapter）',
  !/const val (KERNEL_CONTROL_PORT|PORT) =/.test(runtimeSrc) && /GuestAdapter\.KERNEL_CONTROL_PORT/.test(runtimeSrc));

finish();
