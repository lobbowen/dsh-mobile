#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 第四轮续：订阅/取证/端口归属 三处缺陷的回归
//
// ## 缺陷
//
// P1-1「frozen 且探测失败」使探测闸门**恒真** → 每 5 分钟起停实例：
// `applyDetection` 的失败分支只写 lastProbeError，**不设 nextResetAt**；
// 而路由的闸门是 `missingReset = frozen && !nextResetAt` → 永真。
//
// P1-3 取证链路**零出口**却在转发主路径同步写盘：
// evidenceTail/evidenceStats 全仓无调用方、surface.js 未登记、前端零引用，
// 而 append（statSync + appendFileSync）发生在每个上游 >=400 的路径上。
//
// P2-2 `PortRegistry.release(port, ownerId)` 的第二参被**静默忽略**：
// 调用方（objects.js）以 owner 意图调用，实际按端口号无条件删除 → 可误删他人登记。
//
// P2-4 `setProviderKeys(removeMasked)` 删反代账号时**不做收尾**：
// 缺 stopInstance / ports.unregister / instances 同步（removeProxyKey 三者齐备）
// → orphan 实例与端口记录再无人释放。
//
// ## 锁定不变量
// E-a applyDetection 失败分支必须给出 nextResetAt 兜底（仅 frozen 且无恢复点时）
// E-b 取证默认关闭（opt-in），且仍保留显式启用能力
// E-c release 接受 ownerId 且不匹配时不释放
// E-d setProviderKeys 删除路径必须复用与 removeProxyKey 同等的收尾
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const base = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base.js'), 'utf8');
const idx = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'index.js'), 'utf8');
const ops = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'router-ops.js'), 'utf8');

// ── E-a：失败分支必须补 nextResetAt ──
{
  const m = base.match(/applyDetection\(acc, det\) \{[\s\S]*?\n  \}/);
  check('E-a 定位到 applyDetection', !!m, m ? 'ok' : '未找到');
  const body = m ? m[0] : '';
  const failBranch = body.slice(0, body.indexOf('acc.lastProbeError = null;') + 1);
  check('E-a 失败分支设置了 nextResetAt（防探测闸门恒真）',
    /acc\.nextResetAt\s*=/.test(failBranch), failBranch.length + ' 字符内');
  check('E-a 仅在无既有恢复点时补（不覆盖已精确的值）',
    /!acc\.nextResetAt/.test(failBranch), '有守卫');
}

// ── E-b：取证默认关（opt-in）──
check('E-b evidence 构造受 evidenceEnabled 控制',
  /this\.evidenceEnabled = opts\.evidenceEnabled === true/.test(idx), '已改');
check('E-b 默认不构造（findable：evidenceFile && evidenceEnabled）',
  /this\.evidenceFile && this\.evidenceEnabled/.test(idx), '已改');
check('E-b 仍保留显式启用能力（evidenceEnabled 可传 true）',
  /evidenceEnabled: true/.test(idx), '文档化');

// ── E-c：release 的 owner 校验 ──
check('E-c release 签名接受第二参', /release\(port, ownerId\)/.test(
  fs.readFileSync(path.join(ROOT, 'src', 'guard', 'lifecycle', 'ports.js'), 'utf8')), '已改');
{
  const portsMod = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'ports.js'));
  const { PortRegistry } = portsMod;
  const os = require('node:os');
  const tmp = path.join(os.tmpdir(), 'p4-port-owner-' + process.pid + '.json');
  const reg = new PortRegistry({ file: tmp });
  // allocateMark(port, role, owner) 才能登记自定义 owner（register 的 owner 固定为 system:<role>）
  reg.allocateMark(25000, 'proxyInstance', 'proxy:AAA');
  // 异 owner 释放 → 必须 no-op
  const r1 = reg.release(25000, 'proxy:BBB');
  // 注：`get(role)` 按 role 查，按端口查须用 `isRegistered(port)`
  check('E-c 异 owner 释放被拒（不误删他人登记）', r1 === false && reg.isRegistered(25000),
    'released=' + r1 + ' stillRegistered=' + reg.isRegistered(25000));
  // 同 owner 释放 → 成功
  const r2 = reg.release(25000, 'proxy:AAA');
  check('E-c 同 owner 释放成功', r2 === true && !reg.isRegistered(25000), 'released=' + r2);
  // 不传 owner → 向后兼容（无条件释放）
  reg.allocateMark(25001, 'proxyInstance', 'proxy:CCC');
  const r3 = reg.release(25001);
  check('E-c 不传 ownerId 保持向后兼容', r3 === true, 'released=' + r3);
  try { fs.rmSync(tmp, { force: true }); } catch {}
}

// ── E-d：setProviderKeys 删除路径的收尾 ──
{
  const m = ops.match(/setProviderKeys\(id, opts\) \{[\s\S]*?\n  \}/);
  check('E-d 定位到 setProviderKeys', !!m, m ? 'ok' : '未找到');
  const body = m ? m[0] : '';
  check('E-d 删反代账号时停止实例', /p\.stopInstance\(/.test(body), '有');
  check('E-d 删反代账号时释放端口登记', /ports\.unregister\('proxy:'/.test(body), '有');
  check('E-d 同步 p.instances（防 orphan 实例记录）', /p\.instances\s*=\s*\(p\.instances/.test(body), '有');
  check('E-d 收尾限定于 proxy 类（direct 无实例/端口）', /p\.kind === 'proxy'/.test(body), '有');
}

// ── E-e：applyProxyUpdate 的进度必须写进 task（P2-1）──
// 行为级：task 的 steps 能被子实例登记并推进 —— 这是前端读到的那个事实源。
{
  const { TaskRegistry } = require(path.join(ROOT, 'src', 'platform', 'tasks.js'));
  const os = require('node:os');
  const tmpT = path.join(os.tmpdir(), 'p21-task-' + process.pid + '.json');
  const reg = new TaskRegistry({ file: tmpT });
  const task = reg.begin('proxy-app', 'update', { id: 'cc', name: 'CC' }, { to: 'x', createdBy: 'user' });
  reg.start(task.id);
  reg.step(task.id, 'key-a'); reg.step(task.id, 'key-b');
  reg.stepState(task.id, 0, 'done'); reg.stepState(task.id, 1, 'failed');
  const v = reg.list('proxy-app').find((x) => x.target.id === 'cc');
  check('E-e task 能登记逐实例步骤', v.steps.length === 2, v.steps.length + ' 个');
  check('E-e 步骤状态可推进（前端读到的即此）',
    v.steps[0].state === 'done' && v.steps[1].state === 'failed',
    JSON.stringify(v.steps.map((s) => s.state)));
  check('E-e restarted 语义（done 计数）可算出非 0',
    v.steps.filter((s) => s.state === 'done').length === 1, '1');
  try { fs.rmSync(tmpT, { force: true }); } catch {}
}
// 源码级：确认 update 流程真的调了 tasks.step / tasks.stepState（而非只维护 job.steps）
check('E-e 源码调用 tasks.step 登记步骤', /this\.tasks\.step\(task\.id/.test(ops), '有');
check('E-e 源码调用 tasks.stepState 推进状态', /this\.tasks\.stepState\(task\.id/.test(ops), '有');

// ── E-h：daemon 模式下守卫**不得**写 providers.json（三条路径全覆盖）──
// 缺陷：`setPersistEnabled(false)` 此前只在 supervisor.js 的一处 daemon 分支执行，
// 而 `_ensureRouterRuntime` 还有另两条返回 daemon 的路径 → 双写覆盖。
{
  const sv = fs.readFileSync(path.join(ROOT, 'src', 'guard', 'supervisor', 'supervise-view.js'), 'utf8');
  const sup = fs.readFileSync(path.join(ROOT, 'src', 'supervisor.js'), 'utf8');
  check('E-h 抽出 _disableRouterPersist 集中处置', /_disableRouterPersist\(\) \{/.test(sv), '有');
  // 三条 daemon 路径：① 已在跑 ② 拉起/接管成功 ③ supervisor.js 的兜底
  const n = (sv.match(/_disableRouterPersist\(\);/g) || []).length;
  check('E-h supervise-view 内至少两处调用（覆盖两条 daemon 路径）', n >= 2, n + ' 处');
  check('E-h 拉起/接管路径按返回值判定',
    /res\.mode === 'daemon'\).*_disableRouterPersist|_disableRouterPersist.*res\.mode/.test(sv)
      || /if \(res && res\.mode === 'daemon'\) this\._disableRouterPersist\(\);/.test(sv), '有');
  check('E-h supervisor.js 兜底改用同一方法（不再内联）',
    /this\._disableRouterPersist\(\);/.test(sup), '有');
  // 反向：确认不再有内联的 setPersistEnabled(false) **代码**（方法本体保留一处）。
  // 必须剥离注释行 —— 说明文字里会引用该写法（我第一版就踩了这个假阳性）。
  const stripComments = (s) => s.split(String.fromCharCode(10))
    .filter((l) => { const t = l.trim(); return !t.startsWith('//'); })
    .join(String.fromCharCode(10));
  const inlineAll = (stripComments(sv) + stripComments(sup)).match(/setPersistEnabled\(false\)/g) || [];
  check('E-h 不再有散落的内联 setPersistEnabled(false)（仅方法本体保留）',
    inlineAll.length === 1, inlineAll.length + ' 处');
}

// ── E-i：objects.js 的端口释放必须**带 owner**（P2-2 配套）──
// 缺陷：`release(port, ownerId)` 此前忽略第二参，故 objects.js 有个
// `catch { release(port) }` 回退 —— 那会绕过 owner 判定（误删他人登记）。
// 现已真正支持 owner 校验，回退必须删除。
{
  const objSrc = fs.readFileSync(path.join(ROOT, 'src', 'guard', 'lifecycle', 'objects.js'), 'utf8');
  const body = objSrc.match(/_releasePort\(port, ownerId\) \{[\s\S]*?\n  \}/);
  check('E-i 定位到 _releasePort', !!body, body ? 'ok' : '未找到');
  const code = body ? body[0] : '';
  check('E-i 按 owner 释放', /release\(port, ownerId\)/.test(code), '有');
  // 反向：不得再有无 owner 的回退（那正是绕过 owner 判定的路径）
  check('E-i 无 owner 的回退已删除', !/release\(port\)/.test(code), '已删');
}

// ── E-g：`setProviderKeys(add)` 的 added 必须反映真实结果（P2-5）──
// 行为级用不到（需真供应商），故做源码级不变量 + 契约字段检查。
{
  const m = ops.match(/async setProviderKeys\(id, opts\) \{[\s\S]*?\n  \}/);
  check('E-g setProviderKeys 为 async（需 await 检测结果）', !!m, m ? 'ok' : '未找到');
  const body = m ? m[0] : '';
  check('E-g 等待 addAccount 结果（不再 fire-and-forget）',
    /await Promise\.all\(/.test(body), '有');
  check('E-g 返回 discarded / discardedKeys（供 UI 如实提示）',
    /discardedList\.length/.test(body) && /discardedKeys:/.test(body), '有');
  // 反向：确认「不 await + added++」的旧写法已消失（那正是缺陷本体）
  check('E-g 旧的 fire-and-forget 写法已消失',
    !/addAccount\(t\)\.catch\(\(\) => \{\}\);\s*\n\s*added\+\+/.test(body), '已改');
}

// ── E-f：OAuth 登录的**两条退出路径**必须对称清理（P2-6）──
// 成功与超时/异常分支都必须清 `_ccLoginResolve`/`_ccLoginReject`；
// 否则残留的 reject 会被上一轮浏览器的退出回调取到，误杀**下一次**登录。
{
  const n = (ops.match(/_ccLoginResolve = this\._ccLoginReject = null/g) || []).length;
  check('E-f 成功与失败分支都清理 resolve/reject（两处）', n === 2, n + ' 处');
  // 反向：确认 "只清 promise" 的不对称写法已不存在（该写法恰是缺陷本体）
  const bad = /this\._ccLoginPromise = null;\s*\n\s*return \{ ok: false/.test(ops);
  check('E-f 失败分支不再只清 promise 就返回', !bad, '已对称');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);