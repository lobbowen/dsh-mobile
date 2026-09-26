#!/usr/bin/env node
'use strict';

// 原生件供给门禁：真机上 npm 装不到的 dsh 平台件，每一项必须有归宿；registry 现实一变就红。
//
// 缺这个门禁的代价已经付过一次：dsh 的平台可选依赖按 os/cpu 过滤，真机装不到的那几项
// 只存在于人脑和注释里，于是「libnode 无 RUNPATH 让 run_code 全灭」和「九个平台件没人认领」
// 这类事只能在真机上炸。dsh 还会自升级，升级换依赖时红在 CI 是唯一能提前显形的地方。
//
// 双向对账（与 native-assets 同源的道理）：
//   现场缺、表里没有   ⇒ 红：新原生件无人供给，就是下一次工具静默消失
//   表里有、现场不缺   ⇒ 红：上游补了 android 变体或包已改名，处置记录烂在仓里
// 探针自带对照：npm 忽略平台覆盖配置、输出格式变化、解析出空计划，一律判红，
// 不许把「探针没生效」当成「没有缺口」来绿。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pickHighestVersion } = require('../src/domains/dist');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(ROOT, '..');
const NATIVE_DIR = path.join(ROOT, 'src', 'guard', 'native');
const TABLE_PATH = path.join(NATIVE_DIR, 'supply-table.json');
const REGISTRY = 'https://registry.npmjs.org';
const NPM_TIMEOUT_MS = 300000;
// 投放实现文件名（P-A 之后由表生成，此前先按后缀认）
const IMPL_SUFFIX = /(-shim|-package|-wasm|-prebuild)\.js$/;
// 处置词汇以这里为准：表的 dispositions 只许给这四个词写释义，
// 想加第五种处置，必须先把投放/核验实现做出来并改这里，否则等于口头放行。
const DISP = ['supplied-by-us', 'npm-auto', 'waived', 'runtime-check'];

/** 探针用的 npm 版本：必须与设备上那份同源，见表里 probe.npm.why。 */
function npmVersion() {
  const r = spawnSync('npm', ['--version'], { encoding: 'utf8', timeout: 60000 });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

/**
 * 读回「文件路径#键名」形式的仓内事实源。.sh 取行首 VAR="…"，.json 取顶层键。
 * 设备上那两份运行时的落盘产物（assets/npm/、node 运行时包）都不入库，仓内唯一读得到的
 * 就是钉住它们的声明：投放脚本的 NPM_VER 与 node-versions.json 的 default。表锚只能向它们对账。
 */
function anchoredValue(declared) {
  const m = /^(.+?)#([A-Za-z_][A-Za-z0-9_.]*)$/.exec(String(declared || ''));
  if (!m) return { err: '要写成「文件路径#键名」，现在: ' + JSON.stringify(declared) };
  const [ , rel, key ] = m;
  let src;
  try {
    src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  } catch (e) {
    return { err: '读不到 ' + rel + ': ' + e.code };
  }
  if (rel.endsWith('.json')) {
    let j;
    try {
      j = JSON.parse(src);
    } catch (e) {
      return { err: rel + ' 不是合法 JSON: ' + e.message };
    }
    return j[key] !== undefined ? { version: j[key], from: rel + '#' + key } : { err: rel + ' 里没有键 ' + key };
  }
  const v = new RegExp('^' + key + '="([^"]+)"', 'm').exec(src);
  return v ? { version: v[1], from: rel + '#' + key } : { err: rel + ' 里没有 ' + key + '="…" 赋值（换写法会让核对空转）' };
}

/** 一份 npm 安装计划里的包名集合。npm 的 --dry-run 每行输出 `<动作> <name> <version>`。 */
function npmPlan(flagOs, flagCpu, spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-gate-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"supply-gate-probe","private":true}\n');
  try {
    const r = spawnSync('npm', ['install', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund',
      '--os=' + flagOs, '--cpu=' + flagCpu, spec],
    { cwd: dir, encoding: 'utf8', timeout: NPM_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) return { err: 'npm rc=' + r.status + ' ' + String(r.stderr || '').split('\n').slice(0, 2).join(' | ') };
    const names = new Set();
    for (const line of String(r.stdout || '').split('\n')) {
      const m = /^add (\S+) \S/.exec(line);
      if (m) names.add(m[1]);
    }
    return { names };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let table = null;
try {
  table = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8'));
} catch (e) {
  table = null;
}
check('供给表可读且是合法 JSON', !!table, TABLE_PATH);

if (table) {
  const units = table.units || [];
  check('表已锚定被检 Agent 版本', !!(table.agent && table.agent.package && table.agent.version), JSON.stringify(table.agent || {}));
  check('处置词汇封闭', units.every((u) => DISP.includes(u.disposition)),
    units.filter((u) => !DISP.includes(u.disposition)).map((u) => u.id + '=' + u.disposition).join(', '));
  // 双向：词少了（表用了没释义的词）和词多了（表凭空的释义没实现）都红。
  const glossary = Object.keys(table.dispositions || {});
  const vocGap = DISP.filter((d) => !glossary.includes(d)).concat(glossary.filter((d) => !DISP.includes(d)));
  check('处置释义与词汇表一一对应', vocGap.length === 0, vocGap.join(', '));
  const dup = units.map((u) => u.id).filter((id, i, a) => a.indexOf(id) !== i);
  check('unit id 无重复', dup.length === 0, dup.join(', '));
  const claimed = new Map();
  const collide = [];
  for (const u of units) {
    for (const n of [...(u.hostExcludes || []), ...(u.deviceInstalls || [])]) {
      if (claimed.has(n)) collide.push(n + '（' + claimed.get(n) + ' / ' + u.id + '）');
      else claimed.set(n, u.id);
    }
  }
  check('同一平台件不得被两条处置认领', collide.length === 0, collide.join(', '));
  check('表非空（零条处置等于门禁空转）', units.length > 0, units.length + ' 条');

  for (const u of units) {
    check('处置须写明为什么: ' + u.id, typeof u.why === 'string' && u.why.length >= 20);    if (u.disposition === 'supplied-by-us') {
      check('投放实现文件在场: ' + u.id, !!u.impl && fs.existsSync(path.join(ROOT, u.impl)), u.impl || '（缺 impl）');
    }
    if (u.disposition === 'npm-auto') {
      check('npm-auto 须写明证据: ' + u.id, typeof u.evidence === 'string' && u.evidence.length >= 20);
    }
    if (u.disposition === 'runtime-check') {
      check('runtime-check 必须有可执行判据（不再写「人去真机跑一条命令」）: ' + u.id,
        !!(u.verify && typeof u.verify.node === 'string' && u.verify.node.length >= 20), u.id);
    }
    if (u.disposition === 'waived') {
      const w = u.waiver || {};
      const dates = [w.verifiedAt, w.expiresAt].every((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
      check('豁免须有核验日与到期日: ' + u.id, dates && !!w.followUp, JSON.stringify(w));
      if (dates) {
        check('豁免未过期: ' + u.id + '（' + w.expiresAt + '）', new Date(w.expiresAt + 'T23:59:59Z') >= new Date(),
          '缺口到点未补：补供给，或把不可用如实上屏后改判');
      }
    }
  }

  // ── 能力判据（真机 2026-09-26 定罪的第二结论）───────────────────────────────
  // 投放结局（applied/already/blocked/failed）说的是「我们动过手没有」，不是「用户能不能用」。
  // 案底：sharp 那一格报 applied —— @img/sharp-wasm32 就在依赖树里 —— 而 sharp 自己取不到
  // 绑定（第三方源码 dist/sharp.cjs:103 的 wasm 回退 require 失败后被 :115 的
  // `err.code.endsWith` TypeError 掩盖了真因），read_image 全灭。ADR-0001 P4 当时写的
  // 「图片：已按补真实依赖解决」因此是假结论。判据拆到每格 verify，就是为了下一次不再用
  // 「文件在不在」当「能力通不通」。
  const VERIFY_EXITS = ['node', 'deferred', 'notApplicable'];
  // 被禁的判据形状：以「文件/目录在场」作结论。注意这是**判据层**的禁令，
  // 投放实现里 existsSync 是正当的幂等检查 —— 所以扫的是 verify.node，不是 impl。
  const FILE_SHAPED = /existsSync|statSync|readFileSync|readdirSync|realpathSync|lstatSync/;
  const MARKER = /DSH_PROBE_PASS/;
  let executableCriteria = 0;
  for (const u of units) {
    const v = u.verify;
    if (!v || typeof v !== 'object') {
      check('每格必须有能力判据或明确不核验: ' + u.id, false, 'verify 缺失 —— 供给表退化成「投放=可用」的老口径');
      continue;
    }
    const exits = VERIFY_EXITS.filter((k) => v[k] !== undefined && v[k] !== '' && v[k] !== null);
    check('判据出口唯一（三个键只能给一个）: ' + u.id, exits.length === 1, exits.join('+'));
    if (exits.length !== 1) continue;
    const kind = exits[0];
    if (kind === 'node') {
      executableCriteria++;
      check('判据是可执行判据而非口号: ' + u.id, typeof v.node === 'string' && v.node.length >= 40, String(v.node).length + ' 字');
      check('判据须写明什么算通: ' + u.id, typeof v.criterion === 'string' && v.criterion.length >= 15);
      // 判据不得由「文件在不在」得出 —— 那正是被证伪的那种绿。对照组先行：
      // 正则若连明显的 existsSync 写法都匹配不上，这条规则就是永不红的死规则。
      check('对照组：文件在场判据能命中被禁写法', FILE_SHAPED.test("if (fs.existsSync(target)) process.stdout.write('DSH_PROBE_PASS')"), 'hit');
      const shaped = FILE_SHAPED.exec(v.node);
      check('判据不以文件在场作结论: ' + u.id, !shaped, shaped ? '命中 ' + shaped[0] : '');
      // 空转判据：脚本从不失败（没有 throw / exit(1) 通路）就恒打标记，等于没装锁。
      check('判据有失败出口: ' + u.id, /throw|process\.exit/.test(v.node),
        '没有 throw 也没有非零退出 = 任何状态都算通过');
      check('判据打通过标记: ' + u.id, MARKER.test(v.node));
      const markerCount = (v.node.match(/DSH_PROBE_PASS/g) || []).length;
      check('通过标记只出现一次（多处=有一条路径不打标记也算过）: ' + u.id, markerCount === 1, markerCount + ' 处');
    }
    if (kind === 'deferred') {
      const w = v.deferred || {};
      const dates = [w.verifiedAt, w.expiresAt].every((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
      check('待做判据须有 followUp 与到期日: ' + u.id, dates && !!w.followUp, JSON.stringify(w));
      if (dates) {
        check('待做判据未过期: ' + u.id + '（' + w.expiresAt + '）', new Date(w.expiresAt + 'T23:59:59Z') >= new Date(),
          '挂起到期还没做探针：要么补判据，要么把这条能力如实标为不可用');
      }
    }
    if (kind === 'notApplicable') {
      check('不核验须写明为什么: ' + u.id, typeof v.notApplicable === 'string' && v.notApplicable.length >= 20, u.id);
      // 我们自己在投的件没有「不需要验」这条路 —— 那是把假绿改写成口头豁免。
      check('供给件不得免检: ' + u.id, u.disposition !== 'supplied-by-us',
        'disposition=supplied-by-us 却给 notApplicable');
    }
  }
  // 自证：判据层不能整体空转（若有人把 node 脚本全删成 notApplicable，上面的逐条检查照样全绿）。
  check('至少 5 格有可执行能力判据（否则判据层已空转）', executableCriteria >= 5, executableCriteria + ' 格');
  // 单一真值：通过标记只许住在「定义处」与「表」两处，别处再写一遍就是第二把尺子。
  const markerOwners = ['supply-table.json', 'capability-probe.js'];
  for (const f of fs.readdirSync(NATIVE_DIR)) {
    if (!/\.(js|json)$/.test(f)) continue;
    const src = fs.readFileSync(path.join(NATIVE_DIR, f), 'utf8');
    const hits = (src.match(/DSH_PROBE_PASS/g) || []).length;
    const allowed = markerOwners.includes(f);
    if (allowed) continue;
    check('通过标记不在归属文件之外复写: ' + f, hits === 0, hits + ' 处');
  }
  for (const f of markerOwners) {
    check('标记归属文件确实在打标（零命中=判据接线被拆）: ' + f,
      fs.readFileSync(path.join(NATIVE_DIR, f), 'utf8').includes('DSH_PROBE_PASS'));
  }
  // 接线自证：manager 必须把核验结论作为**第二个**出口摊开（status + 清单），
  // 而不是只存在内存里等人发现。缺任一处 = 结论又在人脑里。
  const mgrSrc = fs.readFileSync(path.join(NATIVE_DIR, 'manager.js'), 'utf8');
  check('manager 有核验入口', /verifyNativeCapabilities\s*\(/.test(mgrSrc), '找不到 verifyNativeCapabilities');
  check('核验结论进 status()', /nativeCaps:/.test(mgrSrc.slice(mgrSrc.indexOf('status()'), mgrSrc.indexOf('/* ═══════ 版本检测'))),
    'status() 未暴露 nativeCaps —— 面板读不到就等于没有第二结论');
  check('核验结论随安装清单落盘', /nativeCaps: caps/.test(mgrSrc), '_recordManifest 未写 nativeCaps');
  // 反向：投放结局不得被写成能力结论（那两个词的语义已经分开，混用即定罪复发）。
  check('投放结局词汇未被扩成能力词', !/status:\s*'(ok|pass|available|working)'/.test(mgrSrc),
    'nativeUnits 里出现能力性 status = 又造了一把尺子');

  // 反向：目录里的投放实现必须都挂在表上 —— 新写垫片不登记就红。
  const impls = fs.readdirSync(NATIVE_DIR).filter((f) => IMPL_SUFFIX.test(f));
  const declared = new Set(units.map((u) => u.impl).filter(Boolean).map((p) => path.basename(p)));
  const orphans = impls.filter((f) => !declared.has(f));
  check('无未登记的投放实现', orphans.length === 0, orphans.join(', '));

  // 反向：manager 里实际跑的投放单元必须与表的 supplied-by-us 集合逐一对应。
  // 为什么按 manager 源码里的字面量取，而不是按 impl 文件名推：单元 id 是结局表
  // （nativeUnits）的键，也是面板/取证读的那把名字 —— 键与表对不上，登记得再全也看不到结局。
  const MANAGER = path.join(NATIVE_DIR, 'manager.js');
  const ms = fs.readFileSync(MANAGER, 'utf8');
  const inCode = (re) => {
    const hits = [];
    let m;
    while ((m = re.exec(ms))) hits.push(m[1]);
    return [...new Set(hits)];
  };
  const mgrUnits = inCode(/_\w*Outcome\(\s*'([a-z0-9-]+)'/g);
  const tableSupplied = units.filter((u) => u.disposition === 'supplied-by-us').map((u) => u.id);
  check('manager 投放单元与表的供给项双向相等',
    mgrUnits.length === tableSupplied.length && mgrUnits.every((u) => tableSupplied.includes(u)),
    'manager ' + mgrUnits.join(', ') + ' / 表 ' + tableSupplied.join(', '));

  // 死词汇：投放实现禁止以容器环境变量 PREFIX 定位能力件。
  // 根因（真机 2026-09-26 定罪）：容器从未导出过这个键，三个单元因此静默 no-op 一整代，
  // rg/pty 投放零日志、glob/grep 与终端全灭。$PREFIX 的唯一事实源是 runtime.json 的 prefix 格。
  // 对照组先行：这条判据若对旧写法零命中，就是一条永不红的死规则。
  check('对照组：环境变量门控判据能命中被禁写法', /env\.PREFIX/.test('if (!process.env.PREFIX) return null;'), 'hit');
  for (const f of ['manager.js'].concat(impls)) {
    const src = fs.readFileSync(path.join(NATIVE_DIR, f), 'utf8');
    check('投放实现不以环境变量 PREFIX 作门控: ' + f, !/env\.PREFIX/.test(src), '命中 env.PREFIX');
  }
  check('对照组：单元 id 抽取判据非空转（认得出全部供给项）', mgrUnits.length === tableSupplied.length && mgrUnits.length >= 5,
    mgrUnits.join(', '));
}

// ---- 现场探针：两份 npm 计划做差集 ----
const anchor = (t) => (t && typeof t.os === 'string' && typeof t.cpu === 'string' ? t : null);
const REF = anchor(table && table.reference);
const HOST = anchor(table && table.host);
check('表锚定了参照平台与被检平台', !!(REF && HOST),
  JSON.stringify({ reference: table && table.reference, host: table && table.host }));
const spec = table && table.agent && table.agent.package && table.agent.version
  ? table.agent.package + '@' + table.agent.version : '';
check('探针安装目标完整（包名@版本）', !!spec, spec || '（无 spec）');
// 探针必须跑在设备那套 node+npm 上，否则答的不是「设备会装什么」。npm 那头是实测过的：runner 自带
// （node v22.23.2 / npm 10.9.8）静默忽略 --os/--cpu，两份计划各 575 项、两侧差集皆空。node 这头本闭包
// 实测 22 与 24 逐字相同，钉它是堵假绿：npm 把 engines 检查用的 nodeVersion 硬编成 process.version，
// optional 依赖不满足即剔除且无视 --engine-strict（arborist build-ideal-tree #checkEngineAndPlatform），
// 于是「某平台件声明 engines >= 新主版本」会让真机装得到、探针装不到。
// 两个版本锚都不许自编：向仓内事实源对账。
const wantNpm = table && table.probe && table.probe.npm && table.probe.npm.version;
const wantNode = table && table.probe && table.probe.node && table.probe.node.version;
const gotNpm = npmVersion();
const gotNode = process.version;
check('探针 npm 版本与表锚一致（设备同源）', !!wantNpm && gotNpm === wantNpm,
  '现场 npm ' + (gotNpm || '(取不到)') + ' / 表锚 ' + wantNpm);
check('探针 node 版本与表锚一致（设备同源）', !!wantNode && gotNode === 'v' + wantNode,
  '现场 node ' + gotNode + ' / 表锚 ' + wantNode);
// 表锚不能是自编的数：必须等于 APK 真投放的那两份运行时 —— 设备上跑的就是它们。
const shipped = anchoredValue(table && table.probe && table.probe.npm && table.probe.npm.shippedBy);
check('表锚 npm = APK 投放的那份', !!wantNpm && !shipped.err && shipped.version === wantNpm,
  (shipped.err || shipped.from + ' = ' + shipped.version) + ' / 表锚 ' + wantNpm);
const devNode = anchoredValue(table && table.probe && table.probe.node && table.probe.node.from);
check('表锚 node = 设备默认运行时那份', !!wantNode && !devNode.err && devNode.version === wantNode,
  (devNode.err || devNode.from + ' = ' + devNode.version) + ' / 表锚 ' + wantNode);
// 探针跑不起来或表缺锚时不许崩在这里：缺口如实记成 FAIL，末尾汇总仍然要打出来。
const ref = REF && spec ? npmPlan(REF.os, REF.cpu, spec) : { err: '缺参照平台锚或安装目标' };
const host = HOST && spec ? npmPlan(HOST.os, HOST.cpu, spec) : { err: '缺被检平台锚或安装目标' };
check('参照平台安装计划可得', !!ref.names, ref.err || '');
check('被检平台安装计划可得', !!host.names, host.err || '');

if (ref.names && host.names && table) {
  check('参照计划规模合理（探针没解析出空集合）', ref.names.size > 100 && host.names.size > 100,
    ref.names.size + ' vs ' + host.names.size);
  // 对照：一个已知按平台分发的包必须在参照侧出现、在被检侧消失、并被换成被检侧变体。
  // 对照组要双向 —— 只查「少了」不查「多了」，npm 若整体罢工也照样绿。
  const ctl = table.probeControl || {};
  check('表带探针对照（缺则无法自证）', !!ctl.referencePackage && !!ctl.hostPackage, JSON.stringify(ctl));
  check('对照成立：参照变体在参照计划中', ref.names.has(ctl.referencePackage), ctl.referencePackage);
  check('对照成立：参照变体不在被检计划中', !host.names.has(ctl.referencePackage));
  check('对照成立：被检变体在被检计划中', host.names.has(ctl.hostPackage), ctl.hostPackage);

  const missing = [...ref.names].filter((n) => !host.names.has(n)).sort();
  const extra = [...host.names].filter((n) => !ref.names.has(n)).sort();
  const declaredEx = new Set(table.units.flatMap((u) => u.hostExcludes || []));
  const declaredDev = new Set(table.units.flatMap((u) => u.deviceInstalls || []));

  const unhandled = missing.filter((n) => !declaredEx.has(n));
  check('真机装不到的包全部有处置', unhandled.length === 0, '未登记: ' + unhandled.join(', '));
  const staleEx = [...declaredEx].filter((n) => !missing.includes(n));
  check('无陈旧的差集处置', staleEx.length === 0, '现场已不缺或已消失: ' + staleEx.join(', '));
  const unrecorded = extra.filter((n) => !declaredDev.has(n));
  check('真机额外装上的包全部有登记', unrecorded.length === 0, '未登记: ' + unrecorded.join(', '));
  const staleDev = [...declaredDev].filter((n) => !extra.includes(n));
  check('无陈旧的 deviceInstalls 处置', staleDev.length === 0, staleDev.join(', '));

  const waived = table.units.filter((u) => u.disposition === 'waived').map((u) => u.id);
  const supplied = table.units.filter((u) => u.disposition === 'supplied-by-us').map((u) => u.id);
  console.log('\n差集：真机不装 ' + missing.length + ' 项 / 真机额外装 ' + extra.length
    + ' 项（探针 node ' + gotNode + ' + npm ' + gotNpm + '）');
  console.log('处置：供给 ' + supplied.length + ' 项（' + supplied.join(', ') + '）；缺口 ' + waived.length + ' 项（' + waived.join(', ') + '）');
}

// ---- 版本判据与内核共用同一实现（不许有第二份「设备装哪个版本」） ----
(async () => {
  const pkg = table && table.agent && table.agent.package;
  if (pkg) {
    try {
      const res = await fetch(REGISTRY + '/' + encodeURIComponent(pkg), {
        headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(20000),
      });
      const j = await res.json();
      const live = pickHighestVersion(Object.values(j['dist-tags'] || {}), Object.keys(j.versions || {}));
      check('表锚定的版本 = 设备真会装的版本', live === table.agent.version,
        'registry 现在给 ' + live + '，表写 ' + table.agent.version + '：闭包须重探');
    } catch (e) {
      check('registry 版本可达', false, e.message);
    }
  } else {
    check('版本比对需要表里的包名锚', false, '表缺 agent.package，未比对 registry');
  }
  const failed = results.filter((x) => !x);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
