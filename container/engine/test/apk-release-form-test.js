'use strict';

// APK 形态门禁（android:debuggable）：行为自测 + 接线/回潮门禁。
//
// 为什么要有这个测试（债 AUD-G33）：写 apk-latest 的链路只跑过 assembleDebug，而签名门禁
// 判的是「谁签的」这两个事实会同时为真 —— container/app/build.gradle.kts:119-132 让 debug 档
// 也用 release keystore 签名，于是签名一路绿、投进存量设备更新通道的仍是 debuggable 包
// （私有目录对任意 adb shell 敞开、可被调试器附加）。形态判据收口在
// scripts/verify-apk-release-form.sh（读 aapt/aapt2 的 badging）。
//
// 盯三件事：
//   ① 行为：这把尺子**两侧都要能红** —— release 判绿、debug 判红，对照档（--expect-debuggable）
//      反向也要能红。只测发布侧的绿分不清「包真的干净」与「解析根本没生效」。
//      「取不到读数一律判红」的每一条退路逐条证伪。
//   ② 接线：投壳 APK 的链只有 fast-apk 一条（发布连归一，docs/adr/0011），它两侧都调、
//      恰好一次带对照档；签名门禁排在投递之前，形态门禁刻意排在之后。
//   ③ 回潮：workflow 里不许再自己 `dump badging`（同一判据的第二份拷贝）。
//
// 全程用假 aapt/aapt2：真读一次要 Android SDK，而这里要的是秒级判定，
// 且「读得出/读不出」必须是可控输入而不是运气。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const makeRunner = require('./harness');

const { check, skip, finish } = makeRunner('apk-release-form');
const strip = makeRunner.stripComments;

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FORM = path.join(ROOT, 'scripts/verify-apk-release-form.sh');
const WF_DIR = path.join(ROOT, '.github/workflows');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-release-form-'));
const SDK = path.join(tmp, 'sdk');
// 「工具不在场」这一档的探测根：一个真实存在、但底下没有 build-tools 的 SDK 目录。
const NO_TOOL_SDK = path.join(tmp, 'sdk-without-build-tools');
fs.mkdirSync(NO_TOOL_SDK, { recursive: true });

// 假 aapt/aapt2：读数完全由 FAKE_BADGE 指向的文件给，FAKE_RC 控制退出码。
const FAKE_TOOL = [
  '#!/usr/bin/env bash',
  'set -uo pipefail',
  '[ -n "${FAKE_BADGE:-}" ] || exit 9',
  '[ -f "$FAKE_BADGE" ] || exit 9',
  'cat "$FAKE_BADGE"',
  '[ "${FAKE_RC:-0}" = 0 ] || exit "$FAKE_RC"',
  'exit 0',
  '',
].join('\n');

function putTool(name, ver, body) {
  const d = path.join(SDK, 'build-tools', ver || '35.0.0');
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, name);
  fs.writeFileSync(p, body || FAKE_TOOL);
  fs.chmodSync(p, 0o755);
  return p;
}
function rmTool(name, ver) {
  fs.rmSync(path.join(SDK, 'build-tools', ver || '35.0.0', name), { force: true });
}
putTool('aapt');

const PKG = "package: name='lobos.app' versionCode='39' versionName='1.1.11'";
const RELEASE_BADGE = [PKG, "application-label:'Lob OS'", "sdkVersion:'24'",
  "uses-permission: name='android.permission.FOREGROUND_SERVICE'"].join('\n') + '\n';
const DEBUG_BADGE = [PKG, 'application-debuggable', "application-label:'Lob OS'"].join('\n') + '\n';
// 真 aapt 从不产出这种行；它是专门造来撞「子串匹配」的：
// 判定若写成 `grep debuggable`，这两行都会被当成 debug 形态。
const LOOKS_DEBUG_BADGE = [PKG, 'application-debuggable-ish',
  "application-label:'A debuggable looking label'"].join('\n') + '\n';

const BADGE = path.join(tmp, 'badge.txt');
const APK = path.join(tmp, 'app.apk');
fs.writeFileSync(APK, 'PK');
const setBadge = (s) => fs.writeFileSync(BADGE, s);

// 探测只有两处：${ANDROID_HOME}/build-tools 与 PATH。所以「工具不在场」这一档
// 由「build-tools 目录里没有工具」+「PATH 里没有 aapt」共同构成，不靠裁剪 PATH ——
// 裁 PATH 会让 pick.sh 自己缺工具，红的不是被测层（这种绿/红都不可解释，等于空转）。
function run(args, o = {}) {
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    ANDROID_HOME: o.noHome ? '' : (o.sdk || SDK),
    FAKE_BADGE: BADGE,
    FAKE_RC: String(o.rc === undefined ? 0 : o.rc),
  };
  if (env.ANDROID_HOME === '') delete env.ANDROID_HOME;
  const r = spawnSync('/bin/bash', [FORM, ...args], { encoding: 'utf8', cwd: ROOT, env });
  return { rc: r.status === null ? -1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const form = (o = {}, extra = []) => run([APK, ...extra], o);

// ---------------------------------------------------------------------------
//  ① 行为：两侧都能红
// ---------------------------------------------------------------------------
{
  setBadge(RELEASE_BADGE);
  const r = form();
  check('形态：release 包 + 默认期望 → 退 0 并打出 debuggable=false',
    r.rc === 0 && r.out.includes('[lobos-form] android:debuggable = false') && r.out.includes('非 debuggable'),
    JSON.stringify({ rc: r.rc, out: r.out.slice(0, 160) }));
}
{
  setBadge(DEBUG_BADGE);
  const r = form();
  check('形态：debug 包 + 默认期望 → 退 1 并落 ::error（发布链路就是这么把 AUD-G33 拦住的）',
    r.rc === 1 && r.out.includes('发布包是 debug 形态') && r.out.includes('::error'),
    JSON.stringify({ rc: r.rc, out: r.out.slice(0, 160) }));
  const r2 = form({}, ['--expect-debuggable']);
  check('形态：debug 包 + 对照档 → 退 0（尺子正例，证明发布侧的绿不是空转）',
    r2.rc === 0 && r2.out.includes('按预期读成 debug 形态'), JSON.stringify({ rc: r2.rc }));
}
{
  setBadge(RELEASE_BADGE);
  const r = form({}, ['--expect-debuggable']);
  check('形态：release 包 + 对照档 → 退 1「形态门禁失灵」（对照组反证：解析没生效时对照档必须红）',
    r.rc === 1 && r.out.includes('形态门禁失灵') && r.out.includes('release 侧的绿同样不可信'),
    JSON.stringify({ rc: r.rc, out: r.out.slice(0, 160) }));
}
{
  setBadge(LOOKS_DEBUG_BADGE);
  const r = form();
  check('形态：按整行匹配 —— 标签里带 debuggable 字样、或 application-debuggable-ish 都不算 debug 形态',
    r.rc === 0 && r.out.includes('android:debuggable = false'), JSON.stringify({ rc: r.rc, out: r.out.slice(0, 160) }));
  const r2 = form({}, ['--expect-debuggable']);
  check('形态：同一份读数在对照档下判红（不误判成 debug 不能只朝一个方向失效）', r2.rc === 1, JSON.stringify({ rc: r2.rc }));
}

// ---------------------------------------------------------------------------
//  ② 取不到读数一律判红：每一条退路
// ---------------------------------------------------------------------------
{
  const noargs = spawnSync('/bin/bash', [FORM], { encoding: 'utf8', cwd: ROOT });
  check('用法：无参数 → 退 2（门禁不许空跑）', noargs.status === 2, noargs.stdout);
  const nofile = run([path.join(tmp, 'nope.apk')]);
  check('用法：APK 不存在 → 退 2', nofile.rc === 2, JSON.stringify({ rc: nofile.rc }));
  const bogus = run([APK, '--expect']);
  check('用法：未知参数 → 退 2（拼错开关不许被当成「已核验」）',
    bogus.rc === 2 && bogus.out.includes('未知参数'), JSON.stringify({ rc: bogus.rc }));
}
{
  setBadge('');
  const r = form();
  check('读数：badging 空输出 → 退 1「审计没发生」', r.rc === 1 && r.out.includes('输出为空'), JSON.stringify({ rc: r.rc }));
}
{
  setBadge(RELEASE_BADGE);
  const r = form({ rc: 3 });
  check('读数：aapt 非零退出 → 退 1（工具报错不许当成「没有 debuggable 行」）',
    r.rc === 1 && r.out.includes('读不出'), JSON.stringify({ rc: r.rc, out: r.out.slice(0, 140) }));
}
{
  setBadge("installation failed: not an android package\n");
  const r = form();
  check('读数：输出里没有 package: 行 → 退 1（解析器没真读到这个包，形态判定无从谈起）',
    r.rc === 1 && r.out.includes('package: name= 行') && r.out.includes('不放行'),
    JSON.stringify({ rc: r.rc, out: r.out.slice(0, 140) }));
}
{
  const hasReal = ['/usr/local/bin', '/usr/bin', '/bin'].some((d) =>
    fs.existsSync(path.join(d, 'aapt')) || fs.existsSync(path.join(d, 'aapt2')));
  if (hasReal) {
    // 跳过必须逐条打行并进汇总计数（harness 的 skip 是唯一合法出口）。
    skip('读数：找不到 aapt/aapt2 → 退 1（本机 PATH 里真有 aapt/aapt2，造不出「工具不在场」这一档）');
    skip('读数：ANDROID_HOME 未设置 → 同上');
  } else {
    setBadge(RELEASE_BADGE);
    const r = form({ sdk: NO_TOOL_SDK });
    check('读数：build-tools 里没有 aapt/aapt2 → 退 1 硬红（拿不到读数 ≠ 包是 release 形态）',
      r.rc === 1 && r.out.includes('找不到 aapt/aapt2'), JSON.stringify({ rc: r.rc, out: r.out.slice(0, 140) }));
    const r2 = form({ noHome: true });
    check('读数：ANDROID_HOME 未设置 → 同样退 1，且诊断点名上游变量',
      r2.rc === 1 && r2.out.includes('找不到 aapt/aapt2') && r2.out.includes('<未设置>'),
      JSON.stringify({ rc: r2.rc }));
  }
}
{
  // aapt 缺席时的退路：aapt2 的 `dump badging` 给同一份文本。
  rmTool('aapt');
  putTool('aapt2');
  setBadge(RELEASE_BADGE);
  const r = form();
  check('退路：只有 aapt2 时走 aapt2，结论不变',
    r.rc === 0 && r.out.includes(path.join('build-tools', '35.0.0', 'aapt2')),
    JSON.stringify({ rc: r.rc, out: r.out.slice(0, 200) }));
  rmTool('aapt2');
  putTool('aapt');
}
{
  // 多 build-tools 版本共存：探测宿主是 scripts/pick.sh --last。
  // 旧版本那份故意读数成 debug 形态 —— 取错版本就会判红，这条才有分辨力。
  putTool('aapt', '34.1.0', [
    '#!/usr/bin/env bash',
    `printf '%s\\n' '${PKG}' 'application-debuggable'`,
    'exit 0',
    '',
  ].join('\n'));
  putTool('aapt', '35.0.0');
  setBadge(RELEASE_BADGE);
  const r = form();
  check('探测：多 build-tools 共存时取最新那份（取到 34.1.0 就会读成 debug 而判红）',
    r.rc === 0 && r.out.includes(path.join('35.0.0', 'aapt')),
    JSON.stringify({ rc: r.rc, out: r.out.slice(0, 200) }));
  rmTool('aapt', '34.1.0');
}

// ---------------------------------------------------------------------------
//  ③ 接线与回潮：判据只住 scripts/，workflow 只调用
// ---------------------------------------------------------------------------
{
  const wfs = fs.readdirSync(WF_DIR).filter((f) => f.endsWith('.yml'))
    .map((f) => [f, fs.readFileSync(path.join(WF_DIR, f), 'utf8')]);
  const byName = Object.fromEntries(wfs);
  const CALL = /bash scripts\/verify-apk-release-form\.sh[^\n]*/g;
  const calls = (t) => strip(t).match(CALL) || [];

  // 调用点用 readdir 扫**全集**：发布连归一（docs/adr/0011）之后投壳 APK 的链只剩 fast-apk 一条，
  // build-apk 的 gate-form 与 release-admin 的 publish/repack 两处随「它们不再投 APK」一起消失 ——
  // 少的是**口**，不是这把尺子：两侧对照仍在唯一投递口里每次构建都跑。
  const formCallers = wfs.filter(([, t]) => /scripts\/verify-apk-release-form\.sh/.test(t)).map(([f]) => f).sort();
  check('形态门禁只被投壳 APK 的那一条链调用（多一条调用点 = 又多出一条发布口）',
    JSON.stringify(formCallers) === JSON.stringify(['fast-apk.yml']), formCallers.join(','));

  // 唯一投递口不写滚动别名，它的职责是把这把尺子的**两侧**每次构建都验一遍。
  const fa = calls(byName['fast-apk.yml']);
  check('唯一投递口两侧对照：两次调用、恰好一次带对照档',
    fa.length === 2 && fa.filter((c) => /--expect-debuggable/.test(c)).length === 1,
    JSON.stringify(fa));
  // 投出去的与判成 debug 的必须是**同一颗**：多链共尺时靠「档」对齐，单链自己就要对齐取数口。
  // 所以钉的是「debug 取数口只有一个目标」而不是出现几次 —— 归一后每多一个消费步骤
  // （签名、审计、投递…）就多一次同一取数，计数会跟着变，而「所有人拿同一颗」这条不会。
  const picks = (byName['fast-apk.yml'].match(/pick\.sh (apk-debug|apk-release) \S+/g) || []);
  const debugTargets = [...new Set(picks.filter((p) => p.startsWith('pick.sh apk-debug')))];
  const releaseTargets = [...new Set(picks.filter((p) => p.startsWith('pick.sh apk-release')))];
  check('fast-apk 的 debug 取数口只有一个目标（各步骤都拿同一颗，包括形态门禁判的那颗）',
    debugTargets.length === 1, JSON.stringify(debugTargets));
  check('release 变体只被取一次（那次控件构建，AUD-G33 的账）',
    releaseTargets.length === 1, JSON.stringify(releaseTargets));
  // 换成 release 形态投递那天（债 AUD-G33）：上面两条（对照档那一侧、取数口目标）要一起改，
  //   不许只把 --expect-debuggable 删掉留下另一侧 —— 那把「两侧都验」变成「只验一侧」。

  // 先判后发：**签名**门禁必须排在投递之前（签错的包发出去 = 设备身份换掉且不可逆）。
  // 形态门禁刻意排在投递**之后**，且这不是疏漏：本链当前投的就是 debug 形态（AUD-G33 在册），
  //   拿「必须非 debuggable」拦自己会把自己拦死；它拦的是「这把尺子两侧仍有效 + release 变体
  //   构建得出来」。两条次序是**两个判据**，所以这里分开钉，不写成一句「都在上传之前」。
  const pos = (t, re) => { const out = []; let m; while ((m = re.exec(t)) !== null) out.push(m.index); return out; };
  const fsrc = strip(byName['fast-apk.yml']);
  const signAt = pos(fsrc, /bash scripts\/verify-apk-signing\.sh/g);
  const upAt = pos(fsrc, /bash scripts\/gh-release-upload\.sh/g);
  const formAt = pos(fsrc, CALL);
  check('fast-apk：签名门禁排在投递之前（判完再发）',
    signAt.length === 1 && upAt.length >= 1 && upAt.every((u) => u > signAt[0]),
    JSON.stringify({ sign: signAt, uploads: upAt }));
  check('fast-apk：形态门禁的两处调用都排在投递之后（AUD-G33 的知情状态；换了投递形态这条要跟着改）',
    formAt.length === 2 && formAt.every((g) => g > upAt[0]),
    JSON.stringify({ form: formAt, firstUpload: upAt[0] }));

  // 变体构建：唯一投递口两侧都真构建（debug 投递 + release 控件），出 APK 的验证载体链只构建 debug。
  const gradle = (t) => strip(t).match(/\.\/gradlew[^\n]*/g) || [];
  check('build-apk 只构建 debug 验证载体（它不再投 APK；release 变体的控件构建归唯一投递口）',
    gradle(byName['build-apk.yml']).some((c) => /assembleDebug/.test(c))
      && !gradle(byName['build-apk.yml']).some((c) => /assembleRelease/.test(c)),
    JSON.stringify(gradle(byName['build-apk.yml'])));
  check('fast-apk 每次构建都真跑一次 release 变体（发布路径长期不被执行正是 AUD-G33 的成因）',
    gradle(byName['fast-apk.yml']).some((c) => /assembleRelease/.test(c))
      && gradle(byName['fast-apk.yml']).some((c) => /assembleDebug/.test(c)),
    JSON.stringify(gradle(byName['fast-apk.yml'])));

  const INLINE = /dump\s+badging/;
  check('回潮判据自证：内联 badging 解析必被抓',
    INLINE.test('aapt dump badging "$APK" | grep -q application-debuggable'),
    '判据形状与真实写法脱节了');
  check('回潮判据不误伤：宿主调用不含 badging',
    !INLINE.test('bash scripts/verify-apk-release-form.sh "$APK"'),
    '判据太宽会把收口本身抓成回潮');
  const inline = wfs.filter(([, t]) => INLINE.test(t)).map(([f]) => f);
  check('workflow 无内联形态解析回潮（形态判据只住宿主）', inline.length === 0, inline.join(','));
}

fs.rmSync(tmp, { recursive: true, force: true });
finish();
