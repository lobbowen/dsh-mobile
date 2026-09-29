#!/usr/bin/env node
'use strict';

// 线上 C 层清单与「本代码会声明什么」逐格对账。
//
// 为什么要有它（2026-09-30 真机定罪 ENV-26）：aliases 的读（壳 Kotlin）与写（发布器）都合进了 main，
// 但线上清单仍停在 `npm.aliases=null` —— 没有任何 job 会因为「发布器的代码变了」去重发清单，
// 于是设备上 `npx` 按真名调不到，而 CI 一路全绿。**改了声明却不重发**必须是红的。
//
// 只比内容格（provider/version/url/sha256/entry/aliases/判据）。不比清单的 version/sequence/
// expiresEpochMs：那三格每次发布都合理变化，钉它们会让对照永远红、然后被人关掉。
//
// 用法：node scripts/check-userland-manifest-drift.js <仓内投影.json> [channel]
//   env USERLAND_ONLINE_FILE：读本地文件当线上（CI 的自测走这条，不碰网）
//   线上取自 APK 里那份通道锚（assets/supply/channel.json）—— 与设备读的是同一个键，不另造 URL。

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const ROOT = path.resolve(__dirname, '..');
const LOCAL = process.argv[2];
const CHANNEL = process.argv[3] || 'canary';

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

function fail(msg) {
  console.error('::error title=线上清单与仓内声明分家::' + msg);
  console.log('[drift] 判红');
  process.exit(1);
}

if (!LOCAL) fail('没给仓内投影文件（用法见文件头）');
let localTools;
try {
  localTools = JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
} catch (e) {
  fail('仓内投影读不出: ' + e.message);
}
if (!Array.isArray(localTools) || localTools.length === 0) fail('仓内投影是空的 —— 没有件可对照，不许当作通过');

const anchor = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'container/app/src/main/assets/supply/channel.json'), 'utf8'),
);
const onlinePath = process.env.USERLAND_ONLINE_FILE;
const onlineUrl = anchor.baseUrl.replace(/\/+$/, '') + '/userland-' + CHANNEL + '/' + anchor.manifestName
  + '?t=' + Date.now();

function fetchOnline() {
  return new Promise((resolve, reject) => {
    if (onlinePath) return resolve(fs.readFileSync(onlinePath));
    const req = https.get(onlineUrl, { timeout: 15_000 }, (res) => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' ' + onlineUrl));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('取线上清单超时')));
    req.on('error', reject);
  });
}

fetchOnline().then((buf) => {
  let man;
  try {
    man = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return fail('线上清单不是合法 JSON（' + (onlinePath || onlineUrl) + '）: ' + e.message);
  }
  const online = Array.isArray(man.tools) ? man.tools : [];
  console.log('[drift] 仓内投影 ' + localTools.length + ' 颗，线上清单 ' + online.length
    + ' 颗（线上 version=' + man.version + '，取自 ' + (onlinePath || 'userland-' + CHANNEL + '/' + anchor.manifestName) + '）');
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
    return fail(diffs.length + ' 格不一致 —— 重发清单（build-userland publish=true）或改回仓内声明');
  }
  console.log('[drift] 逐格一致：' + localTools.length + ' 颗件的版本/哈希/入口/别名/判据都在线上');
}).catch((e) => fail('取不到线上清单：' + e.message + '（线上一条都没有 ≠ 没有漂移）'));
