#!/usr/bin/env node
'use strict';

// 无机器绑定路径门禁：代码/脚本/workflow/现行文档不得写死操作者绝对 home（如 /home/bowen）。
// 放行：短名(<4)、通用占位(user/example/test…)、以 . 开头的隐藏目录段(/home/.dsh)。
// 扫描根 = 仓根（曾误写 kernel/ → .github 漏扫、docs 扫 0 个却判绿）。门禁法③：≤60 行 + 自证。
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..');
const SELF = path.basename(__filename);
const NL = String.fromCharCode(10);
const HOME_RE = /(?:\/home\/|\/Users\/|[A-Za-z]:[\\/]Users[\\/])([A-Za-z0-9._-]+)/g;
const GEN = new Set('user users operator example sample test someone public shared localhost host node root admin home john jane alice bob carol dave foo bar baz'.split(' '));
const EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.sh', '.yml', '.yaml', '.json']);
const SKIP = new Set(['node_modules', 'target', 'dist', '.git', 'archive', 'build', '.gradle']);
const R = [];
const check = (n, c, x) => { R.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  <- ' + x : '')); };
/** 像「真实账号」的 home 命中（短名 / 通用占位 / 点开头放行）。 */
function hits(t) {
  const o = []; let m; HOME_RE.lastIndex = 0;
  while ((m = HOME_RE.exec(t))) { const n = m[1]; if (n.length >= 4 && !n.startsWith('.') && !GEN.has(n.toLowerCase())) o.push(m[0]); }
  return o;
}
/** 剥注释：只对代码用（# / // / 块注释）；文档原样。 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split(NL).map((l) => { const t = l.trim(); return (t.startsWith('//') || t.startsWith('#') || t.startsWith('*')) ? '' : l; }).join(NL);
function walk(d, o) { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { if (SKIP.has(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, o); else o.push(p); } }
function scan(items, pick, prep) {
  const files = [];
  for (const d of items) { const p = path.isAbsolute(d) ? d : path.join(ROOT, d); try { if (fs.statSync(p).isDirectory()) walk(p, files); else files.push(p); } catch {} }
  const bad = []; let n = 0;
  for (const f of files) { if (!pick(f)) continue; n++; const h = hits(prep(fs.readFileSync(f, 'utf8'))); if (h.length) bad.push(path.relative(ROOT, f) + ' :: ' + h[0]); }
  return { bad, n, txt: (bad.slice(0, 6).join(' | ') || '零命中') + ' ／ 扫描 ' + n + ' 个' };
}
const c1 = scan(['container', 'kernel', 'scripts', '.github'], (f) => path.basename(f) !== SELF && EXT.has(path.extname(f)), strip);
check('X-1 代码/脚本/workflow 无操作者绝对路径（且扫描非空）', c1.bad.length === 0 && c1.n > 0, c1.txt);
const c2 = scan([path.join(ROOT, 'docs'), path.join(ROOT, 'README.md')], (f) => path.extname(f) === '.md' && path.basename(f) !== 'CHANGELOG.md', (s) => s);
check('X-2 现行文档无操作者绝对路径（且扫描非空）', c2.bad.length === 0 && c2.n > 0, c2.txt);
const proofs = [
  ['抓 POSIX 账号', hits('const p="/home/bowen/x";').length > 0],
  ['抓 Windows 账号', hits('C:\\Users\\bowen\\x').length > 0],
  ['放行短名', hits('/home/a /home/u /home/me').length === 0],
  ['放行占位', hits('/home/user /home/example').length === 0],
  ['放行点段', hits('/home/.dsh/x').length === 0],
  ['不误报 ~/相对', hits('~/.dsh/x relative/path').length === 0],
  ['代码非空', c1.n > 0],
  ['文档非空', c2.n > 0],
];
const blind = proofs.filter(([, ok]) => !ok).map(([n]) => n);
check('X-3 自证（判据有效 + 扫描非空）', blind.length === 0, blind.join(', '));
const failed = R.filter((r) => !r);
console.log(NL + '结果: ' + (R.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
