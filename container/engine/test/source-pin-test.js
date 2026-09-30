'use strict';

// scripts/fetch-pinned.sh（C 层取上游源码的唯一口）+ scripts/userland-sources.json（钉值表）
// 的判红能力自测 + 回潮门禁。
//
// 为什么要有它（2026-09-30 线上清单与两轮构建现读定罪）：件的 URL 里那 12 位就是件的 sha256，
// 清单与设备钉的都是这一格；而当时构建口写的是「候选 URL 列表，谁先通就用谁」。同一个版本的
// 两条来源本来就是两批字节（实测 zlib 1.3.2：zlib.net 1,502,830 B/bb329a0a… vs GitHub archive
// 1,566,911 B/b99a0b86…），于是**同一 commit 隔 20 分钟跑两轮，curl 件的指纹就从
// 0b9c9f0db078 变成 6fe1addf3d84**；sqlite3 更糟，连「这一件声明的是哪一版」都由下载页现刮决定。
// 后果是 `check-userland-manifest-drift.js` 的两格永远归不了零 —— 红线不是「有人改坏了」，
// 而是「网络那一刻哪条镜像先答」。件的字节身份必须由**仓内声明**决定，不由网络状况决定。
//
// 因此这里判的是**不变量**而不是某一种机制：每个取数口要么走钉值表，要么像 npm/pnpm 那样
// 「取回的字节与仓内声明的哈希比过才继续」（那一格在 ⑤ 里按形状认，不认变量名）。
// 每条静态扫描都要「坏了红 + 合法形状不误伤」两侧读数，否则又是一把只朝一个方向失效的尺子。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const makeRunner = require('./harness');

const { check, finish } = makeRunner('source-pin');
const stripComments = makeRunner.stripComments;

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FETCH = path.join(ROOT, 'scripts/fetch-pinned.sh');
const TABLE = path.join(ROOT, 'scripts/userland-sources.json');
const WF = path.join(ROOT, '.github/workflows/build-userland.yml');
const VERIFY = path.join(ROOT, 'scripts/userland-verify.json');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-pin-'));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ── 假 curl ────────────────────────────────────────────────────────────────
// 本机与 CI 镜像里的 curl 都不受控（CI 镜像**有**真 curl，跟着它跑会让「https 来源走得通」
// 这一档变成运气档），所以自带一颗只认夹具的 curl 并把它排在 PATH 最前。
// 它认 https 与 file 两种 scheme —— 表里每一格钉的都是 https，那条必须真能跑。
const BIN_CURL = path.join(tmp, 'bin-curl');
fs.mkdirSync(BIN_CURL, { recursive: true });
fs.writeFileSync(path.join(BIN_CURL, 'curl'), [
  '#!/usr/bin/env bash',
  'url=""; out=""',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in',
  '    -o|--output) out="${2:-}"; shift 2 ;;',
  '    --max-time) shift 2 ;;',
  '    -*) shift ;;',
  '    *) if [ -z "$url" ]; then url="$1"; fi; shift ;;',
  '  esac',
  'done',
  '[ -n "$out" ] || { echo "stub curl: 没给 -o" >&2; exit 54; }',
  'case "$url" in https://*|file://*) : ;; *) echo "stub curl: scheme 不是 https/file：$url" >&2; exit 33 ;; esac',
  'p=""',
  'if [ -n "${STUB_MAP:-}" ]; then',
  '  while IFS="	" read -r u v; do if [ "$u" = "$url" ]; then p="$v"; break; fi; done <<< "$STUB_MAP"',
  'fi',
  'if [ -z "$p" ]; then case "$url" in file://*) p="${url#file://}" ;; esac; fi',
  '[ -n "$p" ] || { echo "stub curl: $url 没有夹具映射" >&2; exit 22; }',
  '[ -f "$p" ] || { echo "stub curl: 夹具不存在 $p" >&2; exit 22; }',
  'cp "$p" "$out"',
  'exit 0',
  '',
].join('\n'));
fs.chmodSync(path.join(BIN_CURL, 'curl'), 0o755);

// 夹具字节：两批「同一版本号下的不同字节」正是这次定罪的形状。
const BLOBS = path.join(tmp, 'blobs');
fs.mkdirSync(BLOBS, { recursive: true });
const GOOD = Buffer.from('good-source-bytes\n'.repeat(16));
const BAD = Buffer.from('same version, different snapshot, different bytes\n'.repeat(11));
fs.writeFileSync(path.join(BLOBS, 'good.tgz'), GOOD);
fs.writeFileSync(path.join(BLOBS, 'bad.tgz'), BAD);
const SHA_GOOD = sha(GOOD);
const SHA_BAD = sha(BAD);
const F = (n) => 'file://' + path.join(BLOBS, n);
const HTTPS_URL = 'https://mirror.invalid/pkg-7.0.1.tgz';

/** 在独立目录里装一份**真脚本的字节** + 受控的表：宿主按自身位置找表，所以换表就换沙箱。 */
const SCRIPT_SRC = fs.readFileSync(FETCH, 'utf8');
function sandbox(name, table) {
  const d = path.join(tmp, 'sb-' + name);
  fs.mkdirSync(path.join(d, 'scripts'), { recursive: true });
  const sh = path.join(d, 'scripts', 'fetch-pinned.sh');
  fs.writeFileSync(sh, SCRIPT_SRC);
  fs.writeFileSync(path.join(d, 'scripts', 'userland-sources.json'),
    typeof table === 'string' ? table : JSON.stringify(table, null, 2));
  return sh;
}
function run(sh, args, o) {
  const env = Object.assign({}, process.env, {
    PATH: BIN_CURL + ':' + (process.env.PATH || ''),
    TMPDIR: tmp,
  }, o && o.env);
  const r = spawnSync('/bin/bash', [sh].concat(args), { encoding: 'utf8', env });
  return { rc: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}
const uniq = (prefix) => path.join(tmp, prefix + '-' + Math.random().toString(36).slice(2));

const T = {
  sources: {
    good: { version: '1.2.3', sha256: SHA_GOOD, urls: [F('good.tgz')] },
    badsha: { version: '1.2.3', sha256: SHA_GOOD, urls: [F('bad.tgz')] },
    failover: { version: '9.9.9', sha256: SHA_GOOD, urls: [F('bad.tgz'), F('good.tgz')] },
    netfail: { version: '9.9.9', sha256: SHA_GOOD, urls: [F('no-such.tgz'), F('good.tgz')] },
    allfail: { version: '9.9.9', sha256: SHA_GOOD, urls: [F('bad.tgz'), F('no-such.tgz')] },
    httpsok: { version: '7.0.1', sha256: SHA_GOOD, urls: [HTTPS_URL] },
    unmapped: { version: '7.0.1', sha256: SHA_GOOD, urls: ['https://mirror.invalid/other.tgz'] },
    noversion: { version: '   ', sha256: SHA_GOOD, urls: [F('good.tgz')] },
    shortsha: { version: '1.0', sha256: 'deadbeef', urls: [F('good.tgz')] },
    nourls: { version: '1.0', sha256: SHA_GOOD, urls: [] },
    httpurl: { version: '1.0', sha256: SHA_GOOD, urls: ['http://mirror.invalid/x.tgz'] },
  },
};

// 夹具本身先自证：PATH 真被我们的 stub 占据、coreutils 在场（否则下面的红都不是被测层造成的）。
{
  const sh = sandbox('fixture', T);
  const probe = spawnSync('/bin/bash', ['-c', 'command -v curl; command -v sha256sum; command -v mktemp'], {
    encoding: 'utf8', env: Object.assign({}, process.env, { PATH: BIN_CURL + ':' + (process.env.PATH || '') }),
  });
  const lines = String(probe.stdout || '').trim().split('\n');
  check('夹具：PATH 最前的 curl 就是假 curl（CI 镜像里有真 curl，不占据首位就等于跟着镜像运气跑）',
    lines[0] === path.join(BIN_CURL, 'curl'), JSON.stringify(lines[0]));
  check('夹具：sha256sum / mktemp 在场（缺了就没有「取数」这一档可验）',
    lines.length >= 3 && /sha256sum/.test(lines[1]) && /mktemp/.test(lines[2]), JSON.stringify(lines));
  check('夹具：两批字节确实不同名（同 sha 的对照组无从构造）', SHA_GOOD !== SHA_BAD);
  const r = run(sh, ['--pin', 'good', uniq('out')]);
  check('夹具：合钉值这一档本身跑得起来（红全来自被测层，不来自夹具）', r.rc === 0, r.out.slice(-200));
}

// ---------------------------------------------------------------------------
//  ① 行为：字节身份只由钉值决定
// ---------------------------------------------------------------------------
{
  const sh = sandbox('bytes', T);

  const o1 = uniq('o1');
  const good = run(sh, ['--pin', 'good', o1]);
  check('① 合钉值 → 退 0 并打印校验通过（这是唯一绿的一档）',
    good.rc === 0 && /校验通过/.test(good.out), JSON.stringify({ rc: good.rc, out: good.out.slice(-160) }));
  check('① 落点真是那批字节（逐字节比，不看文件大小）',
    fs.existsSync(o1) && Buffer.compare(fs.readFileSync(o1), GOOD) === 0);

  const o2 = uniq('o2');
  const bad = run(sh, ['--pin', 'badsha', o2]);
  check('① 同一版本号的另一批字节 → 退 2 并点名不合钉值（绝不「像 tar.gz 就用」）',
    bad.rc === 2 && /不合钉值/.test(bad.out) && /所有来源都不合钉值/.test(bad.out),
    JSON.stringify({ rc: bad.rc, out: bad.out.slice(-200) }));
  check('① 判红时落点没有被写坏（半批字节投给设备是最坏的绿）', !fs.existsSync(o2));

  const o3 = uniq('o3');
  const fo = run(sh, ['--pin', 'failover', o3]);
  check('① 多来源=镜像故障转移：第一条字节不合、第二条合 → 退 0',
    fo.rc === 0 && Buffer.compare(fs.readFileSync(o3), GOOD) === 0, fo.out.slice(-200));
  check('① 故障转移要把第一条的不合读数打出来（静默换源=下次没人知道镜像坏过）',
    /来源 .* 不合钉值/.test(fo.out) && /换下一条/.test(fo.out), fo.out.split('\n').slice(0, 2).join(' | '));

  const o4 = uniq('o4');
  const nf = run(sh, ['--pin', 'netfail', o4]);
  check('① 镜像下载失败（非零退出）也算故障转移，不当成「取不到就放行」',
    nf.rc === 0 && /下载失败，换下一条来源/.test(nf.out), JSON.stringify({ rc: nf.rc, out: nf.out.slice(-180) }));

  const o5 = uniq('o5');
  const af = run(sh, ['--pin', 'allfail', o5]);
  check('① 每条都不合 → 退 2 并说宁可不编译（不把「没有身份的字节」交给下游）',
    af.rc === 2 && /宁可不编译/.test(af.out) && !fs.existsSync(o5), af.out.slice(-180));

  const o6 = uniq('o6');
  const hs = run(sh, ['--pin', 'httpsok', o6], {
    env: { STUB_MAP: HTTPS_URL + '\t' + path.join(BLOBS, 'good.tgz') },
  });
  check('① https 来源真能走通（表里每一格钉的都是 https，只验 file:// 等于没验发布轮会跑的那条）',
    hs.rc === 0 && /来源=https:\/\/mirror/.test(hs.out), JSON.stringify({ rc: hs.rc, out: hs.out.slice(-200) }));

  const o7 = uniq('o7');
  const um = run(sh, ['--pin', 'unmapped', o7], { env: { STUB_MAP: HTTPS_URL + '\t' + path.join(BLOBS, 'good.tgz') } });
  check('① https 来源取不到 → 退 2（对照组：证明上一条不是恒真）', um.rc === 2 && !fs.existsSync(o7));
}

// ---------------------------------------------------------------------------
//  ② 行为：件版本格与钉值是同一个事实
// ---------------------------------------------------------------------------
{
  const sh = sandbox('version', T);
  const vf = uniq('vfile');
  const ok = run(sh, ['--pin', 'good', uniq('o8'), '--version-file', vf]);
  check('② 核验通过才写版本格，内容就是表里的 version（清单号与源码不许两件事）',
    ok.rc === 0 && fs.existsSync(vf) && fs.readFileSync(vf, 'utf8').trim() === '1.2.3',
    JSON.stringify({ rc: ok.rc, body: fs.existsSync(vf) ? fs.readFileSync(vf, 'utf8').trim() : null }));

  const vf2 = uniq('vfile2');
  const bad = run(sh, ['--pin', 'badsha', uniq('o9'), '--version-file', vf2]);
  check('② 判红时版本格不许落盘（对照：绿侧写过、红侧必须没有，否则「有版本格」不证明对过钉值）',
    bad.rc === 2 && !fs.existsSync(vf2));

  const raw = uniq('o10');
  const bare = run(sh, [raw, SHA_GOOD, F('good.tgz')]);
  check('② 裸档（自测/离线用）能取数但不给版本格口子 —— 没有表就没有身份',
    bare.rc === 0 && /校验通过/.test(bare.out), bare.out.slice(-160));
  const bareBad = run(sh, [uniq('o11'), SHA_GOOD, F('bad.tgz')]);
  check('② 裸档的期望值也由调用方给死：字节不合照样退 2', bareBad.rc === 2);
  const tooFew = run(sh, [uniq('o12'), SHA_GOOD]);
  check('② 参数少一个都不算数（退 2 报用法，绝不默认「那就不校验」）',
    tooFew.rc === 2 && /用法/.test(tooFew.out), tooFew.out.slice(-140));
  const unknownFlag = run(sh, ['--pin', 'good', uniq('o13'), '--url', 'https://x']);
  check('② --pin 这一档不认别的旗（多一个口子=多一条绕过钉值的路）',
    unknownFlag.rc === 2 && /只认 --version-file/.test(unknownFlag.out), unknownFlag.out.slice(-160));
}

// ---------------------------------------------------------------------------
//  ③ 行为：钉值表这一格读不通，一律在取数**之前**红
// ---------------------------------------------------------------------------
{
  const sh = sandbox('table', T);
  const cases = [
    ['键不在表里', ['--pin', 'wget', uniq('t1')], /wget 不在钉值表里|这一格读不通/],
    ['sha 不是 64 位十六进制', ['--pin', 'shortsha', uniq('t2')], /不是 64 位小写十六进制/],
    ['没有 version 格', ['--pin', 'noversion', uniq('t3')], /没有 version 格/],
    ['urls 是空的', ['--pin', 'nourls', uniq('t4')], /urls 是空的/],
    ['来源是 http（无 TLS）', ['--pin', 'httpurl', uniq('t5')], /既不是 https 也不是 file/],
  ];
  for (const [name, args, re] of cases) {
    const r = run(sh, args);
    check(`③ 表里${name} → 退 2 并点名（「读不到就当清白」是这类门禁最空的空转口）`,
      r.rc === 2 && re.test(r.out), JSON.stringify({ rc: r.rc, out: r.out.slice(-170) }));
  }
  const missing = run(sh, ['--pin', 'good', uniq('t6'), '--version-file']);
  check('③ --version-file 后面没给落点 → 退 2', missing.rc === 2 && /没给落点/.test(missing.out), missing.out.slice(-150));

  const broken = sandbox('broken', '{"sources": ');
  const rb = run(broken, ['--pin', 'good', uniq('t7')]);
  check('③ 整张表不是合法 JSON → 退 2（读不出表就编译，等于回到没有钉值的年代）',
    rb.rc === 2 && /钉值表这一格读不通/.test(rb.out), rb.out.slice(-170));
  const noTable = sandbox('notable', { other: true });
  const rn = run(noTable, ['--pin', 'good', uniq('t8')]);
  check('③ 表里根本没有 sources 这一格 → 退 2 而不是「一条都不判」', rn.rc === 2);
}

// ---------------------------------------------------------------------------
//  判定函数（纯函数：真文件与合成样本走同一把尺子，否则对照组无从构造）
// ---------------------------------------------------------------------------

/**
 * 展开一个构建口里 `--pin <键>` 用到的键集。
 * 只认本仓的真实形状：字面键，或 `<前缀>$<名单变量>`（git 的补丁循环）。
 * 认不出的形状**报出来**而不是跳过 —— 静默跳过就等于「加了补丁而门禁不动」。
 */
function pinKeysUsed(src) {
  const s = stripComments(src);
  const lists = {};
  for (const m of s.matchAll(/^([A-Za-z_]\w*)=(?:"([^"]*)"|'([^']*)')/gm)) {
    lists[m[1]] = String(m[2] !== undefined ? m[2] : m[3]).trim().split(/\s+/).filter(Boolean);
  }
  for (const m of s.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\s+([^;]+);/g)) {
    const resolved = [];
    for (const it of m[2].trim().split(/\s+/)) {
      const vm = it.match(/^\$\{?(\w+)\}?$/);
      if (vm) { for (const x of (lists[vm[1]] || [])) resolved.push(x); } else if (!it.includes('$')) resolved.push(it);
    }
    lists[m[1]] = resolved;
  }
  const keys = new Set();
  const unresolved = [];
  for (const m of s.matchAll(/--pin\s+(\S+)/g)) {
    const tok = m[1].replace(/^["']/, '').replace(/["']$/, '');
    if (!tok.includes('$')) { keys.add(tok); continue; }
    const mm = tok.match(/^(.*)\$\{?(\w+)\}?$/);
    const parts = mm && lists[mm[2]];
    if (!mm || !parts || !parts.length) { unresolved.push(m[1]); continue; }
    for (const p of parts) keys.add((mm[1] || '') + p);
  }
  return { keys, unresolved };
}

/** 取数口是否「比过仓内声明的哈希」：走钉值口，或自己声明钉值并逐字节比对（npm/pnpm 那一格）。 */
function fetchAudit(src) {
  const s = stripComments(src);
  const fetches = [];
  for (const m of s.matchAll(/^\s*(?:if\s+!|!)?\s*curl\s[^\n]*/gm)) {
    if (/fetch-pinned/.test(m[0])) continue;
    if (/\s(?:-o|--output)\s/.test(m[0])) fetches.push(m[0].trim());
  }
  if (!fetches.length) return { kind: 'pinned', unverified: [] };
  // 仓内声明的钉值字面量：变量名以 SHA256/SHA512 为词干（不认某个脚本的取名习惯），
  // 且右值是一长串字面量而不是命令替换的结果 —— 「期望值现场从上游读」不算声明。
  const declares = /^[A-Z0-9_]*(?:SHA256|SHA512)[A-Z0-9_]*=\S{40,}/gm;
  const declared = [...s.matchAll(declares)];
  const compares = [...s.matchAll(/\[\s*"\$\w*(?:GOT|got)\w*"\s*!=\s*"\$\w*(?:SHA256|SHA512)\w*"/g)];
  const hashes = /(sha256sum|openssl dgst)/.test(s);
  if (declared.length && compares.length && hashes) return { kind: 'self-pinned', unverified: [] };
  return {
    kind: 'unverified',
    unverified: fetches.map((l) => l.slice(0, 90)),
    why: declared.length || compares.length ? '声明了钉值却没有把实取的字节与它比过' : '既没有钉值也没有比对',
  };
}

/** 表本身：每格的形状；件名（userland-verify.json 的 criteria 键）还额外受清单命名规则约束。 */
function tableFindings(table, pieceNames) {
  const out = [];
  const PIECE_VERSION = /^[0-9][^-]*$/;
  const srcs = (table && table.sources) || {};
  for (const k of Object.keys(srcs)) {
    const s = srcs[k] || {};
    if (!/^[0-9a-f]{64}$/.test(String(s.sha256))) out.push(k + '.sha256 不是 64 位小写十六进制：' + JSON.stringify(s.sha256));
    if (!String(s.version == null ? '' : s.version).trim()) out.push(k + '.version 是空的');
    if (!Array.isArray(s.urls) || !s.urls.length) out.push(k + '.urls 不是非空数组');
    else for (const u of s.urls) if (!/^https:\/\//.test(String(u))) out.push(k + ' 的来源不是 https（表里不许钉 file://，那是夹具专用）：' + u);
    if (pieceNames.includes(k) && !PIECE_VERSION.test(String(s.version).trim())) {
      out.push(k + '.version=' + JSON.stringify(s.version) + ' 吃不进件的命名规则 ^[0-9][^-]*$（带连字符会被发布器的件名正则整颗丢掉，清单从此少一件而 CI 不红）');
    }
  }
  return out;
}

/** 每一件声明的 C 层工具都得有字节身份的来源：钉值表那一格，或构建口自钉自比。 */
function coverageFindings(pieceNames, table, builders) {
  const out = [];
  for (const p of pieceNames) {
    if (table.sources && table.sources[p]) continue;
    const src = builders['build-userland-' + p + '.sh'];
    if (src === undefined) { out.push(p + '：既没有钉值表那一格，也没有 scripts/build-userland-' + p + '.sh —— 这件的字节身份无人声明'); continue; }
    const a = fetchAudit(src);
    if (a.kind === 'unverified') out.push(p + '：没有钉值表那一格，构建口也不是「取回后与仓内声明的哈希比过」的形状（' + a.why + '）');
  }
  return out;
}

function pathsCover(wfText, required) {
  const body = stripComments(wfText);
  return required.filter((p) => !new RegExp("^\\s*-\\s*'" + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'\\s*$", 'm').test(body));
}

const BUILDERS = {};
for (const n of fs.readdirSync(path.join(ROOT, 'scripts'))) {
  if (/^build-userland-.*\.sh$/.test(n)) BUILDERS[n] = fs.readFileSync(path.join(ROOT, 'scripts', n), 'utf8');
}
const REAL_TABLE = JSON.parse(fs.readFileSync(TABLE, 'utf8'));
const PIECES = Object.keys(JSON.parse(fs.readFileSync(VERIFY, 'utf8')).criteria);

// ---------------------------------------------------------------------------
//  ④ 静态：调用点的键集与表键集**相等**
// ---------------------------------------------------------------------------
{
  const used = new Set();
  const unresolved = [];
  for (const [name, src] of Object.entries(BUILDERS)) {
    const r = pinKeysUsed(src);
    for (const k of r.keys) used.add(k);
    for (const u of r.unresolved) unresolved.push(name + ' ' + u);
  }
  check('④ --pin 的变量形状全部可展开（认不出的键不许静默跳过）', unresolved.length === 0, unresolved.join('; '));
  const tableKeys = Object.keys(REAL_TABLE.sources);
  const missing = tableKeys.filter((k) => !used.has(k));
  const extra = [...used].filter((k) => !tableKeys.includes(k));
  check('④ 表里每一格都有调用点（死格=改它没人重发，ENV-26 那个形状的另一个宿主）',
    missing.length === 0, '表多出的键：' + missing.join(', '));
  check('④ 每个调用点都在表里（表少一格=构建口现场红，但「加了件没钉值」这件事必须提前知道）',
    extra.length === 0, '调用点用到的键不在表里：' + extra.join(', '));
  check('④ 逐颗件名核对：本仓声明的 C 层件与构建口一一对得上',
    PIECES.length === 6 && Object.keys(BUILDERS).length === 6,
    '件与构建口的颗数读数：pieces=' + PIECES.join(',') + ' builders=' + Object.keys(BUILDERS).sort().join(','));
  check('④ 表键集读数（14 格：6 颗上游源码 + zlib/openssl 两颗依赖 + 8 颗补丁）',
    tableKeys.length === 14, '实为 ' + tableKeys.length + ' 格：' + tableKeys.join(','));

  // 对照组：合成样本必须被同一把尺子抓到，并证明合法形状不误伤。
  const g1 = pinKeysUsed('bash scripts/fetch-pinned.sh --pin zlib x\nbash scripts/fetch-pinned.sh --pin wget y\n');
  check('④ 对照组：调用点用了一个没钉过的键 → 抓得到', g1.keys.has('wget') && !tableKeys.includes('wget'));
  const g2 = pinKeysUsed('bash scripts/fetch-pinned.sh --pin "git-$p" x\n');
  check('④ 对照组：名单变量展开不出来时如实报「认不出」，不是当成 0 颗',
    g2.keys.size === 0 && g2.unresolved.length === 1, JSON.stringify(g2));
  const g3 = pinKeysUsed('PATCHES="a.patch b.patch"\nfor p in $PATCHES; do bash scripts/fetch-pinned.sh --pin "git-$p" x; done\n');
  check('④ 循环里的补丁名单能展开成两颗（git 的真实形状）',
    g3.keys.has('git-a.patch') && g3.keys.has('git-b.patch') && g3.unresolved.length === 0, [...g3.keys].join(','));
  const g4 = pinKeysUsed('# --pin 只是注释里提到\nbash scripts/fetch-pinned.sh --pin curl x\n');
  check('④ 注释里的 --pin 不算调用点（判据钉的是执行面）', g4.keys.size === 1 && g4.keys.has('curl'));
}

// ---------------------------------------------------------------------------
//  ⑤ 静态：任何取数都必须比过仓内声明的哈希（扫遍同类全部构建口）
// ---------------------------------------------------------------------------
{
  const findings = [];
  const kinds = {};
  for (const [name, src] of Object.entries(BUILDERS)) {
    const a = fetchAudit(src);
    kinds[name] = a.kind;
    if (a.kind === 'unverified') findings.push(name + '：' + a.why + ' —— ' + a.unverified.join(' / '));
  }
  check('⑤ 六个构建口没有一颗在「取回不比过就继续编译」（zlib 两批字节那次定罪的形状）',
    findings.length === 0, findings.join(' ;; '));
  check('⑤ 读数：走钉值口的颗数与自钉自比的颗数（两类机制同判一条不变量）',
    Object.values(kinds).filter((k) => k === 'pinned').length === 4
      && Object.values(kinds).filter((k) => k === 'self-pinned').length === 2,
    JSON.stringify(kinds));

  const t1 = fetchAudit('if ! curl -fsSL "$URL" -o work/a.tgz; then exit 1; fi\ntar xzf work/a.tgz\n');
  check('⑤ 对照组：光「下载成功」就继续 → 抓到', t1.kind === 'unverified' && t1.unverified.length === 1, JSON.stringify(t1));
  const t2 = fetchAudit('SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nif ! curl -fsSL "$URL" -o work/a.tgz; then exit 1; fi\nGOT=$(sha256sum work/a.tgz | cut -d" " -f1)\nif [ "$GOT" != "$SHA256" ]; then exit 1; fi\n');
  check('⑤ 对照组：声明了钉值也比过 → 不误伤（npm/pnpm 那一格的形状）', t2.kind === 'self-pinned', JSON.stringify(t2));
  const t3 = fetchAudit('SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nif ! curl -fsSL "$URL" -o work/a.tgz; then exit 1; fi\ntar xzf work/a.tgz\n');
  check('⑤ 对照组：钉值写了却没人比 → 照样抓到（「钉了但没用」和没钉是同一件事）', t3.kind === 'unverified');
  const t4 = fetchAudit('bash "$ROOT_DIR/scripts/fetch-pinned.sh" --pin zlib work/a.tar.gz\n');
  check('⑤ 对照组：走钉值口的脚本不会被算成裸取数', t4.kind === 'pinned');
}

// ---------------------------------------------------------------------------
//  ⑥ 静态：钉值表自身的形状 + 每一件都有字节身份的来源
// ---------------------------------------------------------------------------
{
  const tf = tableFindings(REAL_TABLE, PIECES);
  check('⑥ 表里每一格的 sha/version/urls 形状合法，且 https-only（file:// 只服务夹具）',
    tf.length === 0, tf.join(' ;; '));

  const cf = coverageFindings(PIECES, REAL_TABLE, BUILDERS);
  check('⑥ 六颗声明的件每一颗都有钉值来源（sqlite3 那种「现刮版本」从此没有藏身处）',
    cf.length === 0, cf.join(' ;; '));

  const c1 = tableFindings({ sources: { npm: { version: '1.2.3-rc1', sha256: SHA_GOOD, urls: ['https://x/y'] } } }, ['npm']);
  check('⑥ 对照组：件版本带连字符 → 抓到（发布器 /^userland-([a-z0-9-]+)-([0-9][^-]*)-/ 会把整颗丢掉）',
    c1.some((f) => /命名规则/.test(f)), JSON.stringify(c1));
  const c2 = tableFindings({ sources: { curl: { version: '8.22.0', sha256: SHA_BAD, urls: ['https://x/y'] } } }, ['curl']);
  check('⑥ 对照组：合法形状不误伤', c2.length === 0, JSON.stringify(c2));
  const c3 = tableFindings({ sources: { git: { version: '2.55.0', sha256: SHA_GOOD, urls: ['file:///tmp/x'] } } }, ['git']);
  check('⑥ 对照组：表里钉了 file:// 来源 → 抓到（夹具口不许进发布表）',
    c3.some((f) => /不是 https/.test(f)), JSON.stringify(c3));
  const c4 = coverageFindings(['wtf'], { sources: {} }, {});
  check('⑥ 对照组：加了一件却没有钉值来源也没有构建口 → 抓到（「投放≠能力」的同族形状）',
    c4.length === 1 && /字节身份无人声明/.test(c4[0]), JSON.stringify(c4));
  const c5 = coverageFindings(['npm'], { sources: {} }, { 'build-userland-npm.sh': BUILDERS['build-userland-npm.sh'] });
  check('⑥ 对照组：没有表那一格但构建口自钉自比（npm 的真形状）→ 不算缺', c5.length === 0, JSON.stringify(c5));
  const c6 = coverageFindings(['npm'], { sources: {} }, { 'build-userland-npm.sh': 'curl -fsSL "$T" -o work/x.tgz\n' });
  check('⑥ 对照组：既没表那一格、构建口又不比哈希 → 抓到', c6.length === 1, JSON.stringify(c6));
}

// ---------------------------------------------------------------------------
//  ⑦ 静态：件版本格只有一个宿主；钉值表只有一个读者
// ---------------------------------------------------------------------------
{
  const CROSS = ['build-userland-curl.sh', 'build-userland-git.sh', 'build-userland-jq.sh', 'build-userland-sqlite3.sh'];
  const noHost = CROSS.filter((n) => !/--version-file/.test(stripComments(BUILDERS[n])));
  const secondHost = CROSS.filter((n) => />\s*"?[^\s"]*\/[a-z0-9]+\.version/.test(stripComments(BUILDERS[n])));
  check('⑦ 四颗交叉编译件的版本格都由取数写（--version-file 缺一个 = 版本号与字节又分家）',
    noHost.length === 0 && secondHost.length === 0,
    JSON.stringify({ 缺版本口: noHost, 第二处写版本: secondHost }));

  const readers = fs.readdirSync(path.join(ROOT, 'scripts'))
    .filter((n) => /\.(sh|js)$/.test(n))
    .filter((n) => n !== 'fetch-pinned.sh')
    .filter((n) => stripComments(fs.readFileSync(path.join(ROOT, 'scripts', n), 'utf8')).includes('userland-sources.json'));
  check('⑦ 钉值表只有 scripts/fetch-pinned.sh 一个读者（多处各自解析同一张表=两个结论，与 ref 解析同一条教训）',
    readers.length === 0, '还在读表的文件：' + readers.join(', '));

  const ctrl = stripComments('# 说明见 scripts/userland-sources.json\nnode -e "require(process.argv[1])" "$ROOT/scripts/userland-sources.json"\n');
  check('⑦ 对照组：真代码读表能抓到，注释里提到不算（判据钉执行面不钉文件名）',
    ctrl.includes('userland-sources.json') && !stripComments('# 只在注释里提一句 scripts/userland-sources.json\n').includes('userland-sources.json'));
}

// ---------------------------------------------------------------------------
//  ⑧ 接线：改「用哪批源码」必须触发构建轮（ENV-26 的那一课）
// ---------------------------------------------------------------------------
{
  const wfText = fs.readFileSync(WF, 'utf8');
  const required = ['scripts/fetch-pinned.sh', 'scripts/userland-sources.json'];
  const missing = pathsCover(wfText, required);
  check('⑧ build-userland 的 paths 覆盖钉值表与取数口（不在里面=改了源码来源而没有任何 job 会动，线上清单与仓内声明分家而 CI 全绿）',
    missing.length === 0, 'paths 缺：' + missing.join(', '));
  const already = pathsCover(wfText, ['scripts/publish-userland-manifest.js', 'scripts/check-userland-manifest-drift.js']);
  check('⑧ 原有的两颗（发布器、漂移对照）不许被顺手挤出 paths', already.length === 0, 'paths 缺：' + already.join(', '));
  const onlyComment = "name: x\non:\n  push:\n    paths:\n      # - 'scripts/fetch-pinned.sh'\n      - 'scripts/package-userland.sh'\n";
  check('⑧ 对照组：只有注释提及 → 判缺（证明钉的是列表项，不是文件名出现与否）',
    pathsCover(onlyComment, ['scripts/fetch-pinned.sh']).length === 1);
  const oneShort = wfText.replace(/^\s*-\s*'scripts\/userland-sources\.json'\s*$/m, '');
  check('⑧ 对照组：删掉一行就抓得到（这一格不是恒真）',
    pathsCover(oneShort, required).join(',') === 'scripts/userland-sources.json');
}

// ---------------------------------------------------------------------------
//  ⑨ 静态：拿 `$ROOT_DIR` 拼取数路径的脚本必须自己给它来源
// ---------------------------------------------------------------------------
// 实红出处：tag 轮 36766723667 与 main 校验轮 36766679501 都红在 sqlite3 —— 
// `scripts/build-userland-sqlite3.sh: line 31: ROOT_DIR: unbound variable`。
// 那颗件在 ④/⑤/⑦ 里全是合法的（键在表里、走钉值口、版本格由取数写），**缺的只是拼路径用的
// 仓根没有来源**：`set -euo pipefail` 下它在第一处使用点就死。整类形状在本仓有 8 个宿主，
// 所以判据要扫这一类，而不是只把我改坏的那一行改回去。
{
  // 纯函数：返回「用了却没来源／用在来源之前」的读数。注释里提及不算使用（判据钉执行面）。
  function rootRootFindings(src) {
    const lines = stripComments(src).split(String.fromCharCode(10));
    let firstUse = -1;
    let assign = -1;
    for (let i = 0; i < lines.length; i++) {
      if (firstUse < 0 && /\$\{?ROOT_DIR\b/.test(lines[i])) firstUse = i;
      if (assign < 0 && /^\s*(?:export\s+)?ROOT_DIR=/.test(lines[i])) assign = i;
    }
    if (firstUse < 0) return { uses: false };
    if (assign < 0) return { uses: true, finding: '用了 $ROOT_DIR 却没有一处赋值' };
    if (assign > firstUse) return { uses: true, finding: '第一处使用在赋值之前（set -u 下当场 unbound）' };
    return { uses: true, ok: true };
  }

  const scriptNames = fs.readdirSync(path.join(ROOT, 'scripts')).filter((n) => n.endsWith('.sh'));
  const findings = [];
  const users = [];
  for (const n of scriptNames) {
    const r = rootRootFindings(fs.readFileSync(path.join(ROOT, 'scripts', n), 'utf8'));
    if (r.uses) users.push(n);
    if (r.finding) findings.push(n + '：' + r.finding);
  }
  check('⑨ 拼取数路径的脚本每一颗都有自己的仓根来源（没有任何调用方 export ROOT_DIR，指望环境等于指望运气）',
    findings.length === 0, findings.join(' ;; '));
  check('⑨ 读数：命中面非零（0 个宿主=这把尺子空转）',
    users.length >= 8, users.length + ' 个脚本用仓根拼路径：' + users.join(','));

  check('⑨ 对照组：删掉 sqlite3 那行赋值就抓得到（证明上一条不是恒真）',
    rootRootFindings(fs.readFileSync(path.join(ROOT, 'scripts', 'build-userland-sqlite3.sh'), 'utf8')
      .replace(/^\s*(?:export\s+)?ROOT_DIR=.*$/m, '')).finding === '用了 $ROOT_DIR 却没有一处赋值');
  check('⑨ 对照组：先赋值再使用 → 不误伤',
    rootRootFindings('ROOT_DIR=$(pwd)\nbash "$ROOT_DIR/scripts/fetch-pinned.sh" --pin zlib x\n').ok === true);
  check('⑨ 对照组：使用点在赋值之前 → 抓到',
    /用在赋值之前/.test(rootRootFindings('bash "$ROOT_DIR/f" x\nROOT_DIR=$(pwd)\n').finding));
  check('⑨ 对照组：只在注释里提 $ROOT_DIR 不算宿主（否则改注释也会红）',
    rootRootFindings('# 这里用 $ROOT_DIR 拼路径\necho hi\n').uses === false);
}

finish();
