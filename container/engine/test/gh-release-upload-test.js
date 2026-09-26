'use strict';

// Release 覆盖上传宿主（scripts/gh-release-upload.sh）的行为自测 + 回潮门禁。
//
// ============================================================================
//  为什么要有这个测试
// ============================================================================
//  这一步产出的不是「构建成功」而是「设备能取到新包」。同一句
//  「确保 Release 在 → 覆盖上传 → 看一眼」原先在 fast-apk / build-apk /
//  release-admin(publish、repack、pin) / kernel-ota(归档 + 滚动通道) 各抄了一份，
//  分歧的实际代价是 repack 那份：它把 `file#app-debug.apk` 当改名用，而 gh 的资产名
//  取 file 的 basename（`#` 后面只是 label），于是它**删掉了 app-debug.apk、
//  传上去的是 app-signed.apk** —— latest 的下载地址当场 404，且没有任何一份副本
//  会自查这件事。判据现在只住 scripts/gh-release-upload.sh 一份。
//
//  本文件盯两件事：
//    ① 行为：三档退出、孤立资产回退、发布后逐字节确认、滚动通道清理与 --skip-existing
//       每一条都能被证伪。全部跑在假 gh 上（状态存在临时目录），不碰网络不碰真凭据。
//    ② 回潮：workflow 里不许再出现内联的 `gh release create/upload/delete-asset`。
//
//  「读线上状态」的三档分类与 scripts/read-release-asset.sh 同构（那份管下载，这份管
//  上传）；两边各自 6 行 case 判定，没抽公共层 —— 抽出来只是把两种失败语义绑死。
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const makeRunner = require('./harness');

const { check, finish } = makeRunner('gh-release-upload');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HOST = path.join(ROOT, 'scripts/gh-release-upload.sh');
const WF_DIR = path.join(ROOT, '.github/workflows');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-release-upload-'));
const FLAGS = ['VIEW_ERR', 'VIEW_ABSENT', 'CREATE_FAIL', 'FAIL_CLOBBER', 'FAIL_UPLOAD', 'DELETE_FAIL', 'SPOOF', 'VIEW_JSON_ERR', 'CLOBBER_ERR'];

// 假 gh：行为由环境变量选档，产物状态落在 $ST/assets/ 里。
// VIEW_ERR   网络/权限失败（≠「不存在」）      VIEW_ABSENT  强制报「不存在」
// CREATE_FAIL 建 tag 失败                       FAIL_CLOBBER clobber 一律 404（孤立资产）
// FAIL_UPLOAD 普通上传也失败                    DELETE_FAIL  删旧资产失败
// SPOOF       传上去的是另一份字节（后端截断/替换）
// VIEW_JSON_ERR 事后确认时读不出清单
// CLOBBER_ERR 覆盖失败时报的原文（默认 404=孤立资产；给 5xx 验「不是孤立资产就不许删」）
const STUB = [
  '#!/usr/bin/env bash',
  'sub="$1 $2"',
  'case "$sub" in',
  '  "release view")',
  '    for a in "$@"; do [ "$a" = "--json" ] && sub="release list"; done',
  '    if [ "$sub" = "release list" ]; then',
  '      [ "${VIEW_JSON_ERR:-0}" = 1 ] && { echo "HTTP 500" >&2; exit 1; }',
  '      for p in "$ST"/assets/*; do [ -e "$p" ] || continue; printf \'%s\\t%s\\n\' "${p##*/}" "$(stat -c %s "$p")"; done',
  '      exit 0',
  '    fi',
  '    [ "${VIEW_ERR:-0}" = 1 ] && { echo \'Get "https://api.github.com/": dial tcp: no such host\' >&2; exit 1; }',
  '    if [ "${VIEW_ABSENT:-0}" = 1 ] || [ ! -e "$ST/exists" ]; then echo "release not found" >&2; exit 1; fi',
  '    exit 0 ;;',
  '  "release create")',
  '    [ "${CREATE_FAIL:-0}" = 1 ] && { echo "could not create" >&2; exit 1; }',
  '    : > "$ST/exists"; exit 0 ;;',
  '  "release upload")',
  '    shift 2; f="$2"; shift',
  '    name="${f##*/}"',
  '    clob=0; for a in "$@"; do [ "$a" = "--clobber" ] && clob=1; done',
  '    [ -e "$ST/exists" ] || { echo "release not found" >&2; exit 1; }',
  '    if [ "${FAIL_CLOBBER:-0}" = 1 ] && [ "$clob" = 1 ]; then echo "${CLOBBER_ERR:-HTTP 404: Not Found}" >&2; exit 1; fi',
  '    [ "${FAIL_UPLOAD:-0}" = 1 ] && { echo "upload failed" >&2; exit 1; }',
  '    rm -f "$ST/assets/$name"',
  '    if [ "${SPOOF:-0}" = 1 ]; then printf \'xxxxxxxx\' > "$ST/assets/$name"; else cp "$f" "$ST/assets/$name"; fi',
  '    exit 0 ;;',
  '  "api -X")',
  '    u="${@: -1}"; id="${u##*/}"; nm="${id#*-}"',
  '    [ "${DELETE_FAIL:-0}" = 1 ] && exit 1',
  '    [ -e "$ST/assets/$nm" ] || exit 1',
  '    rm -f "$ST/assets/$nm"; exit 0 ;;',
  '  "api repos"*)',
  '    nm=""',
  '    for a in "$@"; do case "$a" in *\'.name==\'*) nm="${a#*==\\"}"; nm="${nm%%\\"*}" ;; esac; done',
  '    [ -n "$nm" ] || exit 0',
  '    [ -e "$ST/assets/$nm" ] || exit 0',
  '    echo "1-$nm"; exit 0 ;;',
  'esac',
  'echo "STUB: 不认识的 gh 调用: $*" >&2; exit 64',
  '',
].join('\n');

function fixture(flags = {}) {
  const ST = fs.mkdtempSync(path.join(BASE, 'c'));
  fs.mkdirSync(path.join(ST, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(ST, 'assets'), { recursive: true });
  const p = path.join(ST, 'bin', 'gh');
  fs.writeFileSync(p, STUB);
  fs.chmodSync(p, 0o755);
  fs.writeFileSync(path.join(ST, 'pkg.apk'), 'hello-payload\n');
  fs.writeFileSync(path.join(ST, 'version.json'), '{}');
  if (flags.exists) fs.writeFileSync(path.join(ST, 'exists'), '');
  for (const k of FLAGS) {
    if (flags[k] !== undefined) process.env[k] = String(flags[k]);
    else delete process.env[k];
  }
  return { ST, flags };
}
function run(c, args) {
  const env = {
    PATH: path.join(c.ST, 'bin') + ':/usr/local/bin:/usr/bin:/bin',
    GITHUB_REPOSITORY: 'lobbowen/dsh-mobile',
    ST: c.ST,
  };
  for (const k of FLAGS) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  const r = spawnSync('/bin/bash', [HOST, ...args], { encoding: 'utf8', cwd: ROOT, env });
  return { rc: r.status, out: (r.stdout || '') + (r.stderr || ''), ST: c.ST };
}
const detail = (r) => JSON.stringify({ rc: r.rc, out: r.out.slice(0, 160) });
const asset = (c, n) => path.join(c.ST, 'assets', n);

// ---------------------------------------------------------------------------
//  ① 用法档：参数不齐/产物可疑一律退 2，不碰线上
// ---------------------------------------------------------------------------
{
  const cases = [
    ['无参数', [], '参数不齐'],
    ['只有 tag、没有文件', ['apk-latest'], '参数不齐'],
    ['未知选项', ['apk-latest', path.join(fixture().ST, 'pkg.apk'), '--nope'], '不认识的选项'],
  ];
  for (const [label, args, needle] of cases) {
    const r = run(fixture(), args);
    check(`用法：${label} → 2`, r.rc === 2 && r.out.includes(needle), detail(r));
  }
}
{
  const c = fixture();
  const r = run(c, ['apk-latest', path.join(c.ST, 'no-such.apk')]);
  check('用法：要发布的文件不存在 → 2', r.rc === 2 && r.out.includes('不存在'), detail(r));
  const c2 = fixture();
  fs.writeFileSync(path.join(c2.ST, 'zero.bin'), '');
  const r2 = run(c2, ['apk-latest', path.join(c2.ST, 'zero.bin')]);
  check('用法：0 字节产物 → 2（空产物投出去等于把线上资产换成没有）', r2.rc === 2 && r2.out.includes('0 字节'), detail(r2));
  const c3 = fixture();
  const r3 = run(c3, ['apk-latest', path.join(c3.ST, 'pkg.apk'), '--notes', 'a', '--notes-file', path.join(c3.ST, 'version.json')]);
  check('用法：--notes 与 --notes-file 同时给 → 2', r3.rc === 2 && r3.out.includes('只能给一个'), detail(r3));
  const c4 = fixture();
  const env = { PATH: path.join(c4.ST, 'bin') + ':/usr/bin:/bin', ST: c4.ST };
  const r4 = (() => { const rr = spawnSync('/bin/bash', [HOST, 'apk-latest', path.join(c4.ST, 'pkg.apk')], { encoding: 'utf8', cwd: ROOT, env }); return { rc: rr.status, out: (rr.stdout || '') + (rr.stderr || '') }; })();
  check('没有 GITHUB_REPOSITORY → 1（不许把仓库猜成默认值）', r4.rc === 1 && r4.out.includes('GITHUB_REPOSITORY'), detail(r4));
}

// ---------------------------------------------------------------------------
//  ② 线上状态：读不清 ≠ 不存在
// ---------------------------------------------------------------------------
{
  const c = fixture({ VIEW_ERR: 1 });
  const r = run(c, ['apk-latest', path.join(c.ST, 'pkg.apk')]);
  check('view 网络失败 → 1（判成「不存在」就会误建 tag、把重发当首次发布）', r.rc === 1 && r.out.includes('看不清'), detail(r));
}
{
  const c = fixture({ CREATE_FAIL: 1 });
  const r = run(c, ['apk-latest', path.join(c.ST, 'pkg.apk')]);
  check('tag 不存在且创建失败 → 1「本次发布没发生」', r.rc === 1 && r.out.includes('建不出来'), detail(r));
}

// ---------------------------------------------------------------------------
//  ③ 正常路径
// ---------------------------------------------------------------------------
{
  const c = fixture();
  const r = run(c, ['apk-latest', '--title', 'T', '--notes', 'N', path.join(c.ST, 'pkg.apk'), path.join(c.ST, 'version.json')]);
  check('首次发布：创建 + 双文件同批 + 回读确认 → 0',
    r.rc === 0 && r.out.includes('已就位') && fs.existsSync(asset(c, 'pkg.apk')) && fs.existsSync(asset(c, 'version.json')), detail(r));
}
{
  const c = fixture({ exists: true });
  const r = run(c, ['apk-latest', path.join(c.ST, 'pkg.apk')]);
  check('已存在：直接 clobber → 0', r.rc === 0 && r.out.includes('clobber pkg.apk'), detail(r));
}

// ---------------------------------------------------------------------------
//  ④ 孤立资产回退（同名记录在、后端对象 404 —— 2026-09-23 实证）
// ---------------------------------------------------------------------------
{
  const c = fixture({ exists: true, FAIL_CLOBBER: 1 });
  fs.writeFileSync(asset(c, 'pkg.apk'), 'stale\n');
  const r = run(c, ['apk-latest', path.join(c.ST, 'pkg.apk')]);
  check('clobber 404 → 按名删旧记录再普通上传 → 0', r.rc === 0 && r.out.includes('回退为'), detail(r));
}
{
  const c = fixture({ exists: true, FAIL_CLOBBER: 1, DELETE_FAIL: 1 });
  fs.writeFileSync(asset(c, 'pkg.apk'), 'stale\n');
  const r = run(c, ['apk-latest', path.join(c.ST, 'pkg.apk')]);
  check('回退时旧资产删不掉 → 1（不许带着删不掉的记录继续）', r.rc === 1 && r.out.includes('删不掉'), detail(r));
}
{
  const c = fixture({ exists: true, FAIL_CLOBBER: 1, FAIL_UPLOAD: 1 });
  fs.writeFileSync(asset(c, 'pkg.apk'), 'stale\n');
  const r = run(c, ['apk-latest', path.join(c.ST, 'pkg.apk')]);
  check('回退后普通上传也不成 → 1「既覆盖不了也新建不了」', r.rc === 1 && r.out.includes('既覆盖不了也新建不了'), detail(r));
}
{
  // 回退要「先删线上旧记录再传」，删错了就是设备侧的 404，所以只有失败特征对上
  // （404=孤立资产）才许动手。网络抖动/5xx 时报文里没有 404，旧资产必须原地不动。
  const c = fixture({ exists: true, FAIL_UPLOAD: 1, CLOBBER_ERR: 'HTTP 502: Bad Gateway' });
  fs.writeFileSync(asset(c, 'pkg.apk'), 'stale\n');
  const r = run(c, ['apk-latest', path.join(c.ST, 'pkg.apk')]);
  check('覆盖失败但不是孤立资产特征（502）→ 1，且不删不清线上现有资产', r.rc === 1
    && !r.out.includes('回退为') && fs.existsSync(asset(c, 'pkg.apk'))
    && fs.readFileSync(asset(c, 'pkg.apk'), 'utf8') === 'stale\n', detail(r));
}

// ---------------------------------------------------------------------------
//  ⑤ 发布后确认：上传命令退 0 不等于线上真有了
// ---------------------------------------------------------------------------
{
  const c = fixture({ exists: true, SPOOF: 1 });
  const r = run(c, ['apk-latest', path.join(c.ST, 'pkg.apk')]);
  check('线上字节数与本地不符 → 1（后端只收了一半也算没发布）', r.rc === 1 && r.out.includes('≠ 本地'), detail(r));
}
{
  const c = fixture({ exists: true, VIEW_JSON_ERR: 1 });
  const r = run(c, ['apk-latest', path.join(c.ST, 'pkg.apk')]);
  check('确认时读不到清单 → 1（读不出就是没确认，不许报 ok）', r.rc === 1 && r.out.includes('缺失'), detail(r));
}

// ---------------------------------------------------------------------------
//  ⑥ 滚动通道清理与归档只建一次
// ---------------------------------------------------------------------------
{
  const c = fixture({ exists: true });
  const r = run(c, ['apk-latest', path.join(c.ST, 'pkg.apk')]);
  check('基线：先传 pkg.apk', r.rc === 0 && r.out.includes('已就位'), detail(r));
  const zip = path.join(c.ST, 'kernel-9.9.9.zip');
  fs.copyFileSync(path.join(c.ST, 'pkg.apk'), zip);
  fs.writeFileSync(asset(c, 'kernel-1.0.0.zip'), 'old\n');
  const r2 = run(c, ['apk-latest', zip, '--prune', '^kernel-[0-9]']);
  check('--prune 清掉同族旧资产、留下本次（名单自动包含刚传的资产）',
    r2.rc === 0 && r2.out.includes('清理旧资产 kernel-1.0.0.zip')
      && !fs.existsSync(asset(c, 'kernel-1.0.0.zip')) && fs.existsSync(asset(c, 'kernel-9.9.9.zip')), detail(r2));
}
{
  const c = fixture({ exists: true });
  fs.writeFileSync(asset(c, 'kernel-1.2.3.zip'), 'archived\n');
  const r = run(c, ['kernel-1.2.3', path.join(c.ST, 'pkg.apk'), '--skip-existing']);
  check('--skip-existing 且 tag 已在 → 0 且整步不动线上（灰度→生产提升不算错误）',
    r.rc === 0 && r.out.includes('归档只建一次') && !fs.existsSync(asset(c, 'pkg.apk')), detail(r));
  const c2 = fixture();
  const r2 = run(c2, ['kernel-1.2.3', path.join(c2.ST, 'pkg.apk'), '--skip-existing']);
  check('--skip-existing 但 tag 不在 → 照常创建并上传', r2.rc === 0 && r2.out.includes('已就位'), detail(r2));
}

// ---------------------------------------------------------------------------
//  ⑦ 回潮门禁：判据只住 scripts/，workflow 只调用
// ---------------------------------------------------------------------------
{
  const INLINE = /gh\s+release\s+(upload|create|delete-asset)\b/;
  // 双向对照组：旧写法必须被抓，宿主调用与只读 view 不许被抓（否则「零命中」是空转）。
  check('回潮判据自证：仓库里真实出现过的三种写法必被抓',
    INLINE.test('gh release upload "$TAG" "$APK#app-debug.apk" --clobber')
      && INLINE.test('gh release create "$TAG" --repo "$REPO" --title "x"')
      && INLINE.test('gh release delete-asset "$TAG" app-debug.apk --yes'),
    '判据形状与收口前真实写法脱节了');
  check('回潮判据不误伤：宿主调用与只读查询不算内联',
    !INLINE.test('bash scripts/gh-release-upload.sh "$TAG" --title T "$APK"')
      && !INLINE.test('gh release view "$TARGET" --repo "$REPO" --json assets'),
    '判据太宽会把 pin/publish 的只读查询错抓成上传');
  const wfs = fs.readdirSync(WF_DIR).filter((f) => f.endsWith('.yml'))
    .map((f) => [f, fs.readFileSync(path.join(WF_DIR, f), 'utf8')]);
  const inline = wfs.filter(([, t]) => INLINE.test(t)).map(([f]) => f);
  check('workflow 无内联 Release 写操作回潮（上传判据只住宿主）', inline.length === 0, inline.join(','));
  const callers = wfs.filter(([, t]) => /scripts\/gh-release-upload\.sh/.test(t)).map(([f]) => f).sort();
  check('上传宿主被四条链路同调（日常/全量/管理/内核）',
    JSON.stringify(callers) === JSON.stringify(['build-apk.yml', 'fast-apk.yml', 'kernel-ota.yml', 'release-admin.yml']),
    callers.join(','));
  const ko = wfs.find(([f]) => f === 'kernel-ota.yml')[1];
  // 先展平反斜杠续行：这条链路盯的是「同一宿主被调两次、两档政策各自表达」，
  // 政策开关写在哪一行是排版，不是不变量。
  const koFlat = ko.replace(/\\\n\s*/g, ' ');
  check('kernel-ota 的两档政策各自表达：归档 --skip-existing、通道 --prune',
    /gh-release-upload\.sh[^\n]*--skip-existing/.test(koFlat)
      && /gh-release-upload\.sh[^\n]*--prune/.test(koFlat),
    '政策标记丢了就等于把「提升」判成错误');
  const ra = wfs.find(([f]) => f === 'release-admin.yml')[1];
  check('repack 用「改名进临时目录」换资产名（`#` 只改 label 不改名，2026-09-26 的 404 根因）',
    /cp \/tmp\/app-signed\.apk "\$STAGE\/app-debug\.apk"/.test(ra), '又回到 # 后面当改名用，latest 地址会再次 404');
}

finish();
