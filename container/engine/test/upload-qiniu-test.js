'use strict';

// 投放口唯一宿主（scripts/upload-qiniu.js）的行为自测 + 回潮门禁，全跑在进程内假七牛上
// （不碰网络、不碰真凭据）。盯两件事：
//   ① 行为：上传应答不等于投放生效，「设备读得到」只能由回读逐字节比对给出 —— 所以每条出口
//      （生效 / 取不到 / 内容不符 / 4xx / 5xx 重试）都必须有对照组能红。分片路径按七牛
//      《分片上传 v1》：块 ≤ 4 MiB、mkfile 按序组装**块**的 ctx、不用 bput 续片。
//   ② 回潮：回读判据只有这一个宿主 —— workflow 里不许自带只打印不判红的自证回读，
//      每个调用点必须给 QINIU_PUBLIC_BASE；脚本末尾的入口调用必须存在，静默退 0 的投放口
//      比报错的更坏。
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const makeRunner = require('./harness');

const { check, finish } = makeRunner('upload-qiniu');
const stripComments = makeRunner.stripComments;

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HOST_SCRIPT = path.join(ROOT, 'scripts/upload-qiniu.js');
const WF_DIR = path.join(ROOT, '.github/workflows');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-qiniu-'));
const small = Buffer.from('{"hello":"world"}\n', 'utf8');
const smallFile = path.join(tmp, 'manifest.json');
fs.writeFileSync(smallFile, small);
// 分片路径的门槛是 8 MiB（buf.length > 8*1024*1024），取 9 MiB 跨过它。
const bigFile = path.join(tmp, 'tooltree.zip');
const big = Buffer.alloc(9 * 1024 * 1024);
for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
fs.writeFileSync(bigFile, big);

// ---------------------------------------------------------------------------
//  假七牛 Kodo：表单上传 + 分片上传（mkblk/bput/mkfile），外加一个 CDN 域名口。
//  状态由下面的 state 控制，每个用例开跑前重置。
// ---------------------------------------------------------------------------
const state = {};
function resetState() {
  state.bucket = new Map();      // 远端 key -> 实际存下的字节
  state.blocks = new Map();      // ctx -> 该块字节（每块 ≤ 4 MiB，七牛分片上传 v1）
  state.requestHits = 0;         // 上传侧收到的请求总数（含被档位挡掉的）
  state.uploadHits = 0;          // 上传侧成功受理次数（判「有没有真的跑」）
  state.readbackHits = 0;        // CDN 侧被 GET 次数
  state.uploadStatus = 200;      // 上传应答档位
  state.upload5xxThenOk = 0;     // >0：前 N 次上传回 500，之后回 200
  state.publicMode = 'ok';       // ok | absent | spoof | wrong-length
  state.lastFormFields = null;
  state.mkblkHits = 0;
  state.mkfileHits = 0;
  state.blockErrors = [];        // 协议违规（如块超 4 MiB）记录，供断言
}
resetState();

function decodeForm(req, body) {
  const ct = req.headers['content-type'] || '';
  const m = /boundary=([^;]+)/.exec(ct);
  if (!m) return { fields: {}, file: Buffer.alloc(0) };
  const B = Buffer.from('--' + m[1]);
  const fields = {};
  let file = null;
  let pos = body.indexOf(B) + B.length + 2; // 跳过首个分隔符与 CRLF
  while (pos < body.length) {
    const end = body.indexOf(B, pos);
    if (end < 0) break;
    const part = body.subarray(pos, end - 2); // 去掉尾部 CRLF
    const headEnd = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, headEnd).toString('utf8');
    const content = part.subarray(headEnd + 4);
    const nm = /name="([^"]+)"/.exec(head);
    if (/filename=/.test(head)) file = content;
    else if (nm) fields[nm[1]] = content.toString('utf8');
    pos = end + B.length + 2;
  }
  return { fields, file: file || Buffer.alloc(0) };
}

const B64URLDEC = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const uploadSrv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    state.requestHits++;
    if (state.upload5xxThenOk > 0) { state.upload5xxThenOk--; res.writeHead(500); res.end('{"error":"flaky"}'); return; }
    if (state.uploadStatus !== 200) { res.writeHead(state.uploadStatus); res.end('{"error":"BadToken"}'); return; }
    state.uploadHits++;
    // 分片上传 v1：每块一次 mkblk（块 ≤ 4 MiB），mkfile 按顺序把这些块组装成资源。
    if (/^\/mkblk\//.test(req.url)) {
      const declared = Number(req.url.split('/')[2]);
      if (declared !== body.length) { res.writeHead(400); res.end('{"error":"blockSize 与实际字节不符"}'); return; }
      if (body.length > 4 * 1024 * 1024) {
        state.blockErrors.push('mkblk 块 ' + body.length + ' 字节 > 4 MiB');
        res.writeHead(400); res.end('{"error":"block size exceeds 4MB"}'); return;
      }
      const ctx = 'ctx-' + state.mkblkHits + '-' + Date.now();
      state.mkblkHits++;
      state.blocks.set(ctx, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ctx, checksum: 'fake', offset: body.length }));
      return;
    }
    if (/^\/bput\//.test(req.url)) {
      // 一块内续片用得上，本脚本一块就是 ≤4 MiB，不该走到这里；走到就是协议用错。
      state.blockErrors.push('不该使用 bput: ' + req.url);
      res.writeHead(400); res.end('{"error":"unexpected bput"}'); return;
    }
    if (/^\/mkfile\//.test(req.url)) {
      state.mkfileHits++;
      const seg = req.url.split('/');
      const key = B64URLDEC(seg[seg.indexOf('key') + 1]).toString('utf8');
      const declared = Number(seg[seg.indexOf('mkfile') + 1]);
      const ctxs = body.toString('utf8').split(',');
      const missing = ctxs.filter((c) => !state.blocks.has(c));
      if (missing.length) { res.writeHead(401); res.end('{"error":"ctx 未知: ' + missing[0] + '"}'); return; }
      const joined = Buffer.concat(ctxs.map((c) => state.blocks.get(c)));
      if (joined.length !== declared) { res.writeHead(400); res.end('{"error":"mkfile 声明 ' + declared + ' 字节，块合计 ' + joined.length + '"}'); return; }
      state.bucket.set(key, joined);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ key, hash: 'fake' }));
      return;
    }
    // 表单
    const { fields, file } = decodeForm(req, body);
    state.lastFormFields = fields;
    state.bucket.set(fields.key, file);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key: fields.key, hash: 'fake' }));
  });
});

const cdnSrv = http.createServer((req, res) => {
  state.readbackHits++;
  const key = decodeURIComponent((req.url.split('?')[0] || '').replace(/^\/+/, ''));
  const obj = state.bucket.get(key);
  if (state.publicMode === 'absent' || !obj) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"Document not found"}'); return; }
  if (state.publicMode === 'spoof') { res.writeHead(200); res.end(Buffer.concat([obj.slice(0, obj.length - 1), Buffer.from('X')])); return; }
  if (state.publicMode === 'wrong-length') { res.writeHead(200); res.end(obj.subarray(0, Math.max(0, obj.length - 1))); return; }
  res.writeHead(200); res.end(obj);
});

// 假服务端跑在本进程里，所以子进程必须异步起：spawnSync 会占死事件循环，
// 服务端永远轮不到应答（第一次写就用错了，表现为子进程干等上传应答）。
function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOST_SCRIPT, ...args], {
      env: Object.assign({}, process.env, {
        QINIU_AK: 'fake-ak', QINIU_SK: 'fake-sk', QINIU_BUCKET: 'fake-bucket',
        QINIU_UPLOAD_HOST: 'http://127.0.0.1:' + uploadSrv.address().port,
        QINIU_PUBLIC_BASE: 'http://127.0.0.1:' + cdnSrv.address().port,
        QINIU_READBACK_ATTEMPTS: '1',
      }, env || {}),
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const killer = setTimeout(() => { child.kill('SIGKILL'); }, 120000);
    child.on('close', (status) => { clearTimeout(killer); resolve({ status, stdout, stderr }); });
  });
}

(async () => {
  await Promise.all([
    new Promise((r) => uploadSrv.listen(0, '127.0.0.1', r)),
    new Promise((r) => cdnSrv.listen(0, '127.0.0.1', r)),
  ]);

  // ---- ① 行为：小件端到端 —— 上传真的发生、回读真的比对、判据真的放行 ----
  resetState();
  let r = await run([smallFile, 'userland-canary/manifest.json', '--cache-control=60']);
  check('小件端到端退 0（脚本真跑了，不是打印完就退）', r.status === 0, 'status=' + r.status + ' err=' + (r.stderr || '').slice(0, 160));
  check('小件：上传侧收到 1 次 POST', state.uploadHits === 1, 'uploadHits=' + state.uploadHits);
  check('小件：回读命中设备会用的那个 URL', state.readbackHits === 1, 'readbackHits=' + state.readbackHits);
  check('小件：线上字节与本地逐字节一致', Buffer.compare(state.bucket.get('userland-canary/manifest.json') || Buffer.alloc(0), small) === 0);
  check('小件：--cache-control 落到 x:Cache-Control（清单短缓存）', state.lastFormFields && state.lastFormFields['x:Cache-Control'] === 'max-age=60', JSON.stringify(state.lastFormFields));
  check('小件：成功路径打印回读证据（只有「已上传」不算生效）', /\[qiniu\] 回读 \[ok\]/.test(r.stdout), (r.stdout || '').split('\n').pop());

  // ---- 没有回读锚就不许声称投放生效 ----
  resetState();
  r = await run([smallFile, 'userland-canary/manifest.json'], { QINIU_PUBLIC_BASE: '' });
  check('缺 QINIU_PUBLIC_BASE ⇒ 退 2 且一次都不上传', r.status === 2 && state.uploadHits === 0, 'status=' + r.status + ' uploadHits=' + state.uploadHits);

  // ---- 判红必须双向：线上 404 ----
  resetState();
  state.publicMode = 'absent';
  r = await run([smallFile, 'userland-canary/manifest.json']);
  check('线上 404 ⇒ 判红（七牛收了不等于设备读得到）', r.status === 1 && /投放未生效/.test(r.stderr), 'status=' + r.status + ' err=' + (r.stderr || '').slice(0, 160));
  check('线上 404：上传确实发生了（红的是回读，不是上传）', state.uploadHits === 1 && state.readbackHits === 1, 'upload=' + state.uploadHits + ' readback=' + state.readbackHits);

  // ---- 判红必须双向：取到了但是另一份字节（CDN 截断/替换）----
  resetState();
  state.publicMode = 'spoof';
  r = await run([smallFile, 'userland-canary/manifest.json']);
  check('回读内容不符 ⇒ 判红', r.status === 1 && /内容不符/.test(r.stderr), 'status=' + r.status + ' err=' + (r.stderr || '').slice(0, 200));
  check('内容不符不重试（这是事故不是抖动）', state.readbackHits === 1, 'readbackHits=' + state.readbackHits);

  // ---- 缺尾字节也要抓到（长度差比哈希差更常见：截断）----
  resetState();
  state.publicMode = 'wrong-length';
  r = await run([smallFile, 'userland-canary/manifest.json']);
  check('回读少一个字节 ⇒ 判红', r.status === 1, 'status=' + r.status);

  // ---- 4xx 不重试：令牌/参数错，重试不会让它变对 ----
  resetState();
  state.uploadStatus = 401;
  r = await run([smallFile, 'userland-canary/manifest.json']);
  check('上传 4xx ⇒ 退 1', r.status === 1, 'status=' + r.status);
  check('上传 4xx 只发一次（401 不靠重试蒙）', state.requestHits === 1, 'requestHits=' + state.requestHits);

  // ---- 5xx 走重试：一次抖动不该放大成「清单没更新」----
  resetState();
  state.upload5xxThenOk = 1;
  r = await run([smallFile, 'userland-canary/manifest.json']);
  check('上传 5xx 后重试成功 ⇒ 退 0', r.status === 0, 'status=' + r.status + ' err=' + (r.stderr || '').slice(0, 200));
  check('上传 5xx 确实重试了（不是一次失败就退）', state.requestHits === 2 && state.uploadHits === 1, 'requests=' + state.requestHits + ' ok=' + state.uploadHits);

  // ---- 分片路径端到端（>8 MiB 才走这条）----
  resetState();
  r = await run([bigFile, 'userland/git/git-tree.zip', '--cache-control=31536000']);
  check('分片上传退 0（>8 MiB 走 mkblk/mkfile）', r.status === 0, 'status=' + r.status + ' err=' + (r.stderr || '').slice(0, 240));
  check('分片：按块切（9 MiB ⇒ 4+4+1 三块，各一次 mkblk）', state.mkblkHits === 3 && state.mkfileHits === 1, 'mkblk=' + state.mkblkHits + ' mkfile=' + state.mkfileHits);
  check('分片：没有踩协议红线（块 ≤4 MiB、不用 bput 续片）', state.blockErrors.length === 0, state.blockErrors.join(' | '));
  const gotBig = state.bucket.get('userland/git/git-tree.zip');
  check('分片：回读比对整块逐字节一致（块顺序错就会红）', !!gotBig && Buffer.compare(gotBig, big) === 0, 'bytes=' + (gotBig ? gotBig.length : 'null') + '/' + big.length);
  check('分片：成功也必须有回读证据', state.readbackHits === 1 && /\[qiniu\] 回读 \[ok\]/.test(r.stdout));

  // ---- ② 回潮：判据只有一个宿主 ----
  const wfFiles = fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));
  const callSites = [];
  const anchorless = [];
  const inlineProbe = [];
  for (const f of wfFiles) {
    const raw = fs.readFileSync(path.join(WF_DIR, f), 'utf8');
    const body = stripComments(raw);
    const steps = body.split('\n');
    let cur = [];
    for (const line of steps.concat(['###'])) {
      if (/^\s*-\s+name:/.test(line) || line === '###') {
        if (cur.some((l) => /scripts\/upload-qiniu\.js/.test(l))) {
          const blk = cur.join('\n');
          const n = (blk.match(/scripts\/upload-qiniu\.js/g) || []).length;
          for (let i = 0; i < n; i++) callSites.push(f);
          if (!/QINIU_PUBLIC_BASE/.test(blk)) anchorless.push(f);
        }
        cur = [];
      }
      cur.push(line);
    }
    if (/USERLAND_BASE_URL|\[readback\]|curl -s -o \/tmp\/m\.json/.test(body)) inlineProbe.push(f);
  }
  check('投放口存在且不为零（调用点被扫描到才谈得上门禁）', callSites.length >= 5, '调用点=' + callSites.length);
  check('每个 upload-qiniu 调用点都自带回读锚 QINIU_PUBLIC_BASE', anchorless.length === 0, '缺锚: ' + anchorless.join(','));
  check('workflow 里不得再出现只打印不判红的自证回读', inlineProbe.length === 0, '残留: ' + inlineProbe.join(','));
  check('入口调用钉在脚本末尾（静默退 0 的投放口比报错的更坏）', /main\(\)\.catch\(/.test(stripComments(fs.readFileSync(HOST_SCRIPT, 'utf8'))));

  uploadSrv.close(); cdnSrv.close();
  finish();
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
