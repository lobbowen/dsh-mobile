#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// C 层（共享开发环境）的**内容清单**发布器。
//
// 为什么要它：C 是「一份、有版本、可核验、可热更」的一层 —— 它的内容（有哪些件、各自
// 版本/url/sha256/入口）必须住在 **C 自己的通道**里，而不是内核源码里。内核只持有
// **通道锚 + 信任根**，于是「加一件工具 / 升一版」只发清单，**内核不动**。
//
// 为什么对**文件原始字节**签名（而不是像内核 manifest 那样签 canonical JSON）：
//   验签发生在**内核**（JS）。内核不该为此再复制一份 canonical 实现 —— 本仓已有两份
//   （container/engine/src/sign.js 与设备端 assets/node/program-verify.js，靠「逐字节一致」
//   的约定维持），再加一份就是第三把尺子。签字节 = 验字节：
//   验签侧只需 crypto.verify(null, <原始字节>, <公钥>, <签名>)，零额外实现。
//
// 发布前**自检**：用焊在 APK 的那把公钥验一遍，不配对就**硬失败** —— 与内核 OTA 的
//   verify-ota-anchor.sh 同一条纪律（发一个设备验不过的清单 = 假装发布成功）。
//
// 用法：node scripts/publish-userland-manifest.js <dist目录> <输出目录> <私钥> [channel] [--project]
//   env: USERLAND_BASE_URL（缺省 https://hubcdn.zll.ink）、GITHUB_RUN_NUMBER（进 version 那一格的溯源后缀）
//   env: LOBOS_USERLAND_REVISION —— 发布轮的**清单版本号**，必填且必须是正整数。
//     它来自 tag 名（`userland-<channel>-<revision>`，见 docs/adr/0011）：发布决定要能被追溯到一个
//     人写下的版本号，而不是「这次 run 恰好是当天第几轮」。version 那一格是溯源标签（日期.run），
//     单调判据只看 revision —— 两者分开，日期变化不该被当成升版，反之升版也不该依赖跑在哪天。
//   --project：只打 tools 投影到 stdout（不签名、不读私钥），供漂移对照用
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
// 旗标先摘掉再按位置取参数：`--project` 落到 OUT 那一格上，等于让同一个脚本的两种用法互相顶位。
const POS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const PROJECT_ONLY = process.argv.includes('--project');
const DIST = POS[0] || 'dist';
const OUT = POS[1] || 'release';
const KEY = POS[2] || 'keys/ota-private.pem';
const CHANNEL = POS[3] || 'canary';
const BASE = (process.env.USERLAND_BASE_URL || 'https://hubcdn.zll.ink').replace(/\/+$/, '');
const PUBKEY = path.join(ROOT, 'container', 'app', 'src', 'main', 'assets', 'ota-public.pem');
const VERIFY = path.join(__dirname, 'userland-verify.json');
const TTL_MS = 30 * 86400_000;

/** 件的可执行面在件内的路径。**唯一出口是 scripts/read-userland-entry.sh，这里不推导。**
 *  先前这里无条件写 `bin/<name>`，等于把设备契约里已有的 tools[].entry 一格覆盖成猜的：npm 撞上的
 *  正是它 —— 包里与真名同名的 `bin/npm` 是 Windows 安装器用的 bash shim（按 node 二进制的同级目录
 *  找真身，我们的布局里必挂），真正能被解释器接住的是它自己 package.json 的 bin 映射指着一颗
 *  `bin/npm-cli.js`。没声明入口 = 读不到 = 直接抛，与「件没有能力判据就不许发布」同一条纪律。 */
function entryOf(name) {
  return cp.execFileSync('bash', [path.join(ROOT, 'scripts', 'read-userland-entry.sh'), name], { encoding: 'utf8' }).trim();
}

/** 件内一条目的原文。`unzip -p` 对不存在的条目退 11 ⇒ 返回 null（不猜），其它失败照常抛。
 *  stderr 走 pipe 不外泄：件没有根 package.json 是正常形状，unzip 的 "caution" 不该刷进 CI 日志。 */
function pieceText(zipPath, rel) {
  try {
    return cp.execFileSync('unzip', ['-p', zipPath, rel], {
      encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e.status === 11 || /filename not matched/.test(String(e.stderr || ''))) return null;
    throw e;
  }
}

/** 件内条目名表：`unzip -Z1` 一行一个名字，没有 `unzip -l` 的表头表尾装饰（verify-apk-native.sh:54 同一条理由）。 */
function pieceNames(zipPath) {
  return cp.execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

/**
 * 一件提供的**全部真名**里、除本名之外的那些（ENV-26）。
 *
 * 为什么从件内现读：`entry` 那一格已经证明过仓内声明会与件内真相分叉（npm 撞上的就是
 *   `bin/npm` 那颗 Windows shim）。而「一件几个真名、各自落在哪」这件事件自己说得最准 ——
 *   JS 件的根 `package.json` 里 `bin` 映射就是生态给这张表定的标准键（判据 D 认它）。
 *   件内没有这张表（git/jq/curl/sqlite3/pnpm 这些原生件，真机 2026-09-30 逐件现读：只有 npm 有）
 *   ⇒ 一件一入口、没有别名，这不是缺项，不报错。
 *
 * 为什么别名必须**各自带入口**：`npx` 的真身是 `bin/npx-cli.js`（2921 字节，它把 argv 改写成
 *   `npm exec …` 再交给同一份 lib/cli.js），不是 `bin/npm-cli.js`。把别名做成「共享本件 entry 的
 *   名字表」就等于把 npx 装成 npm —— 链建成了、跑出来是错的东西，比缺链更难发现。
 *   形状判定（ELF / shebang）不住在这里，住 scripts/verify-userland-artifact.sh（同一宿主把件内
 *   声明的每一颗面都判一遍），这里只搬运事实：不一致或指向不存在的文件就抛，不静默少写一格。
 */
function aliasesOf(name, zipPath, declaredEntry) {
  const raw = pieceText(zipPath, 'package.json');
  if (raw === null) return [];
  let bin;
  try {
    bin = JSON.parse(raw.toString('utf8')).bin;
  } catch (e) {
    throw new Error('件 ' + name + ' 的根 package.json 读不出 bin 映射: ' + e.message);
  }
  if (bin === undefined) return [];
  if (typeof bin === 'string') {
    // 单颗面：包名即真名，件里没有第二颗可报的别名。与声明入口分叉一样要红。
    if (bin !== declaredEntry) {
      throw new Error('件 ' + name + ' 的 package.json bin 是字符串 ' + bin + '，与仓内声明的入口 ' + declaredEntry + ' 分叉');
    }
    return [];
  }
  if (bin[name] !== declaredEntry) {
    throw new Error('件 ' + name + ' 的 package.json bin 映射里 ' + name + ' → ' + String(bin[name]) +
      '，与仓内声明的入口 ' + declaredEntry + ' 分叉 —— 入口只能有一个真相（scripts/read-userland-entry.sh 那条纪律）');
  }
  const names = pieceNames(zipPath);
  const out = [];
  for (const alias of Object.keys(bin).sort()) {
    if (alias === name) continue;
    const rel = bin[alias];
    if (typeof rel !== 'string' || !rel.includes('/') || rel.startsWith('/') || rel.split('/').includes('..')) {
      throw new Error('件 ' + name + ' 的别名 ' + alias + ' 的件内入口不是合规相对路径: ' + String(rel));
    }
    if (!names.includes(rel)) {
      throw new Error('件 ' + name + ' 声明的别名 ' + alias + ' 指向件内不存在的 ' + rel);
    }
    out.push({ name: alias, entry: rel });
  }
  return out;
}

/**
 * `$PREFIX/bin` 是**一张全局表**：一件几个真名就往这张表里占几格。
 *
 * 撞名不许由「后落位覆盖前一颗」解决：清单是签过名的，签名只证内容没被换，不证两个名字不该撞。
 * 本名与别名走同一条记账（否则「另一颗件的别名 = 这颗件的本名」这一格正好从两个集合的缝里掉出去）。
 */
function assertNameUniqueness(tools) {
  const owner = new Map();
  const claim = (name, who) => {
    const prev = owner.get(name);
    if (prev !== undefined) {
      throw new Error('名字冲突: ' + name + ' 同时属于 ' + prev + ' 与 ' + who + ' —— 后落位会覆盖前一颗');
    }
    owner.set(name, who);
  };
  for (const t of tools) {
    claim(t.name, '件 ' + t.name + ' 的本名');
    for (const a of t.aliases || []) claim(a.name, '件 ' + t.name + ' 的别名 ' + a.name);
  }
}

/** 本轮构建出的件（zip 命名即契约：userland-<name>-<ver>-<sha12>-android-arm64.zip）。 */
function toolsFromDist() {
  if (!fs.existsSync(DIST)) throw new Error('dist 目录不存在: ' + DIST);
  const out = [];
  for (const f of fs.readdirSync(DIST)) {
    // 命名契约（内容寻址）：userland-<name>-<ver>-<sha12>-android-arm64.zip
    const m = /^userland-([a-z0-9-]+)-([0-9][^-]*)-([0-9a-f]{12})-android-arm64\.zip$/.exec(f);
    if (!m) continue;
    const name = m[1];
    const ver = m[2];
    const claimed = m[3];
    const zipPath = path.join(DIST, f);
    const buf = fs.readFileSync(zipPath);
    if (buf.length === 0) throw new Error('0 字节产物: ' + f);
    const real = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
    if (real !== claimed) throw new Error('文件名里的内容哈希与实际不符: ' + f + '（名 ' + claimed + ' vs 实 ' + real + '）');
    const entry = entryOf(name);
    out.push({
      name, provider: 'zip', version: ver,
      url: BASE + '/userland/' + f,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      entry,
      aliases: aliasesOf(name, zipPath, entry),
    });
  }
  return out;
}

function versionString() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  const run = process.env.GITHUB_RUN_NUMBER || '0';
  return d + '.' + run;
}

/** 清单版本号：只认发布轮**显式给**的那一个（来自 tag 名），且必须是正整数。
 *  不给缺省：缺省成日期或 0 就等于「不写版本号也能发」，而这一格是 C 层唯一的单调判据。 */
function revisionForManifest() {
  const raw = process.env.LOBOS_USERLAND_REVISION || '';
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error('LOBOS_USERLAND_REVISION 必须是正整数（它来自发布 tag `userland-<channel>-<revision>`），读到: ' + (raw || '空'));
  }
  return Number(raw);
}

/** 各件的能力判据（随件下发）。缺判据即硬失败：设备拿不到判定依据的件等于不可核验。 */
function criteria() {
  const j = JSON.parse(fs.readFileSync(VERIFY, 'utf8'));
  return j.criteria || {};
}

function main() {
  const crit = criteria();
  const tools = toolsFromDist().sort((a, b) => a.name.localeCompare(b.name));
  if (!tools.length) throw new Error('清单为空：dist 下没有一颗按命名契约产出的件');
  for (const t of tools) {
    const v = crit[t.name];
    if (!v || typeof v.node !== 'string' || v.node.length < 20) {
      throw new Error('件没有能力判据，不许发布: ' + t.name + '（在 scripts/userland-verify.json 里补）');
    }
    t.verify = { criterion: v.criterion, node: v.node };
    if (!t.name || !t.version || !t.sha256) throw new Error('件缺字段(name/version/sha256): ' + JSON.stringify(t).slice(0, 120));
  }
  assertNameUniqueness(tools);
  // `--project`：只输出「这份代码现在声明什么」（tools 投影），不签名、不落盘、不读私钥。
  // 住在这里的理由：投影的组装口必须与发布的组装口是**同一个**，否则漂移对照比的是两把尺子，
  // 线上缺一格时对照自己也可能缺一格 —— 那就是又一处空转门禁（scripts/check-userland-manifest-drift.js 只做比较）。
  if (PROJECT_ONLY) {
    process.stdout.write(JSON.stringify(tools, null, 2) + '\n');
    return;
  }
  const man = {
    schema: 1,
    channel: CHANNEL,
    revision: revisionForManifest(),
    version: versionString(),
    sequence: Math.floor(Date.now() / 1000),
    expiresEpochMs: Date.now() + TTL_MS,
    tools,
  };
  const body = JSON.stringify(man, null, 2) + '\n';
  const key = fs.readFileSync(KEY, 'utf8');
  const sig = crypto.sign(null, Buffer.from(body, 'utf8'), key).toString('base64');
  // 自检：用焊在 APK 的那把公钥验一遍（发一个设备验不过的清单 = 假装发布成功）
  const ok = crypto.verify(null, Buffer.from(body, 'utf8'), fs.readFileSync(PUBKEY, 'utf8'), Buffer.from(sig, 'base64'));
  if (!ok) { console.error('::error title=签名不配对::私钥与 APK 焊死的公钥不是一对 —— 这份清单设备验不过，拒绝发布。'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'userland-manifest.json'), body);
  fs.writeFileSync(path.join(OUT, 'userland-manifest.json.sig'), sig + '\n');
  console.log('[userland] channel=' + CHANNEL + ' revision=' + man.revision + ' version=' + man.version + ' sequence=' + man.sequence + ' tools=' + tools.length);
  for (const t of tools) {
    const als = t.aliases.length ? ' 别名 ' + t.aliases.map((a) => a.name + '→' + a.entry).join(',') : '';
    console.log('  - ' + t.name + '@' + t.version + ' ' + t.provider + ' ' + t.sha256.slice(0, 12) + '… 判据 ' + t.verify.node.length + ' 字 入口 ' + t.entry + als);
  }
  console.log('[userland] 签名自检通过（与 APK 公钥配对）: ' + path.join(OUT, 'userland-manifest.json'));
}

// 别名推导与撞名判定要能被 CI 用真件（fixture zip）逐条判红/判绿，所以导出来；被 require 时不发布。
module.exports = { aliasesOf, assertNameUniqueness, pieceText, pieceNames };

if (require.main === module) {
  try { main(); } catch (e) { console.error('::error title=清单发布失败::' + (e && e.message)); process.exit(1); }
}
