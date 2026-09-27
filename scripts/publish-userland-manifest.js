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
//   （container/engine/src/sign.js 与设备端 assets/node/kernel-verify.js，靠「逐字节一致」
//   的约定维持），再加一份就是第三把尺子。签字节 = 验字节：
//   验签侧只需 crypto.verify(null, <原始字节>, <公钥>, <签名>)，零额外实现。
//
// 发布前**自检**：用焊在 APK 的那把公钥验一遍，不配对就**硬失败** —— 与内核 OTA 的
//   verify-ota-anchor.sh 同一条纪律（发一个设备验不过的清单 = 假装发布成功）。
//
// 用法：node scripts/publish-userland-manifest.js <dist目录> <输出目录> <私钥> [channel]
//   env: USERLAND_BASE_URL（缺省 https://hubcdn.zll.ink）、GITHUB_RUN_NUMBER（进版本号）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DIST = process.argv[2] || 'dist';
const OUT = process.argv[3] || 'release';
const KEY = process.argv[4] || 'keys/ota-private.pem';
const CHANNEL = process.argv[5] || 'canary';
const BASE = (process.env.USERLAND_BASE_URL || 'https://hubcdn.zll.ink').replace(/\/+$/, '');
const PUBKEY = path.join(ROOT, 'container', 'app', 'src', 'main', 'assets', 'ota-public.pem');
const EXTERNAL = path.join(__dirname, 'userland-external-tools.json');
const VERIFY = path.join(__dirname, 'userland-verify.json');
const TTL_MS = 30 * 86400_000;

/** 本次构建出的件（tar.gz 命名即契约：userland-<name>-<ver>-android-arm64.zip）。 */
function toolsFromDist() {
  if (!fs.existsSync(DIST)) throw new Error('dist 目录不存在: ' + DIST);
  const out = [];
  for (const f of fs.readdirSync(DIST)) {
    // 命名契约（内容寻址）：userland-<name>-<ver>-<sha12>-android-arm64.zip
    const m = /^userland-([a-z0-9-]+)-([0-9][^-]*)-([0-9a-f]{12})-android-arm64\.tar\.gz$/.exec(f);
    if (!m) continue;
    const name = m[1];
    const ver = m[2];
    const claimed = m[3];
    const buf = fs.readFileSync(path.join(DIST, f));
    if (buf.length === 0) throw new Error('0 字节产物: ' + f);
    const real = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
    if (real !== claimed) throw new Error('文件名里的内容哈希与实际不符: ' + f + '（名 ' + claimed + ' vs 实 ' + real + '）');
    out.push({
      name, provider: 'zip', version: ver, kind: 'native',
      url: BASE + '/userland/' + f,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      entry: 'bin/' + name,
    });
  }
  return out;
}

function toolsExternal() {
  const j = JSON.parse(fs.readFileSync(EXTERNAL, 'utf8'));
  // 原样透传（含 aliases：件的命令别名由**件的声明**决定，机制照单写入口，内核不写死同名关系）。
  return (j.tools || []).map((t) => ({ ...t }));
}

function versionString() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  const run = process.env.GITHUB_RUN_NUMBER || '0';
  return d + '.' + run;
}

/** 各件的能力判据（随件下发）。缺判据即硬失败：设备拿不到判定依据的件等于不可核验。 */
function criteria() {
  const j = JSON.parse(fs.readFileSync(VERIFY, 'utf8'));
  return j.criteria || {};
}

function main() {
  const crit = criteria();
  const tools = toolsFromDist().concat(toolsExternal()).sort((a, b) => a.name.localeCompare(b.name));
  if (!tools.length) throw new Error('清单为空：没有构建产物也没有外部件');
  const seen = new Set();
  for (const t of tools) {
    const v = crit[t.name];
    if (!v || typeof v.node !== 'string' || v.node.length < 20) {
      throw new Error('件没有能力判据，不许发布: ' + t.name + '（在 scripts/userland-verify.json 里补）');
    }
    t.verify = { criterion: v.criterion, node: v.node };
    if (!t.name || !t.version || !t.sha256) throw new Error('件缺字段(name/version/sha256): ' + JSON.stringify(t).slice(0, 120));
    if (seen.has(t.name)) throw new Error('件重名: ' + t.name);
    seen.add(t.name);
  }
  const man = {
    schema: 1,
    channel: CHANNEL,
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
  console.log('[userland] channel=' + CHANNEL + ' version=' + man.version + ' sequence=' + man.sequence + ' tools=' + tools.length);
  for (const t of tools) console.log('  - ' + t.name + '@' + t.version + ' ' + t.provider + ' ' + t.sha256.slice(0, 12) + '… 判据 ' + t.verify.node.length + ' 字');
  console.log('[userland] 签名自检通过（与 APK 公钥配对）: ' + path.join(OUT, 'userland-manifest.json'));
}

try { main(); } catch (e) { console.error('::error title=清单发布失败::' + (e && e.message)); process.exit(1); }
