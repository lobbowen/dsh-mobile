'use strict';
// 单一真值门禁（spec §2.5，R4）：设备能力判据**只许**住在 capability/ 与
// permissions/PermissionCenter.kt 里；别处再写一遍同样的表达式 —— 哪怕只是顺手 —— 即失败。
//
// 为什么需要它（真机案底）：同一件事（凭据在不在册 / DO 有没有生效 / 服务连没连）曾在
// AdbClientRunner、ProvisioningProbe、HostBridgeService.deviceCapabilities、KernelSelfCheck
// 与 v1 首页各写一份，靠注释承诺一致。结果就是「首页说 S0 绿、桥说没 shell 能力」。
// 注释承诺守不住的规矩，必须由 CI 守。
//
// 扫描口径：**整文件文本**（含注释与字符串），不做注释剥离。理由：判据出现在注释里
// 往往正因为作者打算在同文件再写一份；先剥注释等于给绕过留门。
// 因此 pattern 一律写成「代码形态」（带引号的字面量 / 带括号的调用），
// 文档式提法（如不带引号的 files/adb/state.json）不会误伤。
//
// 双向自证（spec §8「门禁能红」要求）：
//   反向：在任一业务层文件抄一句 `dpm.isDeviceOwnerApp(packageName)` → 本测试必须 FAIL。
//   正向：某规则在其归属范围内命中数为 0（判据被改名/删掉而门禁没跟着改）→ 视为门禁空转，FAIL。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PKG = path.join(ROOT, 'container/app/src/main/java/io/github/lobbowen/dshmobile');
const SKIP_DIRS = new Set(['node_modules', 'build', '.gradle', 'dist', 'assets']);
// 归属范围（相对包根的路径前缀）：判据只许出现在这些地方。
const CAPABILITY_DIR = 'capability/';
const PERMISSION_CENTER = 'permissions/PermissionCenter.kt';
const PERMISSION_CATALOG = 'permissions/PermissionCatalog.kt';

const RULES = [
  {
    name: 'ADB 配对凭据文件',
    re: /"state\.json"|"adbkey\.pem"/,
    owners: [CAPABILITY_DIR],
    why: '凭据在册与否只在 CapabilityCriteria.credentialsState 判一次',
  },
  {
    name: 'Device Owner 回读',
    re: /isDeviceOwnerApp\(/,
    owners: [CAPABILITY_DIR],
    why: 'DO 生效与否只在 CapabilityCriteria.isDeviceOwner 回读（dpm exit 0 不算数）',
  },
  {
    name: '开发者选项/无线调试开关读数',
    re: /"development_settings_enabled"|"adb_wifi_enabled"/,
    owners: [CAPABILITY_DIR],
    why: 'S0 前置开关只在 CapabilityCriteria 读 Settings.Global',
  },
  {
    name: 'Secure 服务登记键名',
    re: /"enabled_accessibility_services"|"enabled_notification_listeners"/,
    owners: [PERMISSION_CATALOG],
    why: '键名串只在 PermissionCatalog 声明一次（读侧与下发侧都引用它）；Settings.Secure 里没有这个公开常量，串抄两处必漂移',
  },
  {
    name: '通道可用性标记',
    re: /"uid=2000"/,
    owners: [CAPABILITY_DIR],
    why: '「通道真能跑 shell」的断言只在 AdbChannelProbe',
  },
  {
    name: 'DO 下发命令串',
    re: /dpm set-device-owner/,
    owners: [CAPABILITY_DIR],
    why: '取法命令只在 CapabilityAcquisitionRunner；GUI 与体检页不得自己拼',
  },
  {
    name: '特殊权限查询原语',
    re: /Settings\.canDrawOverlays\(|Environment\.isExternalStorageManager\(|canRequestPackageInstalls\(|isIgnoringBatteryOptimizations\(|checkSelfPermission\(/,
    owners: [PERMISSION_CENTER],
    why: '权限/授权状态查询唯一入口 = PermissionCenter.isGranted',
  },
];

// 已删除的 v1 判据模型词汇：任何地方（含注释）再出现即失败 —— 判据模型只允许一套。
const DEAD = [
  { name: 'v1 段状态机类型', re: /\bPipelineState\b|\bPipelineProbe\b|\bPipelineReadings\b/ },
  { name: 'v1 读数字段名', re: /\badbPaired\b|\blastPairError\b/ },
  { name: 'v1 凭据判据出口', re: /\bisPaired\s*\(/ },
];

// ---- DAG 不变式（spec §2.1 规则 2/3：`device-owner` 不进任何 requires；DO/ADB 缺席
// 时 S1 以外的能力仍能达成）。这段用**文本级**判据（剥注释后数 `requires = setOf(`
// 的出现次数），不受上面「整文件含注释」口径影响。----
const CATALOG_REL = 'capability/CapabilityCatalog.kt';
const PERM_CATALOG_REL = 'permissions/PermissionCatalog.kt';

// 剥 Kotlin 注释（块注释 + 行注释），只留可执行文本 —— 注释里提"device-owner"不该触发。
function stripKotlinComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// PermissionCatalog 里某个符号的字符串值（无定义返回 null，由调用方判 FAIL）。
function permValue(sym, permCatalogText) {
  const m = permCatalogText.match(new RegExp('const val ' + sym + '\\s*=\\s*"([^"]+)"'));
  return m ? m[1] : null;
}

function parseDag(catalogText) {
  const code = stripKotlinComments(catalogText);
  const consts = {};
  for (const m of code.matchAll(/const val ([A-Z_]+)\s*=\s*"([^"]+)"/g)) consts[m[1]] = m[2];
  const edges = [];
  const unresolved = [];
  let cur = null;
  for (const line of code.split('\n')) {
    const mi = line.match(/\bid\s*=\s*([A-Z_]+)\b/);
    if (mi) {
      if (consts[mi[1]] === undefined) unresolved.push('id 符号 ' + mi[1] + ' 无常量定义');
      cur = consts[mi[1]] || null;
    }
    const mr = line.match(/requires\s*=\s*setOf\(([^)]*)\)/);
    if (mr && cur) {
      const rs = [];
      for (const s of mr[1].matchAll(/([A-Z_]+)/g)) {
        if (consts[s[1]] === undefined) unresolved.push(cur + ' 的 requires 符号 ' + s[1] + ' 无法解析');
        else rs.push(consts[s[1]]);
      }
      edges.push({ from: cur, to: rs });
    }
  }
  return { consts, edges, unresolved };
}

// requires 出现次数必须在解析结果里全额复现 —— 少一条 = 写法变了而解析器漏了，
// 门禁会「带着零违规」通过，那是最坏情况，所以按 FAIL 处理。
function checkDag(catalogText, permCatalogText) {
  const notes = [];
  const code = stripKotlinComments(catalogText);
  const declared = (code.match(/\brequires\s*=\s*setOf\(/g) || []).length;
  const { consts, edges, unresolved } = parseDag(catalogText);
  notes.push('requires 声明 ' + declared + ' 处 / 解析出边 ' + edges.length + ' 条');
  if (declared === 0) notes.push('FAIL 登记表里一条 requires 都没有 —— DAG 约束不存在，门禁无覆盖');
  if (edges.length !== declared) notes.push('FAIL 解析漏边（声明 ' + declared + ' ≠ 解析 ' + edges.length + '）：写法漂移，门禁需跟进');
  if (unresolved.length) notes.push('FAIL requires/id 符号解析失败：\n  ' + unresolved.join('\n  '));

  const owner = consts.DEVICE_OWNER;
  const channel = consts.ADB_CHANNEL;
  if (!owner || !channel) { notes.push('FAIL 缺 DEVICE_OWNER/ADB_CHANNEL 常量，规则失去对象'); return notes; }

  // 规则 2：device-owner 不进任何 requires（v1 定罪的根因）。
  for (const e of edges) {
    if (e.to.includes(owner)) notes.push('FAIL ' + e.from + ' 把 device-owner 当前置（spec §2.1 规则 2：加速器不是门槛）');
  }
  if (!edges.some((e) => e.to.includes(channel))) {
    notes.push('FAIL 没有任何能力以 ' + channel + ' 为前置 —— S1 门禁失效（device-owner 应经 ADB 通道达成）');
  }

  // 规则 3：**非 optional** 能力（= 管线放行所需）的 requires 闭包不得含 adb-channel ——
  // 等价说法：拔掉 ADB，S2/S3 的绿仍可达成。optional=true 的加速器（device-owner、
  // mediaprojection）本就经 ADB 达成，不在此列（v1 的错是把加速器放进了硬前置链，不是它自己有 ADB 依赖）。
  const byFrom = new Map(edges.map((e) => [e.from, e.to]));
  // 条目区间：Capability(id = X, …) 与 perm(PermissionCatalog.Y, …) 各算一条。
  // 必须按锚点切段 —— 用 [^;] 之类的"就近边界"会越到下一条（Kotlin 参数表没有 ;）。
  const anchors = [];
  for (const m of code.matchAll(/\bid\s*=\s*([A-Z_]+)\b/g)) {
    if (consts[m[1]] !== undefined) anchors.push({ at: m.index, id: consts[m[1]] });
  }
  for (const m of code.matchAll(/\bperm\(\s*PermissionCatalog\.([A-Z_]+)/g)) {
    const v = permValue(m[1], permCatalogText);
    anchors.push({ at: m.index, id: v || 'UNRESOLVED:' + m[1], permSym: m[1] });
  }
  anchors.sort((a, b) => a.at - b.at);
  const optionalIds = new Set();
  for (let i = 0; i < anchors.length; i++) {
    const end = i + 1 < anchors.length ? anchors[i + 1].at : code.length;
    if (/\boptional\s*=\s*true/.test(code.slice(anchors[i].at, end))) optionalIds.add(anchors[i].id);
  }
  const ADB_SIDE = new Set([consts.DEV_OPTIONS, consts.WIRELESS_DEBUG, consts.ADB_CREDENTIALS, channel]);
  function closure(id, seen) {
    if (seen.has(id)) return seen;
    seen.add(id);
    for (const r of byFrom.get(id) || []) closure(r, seen);
    return seen;
  }
  for (const id of byFrom.keys()) {
    if (ADB_SIDE.has(id) || optionalIds.has(id)) continue;
    const c = closure(id, new Set());
    if (c.has(channel)) notes.push('FAIL ' + id + ' 的 requires 闭包含 ' + channel + '（无 ADB 的机器上永久锁死）');
  }
  // 环检测：有环则闭包/拓扑序都不成立。
  for (const id of byFrom.keys()) {
    const seen = new Set();
    const stack = [...(byFrom.get(id) || [])];
    while (stack.length) {
      const n = stack.pop();
      if (n === id) { notes.push('FAIL requires 图存在环：' + id); break; }
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(byFrom.get(n) || []));
    }
  }
  // S2 的权限能力必须能在 PermissionCatalog 里查到（查不到 = judge 永远拿不到读数）。
  const badPerms = anchors.filter((a) => a.permSym && a.id.startsWith('UNRESOLVED:'));
  for (const a of badPerms) notes.push('FAIL perm() 引用 PermissionCatalog.' + a.permSym + ' 但在 PermissionCatalog 无定义');
  const permCount = anchors.filter((a) => a.permSym).length;
  if (permCount === 0) notes.push('FAIL 登记表里没有任何 perm() 能力 —— 解析失效');
  notes.push('能力条目 ' + anchors.length + ' 条（含 perm 权限 ' + permCount + ' 项），optional ' + optionalIds.size + ' 项：' +
    [...optionalIds].sort().join(','));
  return notes;
}

const violations = [];
const deadHits = [];
const ownedCount = new Map(RULES.map((r) => [r.name, 0]));
let scannedFiles = 0;

function scanFile(abs, relPkg) {
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return; }
  scannedFiles++;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue;
      const allowed = rule.owners.some((o) => relPkg === o || relPkg.startsWith(o));
      if (allowed) ownedCount.set(rule.name, ownedCount.get(rule.name) + 1);
      else violations.push(rule.name + ' → ' + relPkg + ':' + (i + 1) + ' | ' + line.trim().slice(0, 120));
    }
    for (const d of DEAD) {
      if (d.re.test(line)) deadHits.push(d.name + ' → ' + relPkg + ':' + (i + 1) + ' | ' + line.trim().slice(0, 120));
    }
  });
}

function walk(dir, prefix) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const relPkg = prefix ? prefix + '/' + e.name : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs, relPkg); continue; }
    if (e.name.endsWith('.kt')) scanFile(abs, relPkg);
  }
}
walk(PKG, '');

// DAG 不变式单独取证：登记表原文 + 权限目录原文（判权限 id 是否真有定义）。
const catalogText = fs.readFileSync(path.join(PKG, CATALOG_REL), 'utf8');
const permCatalogText = fs.readFileSync(path.join(PKG, PERM_CATALOG_REL), 'utf8');
const dagNotes = checkDag(catalogText, permCatalogText);
const dagFails = dagNotes.filter((n) => n.startsWith('FAIL'));
const dagMeta = dagNotes.filter((n) => !n.startsWith('FAIL'));

const vacuous = RULES.filter((r) => ownedCount.get(r.name) === 0)
  .map((r) => r.name + '（归属范围内零命中 → ' + r.why + '）');

let failed = false;
// 扫描本身也不许空转：包根下的 .kt 数量低于地板值 = 目录结构变了而门禁还在"零违规"。
const MIN_SCANNED_KT = 30;
if (scannedFiles < MIN_SCANNED_KT) {
  failed = true;
  console.log('FAIL 只扫到 ' + scannedFiles + ' 个 .kt（地板 ' + MIN_SCANNED_KT +
    '）—— 包路径或文件布局已变化，本门禁的扫描范围需要跟着改，不能报零违规通过');
}
if (violations.length) {
  failed = true;
  console.log('FAIL 判据在归属层之外被复写（spec §2.5 单一真值）：');
  violations.forEach((v) => console.log('  ' + v));
}
if (deadHits.length) {
  failed = true;
  console.log('FAIL 已删除的 v1 判据模型词汇复活（判据模型只允许 CapabilityCatalog 一套）：');
  deadHits.forEach((v) => console.log('  ' + v));
}
if (vacuous.length) {
  failed = true;
  console.log('FAIL 门禁规则空转（归属范围内一条都没命中 = 判据已被改名/删除而门禁没跟上，规则失去覆盖面）：');
  vacuous.forEach((v) => console.log('  ' + v));
}
if (dagFails.length) {
  failed = true;
  console.log('FAIL 依赖图不变式被破坏（spec §2.1 规则 2/3）：');
  dagFails.forEach((v) => console.log('  ' + v));
}
if (failed) {
  console.log('\n结果: 0 passed, 1 failed');
  process.exit(1);
}
console.log('PASS 判据单一真值：' + RULES.length + ' 条规则在归属层内均有命中，归属层外零复写，v1 模型词汇零残留');
console.log('PASS 依赖图不变式：' + dagMeta.join('；'));
console.log('结果: 1 passed, 0 failed');
