#!/usr/bin/env node
'use strict';

// 系统日志框架回归（docs/LOGGING-SINGLETON-AUDIT.md / SYSTEM-LOGGING-ARCHITECTURE.md）：
//  - 装配键契约：supervisor 用短键 ctlPorts/daemonLogs {router,lan}，EventHub 内部长键 which('router-daemon')
//    必须映射正确（曾致 daemon 事件永不入聚合的空跑）
//  - daemon 事件经 ctl eventsTail 增量入聚合（首拉建基线不回溯）
//  - 内部簿记事件打 internal 标（默认时间线过滤、审计保留）
//  - LogCore 单例语义（init 幂等 / 异进程拒绝 / 未 init get 惰性默认）

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'loghub-test-'));
const { EventHub, isInternalEvent } = require(path.join(ROOT, 'src', 'platform', 'loghub'));
const LogCore = require(path.join(ROOT, 'src', 'platform', 'logcore'));
const Events = require(path.join(ROOT, 'src', 'platform', 'events'));
const { createRouterCtlServer } = require(path.join(ROOT, 'src', 'domains', 'router', 'ctl'));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : '')); }
}
const freePort = () => new Promise((res) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  // 1) 装配键契约 + daemon ctl 增量入聚合（模拟 supervisor 短键装配）
  {
    const de = new Events(path.join(TMP, 'router.events.log'), 1 << 20, { process: 'router-daemon' });
    de.append('router_old', {}); // 存量（首拉不回溯）
    const ctlPort = await freePort();
    const ctl = createRouterCtlServer({ events: de, logger: null });
    await new Promise((r) => ctl.listen(ctlPort, '127.0.0.1', r));
    const ge = new Events(path.join(TMP, 'guard.events.log'), 1 << 20, { process: 'guard' });
    const hub = new EventHub({ stateDir: path.join(TMP, 's1'), aggBase: 'state', guardEvents: ge, guardLogFile: '', dshLogFile: '', upgradeLogFile: '', daemonLogs: {}, ctlPorts: { router: ctlPort, lan: 0 }, eventsMaxBytes: 1 << 20, logger: { debug() {}, warn() {} } });
    ge.attachHub(hub);
    ge.append('spawned', { pid: 9 });
    for (let i = 0; i < 8; i++) await hub.sync(); // 首拉建基线（应不含 router_old）
    de.append('router_new', { k: 2 });
    for (let i = 0; i < 8; i++) await hub.sync();
    const all = hub.read(0, 50);
    const rEvs = all.filter((e) => e.source === 'router-daemon');
    check('短键装配: daemon 事件经 ctl 入聚合(不含存量)', rEvs.length === 1 && rEvs[0].type === 'router_new', all.map((e) => e.type + '@' + e.source));
    check('聚合行带 producer=router-daemon 与 internal 标', rEvs[0].producer && rEvs[0].producer.process === 'router-daemon' && rEvs[0].internal === false, rEvs[0]);
    ctl.close();
  }
  // 2) internal 判定与默认过滤（时间线只显示业务事件）
  {
    const ge = new Events(path.join(TMP, 'guard2.events.log'), 1 << 20, { process: 'guard' });
    const hub = new EventHub({ stateDir: path.join(TMP, 's2'), aggBase: 'state', guardEvents: ge, guardLogFile: '', dshLogFile: '', upgradeLogFile: '', daemonLogs: {}, ctlPorts: {}, eventsMaxBytes: 1 << 20, logger: { debug() {} } });
    ge.attachHub(hub);
    ge.append('shadow_dsh_action', { diff: false });
    ge.append('managed_object_updated', { kind: 'dsh' });
    ge.append('running', { pid: 1 });
    const all = hub.read(0, 20);
    check('internal 判定+打标', isInternalEvent('shadow_dsh_action') && isInternalEvent('managed_object_updated') && !isInternalEvent('running')
      && all.find((e) => e.type === 'shadow_dsh_action').internal === true && all.find((e) => e.type === 'running').internal === false);
    check('默认过滤后只剩业务事件', all.filter((e) => !e.internal).map((e) => e.type).join(',') === 'running');
  }
  // 2a) 守卫监督簿记名单 internal + readVisible 对历史行(internal 缺失)类型兜底
  {
    const ge = new Events(path.join(TMP, 'guard2a.events.log'), 1 << 20, { process: 'guard' });
    const hub = new EventHub({ stateDir: path.join(TMP, 's2a'), aggBase: 'state', guardEvents: ge, guardLogFile: '', dshLogFile: '', upgradeLogFile: '', daemonLogs: {}, ctlPorts: {}, eventsMaxBytes: 1 << 20, logger: { debug() {} } });
    ge.attachHub(hub);
    check('内部簿记名单: guardian_action/router_daemon_supervised/orphan_audit', isInternalEvent('guardian_action') && isInternalEvent('router_daemon_supervised') && isInternalEvent('orphan_audit') && !isInternalEvent('lan_dsh_token_updated'));
    ge.append('guardian_action', { resource: 'lan' });
    ge.append('lan_cookie_exchanged', { id: 'main' });
    const all = hub.read(0, 20);
    check('名单 internal 在聚合行打标', all.find((e) => e.type === 'guardian_action').internal === true, all.find((e) => e.type === 'guardian_action'));
    // 直接经 writer 造"历史遗留行"（internal 字段缺失）→ readVisible 须按类型兜底过滤
    hub.writer.appendRaw({ ts: new Date().toISOString(), type: 'managed_object_updated', data: {}, source: 'guard', srcSeq: 1 });
    hub.writer.appendRaw({ ts: new Date().toISOString(), type: 'running', data: {}, source: 'guard', srcSeq: 2 });
    const vis = hub.readVisible(0, 20);
    check('readVisible 兜底: internal 缺失历史行被过滤', vis.every((e) => e.type !== 'managed_object_updated') && vis.some((e) => e.type === 'running'), vis.map((e) => e.type));
  }
  // 2b) 事件人性化：裸类型业务事件注入可读中文 message（不改源事件/源文件）
  {
    const ge = new Events(path.join(TMP, 'guard-hum.events.log'), 1 << 20, { process: 'guard' });
    const hub = new EventHub({ stateDir: path.join(TMP, 'shum'), aggBase: 'state', guardEvents: ge, guardLogFile: '', dshLogFile: '', upgradeLogFile: '', daemonLogs: {}, ctlPorts: {}, eventsMaxBytes: 1 << 20, logger: { debug() {} } });
    ge.attachHub(hub);
    ge.append('lan_cookie_exchanged', { id: 'main', via: 'refresh' });
    ge.append('spawned', { pid: 9 });
    const all = hub.read(0, 20);
    const cookie = all.find((e) => e.type === 'lan_cookie_exchanged');
    const spawned = all.find((e) => e.type === 'spawned');
    check('人性化: lan_cookie_exchanged 带中文 message', !!cookie && !!cookie.data && typeof cookie.data.message === 'string' && cookie.data.message.includes('主实例') && cookie.data.message.includes('cookie 已刷新'), cookie && cookie.data);
    check('人性化: 无模板类型不带 message', !!spawned && !('message' in spawned.data));
    const src = JSON.parse(fs.readFileSync(path.join(TMP, 'guard-hum.events.log'), 'utf8').trim().split('\n')[0]);
    check('人性化: 守卫源文件行不被污染(无 message)', !('message' in (src.data || {})), src.data);
  }
  // 3) LogCore 单例语义
  {
    LogCore._resetForTest();
    const c = LogCore.init({ process: 'guard' });
    check('init guard ok(events/logger)', c.process === 'guard' && !!c.events && !!c.logger && c.hub === null);
    check('同 process 幂等', LogCore.init({ process: 'guard' }) === c);
    let threw = false;
    try { LogCore.init({ process: 'lan-daemon' }); } catch { threw = true; }
    check('异进程拒绝', threw);
    LogCore._resetForTest();
    const u = LogCore.get();
    check('未 init get 惰性默认不落盘', u.process === 'unknown' && !!u.logger && !!u.events);
    LogCore._resetForTest();
  }
  // 4) metrics / filter / export / tailLog 冒烟
  {
    const ge = new Events(path.join(TMP, 'guard3.events.log'), 1 << 20, { process: 'guard' });
    fs.writeFileSync(path.join(TMP, 'g.log'), 'a\nb\n');
    const hub = new EventHub({ stateDir: path.join(TMP, 's3'), aggBase: 'state', guardEvents: ge, guardLogFile: path.join(TMP, 'g.log'), dshLogFile: '', upgradeLogFile: '', daemonLogs: { router: path.join(TMP, 'r.log'), lan: path.join(TMP, 'l.log') }, ctlPorts: {}, eventsMaxBytes: 1 << 20, logger: { debug() {} } });
    ge.attachHub(hub);
    ge.append('spawned', { pid: 1 });
    ge.append('running', { pid: 1 });
    const m = hub.metrics();
    check('metrics 事件派生', m.events === 2 && m.bySource.guard === 2);
    check('readFiltered type=spawned', hub.readFiltered({ type: 'spawned' }, 0, 10).length === 1);
    check('exportLines JSONL', hub.exportLines(0, 10).length === 2);
    check('tailLog guard', hub.tailLog('guard', 1).join('') === 'b');
    check('tailLog router(lan daemonLogs 短键)', hub.tailLog('router', 1).length === 0); // 文件不存在返回空不抛
  }
  console.log('\n结果: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
