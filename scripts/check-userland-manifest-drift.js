#!/usr/bin/env node
'use strict';

// 线上 C 层清单与「本代码会声明什么」逐格对账。
//
// 为什么要有它（2026-09-30 真机定罪 ENV-26）：aliases 的读（壳 Kotlin）与写（发布器）都合进了 main，
// 但线上清单仍停在 `npm.aliases=null` —— 没有任何 job 会因为「发布器的代码变了」去重发清单，
// 于是设备上 `npx` 按真名调不到，而 CI 一路全绿。**改了声明却不重发**必须是红的。
//
// 对账模式只比内容格（provider/version/url/sha256/entry/aliases/判据）。不比清单的 version/sequence/
// expiresEpochMs：那三格每次发布都合理变化，钉它们会让对照永远红、然后被人关掉。
// 而 revision 恰恰相反 —— 它每次发布都**必须**变，所以它是闸门模式唯一比的那一格（见下）。
//
// 用法：node scripts/check-userland-manifest-drift.js <仓内投影.json> [channel]
//   node scripts/check-userland-manifest-drift.js --immutable <新清单.json> [channel]
//
// 两种模式共用**同一个**线上取数口（下面的 fetchOnline）：对账与闸门若各写一份 curl，
// 就会有一边读到缓存、另一边读到新件，同一轮里得出两个相反的结论（这正是要防的形状）。
//
// `--immutable` 是**发布前**的那道闸（build-userland 的 manifest job 在上传之前跑它），判两件事：
//   ① revision 必须严格大于线上那份 —— 同号再发一次，就等于「版本号没变而内容变了」，
//      与 ADR-0004 要防的那条是同一句话；C 层唯一的单调判据就是这一格。
//   ② 同一 name@version 的 sha256 不许换 —— 换了意味着同名件的 URL 被另一批字节盖掉，
//      已被长缓存钉住的设备与清单上的哈希从此对不上。
// 线上还没有清单（首次投放该通道）是**确实没有**，不是看不清：当作空表放行并打印这条读数。
//
//   env USERLAND_ONLINE_FILE：读本地文件当线上（CI 的自测走这条，不碰网）
//   线上取自 APK 里那份通道锚（assets/supply/channel.json）—— 与设备读的是同一个键，不另造 URL。

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const IMMUTABLE = argv[0] === '--immutable';
if (IMMUTABLE) argv.shift();
const LOCAL = argv[0];
const CHANNEL = argv[1] || 'canary';

/** 一件在两张表里该比的那几格；别名按 name 排序后压成一行，比较与打印同一份形状。 */
function project(t) {
  const aliases = (t.aliases || [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => a.name + '→' + a.entry)
    .join(',') || '无';
  return {
    provider: t.provider,
    version: t.version,
    url: t.url,
    sha256: t.sha256,
    entry: t.entry,
    aliases,
    判据: t.verify && t.verify.node,
    判据形状: t.verify && t.verify.criterion,
  };
}

function fail(msg, title) {
  console.error('::error title=' + (title || '线上清单与仓内声明分家') + '::' + msg);
  console.log((IMMUTABLE ? '[gate]' : '[drift]') + ' 判红');
  process.exit(1);
}

if (!LOCAL) fail(IMMUTABLE ? '--immutable 后面没给即将上传的清单文件（用法见文件头）' : '没给仓内投影文件（用法见文件头）');

// 两种模式读的本地那份**形状不同**：对账读 `--project` 出的 tools 数组，闸门读即将上传的整份清单。
// 分形状在这里判一次，下面那条线上取数路与两处比较才不用各自再解一遍。
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
} catch (e) {
  fail('本地清单读不出（' + LOCAL + '）: ' + e.message);
}
let localTools;
let localRevision = 0;
if (IMMUTABLE) {
  // revision 的合法性在闸门这里**重新判一次**，不是不信发布器：闸门读的是落盘的那份文件，
  // 发布器再对也只证明它自己往里写过 —— 判据要钉的是即将上传的字节。
  if (!Number.isInteger(parsed.revision) || parsed.revision < 1) {
    fail('即将上传的清单里 revision 不是正整数（读到 ' + JSON.stringify(parsed.revision) + '）', 'C 层清单版本号非法');
  }
  localRevision = parsed.revision;
  localTools = parsed.tools;
} else {
  localTools = parsed;
}
if (!Array.isArray(localTools) || localTools.length === 0) {
  fail((IMMUTABLE ? '即将上传的清单' : '仓内投影') + '是空的 —— 没有件可对照，不许当作通过');
}

const anchor = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'container/app/src/main/assets/supply/channel.json'), 'utf8'),
);
const onlinePath = process.env.USERLAND_ONLINE_FILE;
const onlineFrom = onlinePath || 'userland-' + CHANNEL + '/' + anchor.manifestName;
const onlineUrl = anchor.baseUrl.replace(/\/+$/, '') + '/userland-' + CHANNEL + '/' + anchor.manifestName
  + '?t=' + Date.now();

// 返回 `{ buf }` 或 `{ missing:true }`。missing 只表示**这条键上确实没有清单**（夹具文件不存在 / HTTP 404）；
// 超时、5xx、断连一律 throw —— 把「看不清」并进「确实没有」是空转门禁的入口（三态判据）。
function fetchOnline() {
  return new Promise((resolve, reject) => {
    if (onlinePath) {
      if (!fs.existsSync(onlinePath)) return resolve({ missing: true });
      return resolve({ buf: fs.readFileSync(onlinePath) });
    }
    const req = https.get(onlineUrl, { timeout: 15_000 }, (res) => {
      if (res.statusCode === 404) return resolve({ missing: true });
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' ' + onlineUrl));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ buf: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('取线上清单超时')));
    req.on('error', reject);
  });
}

/** 发布前的不可变闸门：revision 严格单调 + 同 name@version 不许换字节。 */
function gate(online, onlineRevisionRaw, firstPublish) {
  // 旧清单（本方案之前的形状）没有 revision 格、或这条键上根本还没有清单：取严的下界都记作 0，
  // 并把这条读数**打出来**，不静默当通过 —— 首次按 tag 发布必须能过，而过了以后线上每份都带这一格。
  const onlineRevision = Number.isInteger(onlineRevisionRaw) ? onlineRevisionRaw : 0;
  console.log('[gate] revision 线上=' + onlineRevision + ' 本次=' + localRevision
    + '，件 线上 ' + online.length + ' 颗 / 本次 ' + localTools.length + ' 颗（取自 ' + onlineFrom + '）');
  if (firstPublish) console.log('[gate] 这条键上还没有清单 —— 本次是该通道按新发布连投的第一份');
  else if (onlineRevisionRaw === undefined) console.log('[gate] 线上那份没有 revision 格（本方案之前的旧形状，按 0 计）—— 本次之后每份清单都必须带');
  const byName = new Map(online.map((t) => [t.name, t]));
  const reds = [];
  if (!(localRevision > onlineRevision)) {
    reds.push('revision 不单调：线上已经是 ' + onlineRevision + '，本次要发 ' + localRevision
      + ' —— 同号或倒退就是「版本号没变而内容变了」；把发布 tag 里的 revision 提上去重跑');
  }
  for (const t of localTools) {
    const got = byName.get(t.name);
    // 线上没有的这颗是本次首次投放，没有旧字节可盖，直接跳过。
    if (!got || got.version !== t.version) continue;
    if (got.sha256 !== t.sha256) {
      reds.push(t.name + '@' + t.version + ' 换了字节：线上 sha ' + String(got.sha256).slice(0, 12)
        + '… 本次 ' + String(t.sha256).slice(0, 12)
        + '… —— 件的 URL 按版本号命名，发清单就是把旧对象盖掉；而长缓存里的设备仍按旧 sha 核验，从此对不上。'
        + '同一版本号只许一批字节：要么让打包可复现（锁定归档内 mtime），要么提升件的版本');
    }
  }
  if (reds.length) {
    for (const r of reds) console.log('[gate] ' + r);
    return fail(reds.length + ' 条不合格 —— 本次不投递', 'C 层发布闸门');
  }
  console.log('[gate] 通过：revision 单调，' + localTools.length + ' 颗件里没有一颗在同版本下换字节');
}

fetchOnline().then(({ buf, missing }) => {
  if (missing) {
    // 对账模式跑在发布**之后**，键上没有就是这一轮没投上去；闸门模式跑在发布**之前**，没有就是首次投放。
    if (!IMMUTABLE) return fail('线上这个键上还没有清单：' + onlineFrom + ' —— 改过声明却没发出去，与「没有漂移」不是一回事');
    return gate([], undefined, true);
  }
  let man;
  try {
    man = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return fail('线上清单不是合法 JSON（' + onlineFrom + '）: ' + e.message);
  }
  const online = Array.isArray(man.tools) ? man.tools : [];
  if (IMMUTABLE) return gate(online, man.revision);
  console.log('[drift] 仓内投影 ' + localTools.length + ' 颗，线上清单 ' + online.length
    + ' 颗（线上 version=' + man.version + '，取自 ' + onlineFrom + '）');
  const byName = new Map(online.map((t) => [t.name, project(t)]));
  const localNames = new Set();
  const diffs = [];
  for (const t of localTools) {
    localNames.add(t.name);
    const want = project(t);
    const got = byName.get(t.name);
    if (!got) { diffs.push(t.name + ': 线上整颗缺失（仓内声明了，线上没有这件）'); continue; }
    for (const k of Object.keys(want)) {
      if (String(want[k]) !== String(got[k])) {
        diffs.push(t.name + '.' + k + ': 线上=' + (got[k] === undefined ? '∅' : got[k])
          + ' 仓内=' + (want[k] === undefined ? '∅' : want[k]));
      }
    }
  }
  for (const name of byName.keys()) if (!localNames.has(name)) diffs.push(name + ': 线上有而仓内不声明（谁投的？）');
  if (diffs.length) {
    for (const d of diffs) console.log('[drift] ' + d);
    return fail(diffs.length + ' 格不一致 —— 推 `userland-' + CHANNEL + '-<revision>` tag 重发清单，或改回仓内声明');
  }
  console.log('[drift] 逐格一致：' + localTools.length + ' 颗件的版本/哈希/入口/别名/判据都在线上');
}).catch((e) => fail('取不到线上清单：' + e.message + '（看不清 ≠ 没有漂移，也 ≠ 可以发）'));
