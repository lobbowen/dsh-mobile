#!/usr/bin/env node
'use strict';

// ============================================================================
// 上传一个文件到七牛 Kodo（**不依赖 SDK**）。
// ============================================================================
// 为什么不用 SDK：CI 里少一个依赖就少一处漂移；上传协议本身只有两步 —— 
//   ① 用 AK/SK 对上传策略做 HMAC-SHA1，拼出 uploadToken
//   ② multipart/form-data POST 到 up.qiniup.com
//
// 用法：QINIU_AK=… QINIU_SK=… QINIU_BUCKET=… \
//        node scripts/upload-qiniu.js <本地文件> <远端 key> [--cache-control=60]
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ⚠ URL-safe base64，但**保留 '=' padding** —— 实测去掉 padding 会 401 BadToken。
const B64URL = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

function uploadToken(ak, sk, bucket, key, ttlSec) {
  const policy = {
    scope: bucket + ':' + key,
    deadline: Math.floor(Date.now() / 1000) + (ttlSec || 3600),
    insertOnly: 0,            // 0 = 允许覆盖同名 key（同版本重发是标准动作）
  };
  // ⚠ 关键（实测踩过）：签名对象是 **base64url 编码后的 policy 串**，不是 policy 原文。
  // 最初按直觉签了原文 → 401 BadToken；靠给官方 SDK 插桩 crypto.createHmac
  // 才看出入参是编码后的字符串。算法 HMAC-SHA1，结果同样做 URL-safe base64。
  const encodedPolicy = B64URL(JSON.stringify(policy));
  const sign = crypto.createHmac('sha1', sk).update(encodedPolicy).digest();
  return ak + ':' + B64URL(sign) + ':' + encodedPolicy;
}

function multipart(fields, fileField, fileName, fileBuf, mime) {
  const B = '----dsh' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from('--' + B + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + v + '\r\n'));
  }
  parts.push(Buffer.from('--' + B + '\r\nContent-Disposition: form-data; name="' + fileField +
    '"; filename="' + fileName + '"\r\nContent-Type: ' + (mime || 'application/octet-stream') + '\r\n\r\n'));
  parts.push(fileBuf);
  parts.push(Buffer.from('\r\n--' + B + '--\r\n'));
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + B };
}

async function main() {
  const argv = process.argv.slice(2);
  const local = argv[0];
  const key = argv[1];
  const cacheArg = argv.find((a) => a.startsWith('--cache-control='));
  const cacheSec = cacheArg ? Number(cacheArg.split('=')[1]) : null;

  const AK = process.env.QINIU_AK;
  const SK = process.env.QINIU_SK;
  const BUCKET = process.env.QINIU_BUCKET;
  const HOST = process.env.QINIU_UPLOAD_HOST || 'https://up.qiniup.com';
  if (!local || !key) { console.error('用法: upload-qiniu.js <本地文件> <远端 key>'); process.exit(2); }
  if (!AK || !SK || !BUCKET) { console.error('[qiniu] 缺少 QINIU_AK / QINIU_SK / QINIU_BUCKET'); process.exit(2); }
  if (!fs.existsSync(local)) { console.error('[qiniu] 文件不存在: ' + local); process.exit(2); }

  const buf = fs.readFileSync(local);

  // ⚠ 重试是必需的，不是保险：大件（git 约 25 MB）单次 POST 遇到网络抖动就整步失败，
  //   而「矩阵里一件失败 ⇒ manifest 作业被跳过」会把一次抖动放大成「清单没更新」
  //   （2026-09-29 实证：连续两次 `[qiniu] FATAL fetch failed`，三件小的每次都成功）。
  //   要点：① 每次重试**重新签发 token**（退避期间原 token 可能过期）；② 每次带上限时，
  //   避免连接僵死占满整个 CI 步骤；③ 4xx（令牌/参数错）不重试 —— 重试不会让它变对。
  // 单次上限按**实测带宽**定：同 run 对照 jq 353 KB/5.5s、sqlite3 901 KB/0.3s、curl 2.9 MB/47s
  //   ⇒ 上传侧约 60 KB/s，git 件 20+ MB 需要约 6 分钟。原来设 5 分钟 = 每次都在半途被 abort，
  //   重试只是把同一件做不到的事重做一遍（2026-09-29 实证：该步挂了 30 分钟）。故放宽到 15 分钟。
  const ATTEMPTS = 3;
  const PER_ATTEMPT_MS = 900000;
  let lastErr = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const token = uploadToken(AK, SK, BUCKET, key, 3600);
    const fields = { key: key, token: token };
    // 客户端缓存：manifest 要短（否则设备永远读到旧 manifest），包可以长（文件名带版本号）。
    if (cacheSec !== null && Number.isFinite(cacheSec)) fields['x:Cache-Control'] = 'max-age=' + cacheSec;
    const mp = multipart(fields, 'file', path.basename(local), buf);
    const t0 = Date.now();
    try {
      const r = await fetch(HOST, {
        method: 'POST',
        headers: { 'Content-Type': mp.contentType },
        body: mp.body,
        signal: AbortSignal.timeout(PER_ATTEMPT_MS),
      });
      const text = await r.text();
      if (r.status === 200) {
        console.log('[qiniu] 已上传 ' + key + '（' + buf.length + ' 字节，' + (Date.now() - t0) + 'ms，第 ' + attempt + ' 次尝试）');
        return;
      }
      if (r.status >= 400 && r.status < 500) {
        console.error('[qiniu] 上传失败（4xx 不重试）key=' + key + ' status=' + r.status + ' body=' + text.slice(0, 300));
        process.exit(1);
      }
      lastErr = new Error('status=' + r.status + ' body=' + text.slice(0, 200));
    } catch (e) {
      lastErr = e;
    }
    if (attempt < ATTEMPTS) {
      const wait = 3000 * Math.pow(2, attempt - 1);
      console.error('[qiniu] 第 ' + attempt + '/' + ATTEMPTS + ' 次失败（' + (lastErr && lastErr.message) + '），' + wait + 'ms 后重试 key=' + key);
      await new Promise((res) => setTimeout(res, wait));
    }
  }
  console.error('[qiniu] 连续 ' + ATTEMPTS + ' 次失败：key=' + key + ' last=' + (lastErr && lastErr.message));
  process.exit(1);
}

main().catch((e) => { console.error('[qiniu] FATAL ' + e.message); process.exit(1); });
