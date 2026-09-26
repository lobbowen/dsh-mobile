'use strict';

// OTA 公钥锚点宿主（scripts/verify-ota-anchor.sh）的行为自测 + 回潮门禁。
//
// ============================================================================
//  为什么要有这个测试
// ============================================================================
//  「这把公钥能不能用来验我们签的内核」原先在两条 CI 链上各查了一半：build-apk 只在
//  锚点文件缺失时 exit 1，「是不是有效 PEM 公钥」那一问只打 ::warning:: 就继续出包；
//  kernel-ota 只查存在与字节数，从不与签名私钥对照。两边都绿的产物可以是这样的：
//  私钥轮换后重焊了 APK 公钥却忘了改 secret（或反之）—— 签出的每个内核包在所有设备上
//  判 signature-invalid，OTA 静默死亡，而发现它要一轮真机取证。
//  还有一处是两边都没想到的：`openssl pkey -pubin` 对 RSA 公钥一样退 0，所以
//  「有效 PEM 公钥」这句话从来没回答过「能不能验 ed25519 签名」。
//
//  判据现在只住 scripts/verify-ota-anchor.sh 一份。本文件跑在 openssl 现造的临时密钥对上，
//  不碰仓库、不碰任何真凭据；每条都能被证伪（含双向对照组），因为仓里那个锚点只有一份、
//  没法靠它自己暴露「配对判据其实是空转」。
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const makeRunner = require('./harness');

const { check, finish } = makeRunner('ota-anchor');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HOST = path.join(ROOT, 'scripts/verify-ota-anchor.sh');
const REAL_ANCHOR = path.join(ROOT, 'container/app/src/main/assets/ota-public.pem');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-anchor-'));

const ossl = (args) => spawnSync('openssl', args, { encoding: 'utf8' });
const gen = (name, algo = 'ed25519') => {
  const priv = path.join(BASE, name + '-priv.pem');
  const pub = path.join(BASE, name + '-pub.pem');
  const extra = algo === 'ed25519' ? [] : ['-pkeyopt', 'rsa_keygen_bits:2048'];
  const r = ossl(['genpkey', '-algorithm', algo, ...extra, '-out', priv]);
  if (r.status !== 0) return { err: (r.stderr || r.stdout || 'openssl genpkey 失败').trim() };
  const p = ossl(['pkey', '-in', priv, '-pubout', '-out', pub]);
  if (p.status !== 0) return { err: (p.stderr || 'openssl pkey -pubout 失败').trim() };
  return { priv, pub };
};

// ⓪ 前置：openssl 不可用必须**红**，不许把整批断言降级成跳过（那是假绿）。
const opensslOk = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;
check('⓪ openssl 可用（本文件全部用例的前置；缺就红，不许跳过当通过）', opensslOk,
  opensslOk ? undefined : 'PATH 里没有 openssl —— 容器 job 需先跑 bash scripts/ensure-tool.sh openssl openssl');
if (!opensslOk) {
  console.log('（openssl 不可用，后续用例一律不跑 —— 计数里只有上面这一条，红就是红）');
  finish();
}
const A = gen('a');
const B = gen('b');
if (A.err || B.err) {
  check('⓪ 临时密钥对能生成（夹具前置）', false, A.err || B.err);
  finish();
}
check('⓪ 夹具：现造两把互不相同的 ed25519 密钥对', A.priv !== B.priv);

const run = (opts = {}) => {
  const args = [HOST];
  if (opts.anchor) args.push('--anchor', opts.anchor);
  if (opts.private) args.push('--private', opts.private);
  const env = { ...process.env, ...(opts.env || {}) };
  const r = spawnSync('/bin/bash', args, { encoding: 'utf8', env });
  return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const detail = (r) => `\n        rc=${r.rc}\n        ${r.out.trim().split('\n').join('\n        ')}`;
const mk = (name, content) => {
  const p = path.join(BASE, name);
  fs.writeFileSync(p, content);
  return p;
};

// ---------------------------------------------------------------------------
// ① 绿向：锚点有效 / 配对成立 —— 也钉住「按规范化后比」这条实现取向
// ---------------------------------------------------------------------------
{
  const r = run({ anchor: A.pub });
  check('① 只给锚点、算法 Ed25519 → 0', r.rc === 0 && /有效的 Ed25519 公钥/.test(r.out), detail(r));
}
{
  const r = run({ anchor: A.pub, private: A.priv });
  check('① 锚点与私钥配对 → 0', r.rc === 0 && /配对成立/.test(r.out), detail(r));
}
{
  // secret 覆盖写入（build-apk 用 printf '%s' 不带结尾换行）不许造成假红。
  const noNl = mk('anchor-nonl.pem', fs.readFileSync(A.pub, 'utf8').replace(/\n+$/, ''));
  const r = run({ anchor: noNl, private: A.priv });
  check('① 对照组：锚点缺结尾换行也判配对成立（比的是规范化后的公钥，不是文件原文）',
    r.rc === 0 && /配对成立/.test(r.out), detail(r));
}

// ---------------------------------------------------------------------------
// ② 红向：这条批次真正要拦的事 —— 私钥与焊进 APK 的公钥分叉
// ---------------------------------------------------------------------------
{
  const r = run({ anchor: A.pub, private: B.priv });
  const fpPriv = (r.out.match(/派生的公钥指纹 ([0-9a-f]{64})/) || [])[1];
  const fpAnchor = (r.out.match(/锚点指纹 ([0-9a-f]{64})/) || [])[1];
  check('② 私钥派生公钥 ≠ 锚点 → 1，且两个指纹都打出来',
    r.rc === 1 && !!fpPriv && !!fpAnchor && fpPriv !== fpAnchor, detail(r));
  check('② 不配对时把后果写进结论（OTA 静默死亡，而不是「上传失败」）',
    /signature-invalid/.test(r.out), '缺取证线索的红色等于没拦住');
}
{
  const r = run({ anchor: B.pub, private: A.priv });
  check('② 双向对照组：反方向错配（换锚点不换私钥）同样判 1', r.rc === 1 && /不配对/.test(r.out), detail(r));
}
{
  const rsa = gen('rsa', 'rsa');
  if (rsa.err) {
    check('② 对照组：RSA 密钥对能生成（否则下面两条是空转）', false, rsa.err);
  } else {
    const r = run({ anchor: rsa.pub });
    check('② 锚点是合法的 RSA 公钥也判 1（「有效 PEM」≠「能验 ed25519」）',
      r.rc === 1 && /不是 Ed25519/.test(r.out), detail(r));
    const r2 = run({ anchor: A.pub, private: rsa.priv });
    check('② 私钥算法不是 ed25519 → 1（先报算法，不报成「不配对」）',
      r2.rc === 1 && /私钥算法不是 Ed25519/.test(r2.out), detail(r2));
  }
}
{
  const r = run({ anchor: mk('junk.pem', 'not a key at all\n') });
  check('② 锚点读不出公钥 → 1（产物/配置的罪，从前这只是一条 ::warning::）',
    r.rc === 1 && /不是一把可解析的公钥/.test(r.out), detail(r));
}
{
  const r = run({ anchor: path.join(BASE, 'definitely-absent.pem') });
  check('② 锚点文件缺失 → 1（交付缺陷，不是环境档 2）', r.rc === 1 && /锚点缺失或为空/.test(r.out), detail(r));
}
{
  const r = run({ anchor: mk('empty.pem', '') });
  check('② 锚点为空文件 → 1（空文件不是「没有锚点这回事」）', r.rc === 1, detail(r));
}

// ---------------------------------------------------------------------------
// ③ 环境/用法档：读不出来就不放行，且不许伪装成产物的罪
// ---------------------------------------------------------------------------
{
  const r = run({ anchor: A.pub, private: path.join(BASE, 'absent-priv.pem') });
  check('③ 要求配对但私钥文件取不到 → 2（没有私钥 = 判据没法跑，不是配不上）',
    r.rc === 2 && /拒绝签名/.test(r.out), detail(r));
}
{
  const r = run({ anchor: A.pub, private: mk('priv-junk.pem', '-----BEGIN PRIVATE KEY-----\nZm9v\n-----END PRIVATE KEY-----\n') });
  check('③ 私钥读不出公钥 → 2（拿不到派生公钥就无从比对）', r.rc === 2 && /读不出公钥/.test(r.out), detail(r));
}
{
  const r = run({ anchor: A.pub, env: { OPENSSL: '/nonexistent/openssl' } });
  check('③ OPENSSL 指定了却起不来 → 2 环境档', r.rc === 2 && /找不到 openssl/.test(r.out), detail(r));
}
{
  const args = [HOST, '--nope'];
  const r = spawnSync('/bin/bash', args, { encoding: 'utf8' });
  check('③ 未知选项 → 2 并打 usage', r.status === 2 && /不认识的选项/.test(r.stdout + r.stderr));
  const r2 = spawnSync('/bin/bash', [HOST, A.pub], { encoding: 'utf8' });
  check('③ 位置参数 → 2（宿主只管锚点，喂包进去是判据跑错对象）', r2.status === 2 && /不接受位置参数/.test(r2.stdout + r2.stderr));
  const r3 = spawnSync('/bin/bash', [HOST, '--anchor'], { encoding: 'utf8' });
  check('③ --anchor 缺值 → 2', r3.status === 2 && /--anchor 缺值/.test(r3.stdout + r3.stderr));
}

// ---------------------------------------------------------------------------
// ④ 仓库里那份真实锚点：出厂配置漂移即红（夹具证判据，这条证事实源）
// ---------------------------------------------------------------------------
{
  check('④ 出厂锚点存在且非空', fs.existsSync(REAL_ANCHOR) && fs.statSync(REAL_ANCHOR).size > 0, REAL_ANCHOR);
  const r = run({});
  check('④ 出厂锚点过得了宿主（默认路径 = 设备真正会拿到的那一份）', r.rc === 0, detail(r));
}

// ---------------------------------------------------------------------------
// ⑤ 回潮门禁：CI 链与本地签名脚本不许再各写一半判据
// ---------------------------------------------------------------------------
const WF = {
  build: path.join(ROOT, '.github/workflows/build-apk.yml'),
  ota: path.join(ROOT, '.github/workflows/kernel-ota.yml'),
  fast: path.join(ROOT, '.github/workflows/fast-apk.yml'),
};
const BUNDLE = path.join(ROOT, 'scripts/build-kernel-bundle.sh');
// stripComments 的唯一实现住 harness.js（门禁法①，勿在本文件再写第二份）。
const stripComments = makeRunner.stripComments;
{
  const src = {};
  for (const [k, p] of Object.entries(WF)) src[k] = fs.existsSync(p) ? stripComments(fs.readFileSync(p, 'utf8')) : '';
  check('⑤ 三个 workflow 都在（回潮扫描的目标不能指向不存在的文件）', !!src.build && !!src.ota && !!src.fast);
  check('⑤ build-apk 不再把「锚点不是有效公钥」写成 warning 继续出包',
    !/::warning[^\n]*anchor/.test(src.build), '锚点坏 = 所有设备验不过，必须拦');
  check('⑤ kernel-ota 不再只做「锚点存在 + 数字节」',
    !/wc -c[^\n]*ANCHOR/.test(src.ota), '存在性不回答「配不配对」');
  for (const [what, code] of [['build-apk', src.build], ['kernel-ota', src.ota], ['fast-apk', src.fast]]) {
    const calls = (code.match(/bash "?\S*verify-ota-anchor\.sh/g) || []).length;
    check(`⑤ ${what} 调用宿主恰好 1 次`, calls === 1, `实际 ${calls} 次`);
  }
  // 私钥只有签名链拿得到：workflow 里只许 kernel-ota 带 --private，别处不许假装查过。
  check('⑤ 带 --private 的调用只在 kernel-ota（其余两链无从配对）',
    (src.ota.match(/--private/g) || []).length === 1 &&
    (src.build.match(/--private/g) || []).length === 0 &&
    (src.fast.match(/--private/g) || []).length === 0,
    '在没有私钥的地方写配对判据 = 要么空转要么误红');
  // CI 之外的手工/fork 路径也用同一份脚本签名，配对判据必须长在脚本里而非只长在 CI 上。
  const bundle = fs.existsSync(BUNDLE) ? stripComments(fs.readFileSync(BUNDLE, 'utf8')) : '';
  check('⑤ 对照组：build-kernel-bundle.sh 在（扫描目标不能指向不存在的文件）', !!bundle);
  const bundleCalls = (bundle.match(/verify-ota-anchor\.sh/g) || []).length;
  check('⑤ build-kernel-bundle.sh 调用宿主恰好 1 次且带 --private',
    bundleCalls === 1 && /--private/.test(bundle), `实际 ${bundleCalls} 次`);
  check('⑤ 配对判据排在真正签名那一步之前（不配对就不签）',
    bundle.includes('verify-ota-anchor.sh') &&
      bundle.indexOf('verify-ota-anchor.sh') < bundle.indexOf('build-bundle.js'),
    '顺序反了 = 先签出一个没人能验的包再报错');
  const hostSrc = fs.readFileSync(HOST, 'utf8');
  for (const [what, re] of [
    ['锚点缺失判据', /锚点缺失或为空/],
    ['Ed25519 算法判据', /不是 Ed25519/],
    ['配对判据', /不配对/],
  ]) {
    check(`⑤ 对照组：「${what}」的特征确实在 scripts/verify-ota-anchor.sh 里命中`,
      re.test(hostSrc), '否则上面那批「不再内联」断言全是零命中空转');
  }
}

finish();
