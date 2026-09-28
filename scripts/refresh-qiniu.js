#!/usr/bin/env node
'use strict';

// ============================================================================
// 刷新七牛 CDN 缓存（管理 API /refresh）。
// ============================================================================
// 为什么必须有这一步：清单的缓存策略是**短**的（60 秒），但如果这个 key 曾经被
//   以长 TTL 缓存过（本仓 2026-09-27 就发生过：max-age=31536000，一年），
//   那么**新上传不会作废已存在的缓存条目** —— 设备会一直读到旧清单，表现为
//   「发了没更新」（真机验收前的实证）。只能显式刷新。
// 签名：QBox <ak>:<urlsafe-b64(hmac-sha1(sk, path + "\n" + body))>
// 用法：QINIU_AK=… QINIU_SK=… node scripts/refresh-qiniu.js <url> [url...]
// ============================================================================

const crypto = require('node:crypto');

const B64URL = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

async function main() {
  const urls = process.argv.slice(2).filter(Boolean);
  const AK = process.env.QINIU_AK;
  const SK = process.env.QINIU_SK;
  if (!urls.length) { console.error('用法: refresh-qiniu.js <url> [url...]'); process.exit(2); }
  if (!AK || !SK) { console.error('[refresh] 缺少 QINIU_AK / QINIU_SK'); process.exit(2); }
  const body = JSON.stringify({ urls: urls });
  const data = '/refresh' + String.fromCharCode(10) + body;
  const sign = crypto.createHmac('sha1', SK).update(data).digest();
  // 管理凭证 scheme 试两种：现行是 `Qiniu`，老文档写 `QBox`。谁通记谁 —— 不猜，也不静默。
  const schemes = ['Qiniu', 'QBox'];
  let last = null;
  for (const scheme of schemes) {
    const r = await fetch('https://fusion.qiniuapi.com/refresh', {
      method: 'POST',
      headers: { 'Authorization': scheme + ' ' + AK + ':' + B64URL(sign), 'Content-Type': 'application/json' },
      body: body,
      signal: AbortSignal.timeout(60000),
    });
    const text = await r.text();
    if (r.status === 200) {
      console.log('[refresh] 已刷新 ' + urls.length + ' 个 URL（凭证 scheme=' + scheme + '）: ' + text.slice(0, 200));
      return;
    }
    last = 'scheme=' + scheme + ' status=' + r.status + ' body=' + text.slice(0, 200);
    console.error('[refresh] ' + last);
  }
  console.error('[refresh] 两种 scheme 都失败: ' + last);
  process.exit(1);
}

main().catch((e) => { console.error('[refresh] FATAL ' + e.message); process.exit(1); });
