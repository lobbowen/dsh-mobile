'use strict';

// 安卓容器能力垫片：把 dsh 安装树里 4 处「桌面平台硬编码」接到容器注入的 env 旋钮上。
//
// 背景（2026-09-23 全量平台门审计 + 真机报告「缺终端/缺 rg/命令被沙箱拒」）：
//   ① dsh-bash-local 执行器 argv[0] 硬编码 "bash" —— Android 无 /bin/bash 且
//      可 exec 目录只有 nativeLibraryDir（W^X），文件名也必为 lib*.so 形态；
//   ② dsh-terminal-bash DEFAULT_BASH_SHELL = "/bin/bash" 同上；
//   ③ @vscode/ripgrep 解析 `@vscode/ripgrep-android-arm64`（不存在）⇒ 每次
//      glob/grep 必 SEARCH_FAILED；ripgrep 无 JS 等价物，只能 NDK 现编投放；
//   ④ dsh-subprocess-local createProcessInspector 只认 linux/darwin/win32，
//      android 直接 throw（终端报错 "terminal inspection is unsupported on
//      platform android"）。Android 是 Linux 内核，arm64 syscall 号表包内已有
//      （runner-launch 的 LinuxProcessInspector 支路）；/proc/<pid>/mem 被
//      SELinux 拒时该 inspector 自带 catch 降级（isStdinWaiting 退靠 OSC133）。
//
// 沙箱门（PLATFORM_CHAINS 无 android ⇒ bash/PTC 每条命令 SandboxUnavailableError）
// 不需要碰 vendor 代码：dsh-base/cordis.patch.yml 已把权限模式做成部署旋钮
// `mode: process.env.DSH_PERMISSION_MODE`，容器侧注入 danger-full-access 即
// 全链绕行（Android untrusted_app 无用户态沙箱原语，外层 SELinux 即 confinement
// ——产品拍板记录见 commit message）。本垫片只负责①-④的锚点文本补丁。
//
// 门控与自愈模式同 flock/link/PTC 垫片：契约 + DSH_FLOCK_NATIVE（设备标记）在场
// 才投放；锚点命中数≠1 ⇒ 整文件不动报 failed；逐字备份 .dsh-orig；幂等。
// env 缺席（PC/dev）时补丁本身是 `process.env.X || <原字面量>` 的 no-op ⇒ 语义零变化。

const fs = require('node:fs');
const path = require('node:path');

const SHIM_MARKER = 'dsh-android-kernel:capability-env-shim:v1';

/** 目标清单：pkg + lib 下文件（`glob` 形态按前缀匹配哈希名文件）+ [锚点, 替换]。
 *  锚点取自 @deepseek-ai 0.1.7-alpha.2 真实字节（夹具逐字固化于
 *  test/fixtures/capability-env/，门禁钉住命中数）。 */
const TARGETS = [
  {
    pkg: '@deepseek-ai/dsh-bash-local', file: 'lib/index.js',
    replacements: [[
      'return this.executeArgv(spec, [\n\t\t\t"bash",',
      'return this.executeArgv(spec, [\n\t\t\t/* ' + SHIM_MARKER + ' */ process.env.DSH_BASH_BIN || "bash",',
    ]],
  },
  {
    pkg: '@deepseek-ai/dsh-terminal-bash', file: 'lib/index.js',
    replacements: [[
      'const DEFAULT_BASH_SHELL = "/bin/bash";',
      'const DEFAULT_BASH_SHELL = process.env.DSH_BASH_BIN || "/bin/bash"; // ' + SHIM_MARKER,
    ]],
  },
  {
    pkg: '@vscode/ripgrep', file: 'lib/index.js',
    replacements: [[
      'resolved = require.resolve(`${platformPkg}/bin/${binaryName}`);',
      'resolved = process.env.DSH_RIPGREP_BIN || require.resolve(`${platformPkg}/bin/${binaryName}`); // ' + SHIM_MARKER,
    ]],
  },
  {
    pkg: '@deepseek-ai/dsh-subprocess-local', globDir: 'lib', globPrefix: 'runner-launch-', globSuffix: '.js',
    replacements: [[
      'if (platform === "linux") return new LinuxProcessInspector(arch, internals);',
      'if (platform === "linux" || platform === "android") return new LinuxProcessInspector(arch, internals); // ' + SHIM_MARKER,
    ]],
  },
];

function countHits(content, needle) {
  return content.split(needle).length - 1;
}

/** 在安装树里定位指定包目录：扁平优先，@deepseek-ai/* 依赖下嵌套副本兜底
 *  （npm 版本冲突时的压平行为）。同 link-publish-shim。 */
function locatePackages(root, pkgName) {
  const out = [];
  const direct = path.join(root, pkgName);
  try { if (fs.statSync(path.join(direct, 'package.json')).isFile()) out.push(direct); } catch {}
  const scopeDir = path.join(root, '@deepseek-ai');
  try {
    for (const e of fs.readdirSync(scopeDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const nested = path.join(scopeDir, e.name, 'node_modules', pkgName);
      try { if (fs.statSync(path.join(nested, 'package.json')).isFile()) out.push(nested); } catch {}
    }
  } catch {}
  return out;
}

/** 解析目标文件：固定 file 或 glob 前缀匹配（哈希 chunk 名随版本漂移）。 */
function resolveFiles(dir, target) {
  if (target.file) return [path.join(dir, target.file)];
  const d = path.join(dir, target.globDir);
  const out = [];
  try {
    for (const e of fs.readdirSync(d)) {
      if (e.startsWith(target.globPrefix) && e.endsWith(target.globSuffix) && !e.includes('.dsh-orig')) out.push(path.join(d, e));
    }
  } catch {}
  return out;
}

/** 对 npmRoot 安装树幂等投放能力垫片。
 *  返回 { found, results: [{file, status: applied|already|failed, error?}] }；
 *  每文件独立全有或全无（写前全部锚点恰命中 1 次）。 */
function ensureShim(npmRoot) {
  const results = [];
  if (!npmRoot) return { found: 0, results };
  for (const target of TARGETS) {
    for (const dir of locatePackages(npmRoot, target.pkg)) {
      for (const fp of resolveFiles(dir, target)) {
        const rel = path.relative(dir, fp);
        const tag = target.pkg + '/' + rel;
        let cur;
        try { cur = fs.readFileSync(fp, 'utf8'); } catch (e) { results.push({ file: tag, status: 'failed', error: e.message }); continue; }
        if (cur.includes(SHIM_MARKER)) { results.push({ file: tag, status: 'already' }); continue; }
        const missed = target.replacements.filter(([from]) => countHits(cur, from) !== 1);
        if (missed.length) { results.push({ file: tag, status: 'failed', error: '锚点命中数≠1: ' + missed.map(([, t]) => JSON.stringify(t.slice(0, 48))).join(', ') }); continue; }
        let out = cur;
        for (const [from, to] of target.replacements) out = out.split(from).join(to);
        try {
          const base = path.basename(fp);
          const dot = base.lastIndexOf('.');
          const origPath = path.join(path.dirname(fp), base.slice(0, dot) + '.dsh-orig' + base.slice(dot));
          if (!fs.existsSync(origPath)) fs.writeFileSync(origPath, cur);
          fs.writeFileSync(fp, out);
          results.push({ file: tag, status: 'applied' });
        } catch (e) { results.push({ file: tag, status: 'failed', error: e.message }); }
      }
    }
  }
  return { found: results.length, results };
}

module.exports = { SHIM_MARKER, TARGETS, ensureShim, locatePackages, resolveFiles };
