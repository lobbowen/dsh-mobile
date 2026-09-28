'use strict';
// Lob OS 单一事实源门禁（v4 架构重写版）。
//
// 为什么重写：旧版按 :node 双进程 / ContainerConsole / NodeWatchdogPolicy / Device Owner 断言，
// 这些对象已按 v4 全部删除或改名 —— 旧门禁在"空转"与"报错"两边同时失效（0 passed / 1 failed）。
// 新版只断言**当前架构下仍有意义**的不变式，且每条规则都做**覆盖面自证**：
// 扫描范围为空 = 判据失去对象 = 直接 FAIL（防止规则悄悄空转）。
//
// 退役规则（旧 → 新/原因）：
// - BORN/出生标记/rebind 监督链 → 对象已删除（单进程化，:node 不再是 Android 进程）
// - Device Owner 回读与下发 → 产品已整体退出 DO（新规则 R2 反向禁止其回潮）
// - KernelManager 暂存命名/通知 id 唯一性（4 个 id 的老判据）→ 单 FGS/单通知后失去对象

const fs = require('fs');
const path = require('path');

function findRoot(start) {
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'docs', 'contracts', 'layout.json'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error('repo root not found above ' + start);
}
const ROOT = findRoot(__dirname);
const APP = path.join(ROOT, 'container', 'app');
const ENGINE = path.join(ROOT, 'container', 'engine');

function walk(dir, out) {
  out = out || [];
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    if (e.name === 'node_modules' || e.name === 'build' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const appFiles = walk(APP);
const engineFiles = walk(ENGINE);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

const fails = [];
const passes = [];
function rule(name, scanned, fn) {
  if (!scanned) { fails.push(name + '：覆盖面为空（门禁空转）'); return; }
  const bad = fn() || [];
  if (bad.length) fails.push(name + '：' + bad.slice(0, 5).join(' / '));
  else passes.push(name + '（覆盖 ' + scanned + ' 项）');
}

// R1 单一生命周期：单进程、单前台服务、无 watchdog/DO 遗留文件
rule('R1 单一生命周期', appFiles.length, () => {
  const bad = [];
  const mf = path.join(APP, 'src', 'main', 'AndroidManifest.xml');
  if (/(android:process\s*=)/.test(read(mf))) bad.push('AndroidManifest 仍有 android:process');
  // 稳态只允许宿主一个 FGS；**会话型** FGS（截屏的 mediaProjection）不算第二生命周期，
  // 但必须①在 Manifest 声明类型 ②不与宿主同通知 id（细则见 R7）。
  const sf = appFiles.filter((f) => f.endsWith('.kt') && /startForeground\s*\(/.test(read(f)));
  const host = sf.filter((f) => /OsHostService\.kt$/.test(f));
  if (host.length !== 1) bad.push('宿主 FGS 不唯一（startForeground 文件：' + sf.map(rel).join(',') + '）');
  const sess = sf.filter((f) => !/OsHostService\.kt$/.test(f));
  if (sess.length > 1) bad.push('会话型 FGS 多于一个：' + sess.map(rel).join(','));
  if (sess.length && !/foregroundServiceType="mediaProjection"/.test(read(mf))) bad.push('会话型 FGS 未声明 mediaProjection 类型');
  const leftovers = appFiles.filter((f) => /(NodeWatchdogPolicy|DeviceAdminReceiver)/.test(path.basename(f)));
  if (leftovers.length) bad.push('遗留文件：' + leftovers.map(rel).join(','));
  return bad;
});

// R2 Device Owner 彻底退出（OS 代码不得回潮）
rule('R2 DO 已退出', appFiles.length, () => {
  const pat = /(DeviceOwner|Device Owner|set-device-owner|\bdpm\b|device_policy|setKiosk|LockTask)/;
  return appFiles.filter((f) => /\.(kt|xml|js)$/.test(f) && pat.test(read(f))).map(rel);
});

// R3 能力令牌单源：桥/判据不得手写能力表达式（只许读 BridgeTokens/CapabilityCriteria）
rule('R3 能力令牌单源', appFiles.length, () => {
  const bad = [];
  const broker = read(path.join(APP, 'src/main/java/lobos/bridge/CapabilityBroker.kt'));
  if (!/BridgeTokens/.test(broker)) bad.push('CapabilityBroker 未使用 BridgeTokens');
  if (/isDeviceOwnerApp/.test(broker)) bad.push('CapabilityBroker 仍在回读 DO');
  const crit = read(path.join(APP, 'src/main/java/lobos/capability/CapabilityCriteria.kt'));
  if (/isDeviceOwnerApp|dpcComponent\s*=\s*"[^"]+"/.test(crit)) bad.push('CapabilityCriteria 仍回读 DO');
  return bad;
});

// R4 契约接线诚实性：未实现必须显式（-32002 / implemented=false），且缺口落 METHOD-GAPS.md
rule('R4 接线诚实性', appFiles.length, () => {
  const bad = [];
  const broker = read(path.join(APP, 'src/main/java/lobos/bridge/CapabilityBroker.kt'));
  if (!/CODE_NOT_IMPLEMENTED/.test(broker)) bad.push('缺 CODE_NOT_IMPLEMENTED');
  if (!/OS_METHODS/.test(broker)) bad.push('缺 OS_METHODS 分发层');
  const notImpl = (broker.match(/notImplemented\(/g) || []).length;
  if (notImpl < 1) bad.push('未实现项未走 notImplemented');
  const gaps = path.join(APP, 'src/main/java/lobos/os/METHOD-GAPS.md');
  if (!fs.existsSync(gaps)) bad.push('缺 METHOD-GAPS.md');
  return bad;
});

// R5 Program OTA 命名单源：program-* 不得被旧名替换
rule('R5 OTA 命名单源', appFiles.length + engineFiles.length, () => {
  const pat = /(kernel\.json|files\/kernel|kernel\/\$?\{?version|kernel-[a-z0-9])/;
  const scope = appFiles.concat(engineFiles).filter((f) => /\.(kt|js|json|xml)$/.test(f));
  return scope.filter((f) => pat.test(read(f))).map(rel);
});


// R6 契约形状对齐：契约 §2 的方法名必须都在 Kotlin 侧登记，且关键结果键真实出现
// （防「方法登记了但形状漂移」——面板按契约取字段会拿到 undefined）。
rule('R6 契约形状对齐', appFiles.length, () => {
  const bad = [];
  const contract = path.join(ROOT, 'docs', 'components', 'console-system-api.md');
  if (!fs.existsSync(contract)) return ['缺契约文件 docs/components/console-system-api.md'];
  const c = read(contract);
  const broker = read(path.join(APP, 'src/main/java/lobos/bridge/CapabilityBroker.kt'));
  const gaps = read(path.join(APP, 'src/main/java/lobos/os/METHOD-GAPS.md'));
  // 反引号里可能并列多个方法名（如 `os.runtime.get/status`）：按名字逐个提取，别要求整段就是一个名字。
  const methods = [...new Set([...c.matchAll(/`([^`]+)`/g)]
    .flatMap((m) => m[1].split(/[^A-Za-z0-9_.]+/))
    .filter((s) => /^os\.[a-z]+\.[A-Za-z]+$/.test(s)))];
  for (const m of methods) if (!broker.includes('"' + m + '"') && !gaps.includes(m)) bad.push('未登记: ' + m);
  // 关键结果键（契约 §2 的结果列）必须真的出现在 Kotlin 里
  for (const k of ['sessionState', 'modules', 'capacity', 'gseq', 'topTypes', 'uptimeMs', 'degraded', 'exported', 'updateAvailable']) {
    if (!broker.includes('"' + k + '"')) bad.push('结果键缺失: ' + k);
  }
  // 三向对账（复检 AUD-G38）：Kotlin 登记项 ∈ 契约 ∪ METHOD-GAPS；未实现项必须在缺口表里
  const kotlinKeys = [...broker.matchAll(/"((?:[a-z][\w]*\.)+[a-z][\w]*)"\s+to\s+MethodDef/g)].map((m) => m[1]);
  const bridgeDoc = read(path.join(ROOT, 'docs', 'contracts', 'bridge-protocol.md'));
  for (const k of kotlinKeys) {
    if (k.startsWith('os.')) {
      if (!c.includes(k) && !gaps.includes(k)) bad.push('os.* 既不在契约也不在缺口表: ' + k);
    } else if (!bridgeDoc.includes(k) && !c.includes(k)) {
      bad.push('非 os.* 方法未在 bridge-protocol.md / 契约登记: ' + k);
    }
  }
  for (const m of broker.matchAll(/notImplemented\("([^"]+)"\)/g)) {
    if (!gaps.includes(m[1])) bad.push('未实现但缺口表未登记: ' + m[1]);
  }
  return bad;
});


// R7 生命周期完整性（契约要求的三道门禁，复检 AUD-G25）
rule('R7 生命周期完整性', appFiles.length, () => {
  const bad = [];
  const kt = appFiles.filter((f) => f.endsWith('.kt'));
  // ① 稳态只能有一个 FGS（宿主）；允许**至多一个**会话型 FGS（截屏），且必须在 Manifest 声明类型
  const sf = kt.filter((f) => /startForeground\s*\(/.test(read(f)));
  const hostSf = sf.filter((f) => /OsHostService\.kt$/.test(f));
  const otherSf = sf.filter((f) => !/OsHostService\.kt$/.test(f));
  if (hostSf.length !== 1) bad.push('宿主 FGS 必须在且仅在 OsHostService 转前台');
  if (otherSf.length > 1) bad.push('会话型 FGS 多于一个: ' + otherSf.map(rel).join(','));
  const manifest = read(path.join(APP, 'src/main/AndroidManifest.xml'));
  for (const f of otherSf) {
    const cls = /\/(\w+)\.kt$/.exec(f);
    const name = cls ? cls[1] : '';
    if (!name || !new RegExp('\\.' + '[a-z]+\\.' + name + '|' + name).test(manifest)) bad.push('会话型 FGS 未在 Manifest 声明: ' + name);
    if (!/foregroundServiceType="mediaProjection"/.test(manifest)) bad.push('会话型 FGS 缺 mediaProjection 类型声明');
  }
  // ② 稳态通知 id 与会话通知 id 必须各自唯一且**互不相同**（会话通知不得顶掉常驻通知）
  const idsOf = (f) => [...read(f).matchAll(/NOTIF_ID\s*=\s*(\d+)/g)].map((m) => m[1]);
  const hostIds = hostSf.length ? idsOf(hostSf[0]) : [];
  const sessIds = otherSf.length ? idsOf(otherSf[0]) : [];
  if (hostIds.length !== 1) bad.push('宿主通知 id 常量不是唯一: ' + hostIds.join(','));
  if (otherSf.length && sessIds.length !== 1) bad.push('会话通知 id 常量不是唯一: ' + sessIds.join(','));
  if (hostIds.length && sessIds.length && hostIds[0] === sessIds[0]) bad.push('会话通知 id 与宿主相同（会顶掉常驻通知）: ' + hostIds[0]);
  // ③ ACTION_RESTART 必须有发送点（定义处 + 至少一个发送处）
  const senders = kt.filter((f) => /ACTION_RESTART/.test(read(f)));
  if (senders.length < 2) bad.push('ACTION_RESTART 无发送点（出现文件数 ' + senders.length + '）');
  // ④ 不得对非 Service 类 startService/startForegroundService
  const svc = new Set();
  for (const f of kt) for (const m of read(f).matchAll(/class\s+(\w+)\s*:\s*Service\s*\(/g)) svc.add(m[1]);
  for (const f of kt) {
    const s = read(f);
    // 只认「startService(...Intent(...X::class.java)...)」这一形态：同文件里的其它 Intent 不得误配。
    for (const m of s.matchAll(/start(?:Foreground)?Service\s*\(\s*Intent\s*\([^,]+,\s*(\w+)::class\.java\)/g)) {
      const cls = m[1];
      if (/Activity$/.test(cls)) continue;
      if (!svc.has(cls)) bad.push('对非 Service 类 startService: ' + cls + ' @' + rel(f));
    }
  }
  return bad;
});


// R8 唤醒层（复检 AUD-G22）：联网必须短持 WifiLock；组播锁必须有超时；Doze 兜底必须有投递口。
rule('R8 唤醒层', appFiles.length, () => {
  const bad = [];
  const ota = read(path.join(APP, 'src/main/java/lobos/ota/ProgramOtaUpdater.kt'));
  if (!/PowerLocks\.wifi\(/.test(ota)) bad.push('OTA 联网路径未持 WifiLock');
  const mdns = read(path.join(APP, 'src/main/java/lobos/bridge/MdnsWatcher.kt'));
  // MulticastLock 没有 acquire(timeout)：超时靠 postDelayed 排释放，两种形态都认。
  if (!/acquire\(\s*MULTICAST_LOCK_TIMEOUT_MS\s*\)/.test(mdns) && !/postDelayed\(\s*releaseRunnable\s*,\s*MULTICAST_LOCK_TIMEOUT_MS\s*\)/.test(mdns)) bad.push('MulticastLock 未设超时');
  const manifest = read(path.join(APP, 'src/main/AndroidManifest.xml'));
  if (!manifest.includes('DozeBackstopReceiver')) bad.push('Doze 兜底接收器未声明');
  const os = appFiles.filter((f) => f.endsWith('OsHostService.kt'));
  if (!os.length || !os.some((f) => /DozeBackstop\.schedule\(/.test(read(f)))) bad.push('未排 Doze 兜底');
  return bad;
});


// R9 豁免层（复检 AUD-G21）：厂商省电四项必须有能力项、跳转落点、回执存储与执行器。
rule('R9 豁免层', appFiles.length, () => {
  const bad = [];
  const cat = read(path.join(APP, 'src/main/java/lobos/capability/CapabilityCatalog.kt'));
  // id 字面量在 OemGuards；目录侧以常量引用四条能力（id 与能力项都要在）
  for (const [id, constName] of [
    ['oem-card-lock', 'OemGuards.CARD_LOCK'],
    ['oem-full-background', 'OemGuards.FULL_BACKGROUND'],
    ['oem-freeze-whitelist', 'OemGuards.FREEZE_WHITELIST'],
    ['oem-startup-manager', 'OemGuards.STARTUP_MANAGER'],
  ]) {
    const inGuards = fs.existsSync(path.join(APP, 'src/main/java/lobos/capability/OemGuards.kt'))
      && read(path.join(APP, 'src/main/java/lobos/capability/OemGuards.kt')).includes('"' + id + '"');
    if (!inGuards) bad.push('OemGuards 缺 id: ' + id);
    if (!cat.includes(constName)) bad.push('目录未登记能力项: ' + constName);
  }
  for (const nav of ['NAV_OEM_CARD_LOCK', 'NAV_OEM_FULL_BG', 'NAV_OEM_FREEZE', 'NAV_OEM_STARTUP']) {
    if (!cat.includes(nav)) bad.push('缺导航键: ' + nav);
  }
  const guards = path.join(APP, 'src/main/java/lobos/capability/OemGuards.kt');
  if (!fs.existsSync(guards)) bad.push('缺 OemGuards.kt（回执存储唯一实现）');
  else {
    const g = read(guards);
    if (!/fun confirm\(/.test(g) || !/fun confirmed\(/.test(g)) bad.push('OemGuards 缺 confirm/confirmed');
  }
  const nav = read(path.join(APP, 'src/main/java/lobos/capability/CapabilityNavigation.kt'));
  for (const navKey of ['NAV_OEM_STARTUP', 'NAV_OEM_CARD_LOCK', 'NAV_OEM_FULL_BG', 'NAV_OEM_FREEZE']) {
    if (!nav.includes(navKey)) bad.push('导航未接线: ' + navKey);
  }
  const ev = read(path.join(APP, 'src/main/java/lobos/capability/Evidence.kt'));
  if (!ev.includes('oemGuards')) bad.push('Evidence 缺 oemGuards（判据读不到回执）');
  const runner = read(path.join(APP, 'src/main/java/lobos/capability/CapabilityAcquisitionRunner.kt'));
  if (!runner.includes('EXEC_OEM_CONFIRM')) bad.push('执行器未注册「我已完成」');
  return bad;
});

console.log('capability-single-source-gate (v4)');
for (const p of passes) console.log('  PASS  ' + p);
for (const f of fails) console.log('  FAIL  ' + f);
console.log('结果: ' + passes.length + ' passed, ' + fails.length + ' failed');
process.exit(fails.length ? 1 : 0);
