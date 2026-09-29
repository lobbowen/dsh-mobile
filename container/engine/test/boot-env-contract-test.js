'use strict';
// 双管线漂移门禁（生产装配件 ⇄ 测试夹具 boot-fixture.js）
//
// 修复的缺陷（架构收敛 C，ADR-0006）：「装配环境 → spawn 内核」曾有两份实现
// （Kotlin ProcessBuilder 内联块 + engine 侧装配代码），靠注释互指"对齐"——
// 实际 TMPDIR（cacheDir vs os.tmpdir()）、LOBOS_BRIDGE_SOCKET（只有一侧注入）、
// PATH（Kotlin 侧被写两次互相覆盖）全都漂转过，后果是只在真机复现的静默断链。
//
// 现在的收敛：生产装配只剩**两处且分工明确** —— 每个进程树根共享的环境语义在
// lobos/os/RuntimeEnvironment.treeRootEnv()，console 的申报与 command/cwd 在
// GuestAdapter；boot-fixture.js 降级为 e2e 测试夹具。
// 本门禁把"夹具不得发明生产没有的语义"与"语义不许留在某颗 Program 的装配里"
// 变成可执行的判定：
//   1) boot-fixture.js 注入的**每一个**环境键必须在生产装配件（两文件并集）里存在（反向新增=红）；
//   2) 双侧共有的核心键逐字节一致（socket 名、PATH 组装次序、TMPDIR 单源）；
//   3) 漂移的三大历史现场各设一条专项回归断言，指名道姓；
//   4) 装配的触发点与唯一入口（环境是 OS 事实，不长在 console 的路径上）；
//   5) 一次性进程树根改用共享语义，不再各抄一份最小 env（债表 ENV-2）。
//
// 能红的证明：给 boot-fixture.js 加一个生产没有的 FOO=1，判定 1 立刻 FAIL；
// 把 boot-fixture.js 的 socket 名改一个字母，专项断言 FAIL；
// 把 RuntimeEnvironment 的 put("TMPDIR"...) 删掉 → TMPDIR 单源断言 FAIL；
// 在 GuestAdapter 里重新拼一份 HOME/LANG/SSL_CERT_FILE（搬家变复制）→ 判定 5 的"只剩申报" FAIL。
// 这不是过滤后恒真的检查。

const fs = require('fs');
const path = require('path');
const makeRunner = require('./harness');
const { check, finish } = makeRunner('boot-env-contract');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GUEST_KT = path.join(ROOT, 'container', 'app', 'src', 'main', 'java', 'lobos', 'runtime', 'GuestAdapter.kt');
const ENV_KT = path.join(ROOT, 'container', 'app', 'src', 'main', 'java', 'lobos', 'os', 'RuntimeEnvironment.kt');
const RUNTIME_KT = path.join(ROOT, 'container', 'app', 'src', 'main', 'java', 'lobos', 'runtime', 'InstanceHost.kt');
const BRIDGE_KT = path.join(ROOT, 'container', 'app', 'src', 'main', 'java', 'lobos', 'bridge', 'CapabilityBroker.kt');
const FIXTURE_JS = path.join(__dirname, 'boot-fixture.js');

const guestSrc = fs.readFileSync(GUEST_KT, 'utf8');
const envSrc = fs.readFileSync(ENV_KT, 'utf8');
// 生产装配件 = 树根环境语义 + console 申报。键集、PATH 组装点等判定按并集解析。
const guest = guestSrc + '\n' + envSrc;
const boot = fs.readFileSync(FIXTURE_JS, 'utf8');

// ── 解析生产装配的全部环境键（put("K" 与 "K" to 两种写法）──
const ktKeys = new Set();
for (const m of guest.matchAll(/put\(\s*"([A-Z_][A-Z0-9_]*)"/g)) ktKeys.add(m[1]);
for (const m of guest.matchAll(/"([A-Z_][A-Z0-9_]*)"\s+to\s/g)) ktKeys.add(m[1]);
check('生产环境键集解析非空（≥12 个，防空转）', ktKeys.size >= 12, 'size=' + ktKeys.size);

// ── 解析 boot-fixture.js 注入的环境键（env 对象字面量里的 KEY:）──
const envBlock = boot.slice(boot.indexOf('const env = Object.assign'), boot.indexOf('const child = spawn'));
check('boot-fixture.js env 块定位成功（防切片空转）', envBlock.length > 200 && envBlock.includes('LOBOS_ANDROID'));
const jsKeys = new Set();
for (const m of envBlock.matchAll(/^\s*([A-Z][A-Z0-9_]+):/gm)) jsKeys.add(m[1]);
check('boot-fixture.js 键集解析非空（≥8 个，防空转）', jsKeys.size >= 8, 'size=' + jsKeys.size);

// ── 判定 1：夹具不得发明生产没有的键 ──
const invented = [...jsKeys].filter((k) => !ktKeys.has(k));
check('boot-fixture.js 的每个环境键都在生产装配件中（夹具发明键=红）', invented.length === 0, invented.join(', '));

// ── 判定 2：双侧共有的核心语义逐条一致 ──
// socket 名：GuestAdapter.BRIDGE_SOCKET ⇄ boot-fixture.js 默认值 ⇄ HostBridgeService（经别名）
const ktSocket = (guest.match(/const val BRIDGE_SOCKET = "([^"]+)"/) || [])[1];
const jsSocket = (boot.match(/LOBOS_BRIDGE_SOCKET:\s*o\.bridgeSocket\s*\|\|\s*'([^']+)'/) || [])[1];
check('socket 名字面量双侧一致（GuestAdapter ⇄ boot-fixture.js）', !!ktSocket && ktSocket === jsSocket,
  `kotlin=${ktSocket} js=${jsSocket}`);
const bridgeSrc = fs.readFileSync(BRIDGE_KT, 'utf8');
check('CapabilityBroker.SOCKET_NAME 取自 GuestAdapter（不再各写一份字面量）',
  /const val SOCKET_NAME = GuestAdapter\.BRIDGE_SOCKET/.test(bridgeSrc));

// PATH 单点组装：并集里 put("PATH" 只许出现一次（旧实现在 Kotlin 服务里写两次互相覆盖，
// 搬家后若两侧各留一份就是复制而非搬家）。
const pathWrites = (guest.match(/put\(\s*"PATH"/g) || []).length + (guest.match(/"PATH"\s+to/g) || []).length;
check('PATH 组装点全仓唯一', pathWrites === 1,
  '出现 ' + pathWrites + ' 次（0 = 语义丢了，≥2 = 树根之间又各拼一份，都是旧 bug 复发）');
const runtimeSrc = fs.readFileSync(RUNTIME_KT, 'utf8');
check('InstanceHost 不再内联组装任何环境键（spawn 装配只剩装配件）',
  !/environment\(\)\s*\.apply/.test(runtimeSrc) && !/put\("(LOBOS_|PATH|TMPDIR|LD_LIBRARY_PATH|NODE_PATH)/.test(runtimeSrc));

// TMPDIR 单源：装配里只认树根的 tmpDir，而 tmpDir 的生产映射恒 = cacheDir（两段都钉，
// 缺一侧就能在"看起来对齐"的注释下漂回 os.tmpdir()）。boot-fixture.js 经 o.cacheDir 同构。
check('树根装配的 TMPDIR 取自 TreeRoot.tmpDir', /put\("TMPDIR",\s*root\.tmpDir\.absolutePath\)/.test(guest));
check('TreeRoot.tmpDir 的生产映射 = cacheDir（单一事实）', /tmpDir = ctx\.cacheDir/.test(envSrc));
check('boot-fixture.js.TMPDIR 优先 o.cacheDir（os.tmpdir 仅桌面回落）', /TMPDIR:\s*o\.cacheDir\s*\|\|\s*os\.tmpdir\(\)/.test(boot));

// D1 Linux 语义：安卓默认无 locale，排序/字符类落到 C；声明 C.UTF-8（bionic 认得的名字）。
check('树根装配声明 LANG=C.UTF-8（D1：安卓默认无 locale）', /put\("LANG",\s*"C\.UTF-8"\)/.test(guest));
check('boot-fixture.js 同构声明 LANG', /LANG:\s*'C\.UTF-8'/.test(boot));
// D1：安卓语义垫片经 NODE_OPTIONS 预载（仅在 envShim 在场时注入，缺件不许让 node 起不来）。
check('树根装配注入 NODE_OPTIONS=--require 垫片（仅 envShim 在场时）', /put\("NODE_OPTIONS"/.test(guest));
// D1：/tmp → $TMPDIR 前缀重写**默认生效**，不再依赖会被剥离的临时环境键（真机定罪）。
check('liblobosposix 的 /tmp 重写不依赖被剥离的临时开关',
  !/getenv\("[A-Z_]*TMP_REDIRECT"\)/.test(fs.readFileSync(path.join(ROOT, 'container', 'native', 'd1', 'open-fallback.c'), 'utf8')));

// NODE_PATH 双段：内核自带在前、`npm -g` 的安装目录在后（第二段必须与全局前缀同一事实源，
// 旧实现指 filesDir/node_modules ⇒ 全局装的模块永远 import 不到，债表 ENV-5）。
check('NODE_PATH 双段次序（programDir 前 + 全局前缀目录为第二段）',
  /put\(\s*"NODE_PATH"[\s\S]{0,260}?programDir[\s\S]{0,200}?NodeProvisioner\.globalNodeModules\(/.test(guest));
check('boot-fixture.js NODE_PATH 双段次序（programDir 前）',
  /NODE_PATH:\s*\[\s*path\.join\(programDir,\s*'node_modules'\),\s*path\.join\(o\.sandboxHome,\s*'node_modules'\)/.test(boot));
// ENV-5 的同一形状要扫遍每个消费者：旧第二段 File(home,"node_modules") 指向全仓无人创建的目录。
const ORPHAN_NODE_PATH = /File\(\s*(?:i\.)?root\.home,\s*"node_modules"\s*\)/;
check('没有任何树根把 NODE_PATH 指回无人创建的 filesDir/node_modules（含探针）',
  !ORPHAN_NODE_PATH.test(guestSrc), 'guest 侧命中=' + ORPHAN_NODE_PATH.test(guestSrc));

// 命令形态：两侧都是 [nodeBin, entry, 'daemon']（探针模式仅生产有，不比对）。
check('GuestAdapter command = nodeBin + entry + daemon',
  /command = listOf\(\s*i\.root\.nodeBin\.absolutePath,\s*i\.programEntry\.absolutePath,\s*"daemon"/.test(guest));
check('boot-fixture.js spawn = nodeBin + [entry, daemon]', /spawn\(o\.nodeBin,\s*\[entry,\s*'daemon'\]/.test(boot));

// ── 判定 3：端口常量单一来源 ──
check('GuestAdapter 端口常量齐备（36360 控制面 / 3080 探针）',
  /const val CONSOLE_PORT = 36360/.test(guest) && /const val PROBE_PORT = 3080/.test(guest));
check('InstanceHost 不再自带端口常量（读 GuestAdapter）',
  !/const val (CONSOLE_PORT|PORT) =/.test(runtimeSrc) && /GuestAdapter\.CONSOLE_PORT/.test(runtimeSrc));

// ── 判定 4：环境装配的触发点与唯一入口（债表 ENV-1）──
//
// 修的是「能力长在某个消费者的路径上」：$PREFIX、信任根重播、C 层供给过去只在
// InstanceHost.bootProgramOnce 里装配 —— 没有 Program、或内核被杀掉时环境就是空的，
// 第二个住户永远等不到。现在触发点挂在「宿主就位」这条边上，本体住 lobos/os/RuntimeEnvironment。
//
// 能红的证明：
//   a) 从 RuntimeEnvironment 删掉任一供给件调用 → 断言 1 红（本体不是空壳）；
//   b) 从 OsHostService 删掉 ensure 调用 → 断言 2 红（触发点回退到只有启动链）；
//   c) 在 InstanceHost 里重新内联 PrefixProvisioner.provision( → 断言 3 红（装配点不许再分叉）；
//   d) 把 SupplyProvisioner.linkEntry 改成写包装脚本 → 断言 4 红（exec-path.c:8-9 定罪的
//      「中间多了一层」回潮）；
//   e) 在 APK 侧重新引入 npm 面（linkNpm / ensureNpm / LOBOS_NPM_ENTRY / runtime.json 的 npm 键）
//      → 断言 5 红（npm 与 git/curl 同级归口 C 清单，宿主代跑形状不再存在）；
//   f) 把收尾换回 `append(ctx, "supply", true, "C 层供给完成：就位 N 件")` → 断言 6 红
//      （聚合的就位数不是对账：声明 5 件、可用 4 件时它仍写 OK）；
//   g) 让 marker 命中分支重新只 `okCount++` 而不重申真名入口 → 断言 7 红
//      （件在磁盘上 ≠ 按真名调得到；建链只发生在新落位那趟）。
//   h) 把别名建成共享本件 entry 的名字表（npx→npm-cli.js）、或让对账只报件名 → ENV-26 那组红
//      （对照样本 SHARED_ALIAS 就在断言旁边，四把尺子逐条判它红）。
const HOST_KT = path.join(ROOT, 'container', 'app', 'src', 'main', 'java', 'lobos', 'lifecycle', 'OsHostService.kt');
const PREFIX_KT = path.join(ROOT, 'container', 'app', 'src', 'main', 'java', 'lobos', 'runtime', 'PrefixProvisioner.kt');
const SUPPLY_KT = path.join(ROOT, 'container', 'app', 'src', 'main', 'java', 'lobos', 'runtime', 'SupplyProvisioner.kt');
const NODE_KT = path.join(ROOT, 'container', 'app', 'src', 'main', 'java', 'lobos', 'runtime', 'NodeProvisioner.kt');
const hostSrc = fs.readFileSync(HOST_KT, 'utf8');
const prefixSrc = fs.readFileSync(PREFIX_KT, 'utf8');
const supplySrc = fs.readFileSync(SUPPLY_KT, 'utf8');
const nodeSrc = fs.readFileSync(NODE_KT, 'utf8');

// 供给件的三个真实调用（provision / ensureEnvShim / SupplyProvisioner.ensure）。
// 用同一组正则同时判「本体里有」与「InstanceHost 里没有」，两侧对照组共用一把尺子。
const SUPPLY_CALLS = [
  /\bPrefixProvisioner\.provision\(/,
  /\bNodeProvisioner\.ensureEnvShim\(/,
  /\bSupplyProvisioner\.ensure\(/,
];
check('RuntimeEnvironment 真的调用三个供给件（搬家不是空壳，防空转）',
  SUPPLY_CALLS.every((re) => re.test(envSrc)),
  SUPPLY_CALLS.map((re) => re.source + '=' + re.test(envSrc)).join(' '));
check('宿主就位即装配（ENV-1：触发点与「哪颗 Program 装上」解耦）',
  /RuntimeEnvironment\.ensure\(/.test(hostSrc));
check('InstanceHost 不再直接驱动供给件（装配点唯一 = RuntimeEnvironment）',
  SUPPLY_CALLS.every((re) => !re.test(runtimeSrc)),
  SUPPLY_CALLS.filter((re) => re.test(runtimeSrc)).map((re) => re.source).join(', '));

// C 层件（含 npm）的真名兑现只有一处：SupplyProvisioner.linkEntry。
const linkEntryAt = supplySrc.indexOf('private fun linkEntry(');
const linkEntryEnd = supplySrc.indexOf('\n    fun ', linkEntryAt + 1);
const linkEntryBody = linkEntryAt < 0 ? '' : supplySrc.slice(linkEntryAt, linkEntryEnd > 0 ? linkEntryEnd : supplySrc.length);
check('$PREFIX/bin 下的真名 = 符号链接，不是包装脚本（判据 D）',
  linkEntryBody.includes('Os.symlink(entry.absolutePath, link.absolutePath)') &&
    // 包装脚本 = exec-path.c:8-9 已定罪的「中间多了一层」，一次落盘写入都不许有
    !/writeText|outputStream|#!\//.test(linkEntryBody),
  'linkEntry 定位=' + linkEntryAt + ' 体长=' + linkEntryBody.length);
check('APK 侧不留 npm 面（归口 C 清单：解包/建链/自造键/契约键四处全零命中）',
  !/fun linkNpm|NPM_BIN_NAME/.test(prefixSrc) &&
    !/fun ensureNpm\(/.test(nodeSrc) &&
    !/LOBOS_NPM_ENTRY/.test(guestSrc) &&
    !/"npmPath"|"npmEntry"/.test(runtimeSrc),
  'linkNpm=' + /fun linkNpm/.test(prefixSrc) + ' ensureNpm=' + /fun ensureNpm\(/.test(nodeSrc) +
    ' NPM_ENTRY 键=' + /LOBOS_NPM_ENTRY/.test(guestSrc) + ' 契约键=' + /"npmPath"|"npmEntry"/.test(runtimeSrc));

// 供给收尾的真尺（DS-9 设备那半）：分母是**清单声明数**，不是这次运气装上几件；
// 不平要写「不平」，且 ok 位必须是算出来的变量 —— 聚合的「就位 N 件」在 4/5 时仍报 OK。
const SUPPLY_RECON = [
  /= tools\.length\(\)/,
  /"supply", balanced,/,
  /balanced = shortPieces\.isEmpty\(\)/,
  /C 层供给对账不平/,
];
const supplyReconciles = (src) => SUPPLY_RECON.every((re) => re.test(src));
check('C 层供给收尾按「声明数 vs 可用数」对账，且不平才红',
  supplyReconciles(supplySrc) && !/append\(\s*ctx, "supply", true,/.test(supplySrc),
  SUPPLY_RECON.map((re) => re.source + '=' + re.test(supplySrc)).join(' ') +
    ' 写死 true 的收尾=' + /append\(\s*ctx, "supply", true,/.test(supplySrc));
const OLD_AGGREGATE = [
  'val tools = manifest.optJSONArray("tools")',
  'var okCount = 0',
  'RuntimeDiagnostics.append(ctx, "supply", true, "C 层供给完成：就位 " + okCount + " 件", base)',
  'return okCount',
].join('\n');
check('对照组：旧的聚合收尾被同一把尺子判红（尺子不是恒真）', !supplyReconciles(OLD_AGGREGATE),
  SUPPLY_RECON.map((re) => re.source + '=' + re.test(OLD_AGGREGATE)).join(' '));

// 「投放≠能力」的最后一格：真名的判据是 $PREFIX/bin 那条链，marker 命中也要重申一次。
const ensureEntryCalls = (supplySrc.match(/ensureEntry\(ctx,/g) || []).length;
const linkEntryCalls = (supplySrc.match(/linkEntry\(ctx,/g) || []).length;
check('真名入口在两条落位路径上都重申，建链出口唯一 = linkEntry',
  ensureEntryCalls >= 2 && linkEntryCalls === 1,
  'ensureEntry(ctx, 调用=' + ensureEntryCalls + ' linkEntry(ctx, 调用=' + linkEntryCalls);
check('落盘件的可执行位按内容判且两条路径都覆盖（ENV-25：解包 apply / 命中 repair）',
  /ExecBits\.apply\(out\)/.test(supplySrc) && /ExecBits\.repair\(root\)/.test(supplySrc),
  'apply=' + /ExecBits\.apply\(out\)/.test(supplySrc) + ' repair=' + /ExecBits\.repair\(root\)/.test(supplySrc));

// ENV-26 的设备那一半：一件可以多颗真名（npm 件同时给 npx），而 npx 的真身不是本件那颗 entry。
//   把别名做成「共享 entry 的名字表」= 链建得成、跑出来是错的东西（npx 变成 npm），
//   比缺链更难发现 ⇒ 每一颗别名必须用它自己的件内入口，且不可用时红字点到**那颗名字**。
const ALIAS_RULER = [
  // 建链：别名指向 File(root, 各自的 entryRel)，不是共享的 entry
  /for \(a in aliases\)[\s\S]{0,200}Os\.symlink\(File\(root, a\.entryRel\)\.absolutePath/,
  // 对账：坏的那一颗真名要能被点名（return name 等于说「npm 这颗件不可用」，把 npx 吞掉）
  /return a\.name/,
  // 两条落位路径都带上别名表（新落位兑现的名字集合 = marker 命中重申的集合）
  /ensureEntry\(ctx, name, root, entryRel, aliases\)/,
  // 别名格读不出 = 清单与件分叉，这件不算可用，且点名到 journal
  /shortPieces\.add\(name \+ "（aliases/,
];
const aliasOk = (src) => ALIAS_RULER.every((re) => re.test(src));
check('别名各自带件内入口、逐颗真名对账、形状读不出即点名（ENV-26 设备侧）',
  aliasOk(supplySrc) && (supplySrc.match(/ensureEntry\(ctx, name, root, entryRel, aliases\)/g) || []).length === 2,
  ALIAS_RULER.map((re) => re.source + '=' + re.test(supplySrc)).join(' ') +
    ' 两路调用数=' + (supplySrc.match(/ensureEntry\(ctx, name, root, entryRel, aliases\)/g) || []).length);
// 对照样本 = 这四处各自的「共享写法」：一条链都不差，但 npx 会跑成 npm。
const SHARED_ALIAS = [
  'for (a in aliases) { val la = entryLink(ctx, a.name); la.delete(); Os.symlink(entry.absolutePath, la.absolutePath) }',
  'for (a in aliases) if (!entryLink(ctx, a.name).isFile) return name',
  'val broken = ensureEntry(ctx, name, root, entryRel)',
  'if (aliasErr != null) continue',
].join('\n');
check('对照组：共享本件 entry 的别名写法被同一把尺子判红（尺子不是恒真）', !aliasOk(SHARED_ALIAS),
  ALIAS_RULER.map((re) => re.source + '=' + re.test(SHARED_ALIAS)).join(' '));

// ENV-25 的第三种形状：按**名单**给位（旧 PrefixProvisioner 的 `if (executable) dst.setExecutable(...)`）。
// 今天对 bash/rg 恰好正确，换一个名单外却可执行的件就静默不可用 —— 裁判只留 ExecBits 一个。
const KT_ROOT = path.join(ROOT, 'container', 'app', 'src', 'main', 'java');
const ktFiles = [];
(function walkKt(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkKt(p); else if (e.name.endsWith('.kt')) ktFiles.push(p);
  }
})(KT_ROOT);
const xCallers = ktFiles
  .filter((f) => /setExecutable\(/.test(fs.readFileSync(f, 'utf8')))
  .map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
check('可执行位裁判唯一 = ExecBits（其余 Kotlin 出现 setExecutable 即把名单/目录猜位装回来）',
  xCallers.length === 1 && xCallers[0] === 'container/app/src/main/java/lobos/runtime/ExecBits.kt',
  '命中文件=' + xCallers.join(',') + '（kt 文件共 ' + ktFiles.length + ' 个）');

// ── 判定 5：树根收编 —— 环境语义只有一份，所有进程树根共享（债表 ENV-2 / ENV-4）──
//
// 搬家前「环境」实际长在 console 这颗 Program 的装配上：校验器、ADB 客户端各抄一份
// 最小 env（HOME/TMPDIR/LD_LIBRARY_PATH 三遍），谁都没拿到 LD_PRELOAD 与信任根。
// 现在 TreeRoot + treeRootEnv 是唯一的一份，三个消费者都从它取。
//
// 能红的证明：
//   a) 把 ProgramVerifier 改回自己 put("HOME"...) → 断言 1/2 红；
//   b) 在 GuestAdapter 里重新拼一份 LANG/LD_LIBRARY_PATH（搬家变复制）→ 断言 3 红；
//   c) 从 PATH 组装里删掉 globalBin 那段 → 断言 4 红（npm -g 装的 CLI 找不回）。
const VERIFIER_KT = path.join(ROOT, 'container', 'app', 'src', 'main', 'java', 'lobos', 'ota', 'ProgramVerifier.kt');
const ADB_KT = path.join(ROOT, 'container', 'app', 'src', 'main', 'java', 'lobos', 'bridge', 'AdbClientRunner.kt');
const verifierSrc = fs.readFileSync(VERIFIER_KT, 'utf8');
const adbSrc = fs.readFileSync(ADB_KT, 'utf8');
const TREE_CONSUMERS = [
  ['ProgramVerifier.kt', verifierSrc],
  ['AdbClientRunner.kt', adbSrc],
  ['InstanceHost.kt（探针/内核两条 spawn）', runtimeSrc],
];
check('三个树根消费者都走 treeRootEnv/treeRootFor（不再各拼一份 env）',
  TREE_CONSUMERS.every(([, src]) => /RuntimeEnvironment\.treeRoot(Env|For)\(/.test(src)),
  TREE_CONSUMERS.filter(([, src]) => !/RuntimeEnvironment\.treeRoot(Env|For)\(/.test(src)).map(([n]) => n).join(', '));
// 同一路径拼接（HOME=filesDir、TMPDIR=cacheDir）只许存在于 TreeRoot 的生产映射里；
// 四个写法并查，消费者命中任意一个 = 把共享语义又抄了一遍。
const TREE_ASSIGNS = [/put\(\s*"HOME"/, /put\(\s*"TMPDIR"/, /"HOME"\s+to\s/, /"TMPDIR"\s+to\s/];
const dups = TREE_CONSUMERS.flatMap(([n, s]) =>
  TREE_ASSIGNS.filter((re) => re.test(s)).map((re) => n + ' :: ' + re.source));
check('消费者不再重复拼 HOME/TMPDIR（复制 env = 红）', dups.length === 0, dups.join(' | '));

// GuestAdapter 只剩 console 申报：树根语义若在两边各留一份就是复制而不是搬家。
const TREE_KEYS = ['HOME', 'TMPDIR', 'LANG', 'LD_LIBRARY_PATH', 'NODE_BIN', 'SHELL',
  'SSL_CERT_DIR', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO', 'NODE_OPTIONS', 'LD_PRELOAD'];
const leaked = TREE_KEYS.filter((k) =>
  new RegExp('put\\(\\s*"' + k + '"|"' + k + '"\\s+to').test(guestSrc));
check('树根语义只住 RuntimeEnvironment，GuestAdapter 里没有第二份', leaked.length === 0, leaked.join(', '));
check('PATH 段里有 npm 全局 bin（ENV-4：装完的 CLI 按名字调用得到）',
  /put\(\s*"PATH"[\s\S]{0,300}?NodeProvisioner\.globalBin\(/.test(envSrc));

// 2026-09-30（债 E11）：KillAudit 不再起子进程 —— 退出史改走 ActivityManager（查自己 UID 的包
// 不需要任何权限），所以「裸 exec 系统件」的那份**环境豁免撤销**。这条断言现在钉的是反面：
// 它既不许回到 exec dumpsys 的形状（豁免已不存在，回去就是无人复核地重开），也不许自己拼 env。
const KILL_KT = path.join(ROOT, 'container', 'app', 'src', 'main', 'java', 'lobos', 'os', 'KillAudit.kt');
const killSrc = fs.readFileSync(KILL_KT, 'utf8');
check('KillAudit 不起子进程也不拼 env（退出史走 ActivityManager，环境豁免已撤销）',
  !/environment\(\)/.test(killSrc) && !/RuntimeEnvironment\.treeRoot/.test(killSrc) &&
    !/ProcessBuilder\(/.test(killSrc) && /getHistoricalProcessExitReasons\(/.test(killSrc),
  'environment()=' + /environment\(\)/.test(killSrc) + ' treeRoot=' + /RuntimeEnvironment\.treeRoot/.test(killSrc) +
    ' ProcessBuilder=' + /ProcessBuilder\(/.test(killSrc) + ' api=' + /getHistoricalProcessExitReasons\(/.test(killSrc));

finish();

