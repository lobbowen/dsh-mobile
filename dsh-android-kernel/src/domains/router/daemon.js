'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// router-daemon —— 智能路由独立进程（L3 进程解耦，2026-09）。
//
// 定位：RouterService 从守卫进程解耦为独立生命周期。守卫只做监测与异常拉起，
// 本进程独立承载：43011/43012 等供应商端点 + 反代实例（4100x）+ 账号/额度管理。
//
// 运行方式：由守卫 spawn detached（安卓内核无系统服务管理器，不存在独立单元）：
//   node src/domains/router/daemon.js [-c <configPath>]
//
// 共享文件：config.json（读）、providers.json / router-usage-totals.json / ports.json（独占写）。
// 守卫与 daemon 通过「探测 + 文件」松耦合：守卫探测 43011 判定 daemon 存活，异常时拉起。
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const HOME = os.homedir();
const CONFIG_PATH = process.env.DSH_SUPERVISOR_CONFIG || path.join(require('../../platform/state-root').supervisorDir(), 'config.json');

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  // normalize 展开 ~ 路径等（与守卫同源处理，保证 providerFile/ports.json 等路径一致）
  const { normalize } = require('../../platform/config');
  return normalize(raw);
}

function main() {
  const { RouterService } = require('./index');
  const { DistributionManager } = require('../dist/index');
  const { TaskRegistry } = require('../../platform/tasks');

  const config = loadConfig();
  const swDir = config.stateFile ? path.dirname(path.resolve(config.stateFile)) : require('../../platform/state-root').supervisorDir();
  // 系统日志框架（历史设计文档）：daemon 经每进程唯一 LogCore 取日志/事件
  // （自有独立文件，不共享守卫文件；单例 init 幂等，异进程复用拒绝）。
  const core = require('../../platform/logcore').init({
    process: 'router-daemon',
    logFile: config.routerLogFile || path.join(swDir, 'log', 'router-daemon.log'),
    eventFile: config.routerEventsFile || path.join(swDir, 'events', 'router.events.log'),
    logLevel: config.logLevel || 'info',
    logMaxBytes: config.logMaxBytes,
    eventsMaxBytes: config.eventsMaxBytes,
  });
  const events = core.events;
  const logger = core.logger;
  const dist = new DistributionManager({
    registries: (config.registries && config.registries.length) ? config.registries : ['https://registry.npmjs.org'],
    registryFile: path.join(swDir, 'registry.json'),
    events,
    logger,
  });
  const tasks = new TaskRegistry({ stateDir: swDir, logger, events });

  // 迁移S2+重建（2026-09）：router 自治端口段（proxy/providerApi）先迁出共享
  // ports.json 到 ports-router.json，再按 providers.json 重建绑定（幂等合并）。必须在 RouterService 构造前执行，
  // 使构造时 configureFile 加载完整文件（此前在构造后执行 -> RouterService 内存空表覆盖历史绑定，真实数据丢失教训）。
  try {
    const { shared: portsShared } = require('../../guard/lifecycle/ports');
    const oldP = path.join(swDir, 'ports.json');
    const newP = path.join(swDir, 'ports-router.json');
    portsShared.migrateRouterSegment(oldP, newP);
    // 从 providers.json 重建 proxy/providerApi 段绑定（覆盖迁移期因覆盖而丢失的记录；幂等合并）
    const provFile = path.join(swDir, 'providers.json');
    if (fs.existsSync(provFile)) {
      const provs = JSON.parse(fs.readFileSync(provFile, 'utf8'));
      let target = { records: [] };
      try { if (fs.existsSync(newP)) target = JSON.parse(fs.readFileSync(newP, 'utf8')); } catch {}
      const byOwner = {};
      for (const rec of target.records || []) byOwner[rec.owner] = rec.port;
      let changed = false;
      const push = (owner, port, role) => { if (port && byOwner[owner] === undefined) { target.records.push({ port, role, owner, createdAt: Date.now() }); byOwner[owner] = port; changed = true; } };
      for (const p of (provs.providers || [])) {
        if (p.kind !== 'proxy') continue;
        for (const inst of (p.instances || [])) push('proxy:' + (inst.keyId || inst.key), inst.port, 'proxyInstance');
        push('providerApi:' + p.id, p.apiPort, 'providerApi');
      }
      if (changed) {
        fs.mkdirSync(path.dirname(newP), { recursive: true });
        const tmp = newP + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(target, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, newP);
      }
    }
    const cnt = JSON.parse(fs.readFileSync(newP, 'utf8')).records || [];
    logger.info('[router-daemon] 迁移S2+重建：ports-router.json 就绪 records=' + cnt.length);
  } catch (err) {
    logger.error('[router-daemon] 迁移S2 异常(保留旧文件): ' + ((err && err.message) || err));
  }

  const router = new RouterService({
    config,
    providerFile: path.join(swDir, 'providers.json'),
    usageTotalsFile: path.join(swDir, 'router-usage-totals.json'),
    portsFile: path.join(swDir, 'ports-router.json'),
    logger,
    events,
    dist,
    tasks,
  });

  // 守卫控制通道（L3 监督模式状态一致性，2026-09）：守卫经 POST /ctl {method,args}
  // 把 /router/* 读写转发到本 daemon（唯一事实源）——见 src/domains/router/ctl.js。
  const { createRouterCtlServer, DEFAULT_CTL_PORT } = require('./ctl');
  const ctlPort = Number(config.routerCtlPort) || DEFAULT_CTL_PORT;
  const ctl = createRouterCtlServer({ router, logger, events });
  ctl.listen(ctlPort, '127.0.0.1', () => {
    logger.info('[router-daemon] ctl listening on 127.0.0.1:' + ctlPort);
  });
  ctl.on('error', (e) => {
    logger.error('[router-daemon] ctl listen failed (' + ctlPort + '): ' + e.message + '（守卫监督模式将无法转发 router 控制）');
  });

  events.append('router_daemon_started', { pid: process.pid, version: config.guardVersion || 'unknown' });
  logger.info('[router-daemon] started pid=' + process.pid);

  router.start().then((r) => {
    if (r && r.ok === false) {
      logger.error('[router-daemon] 启动失败: ' + (r.error || '未知'));
      process.exit(1);
    }
    logger.info('[router-daemon] 就绪（供应商端点按 activated 监听）');
  }).catch((e) => {
    logger.error('[router-daemon] 启动异常: ' + ((e && e.stack) || e));
    process.exit(1);
  });

  // 优雅退出：SIGTERM → 停 router 并【确认实例子进程已死】再退出（2026-09 根治停服孤儿化：
  // 旧实现 stop() 只发 SIGTERM + unref SIGKILL 定时器，process.exit 令定时器随进程消亡 → 子进程孤儿化、
  // stdio 死 → 重启 adopt 复用即 EPIPE 楔死；426880/677630 两次实锤）
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('[router-daemon] shutting down');
    try { await router.stopAndWait(5000); } catch (e) { logger.error('[router-daemon] 停实例异常: ' + ((e && e.message) || e)); }
    try { events.append('router_daemon_stopped', {}); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', (e) => {
    logger.error('[router-daemon] uncaughtException: ' + ((e && e.stack) || e));
  });
  process.on('unhandledRejection', (e) => {
    logger.error('[router-daemon] unhandledRejection: ' + (e && (e.stack || e.message) || e));
  });
}

main();
