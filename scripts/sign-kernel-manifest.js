#!/usr/bin/env node
'use strict';

// ============================================================================
// 给 kernel-manifest.json 增加**新鲜度字段并签名**（ADR-0005 收尾条款 C3）。
// ============================================================================
// 为什么 manifest 也要签名 + 新鲜度：
//   · 内核包本身已签名（zip 内的 kernel.json）—— 那挡住的是"装一个我们没发过的包"；
//     设备还会把 manifest 的 version 与**包内已签名版本**交叉校验，伪版本/混搭也挡住了。
//   · 但 manifest 是**先被读**的那一个：攻击者或中间缓存可以**重放旧的 manifest**，
//     让设备永远以为"已是最新"（冻结攻击），或把设备指回某个**合法签名的旧版本**。
//   · 所以 manifest 需要：**序**（sequence，单调）、**有效期**（expires）、**签名**。
//     设备端：过期即拒；sequence 不得低于本通道已见最大值（防重放）。
//
// 用法：node scripts/sign-kernel-manifest.js <manifest.json> <private-key.pem> [rolloutPercent]
//       DSH_MANIFEST_TTL_DAYS（默认 30）
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { signManifest } = require(path.join(__dirname, '..', 'container', 'engine', 'src', 'sign'));

const [, , manifestPath, keyPath, rolloutArg] = process.argv;
if (!manifestPath || !keyPath) {
  console.error('用法: sign-kernel-manifest.js <manifest.json> <private-key.pem> [rolloutPercent]');
  process.exit(2);
}

const key = fs.readFileSync(keyPath, 'utf8');
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

m.manifestSchema = 1;
// sequence 用**时间戳（epoch 秒）**，而不是"上一份 manifest 的 sequence + 1"。
//
// 为什么不用 +1：那依赖**外部状态**——上一份 manifest 挂在 Release 上。一旦该 Release 被删除、
// 重建，或换了发布入口，sequence 就会**倒退**。而设备把水位持久化在**自己身上**，
// 它会把更小的 sequence 判为"重放"并拒绝 —— 结果是**设备永久卡住**，直到 sequence 重新涨过旧水位。
// 实测中我为清理被污染的通道删除 Release 时，正好撞上这条隐患。
// 时间戳天然单调、不依赖任何外部状态，换 CI、换机器、删 Release 都不会分叉。
m.sequence = Math.floor(Date.now() / 1000);

const days = Number(process.env.DSH_MANIFEST_TTL_DAYS || 30);
const expMs = Date.now() + (Number.isFinite(days) ? days : 30) * 86400_000;
// 同时给**人类可读**与**机器可读**两种形态：设备端用数值，避免在 Kotlin 里解析 ISO 日期
// （minSdk 24 没有 java.time 的 desugaring，自己解析 ISO 只会多一处可能出错的地方）。
m.expires = new Date(expMs).toISOString();
m.expiresEpochMs = expMs;

const rp = Number(rolloutArg || process.env.DSH_ROLLOUT_PERCENT || 100);
m.rolloutPercent = Math.max(0, Math.min(100, Number.isFinite(rp) ? rp : 100));

m.signature = signManifest(key, m);
fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');

console.log('[manifest] schema=' + m.manifestSchema + ' sequence=' + m.sequence +
  ' rollout=' + m.rolloutPercent + '% expires=' + m.expires);
console.log('[manifest] signature=' + m.signature.slice(0, 24) + '…');
