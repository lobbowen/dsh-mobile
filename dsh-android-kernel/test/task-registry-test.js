'use strict';

// 统一安装/更新任务注册表测试：
//  - 状态机：pending → running → succeeded/failed/skipped/canceled
//  - step 级进度与日志
//  - 持久化：tasks.json 落盘，守卫重启后恢复历史
//  - 中断恢复：running 任务跨重启标记为 failed
//  - 当前任务索引：isBusy/current

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskRegistry } = require(path.join(__dirname, '..', 'src', 'platform', 'tasks'));

let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'task-reg-test-'));

async function main() {
  // ── 场景 1：创建与状态流转 ──
  const reg = new TaskRegistry({ stateDir: TMP });
  const t = reg.begin('native', 'upgrade', { id: 'main', name: '原生 DSH' }, { from: '0.1.1', to: '0.1.2' });
  check('创建任务为 pending', t.state === 'pending', t.state);
  check('isBusy 识别 pending', reg.isBusy('native', 'main') === true);
  check('current 返回任务', reg.current('native', 'main') && reg.current('native', 'main').id === t.id);
  reg.start(t.id);
  check('start → running', reg.get(t.id).state === 'running');
  const s1 = reg.step(t.id, '停止 DSH');
  reg.stepState(t.id, reg.get(t.id).steps.indexOf(s1), 'running');
  reg.stepState(t.id, reg.get(t.id).steps.indexOf(s1), 'done');
  reg.log(t.id, '安装中…');
  reg.log(t.id, '安装完成');
  reg.succeed(t.id);
  check('succeed → succeeded', reg.get(t.id).state === 'succeeded');
  check('完成后 isBusy 释放', reg.isBusy('native', 'main') === false);
  check('current 返回 null', reg.current('native', 'main') === null);
  check('log 记录', reg.get(t.id).log.length === 2 && reg.get(t.id).log[0].includes('安装中'));
  check('steps 状态', reg.get(t.id).steps[0].state === 'done');

  // ── 场景 2：失败与 skip ──
  const t2 = reg.begin('plugin', 'install', { id: 'native', name: '原生' }, { to: 'x' });
  reg.start(t2.id);
  reg.fail(t2.id, 'npm 退出码 1');
  check('fail → failed + error', reg.get(t2.id).state === 'failed' && reg.get(t2.id).error === 'npm 退出码 1');
  const t3 = reg.begin('native', 'upgrade', { id: 'main', name: '原生 DSH' }, {});
  reg.start(t3.id);
  reg.skip(t3.id, '已是最新');
  check('skip → skipped', reg.get(t3.id).state === 'skipped');

  // ── 场景 3：持久化 + 重启恢复 ──
  const t4 = reg.begin('instance', 'upgrade', { id: 'inst-1', name: '实例1' }, {});
  reg.start(t4.id);
  reg.step(t4.id, '安装');
  // 模拟守卫崩溃：不调用任何 finish
  const reg2 = new TaskRegistry({ stateDir: TMP }); // 重新加载（等价守卫重启）
  const recovered = reg2.get(t4.id);
  check('重启后任务历史保留', recovered !== null);
  check('运行中任务重启后标记 failed', recovered && recovered.state === 'failed' && recovered.error.includes('守卫重启'));
  const t1 = reg2.get(t.id);
  check('已完成任务状态保留 succeeded', t1 && t1.state === 'succeeded');
  check('重启后 isBusy 释放', reg2.isBusy('instance', 'inst-1') === false);
  check('重启后历史含全部任务', reg2.list().length >= 4);

  // ── 场景 4：MAX_TASKS 清理 ──
  const reg3 = new TaskRegistry({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'task-reg-test2-')) });
  for (let i = 0; i < 220; i++) {
    const x = reg3.begin('native', 'install', { id: 'main', name: '原生 DSH' }, {});
    reg3.start(x.id);
    reg3.succeed(x.id);
  }
  check('历史保留上限 200', reg3.list().length === 200, String(reg3.list().length));

  // ── 场景：**跨进程**双写者不得丢失更新（2026-09-13 P2 修复）──
  //   缺陷：守卫（supervisor.js:203）与 router-daemon（daemon.js:55）各持一个
  //     TaskRegistry 实例、写同一个 tasks.json，而 _save 是「整份覆盖」→
  //     第一个进程刚写的任务会被第二个进程的覆盖抹掉。
  //   修法：_save 落盘前重读磁盘并按 id 合并（本方优先，其余磁盘条目保留）。
  {
    const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'task-xproc-'));
    const guard = new TaskRegistry({ stateDir: TMP2 });   // 模拟守卫进程
    const daemon = new TaskRegistry({ stateDir: TMP2 });  // 模拟 router-daemon 进程
    const g1 = guard.begin('native', 'install', { id: 'main', name: '原生 DSH' }, {});
    guard.start(g1.id);
    const d1 = daemon.begin('proxy-app', 'update', { id: 'app1', name: 'Proxy' }, {});
    daemon.start(d1.id);
    const disk = JSON.parse(fs.readFileSync(path.join(TMP2, 'tasks.json'), 'utf8'));
    const kinds = disk.tasks.map((x) => x.kind + '/' + x.action);
    check('跨进程：守卫与 daemon 的任务都留在磁盘（旧实现只剩后者）',
      kinds.indexOf('native/install') >= 0 && kinds.indexOf('proxy-app/update') >= 0, kinds.join(','));
    // 反向：同 id 必须以本方为准（不能出现重复条目）
    const g2 = guard.begin('native', 'upgrade', { id: 'main', name: '原生 DSH' }, {});
    guard.start(g2.id);
    const disk2 = JSON.parse(fs.readFileSync(path.join(TMP2, 'tasks.json'), 'utf8'));
    const ids = disk2.tasks.map((x) => x.id);
    check('跨进程：任务 id 无重复', new Set(ids).size === ids.length, String(ids.length));
    check('跨进程：daemon 的条目在守卫后续写入后仍在',
      disk2.tasks.some((x) => x.kind === 'proxy-app'), 'ok');
    // 反向：本进程自己的条目数不被合并放大
    check('跨进程：守卫自己看到 2 条', guard.list().length === 2, String(guard.list().length));
    fs.rmSync(TMP2, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\ntask-registry: ALL PASS' : '\ntask-registry: ' + failures + ' FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
