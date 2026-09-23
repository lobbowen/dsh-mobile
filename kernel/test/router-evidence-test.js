#!/usr/bin/env node
'use strict';

// 自动取证 JSONL（src/system-services/router/evidence.js）回归：
//  - append 落盘（JSON 一行一条，0600）；
//  - 轮转：超 maxBytes → 当前文件改名 .1 再开新文件；
//  - readTail：只回已解析行（坏行跳过）、按序返回最后 n 条；
//  - pickEvidenceHeaders：白名单头过滤（敏感头绝不落盘；大小写兼容）；
//  - stats 报告路径/字节。
// 纯本地文件操作，不触碰真实 daemon/账号/上游。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'router-evidence-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

(async () => {
  const { UpstreamEvidence, pickEvidenceHeaders } = require(path.join(ROOT, 'src', 'domains', 'router', 'evidence'));

  console.log('== append / 落盘 / tail / stats ==');
  const file = path.join(TMP, 'ev.jsonl');
  const ev = new UpstreamEvidence({ file });
  const ok1 = ev.append({ ts: '2026-09-04T10:00:00Z', status: 400, signal: 'credits', body: 'raw body' });
  ev.append({ ts: '2026-09-04T10:00:01Z', status: 429, signal: 'window' });
  ev.append({ ts: '2026-09-04T10:00:02Z', status: 503, signal: 'transient' });
  const raw = fs.readFileSync(file, 'utf8');
  check('append 返回 true 且落盘 3 行合法 JSON', ok1 === true && raw.split('\n').filter(Boolean).length === 3 && raw.split('\n').every((l) => { if (!l.trim()) return true; try { JSON.parse(l); return true; } catch { return false; } }), raw);
  // POSIX 0600 权限位校验；Windows 无 POSIX chmod 语义（mode 恒为 0o666 类默认 ACL），
  // 严格位比较仅适用于类 Unix。Windows 上验证文件确已创建即可（权限由 NTFS ACL 表达）。
  if (process.platform === 'win32') {
    check('文件已创建（Windows：权限经 NTFS ACL，无 POSIX 位）', fs.existsSync(file), 'win');
  } else {
    check('文件权限 0600', (fs.statSync(file).mode & 0o777) === 0o600, String(fs.statSync(file).mode & 0o777));
  }
  const tail1 = ev.readTail(1);
  check('readTail(1) 返回最后 1 条', tail1.length === 1 && tail1[0].status === 503 && tail1[0].signal === 'transient', JSON.stringify(tail1));
  const tail2 = ev.readTail(2);
  check('readTail(2) 按序返回', tail2.length === 2 && tail2[0].status === 429 && tail2[1].status === 503, JSON.stringify(tail2.map((x) => x.status)));
  const st = ev.stats();
  check('stats：路径/字节一致', st.enabled === true && st.file === file && st.bytes === Buffer.byteLength(raw), JSON.stringify(st));

  console.log('== 坏行跳过 ==');
  fs.appendFileSync(file, 'this-is-not-json\n');
  ev.append({ ts: 'x', status: 400 });
  const tail3 = ev.readTail(2);
  check('坏行被跳过，只回合法记录', tail3.length === 2 && tail3.every((x) => x && typeof x === 'object' && x.ts !== undefined), JSON.stringify(tail3.map((x) => x.status)));

  console.log('== 轮转（超 maxBytes → .1）==');
  const rotFile = path.join(TMP, 'rot.jsonl');
  const small = new UpstreamEvidence({ file: rotFile, maxBytes: 150 });
  for (let i = 0; i < 12; i++) small.append({ i, pad: 'x'.repeat(40) }); // 每条约 50B → 超过 150B 即轮转多次
  check('轮转产物 .1 存在', fs.existsSync(rotFile + '.1'), '');
  const tailR = small.readTail(4);
  check('轮转后 readTail 回当前文件尾（最后一条 i=11，条数≤当前文件可容纳）', tailR.length >= 1 && tailR.length <= 4 && tailR[tailR.length - 1].i === 11, JSON.stringify(tailR.map((x) => x.i)));
  const stR = small.stats();
  check('轮转后 stats.rotated>0 且当前文件 ≤ 上限', stR.rotated > 0 && stR.bytes <= 150, JSON.stringify({ rotated: stR.rotated, bytes: stR.bytes }));

  console.log('== pickEvidenceHeaders：白名单过滤 ==');
  const picked = pickEvidenceHeaders({
    'Retry-After': '120',
    'x-ratelimit-reset-ms': '1788000000000',
    'set-cookie': ['sid=secret'],
    authorization: 'Bearer sk-secret',
    'x-request-id': 'req-1',
    'content-type': 'application/json',
  });
  check('保留限额/排查头（大小写兼容）', picked['retry-after'] === '120' && picked['x-ratelimit-reset-ms'] === '1788000000000' && picked['x-request-id'] === 'req-1', JSON.stringify(picked));
  check('敏感头绝不落盘（set-cookie/authorization）', picked['set-cookie'] === undefined && picked.authorization === undefined, JSON.stringify(picked));
  const empty = pickEvidenceHeaders(null);
  check('null headers 安全返回空', empty && Object.keys(empty).length === 0, JSON.stringify(empty));

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
