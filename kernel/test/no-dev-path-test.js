#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 无机器绑定路径门禁（2026-09-14）
//
// ## 解决的问题
//   代码/测试/脚本/文档里写死**某个操作者**的绝对 home（如 /home/bowen），
//   会让项目只在某台机器上成立：
//     · cred.sh 曾默认 /home/bowen/.dsh/credentials；
//     · 两个凭据门禁与 UI placeholder 曾硬编码 /home/bowen；
//     · 文档把「规范库」写成某人的 home。
//   正确形态：真实 home 经 getent/dscl/USERPROFILE 解析（见 cred.sh / _npm-auth.sh），
//   或由 DSH_CRED_DIR / DSH_REAL_HOME 显式覆盖。
//
// ## 判据
//   只把「像真实账号」的 home 名视为违规：长度 < 4 的短名（a/u/me）与
//   通用占位（user/example/test/...）放行 —— 它们是可移植的测试夹具，
//   不是机器绑定。
//
// ## 锁定的不变量
//   X-1 代码/脚本/workflow 无操作者绝对路径（注释里举例不算；剥离注释后判）
//   X-2 现行文档（.md）无操作者绝对路径（CHANGELOG 与 archive/ 属历史，排除）
//   X-3 反向：判据能识别 POSIX/Windows 真实账号路径，且放行通用占位
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const SELF = path.basename(__filename);

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : '')); };

// 捕获 home 段名：/home/<name>、/Users/<name>、C:\Users\<name>
const HOME_RE = /(?:\/home\/|\/Users\/|[A-Za-z]:[\\/]Users[\\/])([A-Za-z0-9._-]+)/g;
// 通用占位（可移植夹具）——不作为机器绑定
const GENERIC = new Set(['user', 'users', 'operator', 'example', 'sample', 'test', 'someone', 'public', 'shared', 'localhost', 'host', 'node', 'root', 'admin', 'home', 'john', 'jane', 'alice', 'bob', 'carol', 'dave', 'foo', 'bar', 'baz']);

/** 返回像「真实账号」的 home 路径命中（长度 < 4 或通用占位放行）。 */
function realHits(text) {
  const out = [];
  let m;
  HOME_RE.lastIndex = 0;
  while ((m = HOME_RE.exec(text))) {
    const name = m[1];
    if (name.length >= 4 && !GENERIC.has(name.toLowerCase())) out.push(m[0]);
  }
  return out;
}

const CODE_DIRS = ['src', 'test', 'bin', '.github', 'ui/src'];
const CODE_EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.sh', '.yml', '.yaml', '.json']);
const SKIP_DIR = new Set(['node_modules', 'target', 'dist', '.git', 'archive']);
const SKIP_FILE = new Set([SELF, 'CHANGELOG.md']);

/** 剥离注释：只对代码用。注释里举例（如 `/home/john smith`）不构成机器绑定。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(String.fromCharCode(10))
    .map((l) => {
      const t = l.trim();
      if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*')) return '';
      return l;
    })
    .join(String.fromCharCode(10));
}

function walk(dir, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
}

// ── X-1 代码/脚本/workflow（剥离注释）──
console.log('== X-1 代码/脚本无操作者绝对路径 ==');
{
  const files = [];
  for (const d of CODE_DIRS) walk(path.join(ROOT, d), files);
  const offenders = [];
  let scanned = 0;
  for (const f of files) {
    if (SKIP_FILE.has(path.basename(f))) continue;
    if (!CODE_EXT.has(path.extname(f))) continue;
    scanned++;
    const hits = realHits(stripComments(fs.readFileSync(f, 'utf8')));
    if (hits.length) offenders.push(path.relative(ROOT, f) + ' :: ' + hits[0]);
  }
  check('X-1 代码/脚本/workflow 无操作者绝对路径',
    offenders.length === 0, offenders.slice(0, 6).join(' | ') || ('扫描 ' + scanned + ' 个文件，零命中'));
}

// ── X-2 现行文档（.md；排除 CHANGELOG 与 archive/）──
console.log('== X-2 现行文档无操作者绝对路径 ==');
{
  const files = [];
  walk(ROOT, files);
  const offenders = [];
  for (const f of files) {
    if (path.extname(f) !== '.md') continue;
    if (SKIP_FILE.has(path.basename(f))) continue;
    const rel = path.relative(ROOT, f);
    if (rel.split(path.sep)[0] === 'archive') continue;
    const hits = realHits(fs.readFileSync(f, 'utf8'));
    if (hits.length) offenders.push(rel + ' :: ' + hits[0]);
  }
  check('X-2 现行文档无操作者绝对路径',
    offenders.length === 0, offenders.slice(0, 6).join(' | ') || '零命中');
}

// ── X-3 反向 ──
console.log('== X-3 反向（判据有效性）==');
{
  check('X-3 反向：能识别 /home/<真实账号>',
    realHits('const p = "/home/bowen/x";').length > 0, 'hit');
  check('X-3 反向：能识别 C:\\Users\\<真实账号>',
    realHits('C:\\Users\\bowen\\x').length > 0, 'hit');
  check('X-3 反向：放行短名夹具（/home/a、/home/u、/home/me）',
    realHits('/home/a /home/u /home/me').length === 0, 'ok');
  check('X-3 反向：放行通用占位（/home/user、/home/example）',
    realHits('/home/user /home/example').length === 0, 'ok');
  check('X-3 反向：不误报 ~ 与相对路径',
    realHits('~/.dsh/x  relative/path').length === 0, 'ok');
  check('X-3 反向：CHANGELOG 被显式排除（历史允许）',
    SKIP_FILE.has('CHANGELOG.md'), 'ok');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
