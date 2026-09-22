#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 内核更新单写入者门禁（Android 版）—— 单写入者 = 安卓容器 OTA，内核「零自更新面」。
//
// ## 契约（见 docs/ANDROID-PLAN.md）
//   内核（本仓产物）由**安卓容器 OTA** 安装/升级/重启，是内核代码的**唯一写入者**。
//   内核自身不分发、不安装、不重启自己；因此它既没有自更新写端点，也没有自更新只读端点
//   （没有"自己的新版本"可查 —— 版本号由容器 OTA 侧持有）。
//
//   ⚠ 本仓是全新仓库：**不保留 410 下架桩**。"已下架但仍在"的端点会让人以为
//     内核还能被某个客户端驱动更新 —— 那正是双写入者错觉的来源。要删就删干净。
//
// ## 锁定不变量
//   KU-1  内核无自更新端点：src/api 无 /self-update 路由，guard.owns 不认该前缀
//   KU-2  surface 清单无 /self-update（路由项 + 前缀项）
//   KU-3  内核无自更新实现：settings-view 无 guardSelfUpdate*
//   KU-4  supervisor 无自更新预期版本/待生效状态
//   KU-5  CLI 无 self-update 命令、不请求 /self-update/*
//   KU-6  面板不调内核自更新端点：更新经消息桥请容器 OTA 执行
//   KU-7  旧 npm/manifest 通道死代码已删除（dist/self-update.js、config 残留键、extractTarGz）
//   KU-8  反向：判据能识别旧的自更新实现（门禁非空转）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : '')); };

const read = (rel) => {
  const s = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return s.includes('\r') ? s.replace(/\r\n/g, '\n') : s;
};
/** 剥离注释行（防止注释里提到被删符号而误判「仍有自更新面」）。 */
const codeOnly = (src) => src.split('\n')
  .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
  .join('\n');

const guard = read('src/api/guard.js');
const surface = read('src/api/surface.js');
const settings = read('src/guard/supervisor/settings-view.js');
const sup = codeOnly(read('src/supervisor.js'));
const cli = read('bin/dsh-supervisor');
const about = read('ui/src/features/supervisor/settings/AboutCard.tsx');
const client = read('ui/src/services/supervisor/client.ts');
const bridge = read('ui/src/services/supervisor/kernelUpdateBridge.ts');

// ── KU-1：内核无自更新端点 ──
check('KU-1 guard.js 无 /self-update 路由代码', !/self-update/.test(codeOnly(guard)), 'ok');
check('KU-1 guard 域不认领 /self-update/ 前缀', !/startsWith\('\/self-update\/'\)/.test(guard), 'ok');
check('KU-1 全 src/api 无 /self-update',
  fs.readdirSync(path.join(ROOT, 'src', 'api')).filter((f) => f.endsWith('.js'))
    .every((f) => !/self-update/.test(codeOnly(read('src/api/' + f)))), 'ok');

// ── KU-2：surface 清单无自更新条目 ──
check('KU-2 surface 无 /self-update 路由项', !/path: '\/self-update/.test(surface), 'ok');
check('KU-2 surface 无 /self-update/ 前缀项', !/prefix: '\/self-update\//.test(surface), 'ok');

// ── KU-3：内核无自更新实现 ──
const sc = codeOnly(settings);
check('KU-3 无 guardSelfUpdateApply', !/guardSelfUpdateApply\s*\(/.test(sc), 'ok');
check('KU-3 无 guardSelfUpdateRestart', !/guardSelfUpdateRestart\s*\(/.test(sc), 'ok');
check('KU-3 无 guardSelfUpdateStatus', !/guardSelfUpdateStatus\s*\(/.test(sc), 'ok');

// ── KU-4：supervisor 无自更新状态字段 ──
check('KU-4 无自更新预期版本状态', !/_selfUpdateExpectedVersion|_selfUpdatePending/.test(sup), 'ok');

// ── KU-5：CLI 无 self-update 命令 ──
check('KU-5 CLI 无 self-update 命令分支', !/case 'self-update'/.test(cli), 'ok');
check('KU-5 CLI 无 cmdSelfUpdate 实现', !/cmdSelfUpdate/.test(cli), 'ok');
check('KU-5 CLI 用法无 self-update 行', !/self-update \[check\]/.test(cli), 'ok');
check('KU-5 CLI 不请求 /self-update/*', !/self-update\//.test(cli), 'ok');

// ── KU-6：面板请容器 OTA 执行（而非调内核写端点）──
check('KU-6 桥协议版本 = 1', /BRIDGE_PROTOCOL_VERSION = 1/.test(bridge), 'ok');
check('KU-6 请求类型为 dsh:kernel-update-request', /dsh:kernel-update-request/.test(bridge), 'ok');
check('KU-6 AboutCard 用 requestKernelUpdate', /requestKernelUpdate/.test(about), 'ok');
check('KU-6 AboutCard 无内核自更新调用', !/selfUpdateApply|selfUpdateRestart|selfUpdateStatus/.test(about), 'ok');
check('KU-6 client 无自更新方法', !/selfUpdateApply|selfUpdateRestart|selfUpdateStatus/.test(client), 'ok');

// ── KU-7：旧 npm/manifest 通道死代码已删 ──
check('KU-7 dist/self-update.js 已删除', !fs.existsSync(path.join(ROOT, 'src', 'domains', 'dist', 'self-update.js')), 'ok');
const cfg = codeOnly(read('src/platform/config.js'));
check('KU-7 config 无 selfUpdateManifestUrl/Dir 残留键', !/selfUpdateManifestUrl|selfUpdateDir:/.test(cfg), 'ok');
const fsu = read('src/platform/fs-utils.js');
check('KU-7 extractTarGz 死代码已删', !/extractTarGz/.test(fsu), 'ok');

// ── KU-8：反向自检（判据能识别旧自更新实现/端点）──
const hasSelfUpdateSurface = (src) => /self-update/.test(codeOnly(src)) || /guardSelfUpdate(Apply|Restart|Status)\s*\(/.test(codeOnly(src));
const legacyImpl = '  async guardSelfUpdateApply() {\n    return this.dist.runNpmInstall({});\n  }';
const legacyRoute = "    if (req.method === 'POST' && pathname === '/self-update/apply') {\n      return send(200, {});\n    }";
check('KU-8 旧实现必须被识别（非空转）', hasSelfUpdateSurface(legacyImpl), 'ok');
check('KU-8 旧端点必须被识别（非空转）', hasSelfUpdateSurface(legacyRoute), 'ok');
check('KU-8 当前实现不被误判',
  !hasSelfUpdateSurface(guard) && !hasSelfUpdateSurface(settings) && !hasSelfUpdateSurface(cli), 'ok');

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
