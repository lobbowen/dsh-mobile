'use strict';

// scripts/check-userland-manifest-drift.js 的判红能力自测 + 回潮门禁。
//
// 为什么要有这个测试（2026-09-30 真机定罪 ENV-26）：aliases 的读写代码合进了 main、CI 全绿，
// 而线上清单仍是 `npm.aliases=null` ⇒ 设备上 `npx` 按真名调不到。**「声明改了没人重发」这件事
// 当时没有任何东西会红**，所以这里先把对照本身判红的能力钉住：每一格都要有一组「线上少它 ⇒ 红、
// 两边一致 ⇒ 绿」的对照，取不到线上更要红（读不到就当清白 = 又一处空转）。
// 最后两条盯 workflow：发布器自己不在 build-userland 的 paths 里（这正是这次分家的入口），
// 且漂移对照必须真的挂在 CI 上 —— 两者少一个，本文件就红。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const makeRunner = require('./harness');

const { check, finish } = makeRunner('userland-manifest-drift');
const stripComments = makeRunner.stripComments;

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CHECKER = path.join(ROOT, 'scripts/check-userland-manifest-drift.js');
const WF = path.join(ROOT, '.github/workflows/build-userland.yml');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-'));
const write = (name, obj) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return p;
};

/** 一件的完整形状（与发布器 toolsFromDist 的格同名），别名/判据都给出，缺哪格就 delete 哪格。 */
const tool = (over) => Object.assign({
  name: 'npm', provider: 'zip', version: '11.19.0',
  url: 'https://cdn/userland/userland-npm-11.19.0-aaaaaaaaaaaa-android-arm64.zip',
  sha256: 'a'.repeat(64), entry: 'bin/npm-cli.js',
  aliases: [{ name: 'npx', entry: 'bin/npx-cli.js' }],
  verify: { criterion: 'node', node: 'x'.repeat(40) },
}, over);

const manifest = (tools) => ({ schema: 1, channel: 'canary', version: '2026.09.29.148', sequence: 1, expiresEpochMs: 2, tools });

function run(localFile, onlineFile) {
  return spawnSync(process.execPath, [CHECKER, localFile, 'canary'], {
    encoding: 'utf8', env: Object.assign({}, process.env, { USERLAND_ONLINE_FILE: onlineFile }),
  });
}

// ① 逐格一致 ⇒ 绿
const same = [tool()];
const localSame = write('local-same.json', same);
const onlineSame = write('online-same.json', manifest(same));
let r = run(localSame, onlineSame);
check('两边逐格一致时退 0', r.status === 0, 'exit=' + r.status + ' out=' + r.stdout.slice(-120));
check('一致时正文报出两侧颗数', /仓内投影 1 颗，线上清单 1 颗/.test(r.stdout), r.stdout.split('\n')[0]);

// ② ENV-26 的真实那一格：线上少 aliases ⇒ 红，且点名到那一格
const onlineNoAlias = write('online-noalias.json', manifest([
  Object.assign({}, tool(), { aliases: undefined }),
]));
r = run(localSame, onlineNoAlias);
check('线上缺 aliases 时判红', r.status === 1, 'exit=' + r.status);
check('红字点名到 npm.aliases 这一格', /npm\.aliases:.*仓内=npx→bin\/npx-cli\.js/.test(r.stdout + r.stderr),
  (r.stdout + r.stderr).split('\n').filter((l) => l.includes('aliases')).join(' | '));

// ③ 线上整颗缺失 / 线上多投 —— 两个方向都要红
r = run(localSame, write('online-empty.json', manifest([])));
check('线上整件缺失时判红', r.status === 1 && /线上整颗缺失/.test(r.stdout), 'exit=' + r.status);
r = run(write('local-one.json', same), write('online-extra.json', manifest([tool(), tool({ name: 'jq', aliases: [] })])));
check('线上多投一件时判红并点名 jq', r.status === 1 && /jq: 线上有而仓内不声明/.test(r.stdout), 'exit=' + r.status);

// ④ 内容变了没重发（sha 那一格）—— 与「重编即新名」同一条纪律的另一半
r = run(localSame, write('online-other-sha.json', manifest([tool({ sha256: 'b'.repeat(64) })])));
check('线上 sha 与仓内不符时点名 npm.sha256', r.status === 1 && /npm\.sha256:/.test(r.stdout), 'exit=' + r.status);

// ⑤ 取不到线上 = 红，不是「无从比较所以算了」（防伪绿）
r = run(localSame, path.join(tmp, 'no-such-file.json'));
check('线上读不到时判红', r.status === 1, 'exit=' + r.status);
check('线上读不到时不说一致', !/一致/.test(r.stdout + r.stderr), (r.stdout + r.stderr).slice(-160));
r = run(localSame, write('online-broken.json', 'not json at all'));
check('线上不是合法 JSON 时判红', r.status === 1, 'exit=' + r.status);
r = run(write('local-empty.json', []), onlineSame);
check('仓内投影为空时判红（空对照不算通过）', r.status === 1, 'exit=' + r.status);

// ⑥ 回潮：发布器与它的入口声明必须在 build-userland 的 paths 里
const wf = stripComments(fs.readFileSync(WF, 'utf8'));
check('paths 覆盖清单发布器', /-\s*'scripts\/publish-userland-manifest\.js'/.test(wf),
  '改发布器不触发任何东西 = ENV-26 那次分家的入口');
check('paths 覆盖入口声明脚本', /-\s*'scripts\/read-userland-entry\.sh'/.test(wf), 'entry 那一格由它给');

// ⑦ 回潮：漂移对照真的挂在 CI 上（跑了、且判红），不是又一个只打印的 curl 自证
check('workflow 里调用漂移对照', /check-userland-manifest-drift\.js/.test(wf), '没有这一步，重发与否没人知道');
check('对照步骤自己判红', /set -euo pipefail/.test(wf) && !/check-userland-manifest-drift\.js[^\n]*\|\| true/.test(wf));

// ── ⑧ `--immutable`：发布前那道闸真的能红（docs/adr/0011 之后 C 层唯一的单调判据）──
// 为什么单列一节：闸门模式与对账模式**判的不是同一件事**（一个比内容格、一个比 revision 单调 +
// 同版本字节），复用上面那些夹具的期望会得出相反结论。每条都要「坏了红 + 合法形状不误伤」两侧读数，
// 否则这就是一把只朝一个方向失效的尺子。
const man = (revision, tools) => Object.assign(manifest(tools), { revision });
function runGate(localFile, onlineFile) {
  return spawnSync(process.execPath, [CHECKER, '--immutable', localFile, 'canary'], {
    encoding: 'utf8', env: Object.assign({}, process.env, { USERLAND_ONLINE_FILE: onlineFile }),
  });
}
const gateOut = (r) => String(r.stdout || '') + String(r.stderr || '');

// ⑧-1 正常前进：线上 revision=5、本次 6，同颗件同 sha ⇒ 必须放行
// （首次按 tag 发布要能过，否则这条链跑不起来 = 判据不能被兑现，见 ADR-0011）
const gAdvance = runGate(write('g-adv.json', man(6, [tool()])), write('g-online5.json', man(5, [tool()])));
check('⑧ revision 前进且同版本没换字节 → 放行', gAdvance.status === 0, gateOut(gAdvance).slice(-200));
check('⑧ 放行时把两侧读数打出来（revision 与颗数），不说清就是又一次「绿得看不懂」',
  /revision 线上=5 本次=6/.test(gateOut(gAdvance)), gateOut(gAdvance).split('\n')[0]);

// ⑧-2 同号再发 / 倒退 —— 这一格是 C 层唯一的「版本号变了没」判据，两侧都要红
const gSame = runGate(write('g-same.json', man(5, [tool({ version: '11.19.1' })])), write('g-online5.json', man(5, [tool()])));
check('⑧ revision 与线上相等 → 判红（同号换内容就是「版本号没说谎的能力没了」）',
  gSame.status === 1 && /revision 不单调/.test(gateOut(gSame)), gateOut(gSame).slice(-220));
const gBack = runGate(write('g-back.json', man(4, [tool()])), write('g-online5.json', man(5, [tool()])));
check('⑧ revision 倒退 → 判红', gBack.status === 1 && /线上已经是 5，本次要发 4/.test(gateOut(gBack)), gateOut(gBack).slice(-220));

// ⑧-3 同 name@version 换字节：清单把旧对象盖掉，而长缓存里的设备仍按旧 sha 核验。
const gSha = runGate(write('g-sha.json', man(6, [tool({ sha256: 'c'.repeat(64) })])), write('g-online5.json', man(5, [tool()])));
check('⑧ 同版本换 sha256 → 判红并点名那颗件',
  gSha.status === 1 && /npm@11\.19\.0 换了字节/.test(gateOut(gSha)), gateOut(gSha).slice(-260));
// 对照组：换了 version 就是**另一颗件**（URL 按版本号命名，不会盖旧对象）—— 不许误伤正常提升。
const gBump = runGate(write('g-bump.json', man(6, [tool({ version: '11.19.1', sha256: 'c'.repeat(64) })])), write('g-online5.json', man(5, [tool()])));
check('⑧ 对照组：件自己提升版本并换字节 → 放行（否则正常的升级会被这道闸拦死）',
  gBump.status === 0, gateOut(gBump).slice(-220));

// ⑧-4 「线上还没有」与「看不清」必须分开（三态纪律，同 read-release-asset.sh 那一条）
const gFirst = runGate(write('g-first.json', man(1, [tool()])), path.join(tmp, 'g-none.json'));
check('⑧ 该键上还没有清单 → 放行并明说这是按新发布连投的第一份（首次投放不能被判红）',
  gFirst.status === 0 && /本次是该通道按新发布连投的第一份/.test(gateOut(gFirst)), gateOut(gFirst).slice(-220));
// 旧形状（本方案之前的清单没有 revision 格）：按下界 0 比，且把这条读数打出来，不静默通过。
const gLegacy = runGate(write('g-legacy.json', man(1, [tool()])), write('g-online-legacy.json', manifest([tool()])));
check('⑧ 线上那份没有 revision 格 → 按 0 计并放行，同时点名「本次之后每份都必须带」',
  gLegacy.status === 0 && /线上那份没有 revision 格/.test(gateOut(gLegacy)), gateOut(gLegacy).slice(-240));
const gBroken = runGate(write('g-adv2.json', man(6, [tool()])), write('g-online-broken.json', 'not json'));
check('⑧ 线上清单读不出 → 判红（看不清就不许投递，绝不降成「没有旧字节」）',
  gBroken.status === 1, gateOut(gBroken).slice(-200));

// ⑧-5 即将上传的那份自己坏掉：revision 非法 / tools 为空 ⇒ 红（闸门的输入也判一次）
for (const [name, rev] of [['缺格', undefined], ['0', 0], ['字符串', '6']]) {
  const bad = write('g-rev-' + name + '.json', Object.assign(manifest([tool()]), rev === undefined ? {} : { revision: rev }));
  const rb = runGate(bad, write('g-online5b.json', man(5, [tool()])));
  check(`⑧ 本次 revision 是${name} → 判红「不是正整数」（不轻信发布器已经写过了）`,
    rb.status === 1 && /revision 不是正整数/.test(gateOut(rb)), gateOut(rb).slice(-200));
}
const gEmpty = runGate(write('g-empty.json', man(6, [])), write('g-online5c.json', man(5, [tool()])));
check('⑧ 本次清单没有件 → 判红（空表不算通过）', gEmpty.status === 1 && /是空的/.test(gateOut(gEmpty)), gateOut(gEmpty).slice(-200));

// ⑧-6 接线：闸门真的排在**清单落盘之后、清单投递之前**，且步骤会判红
// （件本身在 build job 就传上桶了 —— 这一格的职责是「不再让清单把这份覆盖合法化」，次序写死在这里）。
{
  const flat = wf.replace(/\\\n\s*/g, ' ');
  const gateAt = flat.indexOf('check-userland-manifest-drift.js --immutable');
  const uploadAt = flat.search(/node\s+scripts\/upload-qiniu\.js\s+release\/userland-manifest\.json/);
  check('⑧ manifest job 用 --immutable 跑闸门（命令式调用，注释提及不算）', gateAt > 0, '调用行找不到');
  check('⑧ 闸门排在清单上传之前', uploadAt > 0 && gateAt < uploadAt, JSON.stringify({ gateAt, uploadAt }));
  // 对照组：把调用写成注释 → 上面那条必须抓不到（否则「命令式调用」这条是恒真）
  const commented = '  # node scripts/check-userland-manifest-drift.js --immutable release/x.json canary';
  check('⑧ 接线判据自证：只有注释提及 → 抓不到（证明钉的是调用而不是文件名）',
    commented.replace(/\\\n\s*/g, ' ').indexOf('check-userland-manifest-drift.js --immutable') > 0
      && !/^[^\n#]*node\s+scripts\/check-userland-manifest-drift\.js\s+--immutable/m.test(commented),
    '判据把注释也当成调用，将来删掉调用留着注释就不会红');
  // 对账模式（发布后那一步）不许被顺手改成闸门：两模式判据相反，混用会得出相反结论
  check('⑧ 两种模式各有一处调用（漂移对照仍跑发布后，闸门跑发布前）',
    /check-userland-manifest-drift\.js\s+(?!--immutable)/.test(flat) && /--immutable/.test(flat),
    '少一个模式 = 少一道判据');
}

finish();
