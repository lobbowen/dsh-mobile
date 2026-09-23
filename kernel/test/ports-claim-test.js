#!/usr/bin/env node
'use strict';

// 确定性槽位仲裁 claimSlot 回归（2026-09，docs/port-architecture.md）：
//  byOwner 绑定复用 / binding-lost 迁移(显式) / preferred advisory 回退 / 顺序补位 / 单 owner 单端口
// 隔离 range（28130+50）→ 确定性，不依赖宿主真实 relay 段占用。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-claim-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };
const RANGE = { base: 28130, count: 50 };

(async () => {
  const { PortRegistry } = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'ports'));
  const ports = new PortRegistry({ file: path.join(TMP, 'ports.json') });
  const claim = (owner, pref, extra) => ports.claimSlot('relay', owner, Object.assign({ range: RANGE }, pref ? { preferred: pref } : {}, extra || {}));

  console.log('== 确定性分配（preferred + 顺序补位）==');
  const m = await claim('relay:main', RANGE.base);
  check('main → base（preferred）', m && m.port === RANGE.base && !m.conflict, JSON.stringify(m));
  const a = await claim('relay:instA');
  check('instA → base+1', a && a.port === RANGE.base + 1, JSON.stringify(a));
  const b = await claim('relay:instB');
  check('instB → base+2（顺序补位）', b && b.port === RANGE.base + 2, JSON.stringify(b));

  console.log('== byOwner 复用（绑定持久，重启不漂移）==');
  const m2 = await claim('relay:main', RANGE.base);
  check('main 再 claim → 复用 base（binding）', m2 && m2.port === RANGE.base && m2.binding === true && !m2.bindingLost, JSON.stringify(m2));
  const b2 = await claim('relay:instB');
  check('instB 再 claim → 复用 base+2', b2 && b2.port === RANGE.base + 2, JSON.stringify(b2));

  console.log('== 删除后补位 + 单 owner 单端口 ==');
  ports.unregister('relay:instA');
  const c1 = await claim('relay:instC');
  check('A 释放后 instC → 补 base+1', c1 && c1.port === RANGE.base + 1, JSON.stringify(c1));
  const recs = ports.list().map((r) => r.port + ':' + r.owner);
  check('无重复端口、每 owner 一条', recs.length === new Set(recs.map((s) => s.split(':')[0])).size && recs.length === new Set(recs).size, JSON.stringify(recs));

  console.log('== inst.wanPort 持久绑定优先 ==');
  const d = await claim('relay:instD', RANGE.base + 7);
  check('instD 按 preferred 绑定 base+7', d && d.port === RANGE.base + 7, JSON.stringify(d));
  const d2 = await claim('relay:instD');
  check('instD 再 claim → 复用 base+7（绑定持久）', d2 && d2.port === RANGE.base + 7 && d2.binding === true, JSON.stringify(d2));

  console.log('== preferred advisory：被其它 owner 占 → 回退最小空闲，不中断 ==');
  ports._records.set(RANGE.base + 20, { port: RANGE.base + 20, role: 'relay', owner: 'relay:OTHER', createdAt: Date.now() });
  const fallback = await claim('relay:instE', RANGE.base + 20);
  check('preferred 被异 owner 占 → 回退最小空闲（服务不中断）', fallback && !fallback.conflict && fallback.port !== RANGE.base + 20 && fallback.port >= RANGE.base, JSON.stringify(fallback));
  const recE = ports.list().find((r) => r.owner === 'relay:instE');
  check('instE 回退后已登记（绑定持久化）', !!recE && recE.port === fallback.port, JSON.stringify(recE));

  console.log('== binding 被盗（持久绑定记忆被异 owner 抢注）→ 迁移 + bindingLost 显式 ==');
  // main 持久绑定 base（bindingPreferred）；THIEF 抢注 base 记录
  ports._records.set(RANGE.base, { port: RANGE.base, role: 'relay', owner: 'relay:THIEF', createdAt: Date.now() });
  let lost = null;
  const mig = await ports.claimSlot('relay', 'relay:main', {
    range: RANGE, preferred: RANGE.base, bindingPreferred: true,
    onBindingLost: (x) => { lost = x; },
  });
  check('绑定被盗 → 迁移 + bindingLost 事件（不静默）', mig && !mig.conflict && mig.bindingLost === true && mig.from === RANGE.base && !!lost && lost.to === mig.port, JSON.stringify(mig) + ' lost=' + JSON.stringify(lost));
  const recMain = ports.list().find((r) => r.owner === 'relay:main');
  check('main 已迁移并登记新端口', !!recMain && recMain.port === mig.port && recMain.port !== RANGE.base, JSON.stringify(recMain));

  // reload 契约（阶段三）：读路径以权威文件为准——外部进程新增记录后 reload 可见；
  // 内存未落盘记录 reload 后丢弃（以文件为 truth 的语义）。
  {
    const p2 = new PortRegistry({ file: path.join(TMP, 'ports-reload.json') });
    await p2.claimSlot('relay', 'owner-A', { range: RANGE });
    const pA = p2.byOwner('owner-A');
    // 模拟另一进程（独立实例）向同一文件写入新记录
    const pOther = new PortRegistry({ file: path.join(TMP, 'ports-reload.json') });
    const slotB = await pOther.claimSlot('relay', 'owner-B', { range: RANGE });
    check('R-reload-1 外部新增记录文件已含 owner-B', !!slotB && slotB.port > 0, String(slotB && slotB.port));
    check('R-reload-2 reload 前内存不见 owner-B（陈旧快照）', p2.byOwner('owner-B') === null, String(p2.byOwner('owner-B')));
    p2.reload();
    check('R-reload-3 reload 后 owner-B 可见（以文件为准）', p2.byOwner('owner-B') === slotB.port, String(p2.byOwner('owner-B')));
    check('R-reload-4 reload 后 owner-A 绑定保留', p2.byOwner('owner-A') === pA, String(p2.byOwner('owner-A')));
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
