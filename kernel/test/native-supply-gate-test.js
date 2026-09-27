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
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { pickHighestVersion } = require('../src/domains/dist');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const ROOT = path.join(__dirname, '..');

/** impl 路径解析：内核内相对优先，其次仓内相对（C 的实现在 APK 侧，不在内核里）。 */
function implPath(u) {
  const inKernel = path.join(ROOT, u.impl);
  if (fs.existsSync(inKernel)) return inKernel;
  return path.join(ROOT, '..', u.impl);
}const REPO_ROOT = path.join(ROOT, '..');
const NATIVE_DIR = path.join(ROOT, 'src', 'assembler');
const TABLE_PATH = path.join(NATIVE_DIR, 'supply-table.json');
const REGISTRY = 'https://registry.npmjs.org';
const NPM_TIMEOUT_MS = 300000;
// 投放实现文件名（P-A 之后由表生成，此前先按后缀认）
const IMPL_SUFFIX = /(-shim|-package|-wasm|-prebuild)\.js$/;
// 处置词汇以这里为准：表的 dispositions 只许给这四个词写释义，
// 想加第五种处置，必须先把投放/核验实现做出来并改这里，否则等于口头放行。
const DISP = ['supplied-by-us', 'npm-auto', 'waived', 'runtime-check', 'seed'];

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
      check('投放实现文件在场: ' + u.id, !!u.impl && fs.existsSync(implPath(u)), u.impl || '（缺 impl）');
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
      // 判据是数据，CI 从不执行它（它跑在设备上），于是连解析都没人做过：一个括号写错的格子
      // 到设备上只会读成 false/null，把「判据自己坏了」误报成「能力坏了」。
      check('对照组：语法检查能命中坏判据',
        (() => { try { new vm.Script("process.stdout.write('"); return false; } catch (e) { return true; } })());
      let syntaxErr = null;
      try { new vm.Script(v.node); } catch (e) { syntaxErr = e.message; }
      check('判据语法可解析: ' + u.id, !syntaxErr, syntaxErr || '');
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

  // D2：平台件库 —— 回答**「上游按什么名字/位置找它」**，本体不在此（2026-09-27 按 ADR-0009 校正）。
  //   本体（bits）归 B 种子 / C 内容 / npm 树；落位规则与能力判据归 E（本目录的 supply-table.json）。
  const D2_DIR = path.join(ROOT, 'src', 'd2');
  check('D2 平台件库在场（pieces.json + artifacts.js）',
    fs.existsSync(path.join(D2_DIR, 'pieces.json')) && fs.existsSync(path.join(D2_DIR, 'artifacts.js')), 'kernel/src/d2/');
  check('D2 不再住 E 的目录（assembler/platform-artifacts.js 必须已迁走）',
    !fs.existsSync(path.join(NATIVE_DIR, 'platform-artifacts.js')), 'assembler/ 里还有 D2 的文件');
  let d2 = null;
  try { d2 = JSON.parse(fs.readFileSync(path.join(D2_DIR, 'pieces.json'), 'utf8')); } catch (_e) { d2 = null; }
  check('D2 件清单是合法 JSON 且有 pieces', !!(d2 && Array.isArray(d2.pieces) && d2.pieces.length >= 3), '');
  if (d2) {
    for (const p of d2.pieces) {
      check('D2 件须写明身份与上游期望: ' + p.id,
        ['id', 'upstream', 'delivery', 'placedAt'].every((k) => typeof p[k] === 'string' && p[k].length > 0),
        JSON.stringify(p).slice(0, 120));
      check('D2 件须有版本/哈希格（null = 未固化）: ' + p.id, 'version' in p && 'sha256' in p);
    }
    const d2ids = d2.pieces.map((p) => p.id);
    check('D2 件 id 无重复', d2ids.length === new Set(d2ids).size, d2ids.join(','));
    // 对账：带 libName 的 D2 件必须出现在「随包能力件清单」（生成物）—— 知识一处、投递一处，两边不许漂移。
    const capsPath = path.join(ROOT, '..', '.github', 'native-capabilities.txt');
    const caps = fs.existsSync(capsPath) ? fs.readFileSync(capsPath, 'utf8') : '';
    check('D2 对账的对照组：随包清单在场（判据不得恒空）', caps.length > 0, 'native-capabilities.txt');
    for (const p of d2.pieces) {
      if (!p.libName) { check('D2 非原生件须写明投递方式: ' + p.id, p.delivery === 'npm-tree', p.delivery); continue; }
      check('D2 件与随包清单对账（' + p.libName + '）', caps.indexOf(' ' + p.libName + ' ') >= 0, '件清单里找不到 ' + p.libName);
    }
  }
  check('manager 经 D2 解析 rg/pty 工件（不再自拼 $PREFIX 路径）',
    /platformArtifacts\.resolve\(ctx, 'rg'\)/.test(mgrSrc) && /platformArtifacts\.resolve\(ctx, 'pty'\)/.test(mgrSrc) &&
      /require\('\.\.\/d2\/artifacts'\)/.test(mgrSrc),
    'manager 未接 D2');

  // ── C 层：共享开发环境清单（与上面「dsh 的平台件差集」分开，语义不同）──
  // 为什么单列：开发环境是**一层**（共享、与产品无关），它的完整度要能被机器读出来；
  // 缺件要如实登记（含到期豁免），而不是等 agent 跑到一半才发现「这台没有 git」。
  const envUnits = table.envUnits || [];
  check('C 层环境清单非空（开发环境是一等层，不许空转）', envUnits.length > 0, envUnits.length + ' 条');
  const envDup = envUnits.map((u) => u.id).filter((id, i, a) => a.indexOf(id) !== i);
  check('C 层 unit id 无重复', envDup.length === 0, envDup.join(', '));
  check('C 层处置词汇封闭（与平台件同一词汇表）', envUnits.every((u) => DISP.includes(u.disposition)),
    envUnits.filter((u) => !DISP.includes(u.disposition)).map((u) => u.id + '=' + u.disposition).join(', '));
  for (const u of envUnits) {
    check('C 层须写明能力: ' + u.id, typeof u.capability === 'string' && u.capability.length >= 4, u.capability || '(缺)');
    // 归属层词表：seed=底座种子(B) / shared=共享供给(C) / d1=Linux 语义兑现(D1) / d2=Android 平台件库(D2)。
// 为什么必须扩：D1 的两格原先只能借 shared 表达 —— 那不是它们的家，面板按归属维分组也分不出来
//（真机 2026-09-28 用户复核：「这些东西位置都不对」）。
const LAYERS = ['seed', 'shared', 'd1', 'd2'];
check('C 层须写明归属层（seed=B种子 / shared=C共享 / d1=Linux语义 / d2=平台件库）: ' + u.id, LAYERS.indexOf(u.layer) >= 0, u.layer);
    check('C 层须写明为什么: ' + u.id, typeof u.why === 'string' && u.why.length >= 20);
    const v = u.verify || {};
    const shapes = ['node', 'deferred', 'notApplicable', 'delegated'].filter((k) => v[k] !== undefined);
    check('C 层每格须有唯一核验出口: ' + u.id, shapes.length === 1, shapes.join('+') || '(缺 verify)');
    if (v.delegated) {
      // 判据随件下发 ⇒ 发布侧必须真的有这件判据（本地文件，不依赖网络）。
      const toolName = String(u.id).replace(/^env-/, '');
      let crit = null;
      try { crit = (JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'scripts', 'userland-verify.json'), 'utf8')).criteria || {})[toolName]; } catch (_e) { crit = null; }
      check('随件判据须在发布侧在册: ' + u.id, !!(crit && typeof crit.node === 'string' && crit.node.length >= 20),
        crit ? 'ok' : 'scripts/userland-verify.json 里没有 ' + toolName);
    }
    if (u.disposition === 'supplied-by-us') {
      check('C 层供给件须有在场 impl: ' + u.id, !!u.impl && fs.existsSync(implPath(u)), u.impl || '（缺 impl）');
      check('C 层供给件不得免检: ' + u.id, !v.notApplicable, 'supplied-by-us 却给 notApplicable');
    }
    if (u.disposition === 'runtime-check') {
      check('C 层 runtime-check 须有可执行判据: ' + u.id, typeof v.node === 'string' && v.node.length >= 40, '判据缺失或过短');
    }
    if (u.disposition === 'waived') {
      const w = u.waiver || {};
      const dates = [w.verifiedAt, w.expiresAt].every((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
      check('C 层豁免须有核验日与到期日: ' + u.id, dates && !!w.followUp, JSON.stringify(w));
      if (dates) check('C 层豁免未过期: ' + u.id + '（' + w.expiresAt + '）', new Date(w.expiresAt + 'T23:59:59Z') >= new Date());
    }
  }
  // C 层供给实现必须**语法可解析**：它只在设备上跑，CI 此前从不解析它 —— 一个括号写错的 impl
  // 会一路走到真机才炸，而那时的表现是「工具没装上」，排查方向被带偏一整轮。
  check('对照组：语法检查能命中坏文件',
    (() => { try { new vm.Script('function {'); return false; } catch (e) { return true; } })());
  for (const impl of [...new Set(envUnits.map((u) => u.impl).filter(Boolean))]) {
    const p = path.join(ROOT, impl);
    // 实现已搬到 APK 侧且是 Kotlin/Android 原生 —— JS 语法解析对它无意义，跳过（不是放过：在场性与形状另有判据）。
    const __isJs = String(impl).endsWith('.js');
    if (!__isJs) { /* 非 JS 实现不解析 */ } else
    let parseErr = null;
    try { new vm.Script(fs.readFileSync(p, 'utf8'), { filename: impl }); } catch (e) { parseErr = e.message; }
    check('C 层供给实现语法可解析: ' + impl, !parseErr, parseErr || '');
  }
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
// ── 口径对账：定稿的运行时/工具清单 ↔ 登记表每格（防「位置漂了」再发生）────────────
// 由来（2026-09-28 用户复核）：我把 npm 摆进种子组、把 shell 写成 runtime、把 node/go/java 的 layer
//   写成 seed —— 与 docs/contracts/layout.json 的 C.shape 明文口径冲突，且与登记表自己第 386 行
//   的定义自相矛盾。这条规则把口径变成机检：清单里每一项都必须在册、且 kind 对得上。
// 匹配容错：文档写 python，格是 env-python3/bin=python3 —— 按前缀认，不要求逐字相同。
try {
  const layout = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'docs', 'contracts', 'layout.json'), 'utf8'));
  const shape = String((((layout.deliveryLayers || {}).C) || {}).shape || '');
  const grab = (label) => {
    const i = shape.indexOf(label + '（');
    if (i < 0) return null;
    const j = shape.indexOf('）', i);
    if (j < 0) return null;
    return shape.slice(i + label.length + 1, j).split('·').map((s) => s.trim()).filter(Boolean);
  };
  const runtimes = grab('运行时');
  const tools = grab('工具');
  check('口径：C.shape 能解析出运行时与工具清单', !!runtimes && !!tools && runtimes.length > 0 && tools.length > 0, JSON.stringify({ runtimes, tools }));
  const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'assembler', 'supply-table.json'), 'utf8'));
  const units = (table.envUnits || []);
  const cellOf = (name) => units.find((u) => (u.bin && String(u.bin).indexOf(name) === 0) || u.id === 'env-' + name);
  for (const n of (runtimes || [])) {
    const u = cellOf(n);
    check('口径对账 · 运行时在册且 kind=runtime: ' + n, !!u && u.kind === 'runtime', u ? ('kind=' + u.kind) : '缺格');
  }
  for (const n of (tools || [])) {
    const u = cellOf(n);
    check('口径对账 · 工具在册且 kind=tool: ' + n, !!u && u.kind === 'tool', u ? ('kind=' + u.kind) : '缺格');
  }
  const shell = units.find((u) => u.id === 'env-shell');
  check('口径对账 · shell 是底座种子（seed/seed）不是运行时', !!shell && shell.kind === 'seed' && shell.layer === 'seed', shell ? (shell.kind + '/' + shell.layer) : '缺格');
} catch (e) { check('口径对账 · 规则自身可执行', false, e.message); }
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
