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

finish();
