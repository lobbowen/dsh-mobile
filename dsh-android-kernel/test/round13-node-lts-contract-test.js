#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 第十三轮续：前端类型声明必须与后端**实际产出**一致（2026-09-13）
//
// ## 缺陷（失效模式 a + b + c，跨层）
//
// `ui/src/services/supervisor/types.ts` 的 NodeLtsStatus 声明了
// `latestLts` / `ltsName` / `updateAvailable` 三个字段，
// 而内核 `guard/supervisor/settings-view.js::nodeLtsStatus()` **从不产出**它们
// （该实现明确「不做远端查询」，避免守卫启动依赖网络）。
// 于是 `OverviewPage.tsx` 的「可更新到 vX LTS」整块是**不可达死分支**，
// 而 tsc/eslint/build 都**不会**报错（读的是已声明的可选字段）。
//
// 注：本项由只读审计提出，但其「环境检测永久停在占位文本」的结论**不成立**——
//   后端确实返回 `current`，故主行本来就会渲染。真实缺陷只是上述死字段/死分支，
//   已按真实缺陷范围修正（不夸大为 P1）。
//
// ## 门禁
//   A **行为级对账**：真实调用后端 nodeLtsStatus()，取其实际键集合；
//     断言 types.ts 声明里**没有**「后端不产出且前端也不用」的幽灵字段
//   B UI 源码不得再引用 latestLts / ltsName（node-lts 语境）
//   C 后端真实产出的键必须都在类型声明里（防反向漂移：前端拿不到新字段）
//   D 反向：判据能识别幽灵字段（门禁非空转）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

/** 解析 types.ts 里某个 interface 的字段名。 */
function ifaceFields(src, name) {
  const i = src.indexOf('export interface ' + name + ' {');
  if (i < 0) return [];
  const body = src.slice(i, src.indexOf('\n}', i));
  return [...body.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\??\s*:/gm)].map((m) => m[1]);
}

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r13ui-'));
  const typesSrc = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'services', 'supervisor', 'types.ts'), 'utf8');
  const fields = ifaceFields(typesSrc, 'NodeLtsStatus');
  check('A 解析到 NodeLtsStatus 字段', fields.length > 0, fields.join(','));

  // 真实调用后端
  const desc = require(path.join(ROOT, 'src', 'guard', 'supervisor', 'settings-view.js'));
  const svc = Object.create({}, desc);
  svc.config = { stateFile: path.join(TMP, 'state.json') };
  const ret = await svc.nodeLtsStatus();
  const realKeys = Object.keys(ret || {});
  check('A 后端确实返回 ok/current（主行能渲染）',
    realKeys.includes('ok') && realKeys.includes('current'), realKeys.join(','));

  // A：幽灵字段 = 声明了但后端不产出。
  //   `error` 属**失败路径**产出（nodeLtsStatus 的 catch 返回 {ok:false,error}），
  //   成功路径不返回它 —— 故显式豁免（不是幽灵字段）。
  const ERROR_PATH_ONLY = ['error'];
  const phantom = fields.filter((f) => realKeys.indexOf(f) < 0 && ERROR_PATH_ONLY.indexOf(f) < 0);
  // 先证明豁免项本身是合理的（失败路径确实产出 error），避免豁免变成藏污纳垢
  {
    // 直接构造失败路径：用一个会抛的 config（访问 stateFile 时抛）
    const failing = Object.create({}, desc);
    Object.defineProperty(failing, 'config', { get() { throw new Error('boom-config'); } });
    const er = await failing.nodeLtsStatus();
    check('A 豁免项 error 确为失败路径产出', Object.prototype.hasOwnProperty.call(er, 'error'), JSON.stringify(er).slice(0, 60));
  }
  check('A 无幽灵字段（声明了但后端从不产出）—— 旧实现有 latestLts/ltsName/updateAvailable',
    phantom.length === 0, phantom.length ? phantom.join(',') : '0 个');

  // C：反向漂移 —— 后端产出的键都应在声明里
  const undeclared = realKeys.filter((k) => fields.indexOf(k) < 0);
  check('C 后端产出的键都已在类型声明中（防反向漂移）',
    undeclared.length === 0, undeclared.length ? undeclared.join(',') : '0 个');

  // B：UI 源码不得再引用 node-lts 语境的死字段
  {
    const uiFiles = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p); }
        else if (/\.(ts|tsx)$/.test(e.name)) uiFiles.push(p);
      }
    };
    walk(path.join(ROOT, 'ui', 'src'));
    const offenders = [];
    for (const f of uiFiles) {
      if (f.indexOf('types.ts') >= 0) continue;
      const src = fs.readFileSync(f, 'utf8');
      // ⚠ 剥离整行注释后再查：本次修正的**说明注释里必然引用旧字段名**
      //   （「原实现读 latestLts / ltsName」），不剥离就会自匹配。
      const codeOnly = src.split('\n').filter((l) => {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      }).join('\n');
      for (const bad of ['latestLts', 'ltsName']) {
        if (codeOnly.indexOf(bad) >= 0) offenders.push(path.relative(ROOT, f) + ':' + bad);
      }
    }
    check('B UI 源码不再引用 latestLts/ltsName（node-lts 死字段）',
      offenders.length === 0, offenders.length ? offenders.join(' | ') : '0 处');
  }

  // D 反向：判据能识别幽灵字段
  {
    const fakeFields = ['ok', 'current', 'latestLts'];
    const ph = fakeFields.filter((f) => realKeys.indexOf(f) < 0);
    check('D 反向：判据能识别幽灵字段（门禁非空转）', ph.length === 1 && ph[0] === 'latestLts', ph.join(','));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
