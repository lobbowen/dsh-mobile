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
//   反向：在任一业务层文件抄一句 `dpm.isDeviceOwnerApp(packageName)` → 本测试必须 FAIL；
//         在 ui/PairingProbeService.kt 写 `val h = host ?: "127.0.0.1"` → 必须 FAIL；
//         在 ui/ 或 bridge/ 别处再写一遍 `"android.settings.WIRELESS_DEBUGGING_SETTINGS"` → 必须 FAIL。
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
  {
    // 真机案底（spec §7③）：这个 action 在 ColorOS/PLP120 上根本没有 Activity 响应，
    // 于是「先问系统能不能解析、不能就退开发者选项页」这件事只许存在一处。别处再抄一遍
    // 就是第二把尺子 —— 两处对同一个 action 做不同降级，跳页行为会随调用点漂移。
    // pattern 取带引号的字面量形态：注释里提到 action 名（无反引号前缀）不算复写。
    name: '无线调试深链 action',
    re: /"android\.settings\.WIRELESS_DEBUGGING_SETTINGS"/,
    owners: ['capability/CapabilityNavigation.kt'],
    why: '深链落点与它的降级判定只在 CapabilityNavigation 声明一次',
  },
  {
    // 端口读数的来源必须唯一：服务类型串抄两份，就会出现「一处 browse pairing、另一处
    // 判 connect」这种永远对不上的在册判定。常量住 MdnsWatcher，消费者引它。
    name: 'mDNS 服务类型字面量',
    re: /"_adb-tls-(pairing|connect)\._tcp"/,
    owners: ['bridge/MdnsWatcher.kt'],
    why: '两个服务类型只在 MdnsWatcher 声明一次（TYPE_PAIRING / TYPE_CONNECT）',
  },
  {
    // 真机定罪（2026-09-26「我把这个 APP 打开了就崩了」）：运行时的「重启」动作实现是
    // destroy 当前实例。它一旦被开场/能力层的取法链引用，用户点开界面就可能亲手拆掉正在
    // 跑的内核再等 30s。死活动作只许住在实现它的服务与诊断页兜底按钮里，判据层不得引用。
    name: '运行时重启动作的归属',
    re: /\bACTION_RESTART\b/,
    owners: ['runtime/NodeRuntimeService.kt', 'MainActivity.kt'],
    why: '运行时的死活归监督链（ContainerSupervisor + :node 自家 boot 循环）；开场界面只给「看启动日志」，不给拆内核的按钮',
  },
  {
    // 报告 2026-09-26 §六1 的病根就是「guest 里 npm 的落点有两把尺子」：内核按
    // npm_config_prefix 装、容器按 .npmrc 钉、shell 里看到的却是只读的 /data/app/*/lib。
    // 目录名只许住 NodeProvisioner（内核侧那份同名事实由
    // kernel/test/npm-contract-chain-test.js 逐字对账，不是第二把尺子）。
    name: 'npm 全局前缀目录名',
    re: /"\.npm-global"/,
    owners: ['runtime/NodeProvisioner.kt'],
    why: '.npmrc 与 npm root -g 必须指向同一个目录名，第二处字面量=第二把尺子',
  },
  {
    // node 二进制在哪 = 一个事实，且它带着随重装变号的 /data/app/~~<随机段>。
    // 谁再自己拼一次 "libnode.so"，那次拼接就不会跟着重装走（真机案底：旧路径
    // 变死路径 → ENOENT 冷静期死循环）。要路径就问 NativeAssetRegistry.NODE。
    name: 'node 二进制的文件名',
    re: /"libnode\.so"/,
    owners: ['native/NativeAssetRegistry.kt'],
    why: 'libnode.so 的落点只在 NativeAssetRegistry 登记，其余各处经 resolve() 取',
  },
  {
    // K2 定罪（2026-09-26 真机报告）：半包判据与暂存判据各有两个消费方（下载器写、
    // 自检与开机清扫读）。字面量抄第二遍的那一方不会跟着改名走 —— 于是清扫器永远
    // 扫不到尸体（files/kernel/0.1.0-android.12.tmp-* 长期驻留），自检把设计内的
    // 可续传半包读成"没有"。命名与判据同源，改名必须一处改完。
    name: '下载半包后缀',
    re: /"\.part"/,
    owners: ['kernelota/ResumableDownloader.kt'],
    why: '半包命名只在 ResumableDownloader.PART_SUFFIX 声明一次，自检/清扫一律问 isPartialFile',
  },
  {
    // 同上：建名方（KernelInstaller）与认名方（开机清扫、installedVersions 排除）必须
    // 共用一个 infix。两侧各写一遍 = 一次安装失败留下的尸体没人认领，还被当成候选版本。
    name: '安装暂存目录 infix',
    re: /"\.tmp-"/,
    owners: ['kernelota/KernelManager.kt'],
    why: '暂存命名只在 KernelManager.STAGING_INFIX 声明一次，建名/认名都由它派生',
  },
  {
    // BORN 判据的落盘名：写端（:node boot 循环入口）与认端（:main 监督者）各写一遍字面量，
    // 改一边就得到"永远没出生"的假空壳 —— 于是监督者会把健康内核反复清账重建。
    name: ':node 出生标记文件名',
    re: /"node\.birth"/,
    owners: ['lifecycle/ContainerSupervisor.kt'],
    why: '出生标记命名只在 ContainerSupervisor.NODE_BIRTH_FILE 声明一次，:node 经 nodeBirthFile() 取路径',
  },
];

// 零容忍写法：不是「v1 词汇」而是**已定罪的假动作**，在任何地方（含注释）出现即失败。
// 裸回环字面量（引号里不带端口）在配对路径上只有一个用途 —— 伪造一个「看着像地址」的
// 回落，把「mDNS 没发现」伪装成「配对失败」，用户于是对着一个从没存在过的端口重试。
// 真内核控制面/探针的写法一律带端口（"http://127.0.0.1:<port>/..."），所以不会误伤。
const FORBIDDEN = [
  {
    name: '伪造的配对端点',
    re: /"127\.0\.0\.1"/,
    why: '端口不在册就不发起配对（PairingProbeService.handleCode 直接返回并说明原因）',
    sample: 'val host = (pairingHost ?: "127.0.0.1")!!',
  },
];

// 已删除的 v1 判据模型词汇：任何地方（含注释）再出现即失败 —— 判据模型只允许一套。
const DEAD = [
  { name: 'v1 段状态机类型', re: /\bPipelineState\b|\bPipelineProbe\b|\bPipelineReadings\b/ },
  { name: 'v1 读数字段名', re: /\badbPaired\b|\blastPairError\b/ },
  { name: 'v1 凭据判据出口', re: /\bisPaired\s*\(/ },
  // 「能静默办就不问用户」曾被用来把保活锚（无障碍 / 通知读取）排除出开屏冲刺。
  // 那是循环依赖：没有锚 → :main 被冻结清理 → 那条静默通道永远等不到（真机 2026-09-26
  // 「锁屏之后 App 被清理掉」）。锚现在由登记表的 keepAliveAnchor 位推导，函数不许复活。
  { name: 'v1 冲刺排除逻辑', re: /\bsilentLater\s*\(/ },
  // 进程外复活边（周期任务）在 2026-09-26 被用户拍板否决：复活回来的只是壳 ——
  // 内核重启时把 running/pending 一律判 failed（kernel/src/platform/tasks.js 的 _load），
  // 而复活后的通知还会写「运行时在线」，等于把打断伪装成没打断。本产品是单链路
  // 「不许被杀」，被杀后的正解是定罪（ResidencyAudit），不是再拽一次。
  // 这套词汇（含注释）任何地方再出现即失败：想回到多链路兜底，先改这条判据并给出理由。
  { name: '被否决的进程外复活边', re: /\bSelfHeal\b|SelfHealJobService|JobScheduler|JobService|JobInfo|BIND_JOB_SERVICE|setPeriodic\s*\(/ },
  // 空壳 :node（真机 2026-09-26 定罪）的第一版"修复"是监督者在复活路径上向 :node 补投一条
  // start 命令 —— 用户否决：那是拿重试伪装正常，把跨层职责倒过来糊。正解是 :node 在
  // onCreate 自己出生 + 监督者按 BORN 判据把非法态清账重建（见下方出生链结构性判据）。
  // 这条补投写法（含注释里的示例）任何地方再出现即失败：要回到那套，先改本条并给理由。
  { name: '监督者向 :node 补投 start 命令', re: /startService\(\s*Intent\([^)]*NodeRuntimeService/ },
];

// ---- 常驻链的边（真机 2026-09-26 定罪：锁屏后 App 被清 = 这些边一条都不存在）----
// 每条都是「机制存在」的判据：缺一条 = 那条保活边被"顺手重构"掉了，而单测与编译都不会红。
// 因此逐条实名钉死（Kotlin 侧各条边 + manifest 声明一条）：改名/搬家要连同这里一起改，改动即暴露。
const KEEP_ALIVE_EDGES = [
  {
    name: '开屏戳监督者（Application 边）',
    rel: 'NodeContainerApp.kt',
    re: /ContainerSupervisor\.ensureRunning\(/,
    why: '进程一起来就要把常驻链点着，不等用户点开某个页面',
  },
  {
    name: '解锁/亮屏唤醒边',
    rel: 'NodeContainerApp.kt',
    re: /ACTION_USER_PRESENT/,
    why: 'HANS 冻结后的第一条补位：用户解锁 = 立刻重戳监督者（宿主进程还活着，任务还活着）',
  },
  {
    name: '监督者升前台',
    rel: 'lifecycle/ContainerSupervisor.kt',
    re: /startForeground\(/,
    why: 'specialUse 前台服务 + 常驻状态通知，是「锁屏不许被清」的正式形态',
  },
  {
    name: '被杀即定罪：启动先翻旧账',
    rel: 'lifecycle/ContainerSupervisor.kt',
    re: /ResidencyAudit\.auditPreviousExit\(/,
    why: '进程一起来就读上次的收尾情况，不等用户回到界面才发现断了',
  },
  {
    name: '被杀即定罪：活着就盖心跳戳',
    rel: 'lifecycle/ContainerSupervisor.kt',
    re: /ResidencyAudit\.heartbeat\(/,
    why: '没有在册心跳，下次启动无从知道上次活到几点、中断了多久',
  },
  {
    name: '被杀即定罪：正常收尾留 clean 戳',
    rel: 'lifecycle/ContainerSupervisor.kt',
    re: /ResidencyAudit\.markCleanStop\(/,
    why: '缺了它每次重启都会被定罪成「被杀」—— 定罪本身就会变成假信息',
  },
  {
    name: '被杀即定罪：结论上屏（与通知同源）',
    rel: 'ui/OnboardingActivity.kt',
    re: /ResidencyAudit\.interruption\(/,
    why: '打断必须可见：首页与常驻通知读同一份文案，两处不许各说各话',
  },
  {
    name: 'manifest 声明 specialUse 前台类型',
    relPath: 'container/app/src/main/AndroidManifest.xml',
    re: /foregroundServiceType="specialUse"/,
    why: 'Kotlin 侧 startForeground 与 manifest 类型必须同时存在，缺一边运行时直接抛异常',
  },
];


// ---- DAG 不变式（spec §2.1 规则 2/3 + onboarding-flow-spec §3 规则 4）。这段用**文本级**
// 判据：剥注释 → 定位登记表区间 → 按条目锚点切段 → 解析 requires 符号表。
// 区间与切段都是自证的一部分：整文件计数会把 init 校验块里的 `c.requires` 引用
// 和 perm() 条目的边错归到别的 capability 上，那样门禁会「带着错归属」通过。----
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

// 登记表正文区间：`val ALL … = listOf(` 到与之配对的右括号（逐字符数深度，字符串字面量整体跳过）。
// 为什么要限定区间：剥注释后 `perm()` 取法链与 init 校验块里也带 `requires` 字样，
// 把整文件当登记表会把不属于自己的边错归到最后一条能力上（区间切分因此必须先定边界）。
function catalogSpan(code) {
  const head = code.indexOf('val ALL');
  if (head < 0) return null;
  const open = code.indexOf('listOf(', head);
  if (open < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return { from: open, to: i };
      if (depth < 0) return null;
    }
  }
  return null;
}

// requires 里的符号可以是本表常量，也可以是 `PermissionCatalog.X`（权限 id 的事实源在权限表）。
function resolveToken(tok, consts, permCatalogText, from, unresolved) {
  let m = tok.match(/^PermissionCatalog\.([A-Z][A-Z_0-9]*)$/);
  if (m) {
    const v = permValue(m[1], permCatalogText);
    if (v === null) unresolved.push(from + ' 的 requires 符号 PermissionCatalog.' + m[1] + ' 在 PermissionCatalog 无定义');
    return v;
  }
  m = tok.match(/^([A-Z][A-Z_0-9]*)$/);
  if (!m) { unresolved.push(from + ' 的 requires 项写法漂移：' + JSON.stringify(tok) + '（既非常量也非 PermissionCatalog.X）'); return null; }
  if (consts[m[1]] === undefined) { unresolved.push(from + ' 的 requires 符号 ' + m[1] + ' 无常量定义'); return null; }
  return consts[m[1]];
}

// 按锚点切段：Capability(id = X, …) 与 perm(PermissionCatalog.Y, …) 各算一条。
// 用「就近上一条 id =」归属会漏 —— perm() 条目没有 `id =` 行，它的 requires 会落到上一条。
function parseDag(catalogText, permCatalogText) {
  const code = stripKotlinComments(catalogText);
  const consts = {};
  for (const m of code.matchAll(/const val ([A-Z_]+)\s*=\s*"([^"]+)"/g)) consts[m[1]] = m[2];
  const span = catalogSpan(code);
  const edges = [];
  const unresolved = [];
  const anchors = [];
  if (!span) return { consts, edges, unresolved, anchors, optionalIds: new Set(), declared: 0, outside: 0, spanOk: false };
  const inSpan = (i) => i >= span.from && i < span.to;
  for (const m of code.matchAll(/\bid\s*=\s*([A-Z][A-Z_0-9]*)\b/g)) {
    if (inSpan(m.index) && consts[m[1]] !== undefined) anchors.push({ at: m.index, id: consts[m[1]] });
  }
  for (const m of code.matchAll(/\bperm\(\s*PermissionCatalog\.([A-Z][A-Z_0-9]*)/g)) {
    if (!inSpan(m.index)) continue;
    const v = permValue(m[1], permCatalogText);
    anchors.push({ at: m.index, id: v || 'UNRESOLVED:' + m[1], permSym: m[1] });
  }
  anchors.sort((a, b) => a.at - b.at);
  const reqRe = /\brequires\s*=\s*setOf\(([^)]*)\)/g;
  let used = 0;
  const optionalIds = new Set();
  for (let i = 0; i < anchors.length; i++) {
    const start = anchors[i].at;
    const end = i + 1 < anchors.length ? anchors[i + 1].at : span.to;
    const body = code.slice(start, end);
    const cur = anchors[i].id;
    if (/\boptional\s*=\s*true/.test(body)) optionalIds.add(cur);
    for (const mr of body.matchAll(reqRe)) {
      used++;
      const rs = [];
      for (const raw of mr[1].split(',')) {
        const tok = raw.trim();
        if (tok === '') continue;
        const v = resolveToken(tok, consts, permCatalogText, cur, unresolved);
        if (v !== null) rs.push(v);
      }
      edges.push({ from: cur, to: rs });
    }
  }
  const declaredAll = (code.match(/\brequires\s*=\s*setOf\(/g) || []).length;
  return { consts, edges, unresolved, anchors, optionalIds, declared: declaredAll, outside: declaredAll - used, spanOk: true };
}

// requires 出现次数必须在解析结果里全额复现 —— 少一条 = 写法变了而解析器漏了，
// 门禁会「带着零违规」通过，那是最坏情况，所以按 FAIL 处理。
function checkDag(catalogText, permCatalogText) {
  const notes = [];
  const { consts, edges, unresolved, anchors, optionalIds, declared, outside, spanOk } = parseDag(catalogText, permCatalogText);
  notes.push('requires 声明 ' + declared + ' 处 / 解析出边 ' + edges.length + ' 条');
  if (!spanOk) notes.push('FAIL 定位不到登记表区间（val ALL … listOf( 或其右括号）—— 下面所有 DAG 判据失去覆盖面');
  if (declared === 0) notes.push('FAIL 登记表里一条 requires 都没有 —— DAG 约束不存在，门禁无覆盖');
  if (edges.length !== declared) notes.push('FAIL 解析漏边（声明 ' + declared + ' ≠ 解析 ' + edges.length + '）：写法漂移，门禁需跟进');
  if (outside > 0) notes.push('FAIL 有 ' + outside + ' 处 requires 写在登记表条目区间之外（取法链/init 里的引用不是边）');
  if (unresolved.length) notes.push('FAIL requires/id 符号解析失败：\n  ' + unresolved.join('\n  '));
  const ghostPerms = anchors.filter((a) => a.permSym && a.id.startsWith('UNRESOLVED:'));
  for (const a of ghostPerms) notes.push('FAIL perm() 引用 PermissionCatalog.' + a.permSym + ' 但在 PermissionCatalog 无定义');

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
  // 规则 4（onboarding-flow-spec §3）：S0 死锁的复发病根是「通知权限登记在 S2，
  // 而配对入口在 S0」。配对没有通知栏输码就根本没有入口 —— 所以 adb-credentials 的
  // 硬前置里必须实名带着 post_notifications。写回 S2 或整条删掉，本门禁必须红。
  const notif = permValue('POST_NOTIFICATIONS', permCatalogText);
  const cred = consts.ADB_CREDENTIALS;
  if (!notif || !cred) {
    notes.push('FAIL 解析不到 post-notifications / adb-credentials 的 id，规则 4 失去对象');
  } else {
    const req = (byFrom.get(cred) || []);
    if (!req.includes(notif)) notes.push('FAIL ' + cred + ' 的 requires 不含 ' + notif + '（无通知 = 无输码入口 = S0 死锁复发）');
    for (const must of [consts.DEV_OPTIONS, consts.WIRELESS_DEBUG]) {
      if (!req.includes(must)) notes.push('FAIL ' + cred + ' 的 requires 不含 ' + must + '（配对前必须先开开发者环境）');
    }
    const notifEdge = byFrom.get(notif);
    if (notifEdge && notifEdge.length) {
      notes.push('FAIL ' + notif + ' 自带 requires（' + notifEdge.join(',') + '）：首启授权冲刺不能被自己的前置锁死');
    }
  }
  const permCount = anchors.filter((a) => a.permSym).length;
  if (permCount === 0) notes.push('FAIL 登记表里没有任何 perm() 能力 —— 解析失效');
  notes.push('能力条目 ' + anchors.length + ' 条（含 perm 权限 ' + permCount + ' 项），optional ' + optionalIds.size + ' 项：' +
    [...optionalIds].sort().join(','));
  notes.push('配对前置实名为 ' + notif + '：' + ((byFrom.get(consts.ADB_CREDENTIALS) || []).join(',')));
  return notes;
}

const violations = [];
const deadHits = [];
const forbiddenHits = [];
const ownedCount = new Map(RULES.map((r) => [r.name, 0]));
// 通知 id → 声明它的地方。多进程同属一个包，通知命名空间是**共享**的：两处用同一个 id，
// 后 notify 的那条会把前一条顶掉（真机案底：监督者一度选到桥的 1002，症状「桥活着但通知不见了」）。
const notifIds = new Map();
let scannedFiles = 0;

function scanFile(abs, relPkg) {
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return; }
  scannedFiles++;
  // 只认「通知 id 常量」：名字以 NOTIF / NOTIF_ID 结尾（NOTIFY_MS 这类时长常量不算，
  // 否则会拿 20_000L 的前缀 20 冒充 id 参与撞号判断）。
  for (const mm of text.matchAll(/\b([A-Z0-9_]*NOTIF(?:_ID)?)\s*=\s*(\d+)(?![\d_])/g)) {
    if (!notifIds.has(mm[2])) notifIds.set(mm[2], []);
    notifIds.get(mm[2]).push(relPkg + ':' + mm[1] + '=' + mm[2]);
  }
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
    for (const f of FORBIDDEN) {
      if (f.re.test(line)) forbiddenHits.push(f.name + ' → ' + relPkg + ':' + (i + 1) + ' | ' + line.trim().slice(0, 120));
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

// 常驻链四条边：逐条读文件验「机制还在」。文件读不到 = 边被删了，直接 FAIL。
const edgeFails = [];
for (const edge of KEEP_ALIVE_EDGES) {
  const where = edge.relPath || edge.rel;
  const abs = edge.relPath ? path.join(ROOT, edge.relPath) : path.join(PKG, edge.rel);
  let text = null;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { /* 缺失由下面报 FAIL */ }
  if (text === null) edgeFails.push(edge.name + ' → 读不到 ' + where + '（' + edge.why + '）');
  else if (!edge.re.test(text)) edgeFails.push(edge.name + ' → ' + where + ' 里找不到 ' + edge.re + '（' + edge.why + '）');
}
// 自证：边表本身不许空转（一条都没有 = 判据被删干净而门禁还在「零违规」）。
if (KEEP_ALIVE_EDGES.length < 4) edgeFails.push('常驻链边表只剩 ' + KEEP_ALIVE_EDGES.length + ' 条（<4）—— 边被删了，门禁失去覆盖面');
const dupNotif = [...notifIds.entries()].filter(([, where]) => where.length > 1);
if (notifIds.size < 4) edgeFails.push('全仓只扫到 ' + notifIds.size + ' 个通知 id 常量（<4）—— 命名变了，唯一性检查失去覆盖面');

// DAG 不变式单独取证：登记表原文 + 权限目录原文（判权限 id 是否真有定义）。
const catalogText = fs.readFileSync(path.join(PKG, CATALOG_REL), 'utf8');
const permCatalogText = fs.readFileSync(path.join(PKG, PERM_CATALOG_REL), 'utf8');
const dagNotes = checkDag(catalogText, permCatalogText);
const dagFails = dagNotes.filter((n) => n.startsWith('FAIL'));
const dagMeta = dagNotes.filter((n) => !n.startsWith('FAIL'));

const vacuous = RULES.filter((r) => ownedCount.get(r.name) === 0)
  .map((r) => r.name + '（归属范围内零命中 → ' + r.why + '）');

// 零容忍规则反过来不自证一次就会「永远零命中」地空转：正则写坏了没人知道，等于没装锁。
// 所以每条 FORBIDDEN 自带一段必然命中的样本写法，匹配不上就是正则错。
const blank = FORBIDDEN.filter((f) => !f.re.test(f.sample))
  .map((f) => f.name + ' 的正则连自身样本 "' + f.sample + '" 都匹配不上 → pattern 写坏了');

// ---- 出生链（真机 2026-09-26 定罪「空壳 :node」）----
// 为什么这一组不许用整文件正则计数：`scheduleBootLoop()` 在 onStartCommand 里本来就有一次调用，
// 整文件计数在"出生只挂在 onStartCommand"的旧写法下照样绿 —— 那是空转门禁。
// 所以按**函数体**取证：定位函数签名 → 花括号配对切正文 → 只在正文里找该在的调用。
function skipKotlinString(text, qi) {
  if (text[qi + 1] === '"' && text[qi + 2] === '"') {
    const end = text.indexOf('"""', qi + 3);
    return end < 0 ? text.length : end + 2;
  }
  for (let j = qi + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === '"') return j;
  }
  return text.length;
}
// 切函数正文：从签名的左花括号到与之配对的右花括号（跳过字符串/字符/注释里的花括号）。
function kotlinBlock(text, sigRe) {
  const m = sigRe.exec(text);
  if (!m) return null;
  let i = text.indexOf('{', m.index + m[0].length - 1);
  if (i < 0) return null;
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { i = skipKotlinString(text, i); continue; }
    if (c === "'") { const e = text.indexOf("'", i + 1); i = e < 0 ? text.length : e; continue; }
    if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue; }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(m.index, i + 1); }
  }
  return null;
}
// 切**签名段**（匹配起点到左花括号之前）：参数表里的不变量（如判据的入参维度）不在正文里，
// 用 kotlinBlock 取正文去查必然查不到 —— 那是假红，也是空转。
function kotlinHead(text, sigRe) {
  const m = sigRe.exec(text);
  if (!m) return null;
  const open = text.indexOf('{', m.index + m[0].length - 1);
  return open < 0 ? null : text.slice(m.index, open);
}

const BIRTH_LINK_CHECKS = [
  {
    name: ':node 在 onCreate 自出生（谁创建我，我都出生）',
    rel: 'runtime/NodeRuntimeService.kt',
    sig: /override fun onCreate\s*\(\s*\)\s*\{/,
    need: /scheduleBootLoop\s*\(\s*\)/,
    // 自证：同一段正文里必然存在的另一句 —— 提取器截断/错位时它就不在，判据立刻 FAIL 而不是空转。
    proof: /writeNodePidFile\s*\(\s*\)/,
    why: 'BIND_AUTO_CREATE 复活只跑 onCreate，ROM 的 cached-kill 之后不会重投 start 命令 —— 出生挂在 onStartCommand 上就得到"进程在、内核从没起"的空壳',
  },
  {
    name: 'boot 循环入口盖出生标记（BORN 写端）',
    rel: 'runtime/NodeRuntimeService.kt',
    sig: /private fun bootLoop\s*\(\s*\)\s*\{/,
    need: /writeNodeBirthMark\s*\(\s*\)/,
    why: '监督者的 BORN 判据要有读得到的事实：循环一跑就落本进程 pid，否则空壳与健康内核无从区分',
  },
  {
    name: '监督者把 BORN 事实喂进判据（读端接线）',
    rel: 'lifecycle/ContainerSupervisor.kt',
    sig: /private val tick: Runnable/,
    // 只钉不变量「decide 的参数里有 born」，不钉 positional 写法：改成具名实参、换参数顺序
    // 都不该红（那是实现细节）；把 born 整条摘掉才红（那才是本门禁要守的）。
    need: /decide\([^)]*\bborn\b/,
    proof: /birthMarkMatches\(/,
    why: 'born 不进判据 = 三态退化成 POWER 一维，空壳继续被误判成健康（本门禁要抓的就是这个）',
  },
  {
    name: '出生标记文件由单一常量源给出（读写不得各拼字面量）',
    rel: 'lifecycle/ContainerSupervisor.kt',
    sig: /companion object/,
    need: /fun nodeBirthFile\(/,
    proof: /NODE_BIRTH_FILE\s*=\s*"node\.birth"/,
    why: '写端（:node）与认端（:main）共用同一取径；两边各拼一遍文件名 = 一次改名就得到永久"没出生"的假空壳',
  },
  {
    name: 'BORN 是判据签名的一等输入（不许退回 POWER 单维）',
    rel: 'lifecycle/NodeWatchdogPolicy.kt',
    sig: /fun decide\(/,
    part: 'head',
    need: /born: Boolean/,
    proof: /pidRecordAgeMs: Long/,
    why: '空壳（进程在、boot 循环没跑）与卡死、断连是三件事，判据缺 BORN 维就会把第一件判成健康',
  },
  {
    name: '空壳态进常驻通知的状态出口',
    rel: 'lifecycle/ContainerSupervisor.kt',
    sig: /private fun statusLine\s*\(\s*\)\s*:\s*String\s*\{/,
    need: /运行时未出生/,
    why: '不许把空壳写成"运行时在线"：状态不真是本产品唯一对用户的承诺',
  },
];

const birthFails = [];
for (const c of BIRTH_LINK_CHECKS) {
  const abs = path.join(PKG, c.rel);
  let text = null;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { /* 缺失下面报 FAIL */ }
  if (text === null) { birthFails.push(c.name + ' → 读不到 ' + c.rel); continue; }
  const body = c.part === 'head' ? kotlinHead(text, c.sig) : kotlinBlock(text, c.sig);
  if (body === null) { birthFails.push(c.name + ' → ' + c.rel + ' 里定位不到' + (c.part === 'head' ? '签名段 ' : '函数体 ') + c.sig + '（签名写法变了，判据失去覆盖面）'); continue; }
  if (c.proof && !c.proof.test(body)) { birthFails.push(c.name + ' → ' + c.rel + ' 的函数体提取自证失败（连必然在的 ' + c.proof + ' 都没了 = 提取截断）'); continue; }
  if (!c.need.test(body)) birthFails.push(c.name + ' → ' + c.rel + ' 的函数体内找不到 ' + c.need + '（' + c.why + '）');
}
// 反向自证：判据必须**能红**。给一段"出生只挂在 onCreate 之外"的样本正文，提取器要能切出它、
// 且判据必须判它不合格 —— 两头都对不上才是可用的门禁（只验正样本 = 正则写坏也照样绿）。
const RED_PROOF_SRC = 'class X {\n override fun onCreate() {\n super.onCreate()\n promoteToForeground()\n writeNodePidFile()\n }\n}\n';
const redBlock = kotlinBlock(RED_PROOF_SRC, BIRTH_LINK_CHECKS[0].sig);
const birthBlank = [];
if (redBlock === null) birthBlank.push('出生链提取器连样本都切不出 → kotlinBlock 写坏了');
else if (/scheduleBootLoop\s*\(\s*\)/.test(redBlock)) birthBlank.push('出生链判据形同虚设：负样本（onCreate 里没有 scheduleBootLoop）竟被判为合格');

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
if (forbiddenHits.length) {
  failed = true;
  console.log('FAIL 零容忍写法（已定罪的假动作）重新出现：');
  forbiddenHits.forEach((v) => console.log('  ' + v));
}
if (vacuous.length) {
  failed = true;
  console.log('FAIL 门禁规则空转（归属范围内一条都没命中 = 判据已被改名/删除而门禁没跟上，规则失去覆盖面）：');
  vacuous.forEach((v) => console.log('  ' + v));
}
if (blank.length) {
  failed = true;
  console.log('FAIL 零容忍规则形同虚设（正则连自己的样本都匹配不上）：');
  blank.forEach((v) => console.log('  ' + v));
}
if (birthFails.length) {
  failed = true;
  console.log('FAIL 出生链断了（真机 2026-09-26 定罪「空壳 :node」：rebind 复活出来的进程从没跑过 boot 循环）：');
  birthFails.forEach((v) => console.log('  ' + v));
}
if (birthBlank.length) {
  failed = true;
  console.log('FAIL 出生链判据形同虚设（自证双向失败）：');
  birthBlank.forEach((v) => console.log('  ' + v));
}
if (dagFails.length) {
  failed = true;
  console.log('FAIL 依赖图不变式被破坏（spec §2.1 规则 2/3）：');
  dagFails.forEach((v) => console.log('  ' + v));
}
if (edgeFails.length) {
  failed = true;
  console.log('FAIL 常驻链的边被拆掉了（真机 2026-09-26 定罪「锁屏后 App 被清理」）：');
  edgeFails.forEach((v) => console.log('  ' + v));
}
if (dupNotif.length) {
  failed = true;
  console.log('FAIL 通知 id 撞号（同包多进程共享一套通知命名空间，后 notify 顶掉前一条）：');
  dupNotif.forEach(([id, where]) => console.log('  id ' + id + ' → ' + where.join(' | ')));
}
if (failed) {
  console.log('\n结果: 0 passed, 1 failed');
  process.exit(1);
}
console.log('PASS 判据单一真值：' + RULES.length + ' 条规则在归属层内均有命中，归属层外零复写，v1 模型词汇零残留');
console.log('PASS 依赖图不变式：' + dagMeta.join('；'));
console.log('PASS 常驻链：' + KEEP_ALIVE_EDGES.length + ' 条边全在位；通知 id ' + notifIds.size + ' 个全仓唯一');
console.log('PASS 出生链：' + BIRTH_LINK_CHECKS.length + ' 处按函数体/签名段取证全在位（写端 onCreate 自出生 → 出生标记落盘 → 判据 BORN 维 → 读端接线 → 状态出口），负样本判为不合格');
console.log('结果: 1 passed, 0 failed');
