'use strict';

// APK 签名身份链（注入 → 门禁）的行为自测 + 回潮门禁。
//
// ============================================================================
//  为什么要有这个测试
// ============================================================================
//  「这个包是谁签的」决定的是**存量设备能不能装上新包**：AGP 没拿到 keystore 时用
//  runner 现场生成的 debug 密钥签名，指纹每次构建都不同 ⇒ 覆盖安装直接
//  INSTALL_FAILED_UPDATE_INCOMPATIBLE。build-apk 发的是 apk-latest（设备更新通道），
//  而它在发布前只写过一個 /tmp/signing-state 标记 —— 全仓零读取点，等于没有门禁。
//
//  判据收口到 scripts/inject-apk-keystore.sh（三档退出）+ scripts/verify-apk-signing.sh
//  （三档判据）。本文件盯两件事：
//    ① 行为：两条宿主的每一条退路都要能被证伪（含「一致但仍是 debug」「签成了另一把
//       key」这两种光看 DN 判不出来的形态）。
//    ② 回潮：workflow 里不许再出现内联的 keytool 核验 / base64 解 keystore，
//       也不许再造一次「写了没人读」的标记文件。
//
//  全程用 stub（假 keytool / 假 apksigner / 假 openssl），不依赖 JDK、不依赖 Android SDK：
//  门禁 job 的容器里这些都没有，真跑一次的代价是整条链路，而这里要的是秒级判定。
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const makeRunner = require('./harness');

const { check, finish } = makeRunner('apk-signing-gate');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const INJECT = path.join(ROOT, 'scripts/inject-apk-keystore.sh');
const VERIFY = path.join(ROOT, 'scripts/verify-apk-signing.sh');
const WF_DIR = path.join(ROOT, '.github/workflows');

const FP = '4f2a9c00112233445566778899aabbccddeeff00112233445566778899aabbcc';
const FP_OTHER = 'ff2a9c00112233445566778899aabbccddeeff00112233445566778899aabbcc';
const COLON = FP.replace(/(.{2})(?=.)/g, '$1:').toUpperCase();
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBFakeFakeFake\n-----END CERTIFICATE-----\n';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-signing-gate-'));
const BIN_KT = path.join(tmp, 'bin-kt');
const BIN_OS = path.join(tmp, 'bin-os');
const SDK = path.join(tmp, 'sdk');
[BIN_KT, BIN_OS, path.join(SDK, 'build-tools', '35.0.0')].forEach((d) => fs.mkdirSync(d, { recursive: true }));

// 假 keytool：只认 :env 形态（参数是环境变量名）；口令被明文传上命令行就当场报出来。
fs.writeFileSync(path.join(BIN_KT, 'keytool'), [
  '#!/usr/bin/env bash',
  'set -uo pipefail',
  'mode=""; ks=""; storeenv=""; alias=""; outfile=""; leak=0',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in',
  '    -list|-exportcert|-printcert) mode="${1#-}" ;;',
  '    -keystore) ks="$2"; shift ;;',
  '    -storepass:env) storeenv="$2"; shift ;;',
  '    -storepass) leak=1 ;;',
  '    -keypass:env) : ;;',
  '    -keypass) leak=1 ;;',
  '    -alias) alias="$2"; shift ;;',
  '    -file) outfile="$2"; shift ;;',
  '  esac',
  '  shift',
  'done',
  '[ "$leak" = 0 ] || { echo "STUB: 口令被明文传上命令行（不该发生）" >&2; exit 3; }',
  'pw="${!storeenv:-}"',
  'case "$mode" in',
  '  list) [ "$pw" = rightpass ] || exit 1',
  '        grep -q KEystoreFake "$ks" 2>/dev/null || exit 1',
  `        echo "Certificate fingerprint (SHA-256): ${COLON}" ;;`,
  '  exportcert) [ "$alias" = dsh ] || { echo "stub: 别名 $alias 不存在" >&2; exit 1; }',
  // 证书体以 '-' 开头，printf 会把它当选项解析（实测 printf: --: invalid option），
  // 故用 '%s\n' + 三个参数，而不是把 PEM 直接当格式串。
  "        printf '%s\\n' '-----BEGIN CERTIFICATE-----' 'MIIBFakeFakeFake' '-----END CERTIFICATE-----' > \"$outfile\" ;;",
  '  printcert) [ -s "$outfile" ] || exit 1',
  '        echo "Owner: CN=dsh-test"',
  `        echo "Certificate fingerprint (SHA-256): ${COLON}" ;;`,
  'esac',
  'exit 0',
  '',
].join('\n'));
fs.chmodSync(path.join(BIN_KT, 'keytool'), 0o755);

// 假 openssl：验-apk-signing 读不到 keytool 时的退路（CI 容器里真 openssl 有、keytool 没有）。
fs.writeFileSync(path.join(BIN_OS, 'openssl'), [
  '#!/usr/bin/env bash',
  'case "$*" in',
  `  *fingerprint*) echo "sha256 Fingerprint=${COLON}"; exit 0 ;;`,
  'esac',
  'exit 1',
  '',
].join('\n'));
fs.chmodSync(path.join(BIN_OS, 'openssl'), 0o755);

const APK = path.join(tmp, 'app.apk');
fs.writeFileSync(APK, 'PK');

// 假 apksigner：放在 <sdk>/build-tools/<ver>/apksigner —— 宿主真会用 scripts/pick.sh 探它。
const dnLine = (dn) => `Signer #1 certificate DN: ${dn}\\n`;
function setApksigner(body, ver) {
  const d = path.join(SDK, 'build-tools', ver || '35.0.0');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'apksigner'), `#!/usr/bin/env bash\nprintf '${body}'\nexit 0\n`);
  fs.chmodSync(path.join(d, 'apksigner'), 0o755);
  return d;
}
const OUT = {
  stable: dnLine('CN=dsh-test, O=dsh, C=US') + `Signer #1 certificate SHA-256 digest: ${FP}\\n`,
  debug: dnLine('CN=Android Debug, O=Android, C=US') + `Signer #1 certificate SHA-256 digest: ${FP}\\n`,
  otherKey: dnLine('CN=dsh-test, O=dsh, C=US') + `Signer #1 certificate SHA-256 digest: ${FP_OTHER}\\n`,
  noDN: 'Signer #1 certificate SHA-256 digest: deadbeef\\n',
  sha1Only: dnLine('CN=dsh-test') + `Signer #1 certificate SHA-1 digest: ${COLON}\\n`,
  jdkStyle: dnLine('CN=dsh-test') + `\\t SHA256: ${COLON}\\n`,
  eqStyle: dnLine('CN=dsh-test') + `sha256 Fingerprint=${COLON}\\n`,
};
const CERT = path.join(tmp, 'keys/release.cert');
// 锚点由 inject 的全绿用例产出，但 ② 的比对用例不该依赖它 —— 先直接放一份，
// 让两节各自可独立证伪。
fs.mkdirSync(path.dirname(CERT), { recursive: true });
fs.writeFileSync(CERT, PEM);

// PATH 组装：kt=有假 keytool，os=有假 openssl。
function run(script, args, o = {}) {
  const parts = [];
  if (o.kt) parts.push(BIN_KT);
  if (o.os) parts.push(BIN_OS);
  parts.push('/usr/local/bin', '/usr/bin', '/bin');
  const env = {
    PATH: parts.join(':'),
    ANDROID_HOME: o.sdk === null ? undefined : (o.sdk || SDK),
    ...o.env,
  };
  if (env.ANDROID_HOME === undefined) delete env.ANDROID_HOME;
  const r = spawnSync('/bin/bash', [script, ...args], { encoding: 'utf8', cwd: ROOT, env });
  return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const inj = (env, o = {}) => run(INJECT, [path.join(tmp, 'keys')],
  { ...o, env: { ...env, GITHUB_ENV: path.join(tmp, 'gh_env.txt') } });
const ver = (extra, o = {}) => run(VERIFY, [APK, ...(extra || [])], o);

// ---------------------------------------------------------------------------
//  ① inject-apk-keystore.sh：三档退出语义
// ---------------------------------------------------------------------------
{
  const r = inj({});
  check('inject：未配 KS_B64 → 退 10（「本次是 debug 签名包」是合法档位，判红与否由调用方定）',
    r.rc === 10 && r.out.includes('一次性 debug 签名'), JSON.stringify({ rc: r.rc, out: r.out.slice(0, 120) }));
}
{
  const r = inj({ KS_B64: 'not*base64@@@', KS_PASS: 'rightpass' });
  check('inject：base64 残缺 → 退 2 报「解码失败」（先做无依赖的解码，不被 JDK 缺席盖住真因）',
    r.rc === 2 && r.out.includes('解码失败'), JSON.stringify({ rc: r.rc, out: r.out.slice(0, 120) }));
}
{
  const r = inj({ KS_B64: Buffer.from('KEystoreFake').toString('base64') });
  check('inject：配了 keystore 却没配口令 → 退 2 明说「不是没配」（退 10 会被发布链路读成「本轮没密钥」而放行）',
    r.rc === 2 && r.out.includes('不是没配'), JSON.stringify({ rc: r.rc }));
}
{
  const r = inj({ KS_B64: Buffer.from('KEystoreFake').toString('base64'), KS_PASS: 'rightpass' });
  check('inject：keytool 不可用 → 退 2（核验不成就不许继续构建）',
    r.rc === 2 && r.out.includes('keytool 不可用'), JSON.stringify({ rc: r.rc, out: r.out.slice(0, 120) }));
}
{
  const r = inj({ KS_B64: Buffer.from('this-is-not-a-keystore').toString('base64'), KS_PASS: 'wrongpass' }, { kt: true });
  check('inject：口令错 / keystore 读不出 → 退 2', r.rc === 2 && r.out.includes('读不出条目'), JSON.stringify({ rc: r.rc }));
}
{
  const r = inj({ KS_B64: Buffer.from('KEystoreFake').toString('base64'), KS_PASS: 'rightpass', KS_ALIAS: 'nope' }, { kt: true });
  check('inject：别名不存在 → 退 2 点名别名（只查 -list 会放过这种形态）',
    r.rc === 2 && r.out.includes('别名'), JSON.stringify({ rc: r.rc, out: r.out.slice(0, 140) }));
}
{
  fs.rmSync(CERT, { force: true });   // 前置写过一份，这里必须让它重新生成才算 inject 的功劳
  const r = inj({ KS_B64: Buffer.from('KEystoreFake').toString('base64'), KS_PASS: 'rightpass' }, { kt: true });
  check('inject：全绿 → 退 0、导出 PEM 锚点（事实进产物，不留跨步骤标记）',
    r.rc === 0 && fs.existsSync(CERT) && fs.readFileSync(CERT, 'utf8').includes('BEGIN CERTIFICATE'),
    JSON.stringify({ rc: r.rc, out: r.out.slice(0, 160) }));
  check('inject：口令以 :env 形态传给 keytool（没被明文写上命令行）',
    !r.out.includes('明文传上命令行'), r.out.slice(0, 160));
  const envTxt = fs.existsSync(path.join(tmp, 'gh_env.txt')) ? fs.readFileSync(path.join(tmp, 'gh_env.txt'), 'utf8') : '';
  check('inject：GITHUB_ENV 导出 gradle 那三个变量 + 锚点路径（名字与 build.gradle.kts 逐字对齐）',
    ['DSH_KEYSTORE_PASSWORD=rightpass', 'DSH_KEY_ALIAS=dsh', 'DSH_KEY_PASSWORD=rightpass', 'DSH_APK_CERT_FILE=' + CERT]
      .every((k) => envTxt.includes(k)), envTxt.slice(0, 200));
  check('inject：keystore 落盘不带同组/其他人可读位',
    (() => { const p = path.join(tmp, 'keys/release.keystore'); return fs.existsSync(p) && (fs.statSync(p).mode & 0o077) === 0; })());
}

// ---------------------------------------------------------------------------
//  ② verify-apk-signing.sh：三档判据 + 每条退路
// ---------------------------------------------------------------------------
{
  const noargs = spawnSync('/bin/bash', [VERIFY], { encoding: 'utf8', cwd: ROOT });
  check('verify：无参数 → 退 2（门禁不许空跑）', noargs.status === 2, noargs.stdout);
  const nofile = spawnSync('/bin/bash', [VERIFY, path.join(tmp, 'nope.apk')], { encoding: 'utf8', cwd: ROOT });
  check('verify：APK 不存在 → 退 2', nofile.status === 2, nofile.stdout);
  const bogus = ver(['--bogus']);
  check('verify：未知参数 → 退 2（拼错参数不许被当成「已核验」）',
    bogus.rc === 2 && bogus.out.includes('未知参数'), JSON.stringify({ rc: bogus.rc }));
}
{
  setApksigner(OUT.stable);
  const r = ver(['--cert', path.join(tmp, 'missing.cert')]);
  check('verify：锚点文件缺失 → 退 1「注入步骤没做完」，且这条诊断先于工具探测',
    r.rc === 1 && r.out.includes('注入步骤没做完'), JSON.stringify({ rc: r.rc, out: r.out.slice(0, 140) }));
}
{
  const r = run(VERIFY, [APK], { sdk: path.join(tmp, 'no-such-sdk') });
  check('verify：找不到 apksigner → 退 1 硬红（拿不到读数 ≠ 签名没问题）',
    r.rc === 1 && r.out.includes('找不到 apksigner'), JSON.stringify({ rc: r.rc, out: r.out.slice(0, 140) }));
  const r2 = run(VERIFY, [APK], { sdk: null });
  check('verify：ANDROID_HOME 未设置 → 同样退 1 报找不到，而不是炸在探测路径上',
    r2.rc === 1 && r2.out.includes('找不到 apksigner') && r2.out.includes('<未设置>'), JSON.stringify({ rc: r2.rc }));
}
{
  setApksigner(OUT.noDN);
  const r = ver();
  check('verify：apksigner 输出里没有 DN 行 → 退 1（解析不到身份不放行）',
    r.rc === 1 && r.out.includes('DN 行'), JSON.stringify({ rc: r.rc, out: r.out.slice(0, 140) }));
}
{
  // 旧版本那份故意签成「另一把 key」：取错版本就会指纹不符 → 退 1，判据才有分辨力。
  setApksigner(OUT.otherKey, '34.1.0');
  setApksigner(OUT.stable, '35.0.0');
  const r = ver(['--cert', CERT], { kt: true });
  check('verify：多 build-tools 版本共存时取最新那份（探测宿主 = scripts/pick.sh --last）',
    r.rc === 0 && r.out.includes(path.join('35.0.0', 'apksigner')),
    JSON.stringify({ rc: r.rc, out: r.out.slice(0, 200) }));
}
{
  setApksigner(OUT.stable);
  const r = ver();
  check('verify：非 debug、无锚点、未要求 stable → 退 0 但 warn「不知道是哪把 key」',
    r.rc === 0 && r.out.includes('签名身份无从核验'), JSON.stringify({ rc: r.rc, out: r.out.slice(0, 140) }));
  const r2 = ver(['--require-stable']);
  check('verify：require-stable 无锚点 → 放行但明说「只证明了不是 debug」',
    r2.rc === 0 && r2.out.includes('没有】可比对的锚点指纹'), JSON.stringify({ rc: r2.rc }));
}
{
  setApksigner(OUT.debug);
  const r = ver(['--require-stable']);
  check('verify：发布链路拿到 debug 签名 → 退 1（build-apk 原先就是这个洞：无条件 if: success() 照发）',
    r.rc === 1 && r.out.includes('发布包是 debug 签名'), JSON.stringify({ rc: r.rc, out: r.out.slice(0, 140) }));
  const r2 = ver();
  check('verify：日常链路 debug 且未配密钥 → 退 0 + ::warning::（可用但不可发布，说清即可）',
    r2.rc === 0 && r2.out.includes('::warning') && r2.out.includes('开发签名'), JSON.stringify({ rc: r2.rc }));
}
{
  setApksigner(OUT.stable);
  const r = ver(['--cert', CERT], { kt: true });
  check('verify：APK 指纹 == 锚点指纹 → 退 0（强档：证明「就是这把 key」）',
    r.rc === 0 && r.out.includes('与注入锚点一致'), JSON.stringify({ rc: r.rc, out: r.out.slice(0, 160) }));
  const r2 = ver(['--cert', CERT], { os: true });
  check('verify：没有 keytool 时退到 openssl 读锚点，结论不变',
    r2.rc === 0 && r2.out.includes('与注入锚点一致'), JSON.stringify({ rc: r2.rc, out: r2.out.slice(0, 160) }));
}
{
  setApksigner(OUT.otherKey);
  const r = ver(['--cert', CERT, '--require-stable'], { kt: true });
  check('verify：签成了另一把 key（DN 看着正常、非 debug）→ 退 1 并打出双方指纹',
    r.rc === 1 && r.out.includes('签名身份不符') && r.out.includes(FP) && r.out.includes(FP_OTHER),
    JSON.stringify({ rc: r.rc, out: r.out.slice(0, 140) }));
}
{
  setApksigner(OUT.debug);
  const r = ver(['--cert', CERT, '--require-stable'], { kt: true });
  check('verify：锚点自身就是 debug（一致但仍不可发布）→ 退 1（一致≠稳定）',
    r.rc === 1 && r.out.includes('本身就是 Android Debug'), JSON.stringify({ rc: r.rc, out: r.out.slice(0, 160) }));
}
{
  setApksigner(OUT.stable);
  const garbage = path.join(tmp, 'garbage.cert');
  fs.writeFileSync(garbage, '这不是证书\n');
  // 不给假 keytool/假 openssl：让宿主面对一份真读不出来的锚点（CI 容器里有没有
  // 真 openssl 都同结论 —— 退 1「不放行」，这条不依赖镜像里装了什么）。
  const r = run(VERIFY, [APK, '--cert', garbage], {});
  check('verify：锚点读不出指纹 → 退 1（不许把读不出当成「没配锚点」降级放行）',
    r.rc === 1 && r.out.includes('锚点') && r.out.includes('不放行'), JSON.stringify({ rc: r.rc, out: r.out.slice(0, 160) }));
}
// 指纹行的三种真实写法都要归一到同一个 64 位摘要；只有 SHA-1 时不许冒充 SHA-256。
// 判据全程不走管道（pipefail 下「grep 命中 + 左侧 SIGPIPE」会被翻成未命中，
// 前科见 scripts/verify-apk-native.sh 头部 2026-09-26 的记录）。
for (const [label, body, wantRc] of [
  ['apksigner 的 "SHA-256 digest: <hex>"', OUT.stable, 0],
  ['keytool 分条列出的 "\\t SHA256: AA:BB…"', OUT.jdkStyle, 0],
  ['openssl 的 "sha256 Fingerprint=AA:BB…"', OUT.eqStyle, 0],
  ['只有 SHA-1 行', OUT.sha1Only, 1],
]) {
  setApksigner(body);
  const r = ver(['--cert', CERT], { kt: true });
  check(`verify：指纹写法「${label}」→ 退 ${wantRc}（归一化不误收、也不漏收）`,
    r.rc === wantRc && !r.out.includes('Broken pipe'), JSON.stringify({ rc: r.rc, out: r.out.slice(0, 160) }));
}
{
  setApksigner(OUT.stable + Array.from({ length: 16 }, () => 'junk line with 64-hex-ish noise\\n').join(''));
  const r = ver(['--cert', CERT], { kt: true });
  check('verify：噪声行淹不掉正确指纹（无管道 ⇒ 无 SIGPIPE 假阳性）',
    r.rc === 0 && !r.out.includes('Broken pipe'), JSON.stringify({ rc: r.rc, out: r.out.slice(0, 160) }));
}

// ---------------------------------------------------------------------------
//  ③ 回潮门禁：判据只住 scripts/，workflow 只调用
// ---------------------------------------------------------------------------
{
  const INJECT_INLINE = /base64\s+-d\s*>\s*\S*release\.keystore/;
  const KEYTOOL_INLINE = /keytool\s+-list\s+-keystore/;
  // 「写了没人读」的标记文件。判据扫的是 workflow 全文（含注释），所以 build-apk 里
  // 那段历史说明只能写成中文描述、不能出现这个路径字面量 —— 取舍是刻意的：
  // 与其给扫描器开「忽略注释」的口子（回潮最容易从注释溜进去），不如让注释让路。
  const MARKER = /\/tmp\/signing-state/;
  // 双向对照组的正例：旧内联形态必须被抓（否则「零命中」是空转而不是清白）。
  check('回潮判据自证：旧的三种写法必被抓',
    INJECT_INLINE.test('echo "$KS_B64" | base64 -d > keys/release.keystore')
      && INJECT_INLINE.test('base64 -d > "$RUNNER_TEMP/keys/release.keystore"')
      && KEYTOOL_INLINE.test('keytool -list -keystore keys/release.keystore \\'),
    '判据形状与仓库里真实出现过的写法脱节了');
  check('回潮判据不误伤：宿主调用（含带参调用）不算内联',
    !INJECT_INLINE.test('bash scripts/inject-apk-keystore.sh "$RUNNER_TEMP/keys"')
      && !KEYTOOL_INLINE.test('bash scripts/inject-apk-keystore.sh "$RUNNER_TEMP/keys"'),
    '判据写得太松会把收口本身抓成回潮');
  check('回潮判据自证：写了没人读的标记文件形态被钉住', MARKER.test('echo "SIGNED_STABLE" > /tmp/signing-state'));

  const wfs = fs.readdirSync(WF_DIR).filter((f) => f.endsWith('.yml'))
    .map((f) => [f, fs.readFileSync(path.join(WF_DIR, f), 'utf8')]);
  const inline = wfs.filter(([, t]) => INJECT_INLINE.test(t) || KEYTOOL_INLINE.test(t)).map(([f]) => f);
  check('workflow 无内联 keystore 解码/核验回潮（判据只住 inject 宿主）',
    inline.length === 0, inline.join(','));
  const markers = wfs.filter(([, t]) => MARKER.test(t)).map(([f]) => f);
  check('workflow 无 /tmp/signing-state 残留（标记文件零读取点，写方已全部删除）',
    markers.length === 0, markers.join(','));

  const injCallers = wfs.filter(([, t]) => /scripts\/inject-apk-keystore\.sh/.test(t)).map(([f]) => f).sort();
  check('注入宿主被 fast-apk / build-apk / release-admin 三链同调（一处策略、一份实现）',
    JSON.stringify(injCallers) === JSON.stringify(['build-apk.yml', 'fast-apk.yml', 'release-admin.yml']),
    injCallers.join(','));
  const verCallers = wfs.filter(([, t]) => /scripts\/verify-apk-signing\.sh/.test(t)).map(([f]) => f).sort();
  check('签名身份门禁被同三条链路调用',
    JSON.stringify(verCallers) === JSON.stringify(['build-apk.yml', 'fast-apk.yml', 'release-admin.yml']),
    verCallers.join(','));
  const byName = Object.fromEntries(wfs);
  check('发布面两条链（build-apk / repack）都带 --require-stable；日常链不带',
    /verify-apk-signing\.sh[\s\S]{0,400}?--require-stable/.test(byName['build-apk.yml'])
      && /verify-apk-signing\.sh[\s\S]{0,400}?--require-stable/.test(byName['release-admin.yml'])
      && !/verify-apk-signing\.sh[^\n]*--require-stable/.test(byName['fast-apk.yml']),
    '发布档与日常档的区分丢了');
  check('发布门禁调用点里锚点走 shell 变量（写成 ${{ DSH_APK_CERT_FILE }} 会被展开成空串）',
    !/\$\{\{\s*DSH_APK_CERT_FILE\s*\}\}/.test(wfs.map(([, t]) => t).join('\n')),
    '出现会被 Actions 吃掉的写法');
}

fs.rmSync(tmp, { recursive: true, force: true });
finish();
