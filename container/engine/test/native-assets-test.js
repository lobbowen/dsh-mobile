'use strict';

// 原生资产清单一致性检查（纯静态，不依赖 Android / 不依赖构建）。
//
// ============================================================================
//  为什么要有这个测试
// ============================================================================
// 「哪些 .so 随包、谁要能 exec、谁依赖谁」这件事，在仓库里以 **5 种形态**存在：
//
//   ① 权威源  NativeAssetRegistry.kt             （Kotlin，运行期校验用）
//   ② 打包豁免 app/build.gradle.kts keepDebugSymbols
//   ③ CI 清单  .github/native-assets.txt          （下载校验 + APK 审计）
//   ④ 系统白名单 scripts/native-deps.txt          （构建期 NEEDED 闭环自检）
//   ⑤ 注入脚本 scripts/inject-libcxx-into-apk.py   （anchor 名字）
//
// 历史上这 5 处是**各自硬编码**的，加第三个二进制要同时改 8 个位置，漏一处
// 就在真机上炸 —— 而且往往不是立刻炸，而是「命中缓存后才炸」这种间歇形态。
//
// 这个测试把 ① 当唯一事实来源，逐项核对 ②③④⑤。**双向**检查：
//   正向 —— 注册表里的每一项，下游是否都有
//   反向 —— 下游里的每一项，注册表是否都声明了（防漏声明）
//
// 它不依赖 Android 运行时，所以能在 CI 的几秒内跑完；而它能拦住的
// 恰恰是「必须跑 3 小时 CI + 真机验证才能发现」的那类问题。
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const makeRunner = require('./harness');

const { check, finish } = makeRunner('native-assets');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------
// 读取权威源：NativeAssetRegistry.kt
// ---------------------------------------------------------------------------

const REGISTRY_KT = path.join(
  ROOT, 'container/app/src/main/java/io/github/lobbowen/dshmobile/native/NativeAssetRegistry.kt'
);

/** 去掉注释（行注释 + 块注释），避免注释里的示例被当成真声明。 */
function stripKotlinComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * 从注册表源码里解析出资产声明。
 *
 * 不引 Kotlin 解析器：这里的形态很固定（`val NAME = NativeExecutable( ... )`），
 * 用「按字段名抽字符串/列表字面量」的方式足够稳，且改坏了会被断言抓到。
 */
function parseRegistry(src) {
  const body = stripKotlinComments(src);
  const assets = [];

  // 匹配 val XXX = NativeExecutable( ... )，括号配对取到对应的 ')'
  const re = /val\s+(\w+)\s*=\s*NativeExecutable\s*\(/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[1];
    let i = re.lastIndex - 1; // 指向 '('
    let depth = 0;
    let end = -1;
    for (; i < body.length; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    const argSrc = body.slice(re.lastIndex, end);

    const strField = (f) => {
      const mm = new RegExp(`\\b${f}\\s*=\\s*"([^"]*)"`).exec(argSrc);
      return mm ? mm[1] : null;
    };
    const listField = (f) => {
      const mm = new RegExp(`\\b${f}\\s*=\\s*(?:listOf|emptyList)\\s*\\(([^)]*)\\)`).exec(argSrc);
      if (!mm) return [];
      return mm[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.replace(/^"|"$/g, ''));
    };
    const boolField = (f) => {
      const mm = new RegExp(`\\b${f}\\s*=\\s*(true|false)`).exec(argSrc);
      return mm ? mm[1] === 'true' : null;
    };

    assets.push({
      varName: name,
      id: strField('id'),
      libName: strField('libName'),
      humanName: strField('humanName'),
      probeArgs: listField('probeArgs'),
      requiredDeps: listField('requiredDeps'),
      required: boolField('required'),
    });
  }
  return assets;
}

if (!fs.existsSync(REGISTRY_KT)) {
  check('注册表文件存在', false, REGISTRY_KT + ' 不存在');
  finish();
  return;
}
const registrySrc = fs.readFileSync(REGISTRY_KT, 'utf8');
const ASSETS = parseRegistry(registrySrc);

// 解析本身必须可信，否则后面的断言全是假绿
check('注册表解析出资产（>=2 项）', ASSETS.length >= 2, `解析到 ${ASSETS.length} 项`);
check(
  '每个资产都有 id / libName / humanName / required',
  ASSETS.every((a) => a.id && a.libName && a.humanName && a.required !== null),
  JSON.stringify(ASSETS.map((a) => ({ id: a.id, libName: a.libName, required: a.required })))
);
check(
  'libName 全部符合 lib*.so 形态（否则 PackageManager 不会解压到 nativeLibraryDir）',
  ASSETS.every((a) => /^lib.*\.so$/.test(a.libName)),
  ASSETS.map((a) => a.libName).join(', ')
);
check(
  'id 唯一',
  new Set(ASSETS.map((a) => a.id)).size === ASSETS.length
);
check(
  'libName 唯一',
  new Set(ASSETS.map((a) => a.libName)).size === ASSETS.length
);

const REGISTRY_LIBNAMES = ASSETS.map((a) => a.libName);
const REGISTRY_DEPS = [...new Set(ASSETS.flatMap((a) => a.requiredDeps))];

// ---------------------------------------------------------------------------
// 读取通用清单读取器
// ---------------------------------------------------------------------------

/** 读 `# 注释 + 每行一项` 形态的清单。 */
function readList(file) {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

// ---------------------------------------------------------------------------
// ① → ③  .github/native-assets.txt
// ---------------------------------------------------------------------------

const ASSETS_TXT = path.join(ROOT, '.github/native-assets.txt');
const manifest = readList(ASSETS_TXT);

check('.github/native-assets.txt 存在', manifest !== null, ASSETS_TXT);
if (manifest) {
  const missing = REGISTRY_LIBNAMES.filter((n) => !manifest.includes(n));
  check(
    '③ 清单 ⊇ 注册表（正向：注册表每项都在清单里）',
    missing.length === 0,
    missing.length ? `清单缺: ${missing.join(', ')}` : ''
  );

  const extra = manifest.filter((n) => !REGISTRY_LIBNAMES.includes(n));
  check(
    '③ 清单 ⊆ 注册表（反向：清单没有注册表未声明的项）',
    extra.length === 0,
    extra.length ? `清单多出: ${extra.join(', ')}（注册表未声明 → CI 下载会 404）` : ''
  );
}

// ---------------------------------------------------------------------------
// ① → ②  app/build.gradle.kts 的 keepDebugSymbols
//
//      gradle 侧已改为直接读 .github/native-assets.txt（nativeAssetNames），
//      所以这里核对的是「gradle 确实在读清单」而非硬编码 —— 防有人图省事改回去。
// ---------------------------------------------------------------------------

const GRADLE_KTS = path.join(ROOT, 'container/app/build.gradle.kts');
check('app/build.gradle.kts 存在', fs.existsSync(GRADLE_KTS));
if (fs.existsSync(GRADLE_KTS)) {
  const g = stripKotlinComments(fs.readFileSync(GRADLE_KTS, 'utf8'));
  check(
    '② keepDebugSymbols 由清单派生（不是硬编码文件名）',
    /keepDebugSymbols\s*\+=\s*nativeAssetNames\(\)\.map/.test(g),
    '期望出现 keepDebugSymbols += nativeAssetNames().map { "**/$it" }'
  );
  check(
    '② nativeAssetNames 读的是 .github/native-assets.txt',
    /native-assets\.txt/.test(g),
    'gradle 里应引用 .github/native-assets.txt'
  );
  check(
    '② 清单缺失时抛异常（不静默降级）',
    /GradleException/.test(g) && /native-assets\.txt/.test(g),
    '缺清单应直接 fail —— 否则会打出看似正常、实则缺符号的 APK'
  );
  // 反向：不应再用 `by lazy` 的委托属性。
  // Gradle Kotlin DSL 里脚本体 `val x by lazy {}` 的委托对象在脚本求值过程中才赋值，
  // 而 packaging { } lambda 会先于该赋值执行 → NPE：
  //   Cannot invoke "kotlin.Lazy.getValue()" because "<local1>" is null
  // CI 真实踩过，故加断言防回归。
  check(
    '② nativeAssetNames 用函数而非 by lazy（避免 Gradle 求值顺序 NPE）',
    /fun\s+nativeAssetNames\s*\(\s*\)\s*:\s*List<String>/.test(g),
    '必须写成 fun nativeAssetNames(): List<String>'
  );
  check(
    '② 未见 `nativeAssetNames` 的 by lazy 委托写法',
    !/val\s+nativeAssetNames[^\n]*by\s+lazy/.test(g),
    'by lazy 会在 packaging{} 求值时抛 Lazy.getValue() NPE'
  );
  // 反向：不应再出现硬编码的 lib*.so 字面量（注释已剥离）
  const hardcoded = [...g.matchAll(/"\*\*\/([^"]+\.so)"/g)].map((m) => m[1]);
  check(
    '② 无硬编码的 keepDebugSymbols 条目',
    hardcoded.length === 0,
    hardcoded.length ? `仍硬编码: ${hardcoded.join(', ')}` : ''
  );
}

// ---------------------------------------------------------------------------
// ① → ④  scripts/native-deps.txt（系统库白名单）
//
//      作用域不同但必须互相自洽：白名单描述「系统提供」，
//      注册表 requiredDeps 描述「我们随包」。二者**不可重叠** ——
//      同一库既说系统提供又说随包，说明有一边错了。
// ---------------------------------------------------------------------------

const DEPS_TXT = path.join(ROOT, 'scripts/native-deps.txt');
const sysDeps = readList(DEPS_TXT);

check('scripts/native-deps.txt 存在', sysDeps !== null, DEPS_TXT);
if (sysDeps) {
  check(
    '④ 白名单非空（清空会让构建期依赖自检失去意义）',
    sysDeps.length > 0
  );
  const overlap = REGISTRY_DEPS.filter((d) => sysDeps.includes(d));
  check(
    '④ 白名单与注册表 requiredDeps 无重叠',
    overlap.length === 0,
    overlap.length
      ? `重叠: ${overlap.join(', ')}（同一库既称系统提供又称随包，必有一边错）`
      : ''
  );
  const dup = sysDeps.filter((d, i) => sysDeps.indexOf(d) !== i);
  check('④ 白名单无重复项', dup.length === 0, dup.join(', '));
}

// ---------------------------------------------------------------------------
// ① → ⑤  scripts/build-node-android.sh / inject-libcxx-into-apk.py
// ---------------------------------------------------------------------------

/**
 * 丢掉整行 `#` 注释（shell / yaml 同形）。
 *
 * 下面的门禁判的是「代码里到底有没有这件事」。注释里写一遍 `--enable-new-dtags`
 * 就当通过了，等于把门禁交给抄写员 —— 先剥注释再匹配。
 */
function stripHashComments(src) {
  return src
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

const BUILD_SH = path.join(ROOT, 'scripts/build-node-android.sh');
if (fs.existsSync(BUILD_SH)) {
  const sh = fs.readFileSync(BUILD_SH, 'utf8');
  check(
    '⑤ 构建脚本读 native-deps.txt（不再 case 硬编码）',
    /native-deps\.txt/.test(sh),
    '期望脚本引用 scripts/native-deps.txt'
  );
  check(
    '⑤ 构建脚本做产物↔清单一致性自检',
    /native-assets\.txt/.test(sh),
    '期望脚本核对 OUT_DIR 与 .github/native-assets.txt'
  );
  check(
    '⑤ 构建脚本不再有硬编码的 case 系统库列表',
    !/libc\.so\|libm\.so\|libdl\.so/.test(sh),
    '旧的 case "libc.so|libm.so|..." 应已移除'
  );

  // ---- 依赖自解析（RUNPATH）：三处共用判据的构建期那一处 ----
  const shCode = stripHashComments(sh);
  // 注入点是 make 命令行变量 LDFLAGS.target=…，不是环境变量 LDFLAGS_target。
  // 后者在这个 gyp 生成器里没有任何规则引用 —— run 36216072106 实测 out/Makefile 只有
  // `LDFLAGS.target ?= $(LDFLAGS)`（目标侧取裸 LDFLAGS）与 `LDFLAGS.host ?= $(LDFLAGS_host)`
  // （只有宿主侧认 _host 后缀），92715 行展开里 -rpath 出现 0 次：那几轮 export 完全空转。
  // 换命令行变量后同一份展开实测：-rpath 出现 21 次，且 `-o …/Release/node` 那 3 行配方里就带着
  // `-Wl,-rpath,'$ORIGIN'`（run 36217430866）—— 所以这条判据钉的是被验过的机制，不是又一猜测。
  // 所以这里既钉住正确写法，也反向钉住死钩子别被「顺手」改回去。
  const ldOverride = (shCode.match(/LDFLAGS_TARGET_OVERRIDE="[^"]*"/g) || []).join(' | ');
  check(
    '⑤ 目标侧链接标志以 make 命令行变量 LDFLAGS.target 赋值（零命中即红，别让正则空转）',
    ldOverride !== '',
    '未找到 LDFLAGS_TARGET_OVERRIDE="LDFLAGS.target=…" 赋值行'
  );
  check('⑤ 链接标志走命令行变量而非死钩子环境变量 LDFLAGS_target',
    !/(?:^|\n)\s*(?:export\s+)?LDFLAGS_target=/.test(shCode),
    'out/Makefile 里没有引用 $(LDFLAGS_target) 的规则：export 它等于什么都没注入'
  );
  check(
    '⑤ 链接期带 --enable-new-dtags',
    /--enable-new-dtags/.test(ldOverride),
    '少了它 -rpath 只写进 DT_RPATH，bionic 无条件忽略 → 真机 CANNOT LINK'
  );
  check(
    '⑤ 链接期带 -rpath 且指向转义后的 $ORIGIN',
    /-rpath/.test(ldOverride) && /\$\{DOLLAR\}\$\{DOLLAR\}ORIGIN/.test(ldOverride),
    `实际赋值: ${ldOverride} —— 这里只钉转义形态（\$\{DOLLAR\}\$\{DOLLAR\}ORIGIN）还在，`
      + '展开是否真的落回 $ORIGIN 由构建脚本自己的 make -n 断言把（静态正则判不出三层展开）'
  );
  // ${DOLLAR} 没定义时上面那串静默变成 -Wl,-rpath,'ORIGIN'：有 RUNPATH、值无用。
  check(
    '⑤ DOLLAR 有定义（上面那串 \$\{DOLLAR\} 的取值来源）',
    /^[ \t]*DOLLAR='\$'[ \t]*$/m.test(shCode),
    "缺少 DOLLAR='$' 赋值行，链接标志里的 rpath 值会退化成字面量 ORIGIN"
  );
  // 断言用 make -n 与真实编译用同一次注入 —— 两边各自写一遍就会漂移：
  // 门禁证明的是 A 构建，出厂的是 B 构建。
  const makeCalls = shCode.split('\n').filter(l => /^[ \t]*make[ \t]/.test(l));
  const makeWithOverride = makeCalls.filter(l => l.includes('$LDFLAGS_TARGET_OVERRIDE'));
  check(
    '⑤ 两条 make 调用（make -n 断言 / 真实编译）都带同一串链接标志注入',
    makeCalls.length === 2 && makeWithOverride.length === 2,
    `make 调用 ${makeCalls.length} 条、带 \$LDFLAGS_TARGET_OVERRIDE 的 ${makeWithOverride.length} 条：`
      + `断言与构建不同源就是漂移。实际行:\n        ${makeCalls.join('\n        ')}`
  );
  check(
    '⑤ 构建脚本调用 verify-runtime-elf.sh 校验产物',
    /verify-runtime-elf\.sh/.test(shCode),
    '产物级校验必须真跑，不能只靠 make -n 推断展开结果'
  );
}

const VALIDATOR_SH = path.join(ROOT, 'scripts/verify-runtime-elf.sh');
// 只断言校验器在场并被各入口调用（下面那个循环）。它自己能不能红，不靠本文件
// 的正则自证 —— 那又是一层「注释当证据」。真判据在 CI 里对真实产物跑一次。
check('⑤ 共用校验器 scripts/verify-runtime-elf.sh 存在', fs.existsSync(VALIDATOR_SH));

// 每一个能把原生产物放进可分发东西的入口，都必须接上同一判据。
// 期望次数写在表里：release-admin 有两个各自独立的出口（pin 固化运行时 / repack 重打包发 APK），
// 只接一个就留一个口子 —— 断言次数而不是断言「出现过」，否则第二个出口被人删掉也不会红。
// 构建期那一处在 build-node-android.sh 里（上面的 ⑤ 已断言）。
const VALIDATOR_CALLERS = [
  ['.github/workflows/fast-apk.yml', 1],
  ['.github/workflows/build-apk.yml', 1],
  ['.github/workflows/release-admin.yml', 2],
];
for (const [wf, want] of VALIDATOR_CALLERS) {
  const p = path.join(ROOT, wf);
  const exists = fs.existsSync(p);
  check(`${wf} 存在`, exists, '调用点清单不能指向不存在的文件 —— 文件没了这条断言就空转');
  if (!exists) continue;
  const hits = (stripHashComments(fs.readFileSync(p, 'utf8'))
    .match(/verify-runtime-elf\.sh/g) || []).length;
  check(
    `${wf} 调用 verify-runtime-elf.sh >= ${want} 次`,
    hits >= want,
    `实际命中 ${hits} 次（期望 >= ${want}）：少一个出口就少一道判据`
  );
}

// build-apk 的 node 缓存不许有前缀回退：key 是 node-android-<版本>-<hashFiles(构建脚本)>，
// key 变了就说明脚本动过，此时前缀回退命中拿到的是**旧脚本的产物** —— 而脚本承载的正是
// 链接标志本身（`LDFLAGS.target=-Wl,-rpath,'$$ORIGIN'`），旧产物没有 $ORIGIN，
// 在 dsh run_code 的空环境里上机即死，而流程看起来和正常命中一模一样。
// 也就是说：回退命中会把「脚本没生效」伪装成「缓存命中」。宁可不缓存，也不许拿旧二进制充数。
const BUILD_APK_YML = path.join(ROOT, '.github/workflows/build-apk.yml');
const fallbackHits = (stripHashComments(fs.readFileSync(BUILD_APK_YML, 'utf8'))
  .match(/restore-keys\s*:/g) || []).length;
check(
  'build-apk 的 node 缓存没有 restore-keys 前缀回退',
  fallbackHits === 0,
  `命中 ${fallbackHits} 处 restore-keys（期望 0）：回退命中会拿旧脚本的二进制冒充缓存命中`
);

// ---------------------------------------------------------------------------
// 门禁：pipefail 之下的「取空即静默终止」赋值形态。
//
//     RPATH_SEEN="$(grep -o ... "$DRY_LOG" | sort -u | tr '\n' ' ')"
//
// grep 零命中返回 1，pipefail 把整条 pipeline 判成 1，赋值继承它，`set -e` 当场终止
// 脚本 —— 于是 CI 日志停在上一句 [ok]，断言块一个字都没打出来（2026-09-26 那一轮
// build-apk 红了 1m16s 就是这么红的），而且紧接着那句 `[ -z "$VAR" ] && 报原因`
// 永不可达：伪装成「有校验」的死代码。构建脚本与 workflow 里同形态的 grep/ls/readelf
// 那一批共 10 处已清掉；find 那一批共 17 处见下面 EMPTY_OK_RISKY 处的说明。两批由同一条判据钉住。
// ---------------------------------------------------------------------------

// 命令替换里的 pipeline，某一段可能因「没找到东西」返回非零 —— 只列真会这样的命令词
// （tr/head/sort 不进名单，否则全是噪音）。
// 盲区必须知道：命令词写在变量里的那一段看不见，例如
//   NEEDED="$("$READELF" -d x 2>/dev/null | awk …)"
// 曾试着把 `"$UPPER_VAR"` 也算可疑词，结果 `sha256sum "$OUT" | cut`、
// `find "$W" -name … | head` 一并误伤 7 处 —— 行正则分不出「段首命令词」与
// 「参数位置」，硬判只会把门禁变成噪音源。这类只能靠人按同一判据复核。
// `find` 打头的那一批（`APK="$(find … | head -1)"`）与 grep 那批是同一件事的另一半：
// 复算得 15 处在 pipefail 生效的块里、另 2 处所在块只是没开 pipefail（形态相同）。
// 它们不再逐处补 `|| true`，而是统一走 scripts/pick.sh —— 那 17 处要的其实是
// 「命中就取一条、没命中要带诊断地失败、多个不同内容要判红」，写成 17 份局部兜底
// 只会各自漂移。find 由此进可疑词：裸形态一律判红。
const EMPTY_OK_RISKY = /(?:^|[\s;|&(])(?:grep|egrep|fgrep|ls|readelf|llvm-readelf|find)(?:\s|$)/;
// 显式容错：`|| true` / `|| :` / `|| exit` / `|| { ...; }`。
const TOLERATED = /\|\|\s*(?:true|:|exit\b|\{)/;
const ASSIGN_SUBST = /^[ \t]*(?:local[ \t]+|export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*="\$\((.*)$/;
const SUBST_CLOSES = /"\s*\)?[ \t]*(?:#.*)?$/;

/**
 * 在一组 shell 行里找「取空即静默终止」的赋值。
 *
 * @param lines  shell 源码行（不含注释剥离 —— 注释里不会有赋值形态，剥了反而漏判）
 * @param offset 首行在文件里的行号（1-based），用于报位置
 */
function findSilentAbortAssignments(lines, offset = 1) {
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ASSIGN_SUBST.exec(lines[i]);
    if (!m) continue;
    const body = [m[1]];
    let j = i;
    while (!SUBST_CLOSES.test(body[body.length - 1]) && j + 1 < lines.length && j - i < 8) {
      j += 1;
      body.push(lines[j].trim());
    }
    const full = body.join(' ');
    // 必须是 pipeline（单条 grep 的赋值由 `VAR="$(grep ... || true)"` 那类兜底覆盖，
    // 且非 pipeline 时 set -e 的触发点仍是赋值本身 —— 这里只钉跨段的那一层）。
    if (!/\|[^|]/.test(full)) continue;
    if (!EMPTY_OK_RISKY.test(full)) continue;
    if (TOLERATED.test(full)) continue;
    bad.push({ line: offset + i, text: full.replace(/\s+/g, ' ').slice(0, 120) });
  }
  return bad;
}

/** 取出 workflow 里所有 run 块；只返回真的开了 pipefail 的那些。 */
function pipefailRunBlocks(ymlPath) {
  const lines = fs.readFileSync(ymlPath, 'utf8').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*(?:-\s*)?run:\s*[|>][-+]?\s*$/.test(lines[i])) {
      const indent = /^\s*/.exec(lines[i])[0].length;
      const body = [];
      let j = i + 1;
      while (j < lines.length) {
        const cur = /^\s*/.exec(lines[j])[0].length;
        if (lines[j].trim() !== '' && cur <= indent) break;
        body.push(lines[j]);
        j += 1;
      }
      if (body.some((l) => /pipefail/.test(l))) blocks.push({ start: i + 2, lines: body });
      i = j;
    } else {
      i += 1;
    }
  }
  return blocks;
}

/** 该 shell 文件是否同时开了 `set -e` 与 pipefail（没开 pipefail 就没有这个坑）。 */
function hasPipefail(src) {
  // 只认两件事：set 的参数里带 e、并且出现 pipefail。字母顺序不猜（-euo、
  // set -e -o pipefail 都算）—— 猜写法会让门禁对某一种拼法静默失明。
  return /(^|\n)[ \t]*set[ \t]+-[a-z]*e[a-z]*(\s|$)/.test(src) && /\bpipefail\b/.test(src);
}

const SH_FILES = [];
(function walkSh(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === 'build') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkSh(p);
    else if (ent.name.endsWith('.sh')) SH_FILES.push(p);
  }
})(ROOT);

const silentAbort = [];
for (const p of SH_FILES) {
  const src = fs.readFileSync(p, 'utf8');
  if (!hasPipefail(src)) continue;
  for (const b of findSilentAbortAssignments(src.split('\n'))) {
    silentAbort.push(`${path.relative(ROOT, p)}:${b.line}  ${b.text}`);
  }
}
const WORKFLOWS = fs.readdirSync(path.join(ROOT, '.github/workflows'))
  .filter((f) => f.endsWith('.yml'))
  .map((f) => path.join(ROOT, '.github/workflows', f));
for (const p of WORKFLOWS) {
  for (const blk of pipefailRunBlocks(p)) {
    for (const b of findSilentAbortAssignments(blk.lines, blk.start)) {
      silentAbort.push(`${path.relative(ROOT, p)}:${b.line}  ${b.text}`);
    }
  }
}
// 对照组：判据本身不能是空转的正则。样本取自本轮真实改掉的那几行（不是编的玩具），
// 违规形态必须各命中 1、改后形态必须各命中 0 —— 两个方向都要成立。
// 少了这一段，「零命中」就可能是检测器写坏了：本轮第一版就是这么红的
// （捕获组下标写错 → 恒不命中，同时把一行无关代码误报成违规）。
const MUST_HIT = [
  'RPATH_SEEN="$(grep -o -- \'-Wl,-rpath,[^ ]*\' "$DRY_LOG" | sort -u | tr \'\\n\' \' \')"',
  '          ASSETS="$(grep -v \'^[[:space:]]*#\' .github/native-assets.txt | grep -v \'^[[:space:]]*$\' | tr -d \'\\r\')"',
  '          NEEDED="$(readelf -d libnode.so 2>/dev/null | awk \'/NEEDED/ {gsub(/[\\[\\]]/,"",$5); print $5}\')"',
  '  READELF="$(ls "$ANDROID_NDK"/toolchains/llvm/prebuilt/*/bin/llvm-readelf 2>/dev/null | head -1)"',
  '          APK="$(find container/app/build/outputs/apk/debug -name \'*.apk\' -type f | head -1)"',
];
const MUST_PASS = [
  'RPATH_SEEN="$( { grep -o -- \'-Wl,-rpath,[^ ]*\' "$DRY_LOG" || true; } | sort -u | tr \'\\n\' \' \')"',
  '          ASSETS="$({ grep -v \'^[[:space:]]*#\' .github/native-assets.txt | grep -v \'^[[:space:]]*$\' || true; } | tr -d \'\\r\')"',
  'FIXED="$(grep -c -- \'-rpath\' "$DRY_LOG" || true)"',
  '          NODE_SO="$(find /tmp/pin/dl -type f -name \'libnode.so*\' | head -1 || true)"',
];
const mustHit = MUST_HIT.map((l) => findSilentAbortAssignments([l]).length);
const mustPass = MUST_PASS.map((l) => findSilentAbortAssignments([l]).length);
// 样本条数写进断言：少了这一条，删掉一个样本仍能 every() 通过，而提示语里的数字开始说谎。
check(
  'pipefail 静默终止门禁的对照组：5 个真实违规形态各命中 1 处',
  MUST_HIT.length === 5 && mustHit.every((n) => n === 1),
  `样本 ${MUST_HIT.length} 条、命中计数 ${JSON.stringify(mustHit)}（期望 5 条各 1）：检测器失效，下面的零命中断言就成了空转`
);
check(
  'pipefail 静默终止门禁的对照组：4 个已兜底形态各命中 0 处',
  MUST_PASS.length === 4 && mustPass.every((n) => n === 0),
  `样本 ${MUST_PASS.length} 条、命中计数 ${JSON.stringify(mustPass)}（期望 4 条各 0）：判据过宽会把门禁变成噪音源`
);
check(
  'pipefail 生效的脚本里没有「$(grep/ls/find/readelf … | …)」这种取空即静默终止的赋值',
  silentAbort.length === 0,
  silentAbort.length
    ? `命中 ${silentAbort.length} 处：pipefail + set -e 之下，这一段会在下一行判空之前`
      + '终止脚本且不打诊断，其后的错误分支永不可达。find 打头的那一类改走 scripts/pick.sh\n        '
      + silentAbort.join('\n        ')
    : '零命中'
);

// 判据把裸 find 形态判红之后，唯一的合法出口是 scripts/pick.sh。宿主脚本一旦被删，
// 全仓调用点会在 CI 里以「bash: scripts/pick.sh: No such file」的形式红 ——
// 但那条红出现在各发布路径深处，不如在这里红得直白。
const PICK_SH = path.join(ROOT, 'scripts/pick.sh');
check('scripts/pick.sh 存在（find 命中取的唯一宿主）', fs.existsSync(PICK_SH));
if (fs.existsSync(PICK_SH)) {
  const pick = fs.readFileSync(PICK_SH, 'utf8');
  // 只钉调用方依赖的那一层契约：两个开关的 case 分支还在。
  // 刻意不钉诊断文案 —— 钉字符串会把注释改动变成门禁红。
  check(
    'pick.sh 仍认得 --last 与 --allow-empty 两个开关（17 个调用点按这两个写法传参）',
    /--last\)/.test(pick) && /--allow-empty\)/.test(pick)
  );

  // 宿主脚本真的跑一遍。为什么要跑：它是 17 个发布调用点唯一的出口，而那些路径要么几十分钟
  // 起步（build-apk）、要么按需才触发（release-admin）—— 只把「调用点已换成它」当作已验证，
  // 等于把宿主脚本自身的对错留给一次漫长的构建去发现。
  const pickTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'));
  const mk = (rel, content) => {
    const p = path.join(pickTmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  mk('one/a.apk', 'A');
  mk('same/a.apk', 'A');
  mk('same/b.apk', 'A');
  mk('multi/a.apk', 'A');
  mk('multi/b.apk', 'B');
  mk('bt/34.0.0/x', 'old');
  mk('bt/35.0.1/x', 'new');
  fs.mkdirSync(path.join(pickTmp, 'empty'), { recursive: true });

  /** 跑一次 pick.sh，把「退出码 / stdout / stderr」三样都带回来 —— 三种结局全靠它们区分。 */
  // 用 spawnSync 不用 execFileSync：后者成功时只回 stdout，而这里一半的断言要看的是
  // 成功路径上那行 ::warning（诊断恰恰在成功时才最有意义）。
  const runPick = (args) => {
    const r = spawnSync('bash', [PICK_SH, ...args], { encoding: 'utf8' });
    return { rc: r.status === null || r.status === undefined ? -1 : r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '') };
  };
  const hit = runPick(['t-hit', path.join(pickTmp, 'one'), '-name', '*.apk', '-type', 'f']);
  check('pick.sh：命中一条 → 退出 0 且 stdout 就是那条路径',
    hit.rc === 0 && hit.out === path.join(pickTmp, 'one', 'a.apk'), JSON.stringify(hit));
  const zero = runPick(['t-zero', path.join(pickTmp, 'empty'), '-name', '*.apk', '-type', 'f']);
  check('pick.sh：零命中默认判红（不是打空串继续走）',
    zero.rc === 1 && zero.out === '' && zero.err.includes('::error title=pick(t-zero)'), JSON.stringify(zero));
  const zeroSoft = runPick(['--allow-empty', 't-soft', path.join(pickTmp, 'empty'), '-name', '*.apk', '-type', 'f']);
  check('pick.sh：--allow-empty 把零命中降为一行 warning，交回调用方判空',
    zeroSoft.rc === 0 && zeroSoft.out === '' && zeroSoft.err.includes('::warning title=pick(t-soft)'), JSON.stringify(zeroSoft));
  const dup = runPick(['t-dup', path.join(pickTmp, 'same'), '-name', '*.apk', '-type', 'f']);
  check('pick.sh：多命中但内容同一 → 无害，照常取一条（不因为条数判红）',
    dup.rc === 0 && dup.out !== '', JSON.stringify(dup));
  const ambig = runPick(['t-ambig', path.join(pickTmp, 'multi'), '-name', '*.apk', '-type', 'f']);
  check('pick.sh：多命中且内容不同 → 判红并列候选（head -1 的随机顺序不许当结论）',
    ambig.rc === 1 && ambig.err.includes('内容不同'), JSON.stringify(ambig).slice(0, 300));
  const newest = runPick(['--last', 't-last', path.join(pickTmp, 'bt'), '-name', 'x', '-type', 'f']);
  check('pick.sh：--last 按版本取末位（多个 build-tools / NDK 版本时取最新）',
    newest.rc === 0 && newest.out.includes('35.0.1'), JSON.stringify(newest));
  const partial = runPick(['--allow-empty', '--last', 't-partial',
    path.join(pickTmp, 'no-such-root'), path.join(pickTmp, 'bt'), '-name', 'x', '-type', 'f']);
  check('pick.sh：多根探测里某个根不存在 → 有命中就照常取，只记一行 find 部分失败',
    partial.rc === 0 && partial.out.includes('35.0.1') && partial.err.includes('find 部分失败'),
    JSON.stringify(partial).slice(0, 300));
  const noargs = runPick(['t-noargs']);
  check('pick.sh：没有传给 find 的参数（上游变量为空）→ 退出 2 直接说清',
    noargs.rc === 2 && noargs.err.includes('t-noargs'), JSON.stringify(noargs));
  const badlabel = runPick([]);
  check('pick.sh：缺标签 → 退出 2（不许把开关当成标签）',
    badlabel.rc === 2 && badlabel.err.includes('缺标签'), JSON.stringify(badlabel));
  // 标签与开关的先后顺序不限：`pick.sh --last apksigner …` 这种顺手写法一旦按位置解析，
  // "apksigner" 会变成第一个 find 探测根，红点就落在完全无关的地方。
  const flagFirst = runPick(['--last', 't-order', path.join(pickTmp, 'bt'), '-name', 'x', '-type', 'f']);
  check('pick.sh：开关写在标签前面也能正确解析',
    flagFirst.rc === 0 && flagFirst.out.includes('35.0.1'), JSON.stringify(flagFirst));
}

// ── apk-latest 的版本门禁：判据只住 scripts/verify-apk-version-gate.sh，四个发布口共用 ──
// 为什么要在 CI 里跑它：写 apk-latest 的四条链路（fast-apk / build-apk / release-admin 的
// publish 与 repack）里，只有 fast-apk 会在每次合并后被真实触发，其余三条要么几十分钟起步、
// 要么按需才跑。把「比较版本号」留在各条 workflow 里 = 只有被触发过的那份才是真的在判。
const VGATE = path.join(ROOT, 'scripts', 'verify-apk-version-gate.sh');
check('版本门禁宿主脚本存在', fs.existsSync(VGATE));
if (fs.existsSync(VGATE)) {
  const vTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vgate-'));
  const vk = (rel, vc) => {
    const p = path.join(vTmp, rel);
    fs.writeFileSync(p, JSON.stringify({ shell: { versionName: '9.9.9', versionCode: vc } }));
    return p;
  };
  const v8 = vk('new8.json', 8), v7 = vk('pub7.json', 7), v6 = vk('new6.json', 6), vSame = vk('same.json', 7);
  const vBad = path.join(vTmp, 'bad.json');
  fs.writeFileSync(vBad, '{"shell":{"versionName":"7"}}');
  const vNotInt = path.join(vTmp, 'notint.json');
  fs.writeFileSync(vNotInt, '{"shell":{"versionCode":"7-beta"}}');
  const runV = (args) => {
    const r = spawnSync('bash', [VGATE, ...args], { encoding: 'utf8' });
    return { rc: r.status === null ? -1 : r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '') };
  };

  const up = runV([v8, v7, 'auto']);
  check('版本门禁：前进放行并打出两端的数', up.rc === 0 && up.out.includes('版本前进（7 → 8）'), JSON.stringify(up));
  // 同版本这一格**只按通道分叉**，两侧都跑：只测「显式放行」就等于把自动通道的红写成了装饰。
  const sameExplicit = runV([vSame, v7, 'explicit']);
  check('版本门禁：同版本 + 显式通道放行（修复投递/重传是正当用途）',
    sameExplicit.rc === 0 && sameExplicit.out.includes('同版本重发'), JSON.stringify(sameExplicit));
  const sameAuto = runV([vSame, v7, 'auto']);
  check('版本门禁：同版本 + 自动通道判红（动了 APK 内容就必须 bump）',
    sameAuto.rc === 1 && sameAuto.err.includes('release.md'), JSON.stringify(sameAuto));
  const backAuto = runV([v6, v7, 'auto']);
  const backExplicit = runV([v6, v7, 'explicit']);
  check('版本门禁：回退两种通道都判红（不可逆，显式通道也不放过）',
    backAuto.rc === 1 && backExplicit.rc === 1
      && backAuto.err.includes('不可逆') && backExplicit.err.includes('不可逆'),
    JSON.stringify({ auto: backAuto.rc, explicit: backExplicit.rc }));
  const firstExplicit = runV([v8, '-', 'explicit']);
  check('版本门禁：线上无清单 + 显式通道放行（首次发布）',
    firstExplicit.rc === 0 && firstExplicit.out.includes('显式通道放行'), JSON.stringify(firstExplicit));
  const firstAuto = runV([v8, '-', 'auto']);
  check('版本门禁：线上无清单 + 自动通道判红（不许把「不知道线上是什么」发成正常）',
    firstAuto.rc === 1, JSON.stringify(firstAuto));
  // 退 2 = 「无从校验」，与退 1「判红」分开：调用方两种都不许发，但红点位置不同。
  check('版本门禁：本次清单缺 versionCode → 退 2（无从校验不放行）',
    runV([vBad, v7, 'auto']).rc === 2, JSON.stringify(runV([vBad, v7, 'auto'])));
  check('版本门禁：versionCode 非整数 → 退 2（字符串比较会把 10 判成小于 9）',
    runV([vNotInt, v7, 'auto']).rc === 2, JSON.stringify(runV([vNotInt, v7, 'auto'])));
  check('版本门禁：线上清单坏了 → 退 2（清单丢失不等于首次发布）',
    runV([v8, vBad, 'explicit']).rc === 2, JSON.stringify(runV([v8, vBad, 'explicit'])));
  check('版本门禁：本次清单文件不存在 → 退 2',
    runV([path.join(vTmp, 'nope.json'), v7, 'auto']).rc === 2);
  check('版本门禁：通道词不认 → 退 2（少一个通道就等于自动走放行那侧）',
    runV([v8, v7, 'sometimes']).rc === 2);

  // 接线：三条会写 apk-latest 的 workflow 必须都调宿主；且任何一份都不许再自己比较版本号。
  const VG_FILES = ['fast-apk.yml', 'build-apk.yml', 'release-admin.yml'];
  // 只认**命令行形态**的调用（行首可有 `if !`），注释里提一句脚本名不算接线 ——
  // 否则改天谁把调用删掉、只留着那行解释性注释，这条门禁照样绿。
  const VCALL = /^[^\S\n]*(?:if\s+!\s+)?bash\s+scripts\/check-apk-release-version\.sh\s+.*"\$TAG"/m;
  for (const f of VG_FILES) {
    const src = fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8');
    check(`版本门禁接线：${f} 真的调用取数外壳`, VCALL.test(src), '找不到 bash scripts/check-apk-release-version.sh … "$TAG" 的调用行');
    check(`版本门禁内联复写清零：${f} 不再自己比 versionCode`,
      !/-lt\s+"\$PVC"|-eq\s+"\$PVC"|-lt\s+"\$VC"|-eq\s+"\$VC"/.test(src),
      '同一判据出现第二份拷贝 = 缺陷（门禁法 §7.1）');
    // 「取来源 run 那份清单」也只能有一处：调用点自己抄一次 gh 取数，就会发出
    // 一份和门禁判定用不同源的清单（两次取数可以各自漂移）。出口是 VG_SRC_DIR。
    check(`版本门禁取数复写清零：${f} 不自己取线上/来源清单`,
      !src.includes('contents/version.json?ref='),
      '取数应走 scripts/check-apk-release-version.sh 的 VG_SRC_DIR 出口');
  }
  // 对照组自证：把注释里的脚本名当成接线，正是这条门禁要抓的失效形态 —— 拿一份「只有注释、
  // 没有调用」的样本验它会红，再拿真调用验它不会误红。
  check('版本门禁接线断言自证：只有注释提及 → 判红',
    !VCALL.test('  # 判据 scripts/verify-apk-version-gate.sh\n  # bash scripts/check-apk-release-version.sh version.json "$TAG" auto\n'));
  check('版本门禁接线断言自证：真调用行（含 if ! 包裹）→ 放行',
    VCALL.test('          bash scripts/check-apk-release-version.sh version.json "$TAG" "$VCHANNEL"')
      && VCALL.test('          if ! bash scripts/check-apk-release-version.sh version.json "$TAG" explicit; then'));
  fs.rmSync(vTmp, { recursive: true, force: true });
}

// ── 线上资产读取的三态分类：scripts/read-release-asset.sh（APK 与内核两条发布链共用）──
// 为什么单独跑它：调用方拿到退码后做的事完全不同（0=比 / 10=按首次发布放行 / 2=禁止发布）。
// 旧写法把 2 折进 10 再打一句 ::warning —— 于是「GitHub 刚才没答上来」被当成「这个通道还没发过」，
// 门禁就地失效而流水线全绿。分类只在这一处，所以它必须能被假 gh 逐态跑红。
const RRA = path.join(ROOT, 'scripts', 'read-release-asset.sh');
check('线上资产读取宿主 scripts/read-release-asset.sh 存在', fs.existsSync(RRA));
if (fs.existsSync(RRA)) {
  const rTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rra-'));
  // 假 gh：只看 `gh release view|download` 两条，行为由环境变量选档（不碰网络、不碰真凭据）。
  const fakeBin = path.join(rTmp, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'gh'), [
    '#!/usr/bin/env bash',
    'set -u',
    'sub="${2:-}"; out=""; prev=""',
    'for a in "$@"; do [ "$prev" = "-O" ] && out="$a"; prev="$a"; done',
    'case "${RR_FAKE:-}" in',
    '  ok)               [ "$sub" = "download" ] && printf \'{"version":"0.1.0-android.13"}\' > "$out"; exit 0 ;;',
    '  no_release)       [ "$sub" = "view" ] && { echo "gh: Release not found: apk-latest" >&2; exit 1; }; exit 0 ;;',
    '  no_asset)         [ "$sub" = "download" ] && { echo "HTTP 404: Not Found" >&2; exit 1; }; exit 0 ;;',
    '  transport)        [ "$sub" = "download" ] && { echo "error: Post \\"https://api.github.com/...\\": dial tcp: lookup api.github.com: no such host" >&2; exit 1; }; exit 0 ;;',
    '  rate_limited)     [ "$sub" = "view" ] && { echo "HTTP 403: rate limit exceeded" >&2; exit 1; }; exit 0 ;;',
    '  *)                exit 0 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });

  // 三个 helper 同形（rc/out/err）：spawnSync 的原始结果里那两格叫 stdout/stderr，
  // 直接往上层断言写 r.err 会在「第一格需要看 stderr 的断言」处当场抛 TypeError，
  // 于是整轮测试崩在中间 —— 收口到一处包装，别让每个调用点各自记字段名。
  const rra = (argv, extraEnv) => {
    const r = spawnSync('bash', [RRA, ...argv], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: fakeBin + path.delimiter + process.env.PATH,
        GITHUB_REPOSITORY: 'lobbowen/dsh-mobile',
        ...extraEnv,
      },
    });
    return { rc: r.status === null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
  };
  const runRra = (mode, dir) => rra(['t-' + mode, 'apk-latest', 'version.json', dir], { RR_FAKE: mode });

  const dOk = path.join(rTmp, 'ok');
  const ok = runRra('ok', dOk);
  check('取数三态：线上有资产 → 退 0 且真名文件落地（调用方要读的就是这个路径）',
    ok.rc === 0 && fs.readFileSync(path.join(dOk, 'version.json'), 'utf8').includes('android.13'),
    JSON.stringify(ok));
  const dMiss = path.join(rTmp, 'norel');
  const noRel = runRra('no_release', dMiss);
  check('取数三态：Release 不存在 → 退 10（首次发布是合法状态，不是失败）',
    noRel.rc === 10, JSON.stringify(noRel));
  const dNoAsset = path.join(rTmp, 'noasset');
  const noAsset = runRra('no_asset', dNoAsset);
  check('取数三态：Release 在但资产不在 → 退 10（同上，走门禁的首次发布分支）',
    noAsset.rc === 10, JSON.stringify(noAsset));
  const dNet = path.join(rTmp, 'net');
  const net = runRra('transport', dNet);
  check('取数三态：gh 因网络失败 → 退 2 并打 ::error（旧实现把这一格降成 warning 后照发）',
    net.rc === 2 && net.err.includes('::error') && net.err.includes('不是「资产不存在」'),
    JSON.stringify(net));
  const dRate = path.join(rTmp, 'rate');
  const rate = runRra('rate_limited', dRate);
  check('取数三态：403 限流 → 退 2（含 4xx 字样也不算「不存在」）',
    rate.rc === 2 && rate.err.includes('::error'), JSON.stringify(rate));
  const noRepo = rra(['t-norepo', 'apk-latest', 'version.json', path.join(rTmp, 'x')], { GITHUB_REPOSITORY: '' });
  check('取数三态：没有 GITHUB_REPOSITORY → 退 2（不许把仓库猜成默认值）',
    noRepo.rc === 2 && noRepo.err.includes('GITHUB_REPOSITORY'), JSON.stringify(noRepo));
  const shortArgs = rra(['t-few', 'apk-latest'], {});
  check('取数三态：参数不齐 → 退 2 并打用法',
    shortArgs.rc === 2 && shortArgs.err.includes('用法'), JSON.stringify(shortArgs));

  // 分类只准住一处：调用方再写一遍「404 / no assets」就等于两个真相。
  const CLASSIFIER = /no assets|matching pattern|HTTP 404/i;
  const scanned = ['.github/workflows/fast-apk.yml', '.github/workflows/build-apk.yml',
    '.github/workflows/release-admin.yml', '.github/workflows/kernel-ota.yml',
    'scripts/check-apk-release-version.sh'];
  for (const rel of scanned) {
    check(`取数分类复写清零：${rel} 不再自己判「不存在 vs 取不到」`,
      !CLASSIFIER.test(stripHashComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'))),
      '该分类唯一宿主是 scripts/read-release-asset.sh（退 10 = 不存在，退 2 = 看不清）');
  }
  check('取数分类断言自证：违规样本确实会红',
    CLASSIFIER.test('if grep -qiE "HTTP 404|no assets" "$DIR/err"; then'));
  // 接线：调用点必须真有一行命令式调用。只扫「文件里出现过脚本名」= 把注释当成接线，
  // 谁哪天删掉调用、留着那行解释，门禁照样绿（VCALL 那条钉过的同一失效形态）。
  const RRACALL = /^[^\S\n]*bash\s+"?(?:scripts|\$\(dirname "\$0"\))\/read-release-asset\.sh/m;
  for (const rel of ['.github/workflows/kernel-ota.yml', 'scripts/check-apk-release-version.sh']) {
    check(`取数宿主接线：${rel} 真的调用 read-release-asset.sh`,
      RRACALL.test(stripHashComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'))),
      '找不到 bash …/read-release-asset.sh 的调用行');
  }
  check('取数宿主接线断言自证：只有注释提及 → 判红',
    !RRACALL.test('  # 分类住 scripts/read-release-asset.sh\n  # bash scripts/read-release-asset.sh k "$R" m.json "$T"\n'));
  check('唯一宿主里三种结局都还在（退 10 与退 2 少一个就退化成旧缺陷）',
    /exit 10/.test(fs.readFileSync(RRA, 'utf8')) && /exit 2/.test(fs.readFileSync(RRA, 'utf8')));
  fs.rmSync(rTmp, { recursive: true, force: true });
}

// 运行期探针必须与 run_code 同形：裸环境。补 LD_LIBRARY_PATH = 给被测对象装脚手架。
const PREPARER_KT = path.join(
  ROOT, 'container/app/src/main/java/io/github/lobbowen/dshmobile/native/NativePreparer.kt'
);
if (fs.existsSync(PREPARER_KT)) {
  const kt = stripKotlinComments(fs.readFileSync(PREPARER_KT, 'utf8'));
  check('① 探针清空进程环境（environment().clear()）', /environment\(\)\s*\.\s*clear\(\)/.test(kt));
  check(
    '① 探针不再自行补 LD_LIBRARY_PATH（那会掩盖空环境下的链接失败）',
    !/environment\(\)\s*\[\s*"LD_LIBRARY_PATH"/.test(kt),
    'NativePreparer.probe 必须与 dsh run_code 的裸环境同形'
  );
}

const INJECT_PY = path.join(ROOT, 'scripts/inject-libcxx-into-apk.py');
if (fs.existsSync(INJECT_PY)) {
  const py = fs.readFileSync(INJECT_PY, 'utf8');
  // anchor 必须指向注册表里真实存在的资产（当前是 libnode.so）
  const anchorMatch = /anchor\s*=\s*\(?'lib\/%s\/([^']+)'/.exec(py);
  check('⑤ inject 脚本的 anchor 可解析', anchorMatch !== null);
  if (anchorMatch) {
    check(
      '⑤ inject 脚本 anchor 指向注册表内资产',
      REGISTRY_LIBNAMES.includes(anchorMatch[1]),
      `anchor=${anchorMatch[1]}，注册表=${REGISTRY_LIBNAMES.join(', ')}`
    );
  }
  const target = /new_name\s*=\s*\(?'lib\/%s\/([^']+)'/.exec(py);
  check('⑤ inject 脚本的注入目标可解析', target !== null);
  if (target) {
    check(
      '⑤ inject 脚本注入目标在注册表 requiredDeps 内（它是依赖而非本体）',
      REGISTRY_DEPS.includes(target[1]),
      `注入 ${target[1]}，requiredDeps=${REGISTRY_DEPS.join(', ')}`
    );
  }
}

// ---------------------------------------------------------------------------
// ① → Kotlin 侧：硬编码文件名应已清除
//
//   NativeAssetRegistry.kt 自身除外（它就是定义处）。
// ---------------------------------------------------------------------------

const KT_DIR = path.join(ROOT, 'container/app/src/main/java/io/github/lobbowen/dshmobile');
const REGISTRY_BASENAME = 'NativeAssetRegistry.kt';

/** 递归收集 .kt 文件。 */
function walkKt(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkKt(p));
    else if (e.name.endsWith('.kt')) out.push(p);
  }
  return out;
}

if (fs.existsSync(KT_DIR)) {
  const offenders = [];
  for (const f of walkKt(KT_DIR)) {
    if (path.basename(f) === REGISTRY_BASENAME) continue;
    const body = stripKotlinComments(fs.readFileSync(f, 'utf8'));
    // 在【字符串字面量】里出现资产文件名 = 硬编码
    for (const asset of ASSETS) {
      if (body.includes(`"${asset.libName}"`)) {
        offenders.push(`${path.relative(ROOT, f)} → "${asset.libName}"`);
      }
    }
  }
  check(
    'Kotlin 侧无硬编码资产文件名（改由注册表派生）',
    offenders.length === 0,
    offenders.length ? offenders.join('; ') : ''
  );
}

// ---------------------------------------------------------------------------
// ① → Node 侧 mock：server.js 的 sys.nativeAssets 必须与注册表同形
// ---------------------------------------------------------------------------

const SERVER_JS = path.join(ROOT, 'container/engine/src/bridge/server.js');
if (fs.existsSync(SERVER_JS)) {
  const js = fs.readFileSync(SERVER_JS, 'utf8');
  check(
    'Node mock 有 sys.nativeAssets 分支',
    /case\s+'sys\.nativeAssets'/.test(js)
  );
  const missingMock = ASSETS.filter((a) => !js.includes(`'${a.libName}'`));
  check(
    'Node mock 覆盖注册表全部资产',
    missingMock.length === 0,
    missingMock.length
      ? `mock 缺: ${missingMock.map((a) => a.libName).join(', ')}`
      : ''
  );
}

// ── ⑨ 判据副本收口（门禁法①）：工具安装探测 / 版本事实源读法各留唯一宿主 ──
// 为什么要在这里跑宿主脚本而不是只 grep 调用点：这三条链里只有 fast-apk 会被高频触发，
// 「副本已删 + 宿主行为正确」如果只在偶尔跑的 workflow 里才第一次被验证，等于没验证。
const ENSURE_TOOL = path.join(ROOT, 'scripts', 'ensure-tool.sh');
check('工具安装探测宿主 scripts/ensure-tool.sh 存在', fs.existsSync(ENSURE_TOOL));
if (fs.existsSync(ENSURE_TOOL)) {
  const eTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-'));
  const bin = path.join(eTmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // PATH 里只放一个假 readelf、不放 sudo：走了安装分支必然 command-not-found，
  // 所以「退出 0 且 stdout 空」只可能来自"工具已在 → 完全不碰 apt"这一条路。
  // 用绝对路径起 bash：Node 对 env.PATH 的覆盖会同时作用于可执行文件查找，
  // 只给 PATH=假 bin 时 'bash' 自身会 ENOENT（首轮 CI 就是这么红的）。
  fs.writeFileSync(path.join(bin, 'readelf'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const okRun = spawnSync('/bin/bash', [ENSURE_TOOL, 'readelf', 'binutils'], { encoding: 'utf8', env: { PATH: bin } });
  check('ensure-tool：工具已在 → 退出 0 且无任何安装动作',
    okRun.status === 0 && String(okRun.stdout || '').trim() === '',
    JSON.stringify({ rc: okRun.status, out: String(okRun.stdout || ''), err: String(okRun.stderr || '').slice(0, 120) }));
  const empty = path.join(eTmp, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  const miss = spawnSync('/bin/bash', [ENSURE_TOOL, 'readelf', 'binutils'], { encoding: 'utf8', env: { PATH: empty } });
  check('ensure-tool：工具缺失 → 报"缺少"并尝试安装（安装不可得时如实非零，不静默放行）',
    miss.status !== 0 && String(miss.stdout || '').includes('缺少 readelf'),
    JSON.stringify({ rc: miss.status, out: String(miss.stdout || ''), err: String(miss.stderr || '').slice(0, 120) }));
  const noargs = spawnSync('bash', [ENSURE_TOOL], { encoding: 'utf8' });
  check('ensure-tool：缺参数 → 非零并打 usage', noargs.status !== 0,
    JSON.stringify({ rc: noargs.status }));
  fs.rmSync(eTmp, { recursive: true, force: true });
}

const RNV = path.join(ROOT, 'scripts', 'read-node-versions.sh');
check('版本事实源读取宿主 scripts/read-node-versions.sh 存在', fs.existsSync(RNV));
if (fs.existsSync(RNV)) {
  const truth = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'container/app/src/main/assets/node-versions.json'), 'utf8'));
  // cwd 故意设到子目录：宿主按自身位置定位仓库根，不依赖 cwd（三条链的 working-directory 不同）。
  const runR = (args) => {
    const r = spawnSync('bash', [RNV, ...args], { encoding: 'utf8', cwd: path.join(ROOT, 'container') });
    return { rc: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '') };
  };
  const def = runR(['default']);
  check('read-node-versions：default 与 JSON 一致（cwd 无关）',
    def.rc === 0 && def.out === String(truth.default), JSON.stringify(def));
  const abi = runR(['abi']);
  check('read-node-versions：abi 与 JSON 一致',
    abi.rc === 0 && abi.out === String(truth.abi), JSON.stringify(abi));
  const bad = runR(['no-such-key']);
  check('read-node-versions：未知键 → 退 1 带诊断（不许拿空串当版本）',
    bad.rc === 1 && bad.err.includes('FAIL'), JSON.stringify({ rc: bad.rc, err: bad.err.slice(0, 120) }));
  const nok = runR([]);
  check('read-node-versions：缺键参数 → 非零', nok.rc !== 0, JSON.stringify({ rc: nok.rc }));
}

// 收口不许被"再抄一份"回退：workflow 里禁止再出现内联 binutils 安装探测 / 内联 node-versions 读法；
// YAML 校验只允许一份实现（validate-workflows.py 已删）且被三条会跑它的链同调。
{
  const wfDir = path.join(ROOT, '.github/workflows');
  const wfs = fs.readdirSync(wfDir).filter((f) => f.endsWith('.yml'))
    .map((f) => ({ name: f, src: fs.readFileSync(path.join(wfDir, f), 'utf8') }));
  const PROBE_RE = /apt-get install[^\n]*binutils/;
  check('内联探测判据双向自证：旧形态必被抓、宿主调用不误伤（对照组）',
    PROBE_RE.test('sudo apt-get update -qq && sudo apt-get install -y -qq binutils')
      && !PROBE_RE.test('bash scripts/ensure-tool.sh readelf binutils'));
  const probeBack = wfs.filter((w) => PROBE_RE.test(w.src)).map((w) => w.name);
  check('workflow 无内联 binutils 安装探测回潮（唯一宿主 ensure-tool.sh）',
    probeBack.length === 0, probeBack.join(','));
  const READ_RE = /python3 -c [^\n]*node-versions\.json/;
  check('node-versions 内联读法判据自证 + 无回潮（读取只走 read-node-versions.sh）',
    READ_RE.test('V="$(python3 -c "import json; print(json.load(open(\'container/app/src/main/assets/node-versions.json\'))[\'default\'])")"')
      && !READ_RE.test('V="$(bash scripts/read-node-versions.sh default)"')
      && wfs.filter((w) => READ_RE.test(w.src)).map((w) => w.name).length === 0);
  const vCallers = wfs.filter((w) => /python3 scripts\/validate-workflow\.py/.test(w.src)).map((w) => w.name).sort();
  check('严格 YAML 校验被 ci/fast-apk/build-apk 三链同调',
    JSON.stringify(vCallers) === JSON.stringify(['build-apk.yml', 'ci.yml', 'fast-apk.yml']), vCallers.join(','));
  check('宽松校验器 validate-workflows.py 已删（实现唯一）',
    !fs.existsSync(path.join(ROOT, 'scripts', 'validate-workflows.py')));
}

// ── ⑨c workflow 表达式 token 门禁自证（2026-09-27 定罪）────────────────────────
// run: 块的 shell 注释里写下一个空的 GitHub 表达式，会让 Actions 拒掉【整份】workflow：
// 表现是红色 + 0 个 job + 没有步骤日志，publish/repack/pin/admin 四条运维通道一起哑。
// PyYAML 对此毫无反应，所以 ci.yml 里那道 YAML 校验当时是全绿的 —— 门禁看不见错误形态，
// 就等于没有门禁。这里把判据本身钉成【能红】：坏夹具必被抓，YAML 层的同串不许误伤。
{
  const vw = (args) => spawnSync('python3',
    [path.join(ROOT, 'scripts/validate-workflow.py'), ...args], { encoding: 'utf8', cwd: ROOT });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-expr-'));
  const TOK = '${{' + ' }}';   // 拼出来，免得这份测试自己成为被扫的对象
  // 夹具：run 块里的 shell 注释 / YAML 层的注释 / 合法表达式，三种落点只差位置。
  const wf = (name, body) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, ['name: t', 'on:', '  workflow_dispatch:', 'jobs:', '  a:',
      '    runs-on: ubuntu-latest', '    steps:', '      - name: s'].concat(body).join('\n') + '\n');
    return p;
  };
  const inRun = wf('in-run.yml', ['        run: |', '          # 历史说明里出现了 ' + TOK + '，GitHub 会去替换它']);
  const openTok = wf('open.yml', ['        run: |', '          echo "${{ steps.a.outputs.b']);
  const good = wf('good.yml', ['        run: |', '          echo "${{ github.repository }}"']);
  const yamlComment = path.join(dir, 'yaml-comment.yml');
  fs.writeFileSync(yamlComment, ['name: t', 'on:', '  workflow_dispatch:',
    '# ' + TOK + ' 待在 YAML 注释里，GitHub 看不到它', 'jobs:', '  a:', '    runs-on: ubuntu-latest',
    '    steps:', '      - name: s', '        run: echo hi', ''].join('\n'));
  const rBad = vw([inRun]), rOpen = vw([openTok]), rYaml = vw([yamlComment]), rGood = vw([good]);
  check('表达式门禁真能红：run 块注释里的空表达式被抓',
    rBad.status !== 0 && rBad.stdout.includes('空表达式'), JSON.stringify({ rc: rBad.status, out: rBad.stdout.slice(0, 160) }));
  check('表达式门禁真能红：没闭合的 ${{ 被抓',
    rOpen.status !== 0 && rOpen.stdout.includes('没有闭合'), JSON.stringify({ rc: rOpen.status, out: rOpen.stdout.slice(0, 160) }));
  check('不误伤（对照组）：YAML 注释里的同串、以及合法表达式都放行',
    rYaml.status === 0 && rGood.status === 0,
    JSON.stringify({ yaml: rYaml.status, good: rGood.status, out: rYaml.stdout.slice(0, 160) }));
}

// ── ⑨b APK 原生件审计收口（门禁法①）：三份漂移副本 → scripts/verify-apk-native.sh ──
// 定罪（2026-09-27 复算）：fast-apk 全量硬红 / build-apk 只查清单且 lib/ 零条目只 echo
// 不红、不查内核(ADR-0005)/npm/小体积件 / release-admin diag 刻意只出报告。
// 三处各自的错误信息、处置口径都在漂 —— 这里用合成 zip 夹具把宿主的每条出口都真跑一遍。
const VAN = path.join(ROOT, 'scripts', 'verify-apk-native.sh');
check('APK 原生件审计宿主 scripts/verify-apk-native.sh 存在', fs.existsSync(VAN));
{
  const runVan = (args) => {
    const r = spawnSync('/bin/bash', [VAN, ...args], { encoding: 'utf8' });
    return { rc: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
  };
  const noargs = runVan([]);
  check('verify-apk-native：缺参数 → 退 2 打 usage（审计不许空跑）',
    noargs.rc === 2 && noargs.out.includes('用法'), JSON.stringify(noargs));
  const nofile = runVan(['/nonexistent/app-debug.apk', 'arm64-v8a']);
  check('verify-apk-native：apk 不存在 → 退 2（拿不到对象就不许走到 [ok]）',
    nofile.rc === 2, JSON.stringify(nofile.out.slice(0, 80)));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'van-'));
  const mkZip = (name, files) => {
    const stage = path.join(tmp, name + '.src');
    for (const rel of Object.keys(files)) {
      const p = path.join(stage, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, files[rel] || 'x');
    }
    const z = spawnSync('zip', ['-r', '-q', path.join(tmp, name + '.apk'), '.'], { cwd: stage, encoding: 'utf8' });
    if (z.status !== 0) return null;
    return path.join(tmp, name + '.apk');
  };
  // 合法空包（只有 22 字节的 EOCD）：zip 命令造不出这种形态，直接写字节。
  const emptyZip = path.join(tmp, 'empty.apk');
  fs.writeFileSync(emptyZip, Buffer.from('504b05060000000000000000000000000000000000000000', 'hex'));

  // pipefail 反噬的回归位（本轮定罪见脚本头部注释）：左侧 printf 撞 SIGPIPE 后，
  // 整条管道退码被 pipefail 翻成非零 —— 「命中」会被读成「未命中」。
  // 断言锁【机制】不锁实现写法：任何经管道的命中判定都可能吃到这口，宿主必须不用它。
  const pipeProbe = path.join(tmp, 'pipe-probe.sh');
  fs.writeFileSync(pipeProbe, 'set -euo pipefail\nL="$(printf \'%s\\n\' a b c d e f g h i j k l m n o p q r s t u v w x y z)"\nif printf \'%s\\n\' "$L" | grep -q "  z"; then echo HIT_OK; else echo HIT_FLIPPED_TO_MISS; fi\n');
  const pOut = spawnSync('/bin/bash', [pipeProbe], { encoding: 'utf8' });
  check('回归位：pipefail 会把「grep 命中但左侧 SIGPIPE」翻成未命中（旧宿主的假阳性根因）',
    pOut.status !== 0 || String(pOut.stdout).includes('HIT_FLIPPED_TO_MISS'),
    JSON.stringify({ rc: pOut.status, out: String(pOut.stdout).trim(), err: String(pOut.stderr).trim().slice(0, 80) }));

  const notzip = path.join(tmp, 'not-zip.apk');
  fs.writeFileSync(notzip, '这不是 zip');
  const rNz = runVan([notzip, 'arm64-v8a']);
  check('verify-apk-native：文件不是 zip → 退 2「审计没发生」（读不出清单 ≠ 审计不通过）',
    rNz.rc === 2 && rNz.out.includes('审计没发生'), JSON.stringify({ rc: rNz.rc, out: rNz.out.slice(0, 100) }));
  const rNzRep = runVan([notzip, 'arm64-v8a', '--report']);
  check('verify-apk-native：--report 读不出清单 → 退 0 打 [FAIL]（诊断通道不判红，但要说真话）',
    rNzRep.rc === 0 && rNzRep.out.includes('[FAIL]'), JSON.stringify({ rc: rNzRep.rc, out: rNzRep.out.slice(0, 100) }));

  const rEmpty = runVan([emptyZip, 'arm64-v8a']);
  check('verify-apk-native：空 APK → 退 1 且点名 lib/ 零条目（不空转放行）',
    rEmpty.rc === 1 && rEmpty.out.includes('没有 lib/ 条目') && !rEmpty.out.includes('审计没发生'),
    JSON.stringify({ rc: rEmpty.rc, out: rEmpty.out.slice(0, 140) }));

  // 只有 libnode.so：越过 1)，应在内核之后的小件/清单处逐条点名。
  const libOnly = mkZip('libonly', { 'lib/arm64-v8a/libnode.so': 'ELFAKE' });
  const rLo = runVan([libOnly, 'arm64-v8a']);
  check('verify-apk-native：缺件逐条点名（libc++_shared / 自有小件 / npm 都要出现在缺项里）',
    rLo.rc === 1 && rLo.out.includes('libc++_shared.so') && rLo.out.includes('libdshflock.so')
      && rLo.out.includes('assets/npm/npm.zip') && rLo.out.includes('审计不通过'),
    JSON.stringify({ rc: rLo.rc, out: rLo.out.slice(-260) }));

  const rLoNoAbi = runVan([libOnly]);
  check('verify-apk-native：gate 模式缺 ABI → 退 2（静默用错默认值会把错 ABI 的包判过）',
    rLoNoAbi.rc === 2 && rLoNoAbi.out.includes('ABI'), JSON.stringify({ rc: rLoNoAbi.rc }));

  // 不该有的东西单独红：内核资产进门 = ADR-0005 被改回去。
  const withKernel = mkZip('wkernel', { 'lib/arm64-v8a/libnode.so': 'ELFAKE', 'assets/kernel/k.zip': 'x' });
  const rK = runVan([withKernel, 'arm64-v8a']);
  check('verify-apk-native：APK 含内核资产 → 立刻退 1（ADR-0005，先于其它条目拦）',
    rK.rc === 1 && rK.out.includes('APK 含内核资产'), JSON.stringify({ rc: rK.rc, out: rK.out.slice(0, 140) }));

  // report 模式对同一份坏包：必须退 0，且把缺项打成事实而不是吞掉。
  const rRep = runVan([libOnly, 'arm64-v8a', '--report']);
  check('verify-apk-native：--report 对坏包退 0 且逐条列事实（诊断通道永不判红）',
    rRep.rc === 0 && rRep.out.includes('[MISSING]') && rRep.out.includes('结果:'),
    JSON.stringify({ rc: rRep.rc, out: rRep.out.slice(-200) }));
  const rRepK = runVan([withKernel, 'arm64-v8a', '--report']);
  check('verify-apk-native：--report 把「不该有」记成 FAIL（不混进缺项清单）',
    rRepK.rc === 0 && rRepK.out.includes('[FAIL]'), JSON.stringify({ rc: rRepK.rc }));

  // 全绿对照组：补齐全部条目后必须真 PASS —— 证明审计不是"怎么跑都红"的摆设。
  const all = {
    'assets/npm/npm.zip': 'zipzip', 'assets/npm/version.txt': 'v',
    'assets/node/adb-client/cli.js': 'x',
  };
  for (const a of fs.readFileSync(path.join(ROOT, '.github/native-assets.txt'), 'utf8')
    .split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))) {
    all[`lib/arm64-v8a/${a}`] = 'ELFAKE';
  }
  // 小体积原生件清单**从注册表派生**，不再在这里手抄第二份（门禁法②：清单禁手维护）。
  // 由 NativeAssetRegistry.kt 的 libName 声明推出「除 libnode/libc++ 之外的全部资产」；
  // 注册表新增一件，这里自动跟上 —— 漏抄一件就是「条目齐备」对照组悄悄失真。
  // libdshpty.so 是 node-pty 的**软失败件**，不登记在 CAPABILITY 里，故显式补一个。
  const registryLibs = [...stripKotlinComments(fs.readFileSync(REGISTRY_KT, 'utf8'))
    .matchAll(/libName\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  const provenSmall = registryLibs.filter((n) => n !== 'libnode.so' && n !== 'libc++_shared.so');
  if (!provenSmall.includes('libdshpty.so')) provenSmall.push('libdshpty.so');
  for (const b of provenSmall) {
    all[`lib/arm64-v8a/${b}`] = 'ELFAKE';
  }
  const srcDir = path.join(ROOT, 'container/app/src/main/assets/node/adb-client');
  for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith('.js'))) {
    all[`assets/node/adb-client/${f}`] = fs.readFileSync(path.join(srcDir, f));
  }
  const fullZip = mkZip('full', all);
  const rFull = runVan([fullZip, 'arm64-v8a']);
  check('verify-apk-native：条目齐备 → 退 0 打「审计通过」（全绿对照组，缺此则判红无从证伪）',
    rFull.rc === 0 && rFull.out.includes('APK 原生件审计通过'),
    JSON.stringify({ rc: rFull.rc, out: rFull.out.slice(-220) }));
  // libdshpty.so 缺席只降级：从全绿夹具里拿掉它，仍须退 0 且出现软失败告警。
  const softZip = mkZip('soft', Object.fromEntries(
    Object.entries(all).filter(([k]) => !k.endsWith('libdshpty.so'))));
  const rSoft = runVan([softZip, 'arm64-v8a']);
  check('verify-apk-native：libdshpty.so 缺席 → 软失败 ::warning:: 且整体仍放行',
    rSoft.rc === 0 && rSoft.out.includes('::warning') && rSoft.out.includes('PTY'),
    JSON.stringify({ rc: rSoft.rc, out: rSoft.out.slice(-160) }));
  fs.rmSync(tmp, { recursive: true, force: true });

  // 回潮门禁：workflow 里不许再内联展开这份判据（unzip -l/-v 的清单审计形态）。
  const AUDIT_RE = /unzip\s+-(l|v)\b/;
  check('审计判据自证：旧内联形态必被抓、宿主调用不误伤（双向对照组）',
    AUDIT_RE.test('unzip -l "$APK" | grep \'lib/\'') && AUDIT_RE.test('unzip -v "$APK" | awk')
      && !AUDIT_RE.test('bash scripts/verify-apk-native.sh "$APK" "$ABI"')
      && !AUDIT_RE.test('unzip -o -q "$APK"'));
  const wfDir = path.join(ROOT, '.github/workflows');
  const auditBack = fs.readdirSync(wfDir).filter((f) => f.endsWith('.yml'))
    .filter((f) => AUDIT_RE.test(fs.readFileSync(path.join(wfDir, f), 'utf8')));
  check('workflow 无内联 APK 清单审计回潮（判据只住 verify-apk-native.sh）',
    auditBack.length === 0, auditBack.join(','));
  const vanCallers = fs.readdirSync(wfDir).filter((f) => f.endsWith('.yml'))
    .filter((f) => /scripts\/verify-apk-native\.sh/.test(fs.readFileSync(path.join(wfDir, f), 'utf8')))
    .sort();
  check('审计宿主被 fast-apk/build-apk/release-admin 三链同调（gate×2 + report×1）',
    JSON.stringify(vanCallers) === JSON.stringify(['build-apk.yml', 'fast-apk.yml', 'release-admin.yml']),
    vanCallers.join(','));
}

const METHODS_JS = path.join(ROOT, 'container/engine/src/bridge/methods.js');
if (fs.existsSync(METHODS_JS)) {
  const js = fs.readFileSync(METHODS_JS, 'utf8');
  check(
    'methods.js 注册了 sys.nativeAssets',
    /'sys\.nativeAssets'\s*:/.test(js)
  );
}

// ---------------------------------------------------------------------------

finish();
