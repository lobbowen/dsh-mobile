#!/usr/bin/env node
'use strict';
// 交付面门禁：**读线上**，不读仓内声明的镜像。
// 用法：node scripts/delivery-gate.js [--json]
//
// 为什么必须有（债 INT8/INT16/EXEC-G1，2026-09-29 现读定罪）：仓内所有其它门禁的输入都是
// **我们自己写的文件**，于是「仓内声明的键已改名」和「线上仍是废止身份」可以同时为真、
// 且没有任何东西变红。
// 本门做两件事：① 把 assets 里**声明的每个对象键**拿去线上要一个真实答复 ——
//   200 才算存在；body 里不得出现废止身份词；version 必须读得出来；包体 URL 必须可达。
//   ② 查随清单下发的 C 层判据里写死的对象键，是否还是通道锚当前声明的那一个。
// 读不到（404/超时/TLS 失败）一律判红：分不清「还没发」和「发坏了」的门禁没有存在价值。
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const policy = JSON.parse(fs.readFileSync(path.join(root, '.github/gate-policy.json'), 'utf8'));
const delivery = policy.delivery || {};
const bannedIds = delivery.terms || [];
const byId = new Map(policy.terms.map((t) => [t.id, t]));

function termRegex(id) {
  const t = byId.get(id);
  if (!t) throw new Error('policy.delivery.terms 引用了不存在的词条 id: ' + id);
  const esc = t.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = 'g' + (t.caseInsensitive ? 'i' : '');
  return { id, re: new RegExp(t.word ? '(?:^|[^A-Za-z0-9_])' + esc + '(?:[^A-Za-z0-9_]|$)' : esc, flags) };
}
const banned = bannedIds.map(termRegex);

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

// 声明面：两个 feed 配置是唯一输入（键名由它们决定，不在本脚本里硬编码）。
const supply = readJson('container/app/src/main/assets/supply/channel.json');
const program = readJson('container/app/src/main/assets/program-feed.json');

const targets = [];
targets.push({
  layer: 'C（工具链清单）',
  source: 'assets/supply/channel.json',
  url: supply.baseUrl + '/userland-' + supply.channel + '/' + supply.manifestName,
  expect: 'manifest',
});
if (supply.sigName) {
  targets.push({
    layer: 'C（工具链清单签名）',
    source: 'assets/supply/channel.json',
    url: supply.baseUrl + '/userland-' + supply.channel + '/' + supply.sigName,
    expect: 'sig',
  });
}
targets.push({
  layer: 'Program（可热更新件清单）',
  source: 'assets/program-feed.json',
  url: program.baseUrl + '/program-' + program.channel + '/' + program.manifestName,
  expect: 'manifest',
});

// 每腿限时 60 秒：本门读的是线上，没有上界的 fetch 会把 CI job 挂成六小时超时，
//   把「通道没答」伪装成「门禁卡住」。
async function get(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': 'lobos-delivery-gate' }, redirect: 'follow',
    signal: AbortSignal.timeout(60000),
  });
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
}

(async () => {
  const problems = [];
  const rows = [];

  // 声明面内部一致：C 层判据（逐字下发到设备执行）里写死的对象键必须等于通道锚声明的键。
  // 判据跟着旧键、清单发到新键 ⇒ 设备拿 404 去判 curl/git 不可用（线上 2026-09-29 正是这个形态：
  // 声明键 userland-manifest-2.json 已 200，而判据仍指旧键）。
  const declared = 'userland-' + supply.channel + '/' + supply.manifestName;
  const verifyText = fs.readFileSync(path.join(root, 'scripts/userland-verify.json'), 'utf8');
  for (const m of verifyText.matchAll(/userland-[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+/g)) {
    if (m[0] !== declared) problems.push('C 层判据引用的对象键已废止：' + m[0] + ' ≠ 通道锚声明的 ' + declared);
  }

  for (const t of targets) {
    // 缓存击穿位：CDN 长 TTL 会替我们撒一次谎（channel.json 的 $comment 就是这么被咬的）
    const probe = t.url + (t.url.includes('?') ? '&' : '?') + 'ts=' + Math.floor(Date.now() / 1000);
    let res;
    let lastErr = null;
    // 读不通重试到 3 次（CDN/链路抖动），但只对「读不到」；内容/身份问题一次都不多重试，
    // 重试三次仍读不到就是红 —— 门禁不装作正常。
    for (let a = 1; a <= 3 && !res; a++) {
      try {
        res = await get(probe);
      } catch (e) {
        lastErr = e;
        if (a < 3) await new Promise((r) => setTimeout(r, 2000 * a));
      }
    }
    if (!res) {
      const why = lastErr.name === 'TimeoutError' ? '60s 未答' : (lastErr.code || lastErr.message);
      problems.push(t.layer + ' 读不到（3 次）：' + why + ' @ ' + t.url);
      rows.push({ layer: t.layer, url: t.url, status: 'ERR:' + why });
      continue;
    }
    const row = { layer: t.layer, url: t.url, status: res.status, bytes: res.buf.length };
    if (res.status !== 200) {
      problems.push(t.layer + ' 线上 HTTP ' + res.status + '（声明键从未投放或已失效）：' + t.url);
      rows.push(row);
      continue;
    }
    const text = res.buf.toString('utf8');
    for (const b of banned) {
      b.re.lastIndex = 0;
      if (b.re.test(text)) problems.push(t.layer + ' 的线上内容含废止身份词 [' + b.id + ']：' + t.url);
    }
    if (t.expect === 'manifest') {
      let j = null;
      try { j = JSON.parse(text); } catch (e) { problems.push(t.layer + ' 线上内容不是合法 JSON：' + e.message); }
      if (j) {
        const v = String(j.version == null ? '' : j.version);
        if (!v) problems.push(t.layer + ' 线上清单读不出 version（通道状态坏了）：' + t.url);
        row.version = v;
        // C 的件表必须在**线上**就是投得出的：一颗只有声明、没有取件 URL 的件，设备侧供给循环会
        //   静默跳过它（2026-09-29 定罪 DS-9：清单声明 5 件、机上只 4 件，诊断仍写「就位 4 件」，
        //   读起来像正常）。这条只读线上正文，不读仓内声明 —— 与整扇门的立身之本一致。
        //   只查 `tools`（C 的形状）：Program 的 `url` 空串另有消费者（设备按 feed 推导，见下方那条腿），
        //   把同一把尺子套过去会把一条合法形状判成红。
        if (Array.isArray(j.tools)) {
          row.tools = j.tools.length;
          for (const piece of j.tools) {
            const nm = String((piece && piece.name) || '(无名)');
            if (!piece || typeof piece.url !== 'string' || !piece.url) {
              problems.push(t.layer + ' 线上清单声明的件没有取件 URL（设备永远不会装上它）：' + nm);
            }
          }
        }
        const urls = [...text.matchAll(/https:\/\/[^"'\s]+/g)].map((m) => m[0]);
        // 这条腿只在清单**真写了绝对 URL** 时才查：线上 Program 清单的 `url` 是空串，设备按 feed
        // 自行推导（`ProgramOtaUpdater.kt:202` `ifBlank { cfg.zipUrl(remote) }`）。那条推导是否取得到
        // 件归真机验收（A9/A10），不在这里复述设备算法 —— 否则又造出第二把尺子。
        for (const u of urls) {
          if (!/\.(zip|tgz|tar\.gz|gz)$/i.test(u)) continue;
          try {
            const h = await get(u);
            if (h.status !== 200) problems.push(t.layer + ' 清单里的包体 URL 不可达 HTTP ' + h.status + '：' + u);
          } catch (e) {
            problems.push(t.layer + ' 清单里的包体 URL 读不到（' + (e.code || e.message) + '）：' + u);
          }
        }
      }
    }
    rows.push(row);
  }
  for (const r of rows) console.log('delivery-gate: [' + r.layer + '] ' + r.status + ' ' + (r.version ? 'version=' + r.version + ' ' : '') + (r.tools != null ? 'tools=' + r.tools + ' ' : '') + r.url);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ rows, problems }));
  if (problems.length) {
    console.error('delivery-gate: FAIL（' + problems.length + ' 项）');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('delivery-gate: 声明键全部在线且身份干净');
  process.exit(0);
})();
