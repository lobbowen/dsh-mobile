'use strict';

// 随包原生 ELF 形态门禁（scripts/verify-runtime-elf.sh）的行为自测 + 回潮门禁。
//
// ============================================================================
//  为什么要有这个测试
// ============================================================================
//  这条判据回答的是「这份 .so 装到真机上能不能被跑起来」，答案只有五条：架构、
//  16KB 页对齐、PT_INTERP、DT_NEEDED 闭环、DT_RUNPATH 能否自解析。2026-09-27 之前
//  它有三份实现、两种严格度：release-admin 的 pin 步骤内联写了四条硬红（其中白名单
//  是 scripts/native-deps.txt 那 12 项的第二份副本），构建脚本对同样的 linker64 与
//  16KB 只打 [info]/[warn]，build-apk 又只判架构。同一事实两种结论 = 「构建期说没事、
//  固化期判有罪」，而固化期已是最后还能拦住的地方。现在判据只住宿主一份，五个出口同调。
//
//  收口只是把「一判据一实现」补齐；本文件补的是另一半：**这条门禁真的能红**。
//  宿主只有一处行为此前从未被证伪过 —— 它的判据全靠 readelf 的输出形态，而仓里
//  没有任何 ELF 样本，CI 里它只在真实产物上跑一次（真产物合不合规都不构成对照组）。
//  所以这里用**手工拼的 ELF64 字节**当夹具：五条判据各配一对「该红的红、该绿的红不起来」，
//  对齐那条还专门带了旧实现会误判的两个方向（0x10000 应当放过、混合对齐应当判红）。
//
//  夹具是纯字节，不需要 NDK、不需要网络、不需要真产物，秒级跑完。
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const makeRunner = require('./harness');

const { check, finish } = makeRunner('verify-runtime-elf');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HOST = path.join(ROOT, 'scripts/verify-runtime-elf.sh');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-runtime-elf-'));

// ---------------------------------------------------------------------------
// 最小 ELF64 夹具生成器
// ---------------------------------------------------------------------------
// 只造门禁要看的那几样：ELF 头（e_machine）、Program Headers（PT_LOAD 的 p_align、
// PT_INTERP、PT_DYNAMIC）、以及 .dynamic + .dynstr。没有 section 表（e_shnum=0）——
// readelf -h/-l/-d 全走程序头表，够用。
// 关键约定：每个 PT_LOAD 都覆盖整个文件，且 p_vaddr == p_offset（偏移量恒等），
// 于是 readelf 把 DT_STRTAB 的虚拟地址直接当文件偏移解，字符串才读得出来。
const PT = { LOAD: 1, DYNAMIC: 2, INTERP: 3 };
const DT = { NULL: 0, NEEDED: 1, STRTAB: 5, STRSZ: 10, RPATH: 15, RUNPATH: 29 };

function phdr(type, flags, offset, size, align) {
  const b = Buffer.alloc(56);
  b.writeUInt32LE(type >>> 0, 0);
  b.writeUInt32LE(flags >>> 0, 4);
  b.writeBigUInt64LE(BigInt(offset), 8);
  b.writeBigUInt64LE(BigInt(offset), 16);
  b.writeBigUInt64LE(BigInt(offset), 24);
  b.writeBigUInt64LE(BigInt(size), 32);
  b.writeBigUInt64LE(BigInt(size), 40);
  b.writeBigUInt64LE(BigInt(align), 48);
  return b;
}

function alignUp(v, a) { return Math.ceil(v / a) * a; }

/**
 * @param machine e_machine；默认 183=AArch64，62=x86-64 用来造「架构不对」
 * @param aligns  每个 PT_LOAD 的 p_align（多段即多条）
 * @param interp  PT_INTERP 的字符串；null 表示没有该段
 * @param needed  DT_NEEDED 列表
 * @param runpath/rpath  DT_RUNPATH / DT_RPATH 的值；不给就没有
 * @param dynamic false 表示没有 PT_DYNAMIC（静态产物）；'zero' 表示有表但内容读不出
 */
function elf(o = {}) {
  const machine = o.machine === undefined ? 183 : o.machine;
  const aligns = o.aligns || [0x4000];
  const interp = 'interp' in o ? o.interp : '/system/bin/linker64';
  const needed = o.needed || ['libc.so'];
  const dynamic = o.dynamic === undefined ? true : o.dynamic;
  const runpath = 'runpath' in o ? o.runpath : undefined;
  const rpath = 'rpath' in o ? o.rpath : undefined;

  const strs = [''];
  const push = (s) => { strs.push(s); return s; };
  const offOf = (s) => {
    let off = 0;
    for (const x of strs) { if (x === s) return off; off += x.length + 1; }
    throw new Error('夹具里缺字符串: ' + s);
  };
  for (const n of needed) if (!strs.includes(n)) push(n);
  if (runpath !== undefined && !strs.includes(runpath)) push(runpath);
  if (rpath !== undefined && !strs.includes(rpath)) push(rpath);

  const entries = [];
  if (dynamic === true) {
    // 占位：STRTAB/STRSZ 先记，地址与大小算出来再回填
    entries.push([DT.STRTAB, 'STRTAB'], [DT.STRSZ, 'STRSZ']);
    for (const n of needed) entries.push([DT.NEEDED, offOf(n)]);
    if (rpath !== undefined) entries.push([DT.RPATH, offOf(rpath)]);
    if (runpath !== undefined) entries.push([DT.RUNPATH, offOf(runpath)]);
  }
  entries.push([DT.NULL, 0]);

  const interpLen = interp ? Buffer.byteLength(interp) + 1 : 0;
  const phnum = aligns.length + (interp ? 1 : 0) + (dynamic ? 1 : 0);
  const dataOff = 64 + 56 * phnum;
  const interpOff = interp ? dataOff : 0;
  const strOff = alignUp(dataOff + interpLen, 8);
  const strBuf = Buffer.from(strs.join('\0') + '\0', 'utf8');
  const dynOff = alignUp(strOff + strBuf.length, 8);
  const dynBuf = Buffer.alloc(entries.length * 16);
  entries.forEach(([tag, val], i) => {
    const v = val === 'STRTAB' ? strOff : val === 'STRSZ' ? strBuf.length : val;
    dynBuf.writeBigUInt64LE(BigInt(tag), i * 16);
    dynBuf.writeBigUInt64LE(BigInt(v), i * 16 + 8);
  });

  const total = dynOff + dynBuf.length;
  const buf = Buffer.alloc(total);
  buf.write('\x7fELF', 0, 'binary');
  buf[4] = 2; buf[5] = 1; buf[6] = 1; buf[7] = 0x09;
  buf.writeUInt16LE(3, 16);                 // e_type = DYN（真产物 node 也是 PIE=DYN）
  buf.writeUInt16LE(machine >>> 0, 18);
  buf.writeUInt32LE(1, 20);
  buf.writeBigUInt64LE(BigInt(64), 32);     // e_phoff
  buf.writeBigUInt64LE(BigInt(0), 40);      // e_shoff：没有 section 表
  buf.writeUInt16LE(64, 52);
  buf.writeUInt16LE(56, 54);
  buf.writeUInt16LE(phnum, 56);
  buf.writeUInt16LE(64, 58);

  let p = 64;
  for (const al of aligns) { phdr(PT.LOAD, 7, 0, total, al).copy(buf, p); p += 56; }
  if (interp) { buf.write(interp + '\0', interpOff, 'utf8'); phdr(PT.INTERP, 4, interpOff, interpLen, 1).copy(buf, p); p += 56; }
  // dynamic === 'zero'：留 PT_DYNAMIC 但 p_filesz=0 —— 段在、内容读不出，
  // 这是「取数失败」而不是「静态产物」，门禁必须判红（否则读不出就等于通过）。
  if (dynamic) phdr(PT.DYNAMIC, 6, dynOff, dynamic === 'zero' ? 0 : dynBuf.length, 8).copy(buf, p);
  strBuf.copy(buf, strOff);
  dynBuf.copy(buf, dynOff);
  return buf;
}

// 夹具用的白名单与清单：内容与仓库里那两份同构，但**刻意不共用文件** ——
// 判据要能独立证伪，不能连事实源一起动。
const DEPS = '# 夹具白名单\nlibc.so\nlibm.so\nliblog.so\n';
const MANIFEST = [
  '# 夹具清单',
  '# --- 依赖库（DT_NEEDED，必须与可执行资产同目录）---',
  'libc++_shared.so',
  '# --- 可执行资产本体 ---',
  'libnode.so',
  '',
].join('\n');

function makeCase(files, opts = {}) {
  const c = fs.mkdtempSync(path.join(BASE, 'c'));
  const lib = path.join(c, 'libs');
  fs.mkdirSync(lib);
  for (const [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(lib, name), buf);
  const deps = path.join(c, 'deps.txt');
  const manifest = path.join(c, 'manifest.txt');
  fs.writeFileSync(deps, opts.deps === undefined ? DEPS : opts.deps);
  fs.writeFileSync(manifest, opts.manifest === undefined ? MANIFEST : opts.manifest);
  return { c, lib, deps, manifest };
}

function run(kase, extra = []) {
  const r = spawnSync('bash', [HOST, '--deps', kase.deps, '--manifest', kase.manifest, ...extra, kase.lib],
    { encoding: 'utf8', env: { ...process.env, READELF: process.env.READERLF_BIN || 'readelf' } });
  return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const detail = (r) => `\n        rc=${r.rc}\n        ${r.out.trim().split('\n').join('\n        ')}`;

// ---------------------------------------------------------------------------
// ⓪ 前置：没有 readelf 就跑不出真判据 —— 必须**红**，不许静默跳过变 PASS。
//    （容器 job 在跑本文件前先 scripts/ensure-tool.sh readelf binutils；这一条
//     是第二道保险：漏装就红在这里，而不是红在产物上。）
// ---------------------------------------------------------------------------
const probe = makeCase({ 'libnode.so': elf({ needed: ['libc.so'] }) });
const hasReadelf = run(probe).rc === 0;
check('⓪ readelf 可用（本文件全部用例的前置；缺就红，不许跳过当通过）', hasReadelf,
  hasReadelf ? undefined : 'PATH 里没有 readelf —— 容器 job 需先跑 bash scripts/ensure-tool.sh readelf binutils');
if (!hasReadelf) {
  console.log('（readelf 不可用，后续 20+ 条判据用例无从进行，直接判负退出）');
  finish();
}

// ---------------------------------------------------------------------------
// ① 全绿对照组：合规产物必须放过。这条不成立，后面所有的「红」都不值钱。
// ---------------------------------------------------------------------------
{
  const k = makeCase({
    'libnode.so': elf({ needed: ['libc.so', 'libm.so', 'liblog.so', 'libc++_shared.so'], runpath: '$ORIGIN' }),
    'libc++_shared.so': elf({ interp: null, needed: ['libc.so'] }),
  });
  const r = run(k);
  check('① 五项全合格的目录 → 0', r.rc === 0 && r.out.includes('==> [ok]'), detail(r));
}
{
  // p_align=0x10000（64KB）同样满足 16KB 页。旧实现判的是「输出里存在字符串 0x4000」，
  // 这一份会被它误判成红 —— 夹具就是冲着那个假红写的。
  const k = makeCase({
    'libnode.so': elf({ aligns: [0x10000, 0x10000], needed: ['libc.so'], runpath: '$ORIGIN' }),
  });
  check('① 64KB 对齐（0x10000）也合格 → 0（钉住「按倍数判」而非「找字面量 0x4000」）',
    run(k).rc === 0, detail(run(k)));
}
{
  // 共享库天生没有 PT_INTERP：清单里不是可执行资产就不该要求它。
  // 目录里必须同时放一个合规的可执行资产，否则宿主会先在「没有任何可执行资产」
  // 那条前置判据上退 2 —— 那是对的空转防护，不是本条要判的事。
  const k = makeCase({
    'libnode.so': elf({ needed: ['libc.so'] }),
    'libdshflock.so': elf({ interp: null, needed: ['libc.so', 'liblog.so'] }),
  });
  const r = run(k);
  check('① 非可执行资产缺 PT_INTERP 不判红 → 0（构建脚本原来打 [info] 的那件事）',
    r.rc === 0 && /interp=无\(非可执行资产\)/.test(r.out), detail(r));
}

// ---------------------------------------------------------------------------
// ② 架构
// ---------------------------------------------------------------------------
{
  const k = makeCase({ 'libnode.so': elf({ machine: 62, needed: ['libc.so'] }) });
  const r = run(k);
  check('② e_machine=x86-64 → 1 且报架构', r.rc === 1 && /AArch64/.test(r.out), detail(r));
}

// ---------------------------------------------------------------------------
// ③ 16KB 页对齐
// ---------------------------------------------------------------------------
{
  const k = makeCase({ 'libnode.so': elf({ aligns: [0x1000], needed: ['libc.so'] }) });
  const r = run(k);
  check('③ 唯一 LOAD 段是 4KB 对齐 → 1', r.rc === 1 && /16KB/.test(r.out), detail(r));
}
{
  // 旧写法（grep 存在 0x4000）在这份夹具上是**绿的** —— 一段 0x4000、一段 0x1000，
  // 而它在 16KB 页设备上就是加载不了。逐段取模才拦得住。
  const k = makeCase({ 'libnode.so': elf({ aligns: [0x4000, 0x1000], needed: ['libc.so'] }) });
  const r = run(k);
  check('③ 混合对齐（一段 0x4000、一段 0x1000）→ 1（旧「存在 0x4000 即可」会漏判）',
    r.rc === 1 && /16KB/.test(r.out), detail(r));
}

// ---------------------------------------------------------------------------
// ④ 解释器
// ---------------------------------------------------------------------------
{
  const k = makeCase({ 'libnode.so': elf({ interp: '/lib64/ld-linux-x86-64.so.2', needed: ['libc.so'] }) });
  const r = run(k);
  check('④ 可执行资产的 PT_INTERP 指向 glibc → 1', r.rc === 1 && /不是 bionic 的解释器/.test(r.out), detail(r));
}
{
  // 同样的解释器装在共享库上也要红：判据是「只要声明了就必须是 bionic 的」，
  // 与文件是不是可执行资产无关。（libnode.so 是合规陪衬，为了让目录里有可执行资产。）
  const k = makeCase({
    'libnode.so': elf({ needed: ['libc.so'] }),
    'libc++_shared.so': elf({ interp: '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', needed: ['libc.so'] }),
  });
  const r2 = run(k);
  check('④ 共享库带着 glibc 解释器 → 1（声明了就判，不看身份）',
    r2.rc === 1 && /libc\+\+_shared\.so/.test(r2.out), detail(r2));
}
{
  const k = makeCase({ 'libnode.so': elf({ interp: null, needed: ['libc.so'] }) });
  const r = run(k);
  check('④ 清单说是可执行资产、却没有 PT_INTERP → 1', r.rc === 1 && /PT_INTERP/.test(r.out), detail(r));
}

// ---------------------------------------------------------------------------
// ⑤ DT_NEEDED 闭环（白名单只住 scripts/native-deps.txt，夹具另给一份）
// ---------------------------------------------------------------------------
{
  const k = makeCase({ 'libnode.so': elf({ needed: ['libc.so', 'libtotallymadeup.so'] }) });
  const r = run(k);
  check('⑤ NEEDED 里有「既非系统库、也没随包」的库 → 1 并点名', r.rc === 1 && /libtotallymadeup\.so/.test(r.out), detail(r));
}
{
  // 白名单被清空 = 判据 5 的分支一条都不走 = 空转放行。必须红在「读不出事实源」。
  const k = makeCase({ 'libnode.so': elf({ needed: ['libc.so'] }) }, { deps: '# 只剩注释\n' });
  const r = run(k);
  check('⑤ 白名单文件里没有任何库名 → 2（空名单会让闭环空转）', r.rc === 2 && /native-deps|没有任何库名/.test(r.out), detail(r));
}
{
  const k = makeCase({ 'libnode.so': elf({ needed: ['libc.so'] }) }, { deps: '' });
  check('⑤ 白名单文件不存在 → 2', run({ ...k, deps: path.join(k.c, 'nope.txt') }).rc === 2);
}

// ---------------------------------------------------------------------------
// ⑥ DT_RUNPATH：能否在空环境里自解析同目录依赖（本次收口的起点）
// ---------------------------------------------------------------------------
{
  const k = makeCase({
    'libnode.so': elf({ needed: ['libc.so', 'libc++_shared.so'] }),
    'libc++_shared.so': elf({ interp: null, needed: ['libc.so'] }),
  });
  const r = run(k);
  check('⑥ 依赖同目录随包库却无 DT_RUNPATH → 1', r.rc === 1 && /CANNOT LINK/.test(r.out), detail(r));
}
{
  const k = makeCase({
    'libnode.so': elf({ needed: ['libc.so', 'libc++_shared.so'], runpath: '/data/app/fake/lib/arm64-v8a' }),
    'libc++_shared.so': elf({ interp: null, needed: ['libc.so'] }),
  });
  const r = run(k);
  check('⑥ 有 RUNPATH 但值里没有 $ORIGIN → 1', r.rc === 1 && /RUNPATH/.test(r.out), detail(r));
}
{
  // bionic 忽略 DT_RPATH，链接必须带 -Wl,--enable-new-dtags。这一档不拦住，
  // 三小时 CI 与一轮真机都白跑 —— 判据只认 RUNPATH。
  const k = makeCase({
    'libnode.so': elf({ needed: ['libc.so', 'libc++_shared.so'], rpath: '$ORIGIN' }),
    'libc++_shared.so': elf({ interp: null, needed: ['libc.so'] }),
  });
  const r = run(k);
  check('⑥ 只有 DT_RPATH=$ORIGIN（bionic 忽略它）→ 1 并提示 new-dtags',
    r.rc === 1 && /enable-new-dtags/.test(r.out), detail(r));
}
{
  // 对照组：库存在、但谁也没依赖它 → 不要求 RUNPATH（否则是给「多投一份库」判红）。
  const k = makeCase({
    'libnode.so': elf({ needed: ['libc.so'] }),
    'libc++_shared.so': elf({ interp: null, needed: ['libc.so'] }),
  });
  check('⑥ 没人依赖同目录随包库时不要求 RUNPATH → 0', run(k).rc === 0, detail(run(k)));
}

// ---------------------------------------------------------------------------
// ⑦ 静态产物 / 取数失败：两种「读不出依赖」必须分开
// ---------------------------------------------------------------------------
{
  const k = makeCase({ 'libnode.so': elf({ dynamic: false }) });
  const r = run(k);
  check('⑦ 无 PT_DYNAMIC（静态）→ 0 且打 [skip] 说明只判了三项',
    r.rc === 0 && /\[skip\]/.test(r.out), detail(r));
}
{
  const k = makeCase({ 'libnode.so': elf({ dynamic: 'zero' }) });
  const r = run(k);
  check('⑦ PT_DYNAMIC 在、内容读不出 → 1（取数失败不等于「无依赖」）',
    r.rc === 1 && /读不出动态段/.test(r.out), detail(r));
}

// ---------------------------------------------------------------------------
// ⑧ 用法与环境：读不出来就不放行（退 2），不许「没东西可查」算通过
// ---------------------------------------------------------------------------
{
  const k = makeCase({});
  const r = run(k);
  check('⑧ 目录里没有 .so → 2', r.rc === 2 && /没有任何 \.so/.test(r.out), detail(r));
}
{
  const k = makeCase({ 'libplugin.so': elf({ needed: ['libc.so'] }) });
  const r = run(k);
  check('⑧ 目录里没有清单声明的可执行资产 → 2（判据 3 会整条空转）',
    r.rc === 2 && /可执行资产/.test(r.out), detail(r));
}
{
  const k = makeCase({ 'libnode.so': elf({ needed: ['libc.so'] }) },
    { manifest: '# 只有依赖段\nlibc++_shared.so\n' });
  const r = run(k);
  check('⑧ 清单没有「可执行资产本体」段 → 2（拿空集合当「没有可执行文件」是空转）',
    r.rc === 2 && /可执行资产本体/.test(r.out), detail(r));
}
{
  const k = makeCase({ 'libnode.so': Buffer.from('这不是 ELF，只是一段文本\n', 'utf8') });
  const r = run(k);
  check('⑧ 产物不是 ELF → 1（不是用法问题，是产物不合格）', r.rc === 1 && /不是合法 ELF/.test(r.out), detail(r));
}
{
  const r = run(makeCase({}), ['--nope']);
  check('⑧ 不认识的选项 → 2', r.rc === 2, detail(r));
}
{
  const k = makeCase({ 'libnode.so': elf({ needed: ['libc.so'] }) });
  const r = run(k, [k.lib]);
  check('⑧ 给两个目录参数 → 2（参数错位会让判据跑在错的东西上）', r.rc === 2, detail(r));
}
{
  // 夹具用**合格**产物：这样「退 1 / 报成不是合法 ELF」只可能是工具取数失败造成的，
  // 断言才有方向。拿坏产物当对照组，两条断言都会因为产物自己就该红而空转。
  const k = makeCase({
    'libnode.so': elf({ needed: ['libc.so'], interp: '/system/bin/linker64', runpath: '$ORIGIN' }),
  });
  const checkOk = run(k);
  check('⑧ 对照组：同一份合格夹具在可用 readelf 下退 0', checkOk.rc === 0, detail(checkOk));
  const runWith = (value) => {
    const r = spawnSync('bash', [HOST, '--deps', k.deps, '--manifest', k.manifest, k.lib],
      { encoding: 'utf8', env: { ...process.env, READELF: value } });
    return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const missing = runWith('/nonexistent/readelf');
  check('⑧ READELF 指向不存在的文件 → 2 环境档（不许伪装成产物的罪）',
    missing.rc === 2 && /无法执行/.test(missing.out) && !/不是合法 ELF/.test(missing.out), detail(missing));
  const notExec = path.join(k.c, 'not-executable-readelf');
  fs.writeFileSync(notExec, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(notExec, 0o644);
  const denied = runWith(notExec);
  check('⑧ READELF 不可执行 → 2', denied.rc === 2 && /无法执行/.test(denied.out), detail(denied));
  const broken = runWith('/bin/false');
  check('⑧ READELF 起得来但一定失败 → 2（判「能否执行」而非「是否存在」）',
    broken.rc === 2 && /无法执行/.test(broken.out) && !/不是合法 ELF/.test(broken.out), detail(broken));
}

// ---------------------------------------------------------------------------
// ⑨ 仓库里的那两份真实事实源：白名单与清单必须读得通
//    （夹具验证的是判据；这两条验证的是**出厂配置**不会把判据变成空转。）
// ---------------------------------------------------------------------------
{
  const libs = path.join(BASE, 'real-libs');
  fs.mkdirSync(libs, { recursive: true });
  const real = run({ c: BASE, lib: libs, deps: path.join(ROOT, 'scripts/native-deps.txt'), manifest: path.join(ROOT, '.github/native-assets.txt') });
  check('⑨ 仓库的 native-deps.txt + native-assets.txt 能被宿主读通',
    /系统库白名单/.test(real.out) && /可执行资产/.test(real.out), detail(real));
  fs.writeFileSync(path.join(libs, 'libnode.so'), elf({ needed: ['libm.so', 'libdl.so', 'liblog.so', 'libc++_shared.so', 'libc.so'], runpath: "$ORIGIN" }));
  fs.writeFileSync(path.join(libs, 'libnode.so'), elf({ needed: ['libm.so', 'libdl.so', 'liblog.so', 'libc++_shared.so', 'libc.so'], runpath: "$ORIGIN" }));
  fs.writeFileSync(path.join(libs, 'libc++_shared.so'), elf({ interp: null, needed: ['libc.so', 'libm.so', 'libdl.so'] }));
  const k = { c: BASE, lib: libs, deps: path.join(ROOT, 'scripts/native-deps.txt'), manifest: path.join(ROOT, '.github/native-assets.txt') };
  const r = run(k);
  // 夹具按 2026-09-27 真机产物（libnode 的 NEEDED 五项）抄的：仓库里两份事实源
  // 一改，这条就会红 —— 那正是「白名单漂移」应当暴露的时刻。
  check('⑨ 按真产物 NEEDED 清单抄的夹具过得了出厂白名单（漂移即红）', r.rc === 0, detail(r));
}

// ---------------------------------------------------------------------------
// ⑩ 回潮门禁：ELF 形态判据只准住宿主一份
// ---------------------------------------------------------------------------
// 收口掉的三份内联实现各留了特征串；任何一处回潮 = 同一事实又有了第二种结论。
// 对照组在 ⑩ 末尾：特征串必须**确实存在于宿主**，否则这一批断言是零命中的空转。
const SITES = [
  '.github/workflows/fast-apk.yml',
  '.github/workflows/build-apk.yml',
  '.github/workflows/release-admin.yml',
  'scripts/build-node-android.sh',
];
// 判据特征：对齐值字面量、bionic 解释器路径、把系统库名抄成一份 case 列表。
// 每条都配一个**对照组**（在合法住处必须命中）—— 零命中的「不再内联」断言是空转。
const DEPS_FILE = path.join(ROOT, 'scripts/native-deps.txt');
const SMELLS = [
  ['16KB 对齐判据', /0x4000/, HOST, /%\s*16384/],
  ['bionic 解释器判据', /linker64/, HOST, /system\/bin\/linker64/],
  ['系统库白名单副本', /libc\.so\|libm\.so|libm\.so\|libdl\.so/, DEPS_FILE, /^libm\.so$/m],
];
/** 剥掉整行注释：注释里提这些串是**交代历史**（「原先自己抄了一条…」），不是判据。 */
function stripComments(src) {
  return src.split('\n').filter((l) => !/^\s*(#|\/\/)/.test(l)).join('\n');
}
for (const rel of SITES) {
  const p = path.join(ROOT, rel);
  const exists = fs.existsSync(p);
  check(`${rel} 存在（回潮扫描的目标不能指向不存在的文件）`, exists);
  if (!exists) continue;
  const code = stripComments(fs.readFileSync(p, 'utf8'));
  for (const [what, re] of SMELLS) {
    check(`⑩ ${rel} 不再内联「${what}」`, !re.test(code), `命中：${(code.match(re) || [''])[0]}`);
  }
}
{
  const hostCode = fs.readFileSync(HOST, 'utf8');
  const depsCode = fs.readFileSync(DEPS_FILE, 'utf8');
  for (const [what, , where, controlRe] of SMELLS) {
    const src = where === HOST ? hostCode : depsCode;
    check(`⑩ 对照组：「${what}」的特征在 ${path.relative(ROOT, where)} 里确实命中`,
      controlRe.test(src), '整批「不再内联」断言都会因特征不存在而空转');
  }
}
{
  // 五个出口必须都接上宿主。期望次数写死：少一个出口就少一道判据。
  const CALLERS = [
    ['scripts/build-node-android.sh', 1],
    ['.github/workflows/fast-apk.yml', 1],
    ['.github/workflows/build-apk.yml', 1],
    ['.github/workflows/release-admin.yml', 2],
  ];
  for (const [rel, want] of CALLERS) {
    const p = path.join(ROOT, rel);
    // 只数**调用**（`bash …verify-runtime-elf.sh`），echo 里提路径、注释里讲历史都不算。
    const hits = (stripComments(fs.readFileSync(p, 'utf8')).match(/bash\s+"?\S*verify-runtime-elf\.sh/g) || []).length;
    check(`⑩ ${rel} 调用宿主 ${want} 次`, hits === want, `实际 ${hits} 次`);
  }
}

finish();
