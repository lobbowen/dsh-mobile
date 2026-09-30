'use strict';

// 发布触发条件门（债表 DS-17 · docs/adr/0011 §1）。
//
// 为什么要有这条：ADR-0011 说「发布由人打的带版本号 tag 决定」，而这句话在收口前只由
// 「谁调用上传宿主」那份集合相等钉住 —— 它管得住新增链路，管不住**已有链路的投递步丢掉
// `if:`**。fast-apk 的 Publish 步一旦不再要求 tag，合并到 main 就又自动出包，而所有现存门禁
// 照样全绿 —— 那正是 DS-14/DS-16 整条取证链的起点（发布不是决定，是副作用）。
//
// 盯的是不变量不是写法：每个投递宿主的调用点必须处在一个「分支推送不可能为真」的条件下
// （step 或 job 的 if: 引用 refs/tags/ 或由 tag 名解出来的那格开关）；解不出条件一律算违规
// （宁可红在新增形状上，也不让它悄悄落回「无条件投递」）。唯一的例外按**结构**认：
// 该 workflow 的 on: 里根本没有 push:（能力件那条只有 dispatch，ADR-0011 §5），不是按文件名放行。
const fs = require('fs');
const path = require('path');
const makeRunner = require('./harness');
const { check, finish } = makeRunner('release-trigger');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const WF_DIR = path.join(ROOT, '.github/workflows');
// 投递宿主 = 会把产物写到设备/门禁可读位置的脚本。新增投递宿主必须在这里登记，
// 否则它的调用点不会被扫（第 ① 条的宿主存在性判据防止这里写成空集）。
// skip 那一格是宿主自己的模式开关：publish-userland-manifest.js 的 --project 只打印投影
// （不签名、不读私钥、不上传），拿它当投递口会让对账轮永远红。
const HOSTS = [
  { host: 'scripts/gh-release-upload.sh', call: /\b(?:bash|node|sh)\b[^\n]*scripts\/gh-release-upload\.sh/ },
  { host: 'scripts/upload-qiniu.js', call: /\b(?:bash|node|sh)\b[^\n]*scripts\/upload-qiniu\.js/ },
  { host: 'scripts/append-apk-receipt.sh', call: /\b(?:bash|node|sh)\b[^\n]*scripts\/append-apk-receipt\.sh/ },
  { host: 'scripts/publish-userland-manifest.js', call: /\b(?:bash|node|sh)\b[^\n]*scripts\/publish-userland-manifest\.js/, skip: /--project/ },
];
// 「这一轮是 tag」的两种真表达：直接比 ref，或比由 tag 名解出来的开关（build-userland 的 resolve）。
const TAGGED = /(refs\/tags\/|needs\.[\w-]+\.outputs\.publish\b)/;

function indentOf(line) { return line.length - line.trimStart().length; }

function sitesOf(src) {
  const out = [];
  let jobCond = null, stepCond = null, stepIndent = -1, inSteps = false;
  src.split('\n').forEach((raw) => {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*(#|\/\/)/.test(line)) return;
    const job = line.match(/^  ([a-zA-Z_][\w-]*):\s*$/);
    if (job) { inSteps = false; stepIndent = -1; jobCond = null; return; }
    if (/^    if:\s*/.test(line) && !inSteps) { jobCond = line.slice(line.indexOf(':') + 1).trim(); }
    if (/^ {4,}steps:\s*$/.test(line)) { inSteps = true; stepCond = null; return; }
    const step = line.match(/^(\s*)-\s/);
    if (step && inSteps) { stepIndent = step[1].length; stepCond = null; }
    if (inSteps && stepIndent >= 0 && /^if:\s/.test(line.trim())
        && indentOf(line) > stepIndent && indentOf(line) <= stepIndent + 8) {
      stepCond = line.trim().slice(3);
    }
    // 只有**命令式调用**算投递点（前面必须有解释器）：`on.push.paths` 里登记宿主名是「改它要重跑」的
// 过滤器，不是投递；而带空格的引用路径（`bash "${{ github.workspace }}/scripts/…"`）仍要算，
// 所以放宽到「同一行里解释器之后出现宿主名」而不是「紧邻一个词」。
    const hit = HOSTS.find((h) => h.call.test(line) && !(h.skip && h.skip.test(line)));
    if (hit) out.push({ host: hit.host, cond: stepCond || jobCond || '' });
  });
  return out;
}

const files = fs.readdirSync(WF_DIR).filter((f) => f.endsWith('.yml')).sort();
const texts = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(WF_DIR, f), 'utf8')]));
const delivering = files.filter((f) => sitesOf(texts[f]).length > 0).sort();

check('① 投递宿主名单非空且每只宿主真实存在（名单写错=整条门空转）',
  HOSTS.length > 0 && HOSTS.every((h) => fs.existsSync(path.join(ROOT, h.host))),
  HOSTS.map((h) => h.host).join(','));
check('② 有投递调用的 workflow 恰好是这五个（新增投递链必须在这里显式登记）',
  JSON.stringify(delivering) === JSON.stringify(['build-apk.yml', 'build-userland.yml',
    'fast-apk.yml', 'pin-capabilities.yml', 'program-ota.yml']), delivering.join(','));

const untagged = Object.fromEntries(delivering.map((f) =>
  [f, sitesOf(texts[f]).filter((s) => !TAGGED.test(s.cond)).map((s) => s.host)]));
const exceptions = delivering.filter((f) => untagged[f].length > 0).sort();
check('③ 唯一的无 tag 条件投递链 = pin-capabilities（按结构认：它的 on: 里没有 push:）',
  JSON.stringify(exceptions) === JSON.stringify(['pin-capabilities.yml']), exceptions.join(','));
check('③b 例外靠结构成立，不靠名字放行：它没有 push 触发，其余四条都有',
  !/^\s{2}push:/m.test(texts['pin-capabilities.yml'])
    && ['build-apk.yml', 'build-userland.yml', 'fast-apk.yml', 'program-ota.yml']
      .every((f) => /^\s{2}push:/m.test(texts[f])),
  'pin=' + !/^\s{2}push:/m.test(texts['pin-capabilities.yml']));
check('④ 每个投递调用点都取得到条件（取不到=判红，不许把「看不清」当成「有条件」）',
  delivering.every((f) => sitesOf(texts[f]).every((s) => s.cond.length > 0
    || f === 'pin-capabilities.yml')),
  JSON.stringify(untagged));

// ── 双向对照组：判据必须既能红也能绿，且扫的是调用而不是文件名 ──────────────────
const BAD = 'on:\n  push:\n    branches: [main]\njobs:\n  build:\n    steps:\n'
  + '      - name: Publish\n        run: bash scripts/gh-release-upload.sh t a.apk\n';
check('对照组 A：投递步丢掉 if: → 必须红',
  sitesOf(BAD).length === 1 && !TAGGED.test(sitesOf(BAD)[0].cond));
check('对照组 B：真实接线（step 级 tag 条件）不误伤',
  sitesOf('on:\njobs:\n  b:\n    steps:\n      - name: P\n        if: startsWith(github.ref, \'refs/tags/os-release-\')\n'
    + '        run: bash scripts/gh-release-upload.sh t a.apk\n')[0].cond.includes('refs/tags/'));
check('对照组 C：job 级由 tag 名解出来的开关同样算条件',
  TAGGED.test(sitesOf('on:\njobs:\n  resolve:\n    x: 1\n  m:\n    if: ${{ needs.resolve.outputs.publish == \'true\' }}\n'
    + '    steps:\n      - name: U\n        run: node scripts/upload-qiniu.js f k\n')[0].cond));
check('对照组 D：只有注释提及宿主名 → 不算调用点（防把说明数成投递口）',
  sitesOf('on:\njobs:\n  b:\n    steps:\n      - name: P\n        run: |\n'
    + '          # bash scripts/gh-release-upload.sh t a.apk\n          echo ok\n').length === 0);
// --project 那一格是宿主的模式开关，不是给某条链开的后门：同宿主去掉这个开关必须照样被扫到。
check('对照组 E：清单发布器不带 --project → 仍算投递点（证明 skip 只认模式，不认链路）',
  sitesOf('on:\njobs:\n  b:\n    steps:\n      - name: M\n        run: node scripts/publish-userland-manifest.js dist release k canary\n').length === 1
    && sitesOf('on:\njobs:\n  b:\n    steps:\n      - name: M\n        run: node scripts/publish-userland-manifest.js dist --project\n').length === 0);
// `on.push.paths` 里登记宿主名的语义是「改了它要重跑」，不是投递；把它数成调用点会让
// 每条 CI 链都落进「有投递」那格，集合相等那条（②）就再也抓不到新增链。
check('对照组 F：paths 白名单里登记宿主名 → 不算调用点（否则每条 CI 链都成了投递链）',
  sitesOf('on:\n  push:\n    paths:\n      - \'scripts/upload-qiniu.js\'\n      - \'scripts/**\'\njobs:\n  a:\n    x: 1\n').length === 0);

finish();
