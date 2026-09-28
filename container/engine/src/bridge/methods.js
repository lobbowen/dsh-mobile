'use strict';

// HostBridge 7 组方法表与能力声明（对齐 docs/contracts/bridge-protocol.md §3）。
//
// 两层能力：
// 1) bridgeGroup：program-manifest.json 的 requires 使用的「组令牌」bridge:<group>。
// 2) deviceCaps：方法实际依赖的「设备预置能力」（accessibility / adb_shell / …），
// 由设备权限栈决定设备是否具备。缺失 → 桥返回 ERR_CAPABILITY_MISSING。
// audit=true 的方法属 docs/contracts/bridge-protocol.md §5 强制审计的特权操作。

const GROUPS = ['app_control', 'ui_automation', 'shell', 'storage', 'build', 'notification', 'system'];
const BRIDGE_TOKENS = GROUPS.map((g) => 'bridge:' + g);

// 设备预置能力（设备权限栈）
const DEVICE_CAPS = [
  'base',                     // 容器 App 基础能力（始终可用）
  'accessibility',            // AccessibilityService
  'adb_shell',                // 内置 ADB 客户端已配对（无线调试；ADR-0003 勘误 2026-09-24）
  'mediaprojection',          // MediaProjection
  'manage_external_storage',  // MANAGE_EXTERNAL_STORAGE
  'notification_access',      // 通知访问
  'build_chain',              // 内置 JDK/build-tools（**已证伪，永不置位** —— 见下）
  'program_update',            // 从本地 feed 安装已签名 Program（自举，任意设备具备）
];

// build_chain 与 program_update 的区别（务必别混用）
//
// build_chain —— 「设备上有编译工具链」。**已被实测证伪**：
// Google Maven 上 aapt2 只有 linux/osx/windows 三个 classifier，
// 全是 x86_64；linux-aarch64 / linux-arm64 均 HTTP 404。
// 解包实况：e_machine=0x3e、PT_INTERP=/lib64/ld-linux-x86-64.so.2、
// NEEDED 含 6 个 glibc 库。exec 四道关的 interp/架构/libc
// 三关在装机后无法补救。
// ⇒ 保留此 token 只为表达"这个概念"，**任何设备都不会置位它**。
//
// program_update —— 「设备能安装已签名 Program」。不依赖任何原生工具链，
// 只用到：读本地文件 + Node 自带 OpenSSL 验签 + 写 filesDir。
// ⇒ **任意设备都具备**（OsHostService.deviceCapabilities 无条件置位）。
//
// 这个区分本身就是一条架构教训：原先 build 组绑在 build_chain 上，
// 于是整组因为一个永不具备的能力而**永远返回 -32001** —— 一个"沉默的、
// 代价极高的失败"。把"安装 Program"从"编译"里拆出来，那半条链立刻可用。

// method → { group, caps:[deviceCap...], audit?:bool }
// os.* 契约方法（docs/components/console-system-api.md §2）：由引擎镜像登记，
// 与 Kotlin CapabilityBroker.OS_METHODS 逐项对账（crosslang 门禁覆盖三段名，复检 AUD-G36）。
const OS_METHODS = {
  'os.state.get': { group: 'os', caps: ['base'], audit: false },
  'os.journal.read': { group: 'os', caps: ['base'], audit: false },
  'os.journal.logTail': { group: 'os', caps: ['base'], audit: false },
  'os.journal.export': { group: 'os', caps: ['base'], audit: false },
  'os.journal.metrics': { group: 'os', caps: ['base'], audit: false },
  'os.journal.tasks': { group: 'os', caps: ['base'], audit: false },
  'os.journal.task': { group: 'os', caps: ['base'], audit: false },
  'os.instances.list': { group: 'os', caps: ['base'], audit: false },
  'os.instances.get': { group: 'os', caps: ['base'], audit: false },
  'os.instances.action': { group: 'os', caps: ['base'], audit: true },
  'os.session.get': { group: 'os', caps: ['base'], audit: false },
  'os.session.stop': { group: 'os', caps: ['base'], audit: true },
  'os.programs.overview': { group: 'os', caps: ['base'], audit: false },
  'os.programs.list': { group: 'os', caps: ['base'], audit: false },
  'os.programs.settings': { group: 'os', caps: ['base'], audit: true },
  'os.appmgr.install': { group: 'os', caps: ['base'], audit: true },
  'os.appmgr.upgrade': { group: 'os', caps: ['base'], audit: true },
  'os.appmgr.uninstall': { group: 'os', caps: ['base'], audit: true },
  'os.appmgr.checkUpdate': { group: 'os', caps: ['base'], audit: false },
  'os.registry.info': { group: 'os', caps: ['base'], audit: false },
  'os.registry.apps': { group: 'os', caps: ['base'], audit: false },
  'os.registry.set': { group: 'os', caps: ['base'], audit: true },
  'os.registry.refresh': { group: 'os', caps: ['base'], audit: true },
  'os.registry.probe': { group: 'os', caps: ['base'], audit: false },
  'os.ports.list': { group: 'os', caps: ['base'], audit: false },
  'os.ports.claim': { group: 'os', caps: ['base'], audit: true },
  'os.ports.release': { group: 'os', caps: ['base'], audit: true },
  'os.runtime.status': { group: 'os', caps: ['base'], audit: false },
  'os.runtime.nodeLts': { group: 'os', caps: ['base'], audit: false },
  'os.env.status': { group: 'os', caps: ['base'], audit: false },
  'os.env.programs': { group: 'os', caps: ['base'], audit: false },
  // 上一轮原生件核验的落盘结论（只读 files/os/diag.jsonl，不重跑探针）。
  // 与 sys.nativeAssets 的分工见 docs/runbook/system-device-verification.md §9：
  // 那一个是「现在就验一次」，这一个回答「启动链最近那一轮验出了什么」。
  'os.nativeAssets.status': { group: 'os', caps: ['base'], audit: false },
  // 取证两条：都只读**已落盘**的结论，绝不现场重跑探针（分工见
  // docs/runbook/system-device-verification.md §9 与契约 §2.1）。
  'os.diagnostics.events': { group: 'os', caps: ['base'], audit: false },
  'os.provisioning.get': { group: 'os', caps: ['base'], audit: false },
};

const METHODS = {
  'app.launch':            { group: 'app_control', caps: ['base'] },
  'app.openUrl':           { group: 'app_control', caps: ['base'] },
  'app.stop':              { group: 'app_control', caps: ['base'] },
  'app.listInstalled':     { group: 'app_control', caps: ['base'] },
  // 安装/卸载只保留「用户手动同意」路径：PackageInstaller 提交会话，系统弹确认框，
  // 用户点确认才生效（Manifest 声明 REQUEST_INSTALL_PACKAGES）。不申请任何静默/替换特权。
  'app.install':           { group: 'app_control', caps: ['base'], audit: true },
  'app.uninstall':         { group: 'app_control', caps: ['base'], audit: true },

  // audit 标志的基准 = Kotlin CapabilityBroker 的 MethodDef 第二参数（真机上
  // 唯一真正写 bridge-audit.log 的实现）；由 bridge-methods-crosslang-test.js 钉住。
  'ui.tap':               { group: 'ui_automation', caps: ['accessibility'], audit: true },
  'ui.swipe':             { group: 'ui_automation', caps: ['accessibility'], audit: true },
  'ui.inputText':         { group: 'ui_automation', caps: ['accessibility'], audit: true },
  'ui.getUiTree':         { group: 'ui_automation', caps: ['accessibility'] },
  'ui.screenshot':        { group: 'ui_automation', caps: ['mediaprojection'], audit: true },
  'ui.waitFor':           { group: 'ui_automation', caps: ['accessibility'] },

  // shell 组 = 内置 ADB 客户端通道（一次性 Node 进程跑 assets/node/adb-client/）。
  // pair/status/forget 只要求 base —— 否则未配对设备永远无法配对（能力先于配对的死锁）。
  // exec 要求 adb_shell（= 已配对，files/adb/state.json 存在）。
  'shell.status':         { group: 'shell', caps: ['base'] },
  'shell.pair':           { group: 'shell', caps: ['base'], audit: true },
  'shell.forget':         { group: 'shell', caps: ['base'], audit: true },
  'shell.exec':           { group: 'shell', caps: ['adb_shell'], audit: true },

  'fs.read':              { group: 'storage', caps: ['manage_external_storage'] },
  'fs.write':             { group: 'storage', caps: ['manage_external_storage'], audit: true },
  'fs.list':              { group: 'storage', caps: ['manage_external_storage'] },
  'fs.mkdir':             { group: 'storage', caps: ['manage_external_storage'], audit: true },

  // Program**安装/升级的唯一入口**，且只从 OTA 源（ADR-0005）。参数 { checkOnly? }。
  // 契约 §2.6：能力调用（Program 身份/授权表未落地，Kotlin 侧显式 -32002）。
  'capability.invoke':     { group: 'system', caps: ['base'], audit: true },
  'build.programInstall':  { group: 'build', caps: ['program_update'], audit: true },
  'build.programStatus':   { group: 'build', caps: ['program_update'] },
  // 旧名保留但语义已修正：不再是"编 APK"，而是 Program 安装。
  // 保留它们是为了让存量调用不会突然变成 METHOD_NOT_FOUND（-32601），
  // 而是拿到一个**带解释的错误**（-32602 + 迁移指引）。
  'build.apk':            { group: 'build', caps: ['program_update'], audit: true },
  'build.status':         { group: 'build', caps: ['program_update'] },

  'notif.read':           { group: 'notification', caps: ['notification_access'], audit: true },
  'notif.post':           { group: 'notification', caps: ['base'], audit: true },

  'sys.info':             { group: 'system', caps: ['base'] },
  // 原生资产自检：只读探测，无权限要求。
  //
  // 用途：W^X/exec 链的失败几乎全部发生在真机，且容器侧诊断要用户手动去翻
  // diagnostics.txt。把它暴露给 Program 后，UI 可直接回答「node 到底能不能跑、
  // 为什么不能」，并拿到**结构化归因**（缺依赖 / 未解压 / SELinux 拒 exec / 探针失败）。
  //
  // 返回形状（与 Kotlin NativePreparer.PrepareReport.toJson 对齐）：
  // { allRequiredReady: Boolean, nativeLibraryDir: String, libSearchPath: String,
  // assets: [{ id, libName, humanName, required, note, requiredDeps,
  // status, path?, inApk?, missingDep?, errno?, exit?, output?, hint? }] }
  // status ∈ ready | missing_from_lib | missing_dependency | not_executable | probe_failed
  //
  // 参数：{ walkProbes?: Boolean }，默认 true（真跑 exec-probe）。传 false 只做
  // 存在性+依赖检查，避免频繁 spawn 进程。
  'sys.nativeAssets':     { group: 'system', caps: ['base'] },
};

/** 方法所需设备能力。未知方法返回 null（调用方据此报 METHOD_NOT_FOUND）。 */
function methodCaps(method) {
  return METHODS[method] ? METHODS[method].caps : null;
}

/** 方法是否强制审计。 */
function isAudited(method) {
  return !!(METHODS[method] && METHODS[method].audit);
}

/** 设备能力是否满足方法要求；返回缺失列表（空=满足）。 */
function missingCaps(method, availableCaps) {
  const caps = methodCaps(method);
  if (!caps) return null; // 未知方法
  return caps.filter((c) => !availableCaps.includes(c));
}

// 每组的**代表能力**：握手时判定「该组是否可用」。
//
// 语义（与 Kotlin CapabilityBroker.GROUP_REQUIRED 逐条对齐，2026-09 收敛）：
// 组可用 = 该组的**代表性基础能力**具备，而非「组内每个方法的能力都具备」。
// 例：bridge:app_control 的代表能力是 base —— 否则「启动已装应用」会被特权门槛误挡，
// 而 app.install/uninstall 这类特权方法本就由**方法级 caps**单独门禁（调用时再报 -32001）。
// 两层门禁：组级（握手协商，粗粒度可用性）+ 方法级（每次调用，精确拦截）。
const GROUP_REQUIRED = {
  'app_control': 'base',
  'notification': 'base',
  'system': 'base',
  'ui_automation': 'accessibility',
  'shell': 'adb_shell',
  'storage': 'manage_external_storage',
  // 组代表能力 = program_update，不是 build_chain。
  // 前者"任意设备具备"，后者"永不具备"（见 DEVICE_CAPS 处关于 aapt2 的论证）。
  // 绑错会让整组永远返回 -32001 —— 一个沉默且代价极高的失败。
  'build': 'program_update',
};

/** bridge:* 组令牌 → 该组的代表能力（用于握手协商「组是否可用」）。 */
function groupCaps(group) {
  const rep = GROUP_REQUIRED[group];
  return rep ? [rep] : [];
}

for (const [k, v] of Object.entries(OS_METHODS)) if (!(k in METHODS)) METHODS[k] = v;

module.exports = {
  GROUPS, BRIDGE_TOKENS, DEVICE_CAPS, METHODS, GROUP_REQUIRED,
  methodCaps, isAudited, missingCaps, groupCaps,
};
