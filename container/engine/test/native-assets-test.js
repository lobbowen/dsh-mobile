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
const path = require('path');
const { execFileSync } = require('child_process');
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

// build-apk 的 node 缓存不许有前缀回退：key 变了说明编译脚本动过，回退命中拿到的是
// 旧脚本的产物 —— 本轮变更恰好是链接标志，旧产物没有 $ORIGIN，上机即死，
// 而流程看起来和正常命中一模一样。不许用兜底把必然的失败伪装成缓存命中。
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
// 永不可达：伪装成「有校验」的死代码。构建脚本与 workflow 里同形态共 10 处已清掉并由此钉住
// （`find` 打头的那一批是同一件事的另一半，尚未收口 —— 见下面 EMPTY_OK_RISKY 处的说明）。
// ---------------------------------------------------------------------------

// 命令替换里的 pipeline，某一段可能因「没找到东西」返回非零 —— 只列真会这样的命令词
// （tr/head/sort 不进名单，否则全是噪音）。
// 盲区必须知道：命令词写在变量里的那一段看不见，例如
//   NEEDED="$("$READELF" -d x 2>/dev/null | awk …)"
// 曾试着把 `"$UPPER_VAR"` 也算可疑词，结果 `sha256sum "$OUT" | cut`、
// `find "$W" -name … | head` 一并误伤 7 处 —— 行正则分不出「段首命令词」与
// 「参数位置」，硬判只会把门禁变成噪音源。这类只能靠人按同一判据复核。
// 已知未收口的同形态：`find` 作为段首命令词（`APK="$(find … | head -1)"`）实测在
// pipefail 生效的块里还有 13 处，全在 fast-apk / release-admin 两条发布路径上；
// 本轮改的是链接标志，不夹带那条清扫 —— 加进名单会让这 13 处一起红，把两件事混成
// 一次看不懂的失败。单列一轮：先兜底那 13 行，再把 find 加进可疑词。
const EMPTY_OK_RISKY = /(?:^|[\s;|&(])(?:grep|egrep|fgrep|ls|readelf|llvm-readelf)(?:\s|$)/;
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
];
const MUST_PASS = [
  'RPATH_SEEN="$( { grep -o -- \'-Wl,-rpath,[^ ]*\' "$DRY_LOG" || true; } | sort -u | tr \'\\n\' \' \')"',
  '          ASSETS="$({ grep -v \'^[[:space:]]*#\' .github/native-assets.txt | grep -v \'^[[:space:]]*$\' || true; } | tr -d \'\\r\')"',
  'FIXED="$(grep -c -- \'-rpath\' "$DRY_LOG" || true)"',
];
const mustHit = MUST_HIT.map((l) => findSilentAbortAssignments([l]).length);
const mustPass = MUST_PASS.map((l) => findSilentAbortAssignments([l]).length);
check(
  'pipefail 静默终止门禁的对照组：4 个真实违规形态各命中 1 处',
  mustHit.every((n) => n === 1),
  `实际命中 ${JSON.stringify(mustHit)}（期望全 1）：检测器失效，下面的零命中断言就成了空转`
);
check(
  'pipefail 静默终止门禁的对照组：3 个已兜底形态各命中 0 处',
  mustPass.every((n) => n === 0),
  `实际命中 ${JSON.stringify(mustPass)}（期望全 0）：判据过宽会把门禁变成噪音源`
);
check(
  'pipefail 生效的脚本里没有「$(grep/ls … | …)」这种取空即静默终止的赋值',
  silentAbort.length === 0,
  silentAbort.length
    ? `命中 ${silentAbort.length} 处：pipefail + set -e 之下，这一段会在下一行判空之前`
      + '终止脚本且不打诊断，其后的错误分支永不可达\n        '
      + silentAbort.join('\n        ')
    : '零命中'
);

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
