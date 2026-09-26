#!/usr/bin/env node
'use strict';

// rg 平台包投放回归。钉住的历史缺陷（真机 2026-09-26 定罪）：本单元的 $PREFIX 曾来自
// 容器环境变量，而容器从未导出过那个键 ⇒ 永久 no-op 且零日志，dsh 的 glob/grep 全灭。
// 现在 prefix 只从 runtime.json 契约经参数进来，缺格必须判 blocked（可见缺口），
// 绝不再退回「静默跳过」。
//
// 幂等判据钉的是**链接指向**而不是文件存在：容器换过 rg 之后旧链接照样存在，
// 按存在性判 already 会把安装树永远钉在第一代那份上。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// workflow 只能经 _workflow 读（行尾归一化），裸 readFileSync 由 workflow-parse W4 判红。
const W = require(path.join(__dirname, '_workflow.js'));
const { PKG, ensureRipgrepPackage } = require(path.join(ROOT, 'src', 'guard', 'native', 'ripgrep-package'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-pkg-'));
const npm = path.join(TMP, 'npm-root');
const prefix = path.join(TMP, 'usr');
fs.mkdirSync(npm, { recursive: true });
fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
const rg = path.join(prefix, 'bin', 'rg');
fs.writeFileSync(rg, '#!/x\n');

const linkDir = path.join(npm, '@vscode', 'ripgrep-android-arm64');
const link = path.join(linkDir, 'bin', 'rg');

// ── 缺口必须报警，不许静默 ──
check('无 npm 全局根 -> blocked', ensureRipgrepPackage(null, { prefix }).status === 'blocked');
check('契约无 prefix -> blocked 且不动安装树', (() => {
  const r = ensureRipgrepPackage(npm, { prefix: null });
  return r.status === 'blocked' && !fs.existsSync(linkDir) && String(r.reason).includes('prefix');
})());
check('prefix 在场但该格下无 rg -> blocked', (() => {
  const r = ensureRipgrepPackage(npm, { prefix: path.join(TMP, 'empty-usr') });
  return r.status === 'blocked' && !fs.existsSync(linkDir);
})());

// ── 正常投放 ──
const r1 = ensureRipgrepPackage(npm, { prefix });
check('有 rg -> applied', r1.status === 'applied', JSON.stringify(r1));
// 目录名必须由 PKG 决定：dsh 侧按 @vscode/ripgrep-<platform>-<arch> 拼名解析，
// 实现里若漂成别的名字，require.resolve 就找不到 —— 这条判据让它在 CI 红。
check('投到 PKG 名下（与 dsh 的解析名同源）', fs.existsSync(link) && path.dirname(path.dirname(link)) === path.join(npm, PKG), PKG);
check('package.json 带 name/version', (() => {
  const j = JSON.parse(fs.readFileSync(path.join(linkDir, 'package.json'), 'utf8'));
  return j.name === PKG && !!j.version;
})());
check('rg 是符号链接且逐字指向契约 prefix 下那份', fs.readlinkSync(link) === rg, fs.readlinkSync(link));

// ── 幂等 ──
check('二次调用 -> already（不重复写）', ensureRipgrepPackage(npm, { prefix }).status === 'already');
const pkgJsonBefore = fs.readFileSync(path.join(linkDir, 'package.json'), 'utf8');

// ── 换根后必须重指向（旧实现按存在性判 already 会漏掉这一格）──
const prefix2 = path.join(TMP, 'usr2');
fs.mkdirSync(path.join(prefix2, 'bin'), { recursive: true });
const rg2 = path.join(prefix2, 'bin', 'rg');
fs.writeFileSync(rg2, '#!/x\n');
check('prefix 变更 -> applied 且链接改指新 rg', (() => {
  const r = ensureRipgrepPackage(npm, { prefix: prefix2 });
  return r.status === 'applied' && fs.readlinkSync(link) === rg2;
})());
check('已有 package.json 不被覆盖', fs.readFileSync(path.join(linkDir, 'package.json'), 'utf8') === pkgJsonBefore);

// ── 损坏的占位文件（非链接）也要能被修复 ──
fs.rmSync(link);
fs.writeFileSync(link, 'not-a-symlink');
check('链接位被普通文件占据 -> 重投为符号链接', (() => {
  const r = ensureRipgrepPackage(npm, { prefix });
  return r.status === 'applied' && fs.readlinkSync(link) === rg;
})());

// ── 版本号不许自编：设备上的 rg 是 CI 用 cargo 交叉编出来的那一份，桥接包声明的版本
// 必须是同一格。事实源 = .github/workflows/fast-apk.yml 的 `cargo install --version <x> … ripgrep`。
// 读不到配方/解析不出版本一律 FAIL —— 那样这条判据就是在空转，等于没装锁。
// 取实现源码里的常量而非落盘产物：静态对账，不依赖上面那次投放跑没跑成。
try {
  const impl = fs.readFileSync(path.join(ROOT, 'src', 'guard', 'native', 'ripgrep-package.js'), 'utf8');
  const bridgeVer = (/version:\s*'(\d[\d.]+)'/.exec(impl) || [])[1] || null;
  const wf = W.readWorkflow('fast-apk.yml', path.join(ROOT, '..'));
  const cargoVer = (/cargo install[^\n]*--version\s+([\d.]+)[^\n]*\bripgrep\b/.exec(wf) || [])[1] || null;
  check('桥接包版本 = CI 编 ripgrep 的那份', !!cargoVer && !!bridgeVer && bridgeVer === cargoVer,
    '配方 ' + cargoVer + ' / 桥接包 ' + bridgeVer);
  check('对照组：配方写法变了要红（判据认得真实那一行）',
    !!(/cargo install[^\n]*--version\s+([\d.]+)[^\n]*\bripgrep\b/.exec('RUN cargo install --locked --version 14.1.1 ripgrep --target aarch64-linux-android') || [])[1]);
} catch (e) {
  check('fast-apk.yml 可读（版本对账的前提）', false, e.message);
}

fs.rmSync(TMP, { recursive: true, force: true });
const failed = results.filter((x) => !x);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
