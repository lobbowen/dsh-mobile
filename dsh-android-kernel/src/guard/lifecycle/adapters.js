'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 模块适配器（adapters）—— 把现有模块对象包成 ManagedLifecycle 注册到 LifecycleManager。
//
// 每个适配器只做「翻译」：把模块现有的 start/stop/状态能力映射到统一生命周期抽象，
// 不改模块内部逻辑。守卫 supervisor 启动时调用 registerAll() 完成注册。
// ═══════════════════════════════════════════════════════════════════════════

const { ManagedLifecycle } = require('./managed');
const { kindMeta } = require('./objects');

/** 从受管类型表（MANAGED_KINDS，能力声明的**单一源**）取该模块的能力位。
 *  B1 断点修复：原声明无人消费 → 现由 adapters 注入、LifecycleManager 执法、snapshot 供 UI 灰化。
 *  未登记类型按「可启停/可守护」保守处理（不误禁）。 */
function capsOf(objectKind) {
  const m = kindMeta(objectKind);
  if (!m) return { startable: true, guardable: true };
  return { startable: m.startable !== false, guardable: m.guardable !== false };
}

/**
 * 注册全部模块到 LifecycleManager（supervisor.start 时调用）。统一启停/状态视图用；
 * 周期拉起不在此（守卫 daemon 监督 tick / 实例 watchdog+guardian）。
 * @param {LifecycleManager} mgr
 * @param {object} deps 现有模块对象 { router, dsh(supervisor自身), pluginManager }
 */
function registerAll(mgr, deps) {
  const { router, supervisor, pluginManager } = deps;
  const logger = (deps.logger) || null;

  // ── 1. 智能路由（RouterService）──
  // 智能路由作为一个生命周期单元注册；其下「反代实例」是子层（由 router 自己管理），
  // 不在本注册表展开（保持 router 内部自治；本管理器只对 router 整体负责）。
  // L3 进程解耦（2026-09）：router 优先独立 daemon 承载——统一生命周期启停必须走守卫的
  // setRouterRunning（daemon 感知：拉/停独立进程 + 持久化 routerAutostart），
  // 而不是直接 start() 守卫内嵌实例（监督模式下会双占 43011 / 状态与 daemon 脱节）。
  if (router) {
    const sup = deps && deps.supervisor;
    const rlc = new ManagedLifecycle({
      id: 'router',
      ...capsOf('router-daemon'),
      guardian: true, // 核心服务：健康异常自动拉起（守护上收，阶段二）
      kind: 'router',
      name: '智能路由',
      logger,
      start: async () => (sup && typeof sup.setRouterRunning === 'function') ? sup.setRouterRunning(true) : router.start(),
      // 守卫自身 shutdown（_stopping=true）时 stopAll 不得停独立 router-daemon——
      // L3a 语义：守卫退出不影响被管模块（daemon 独立生命周期继续服务）；仅显式用户停止才停 daemon
      stop: async () => {
        if (sup && sup._stopping) return { ok: true, already: true, reason: 'guard-shutdown 不停 daemon' };
        return (sup && typeof sup.setRouterRunning === 'function') ? sup.setRouterRunning(false) : router.stop();
      },
      // C3-5b：detail 走守卫真实 router 状态视图（daemon 模式经 ctl 取 daemon 实时态）；
      // 曾引用不存在的 router.routerStatus（死回调，恒 null）。
      status: () => (sup && typeof sup.routerStatus === 'function') ? sup.routerStatus() : (router.status ? router.status() : null),
    });
    mgr.register(rlc);
  }

  // ── 2. DeepSeek Harness（主 DSH）——守卫监管的核心对象 ──
  if (supervisor) {
    // guardian 不在此写死：原生 DSH 守护开关(默认关, 持久化 dsh-main.json)由用户在面板控制，
    // 注册时从 supervisor 读当前值，此后经 _syncDshLifecycleView 从 A 平面(dsh-main.json)持续同步——
    // 2026-09 收敛定稿：守护=跟开关走，与沙箱同语义，B 平面不持有独立守护策略。
    const dshGuardian = (supervisor && typeof supervisor.mainGuardian === 'function')
      ? supervisor.mainGuardian() : false;
    const dsh = new ManagedLifecycle({
      id: 'dsh',
      ...capsOf('dsh'),
      guardian: dshGuardian,
      kind: 'dsh',
      name: 'DeepSeek Harness',
      logger,
      start: async () => supervisor.setDesired ? supervisor.setDesired('running') : { ok: false, error: 'unsupported' },
      restart: async () => supervisor.requestRestart ? supervisor.requestRestart() : { ok: false, error: 'unsupported' },
      stop: async () => supervisor.setDesired ? supervisor.setDesired('stopped') : { ok: false, error: 'unsupported' },
      status: () => supervisor.statusSummary ? supervisor.statusSummary() : null,
    });
    mgr.register(dsh);
    // DSH 的生命周期由守卫自身 tick 监管（唯一监管权）；lifecycleManager 的 dsh 项是视图镜像——
    // 同步守卫当前 desired/phase（守卫启动时若 desired=running 则 dsh 项反映运行中）。
    if (supervisor.desired === 'running') dsh.wantRunning();
    const ph = String(supervisor.phase || '');
    if (ph === 'RUNNING') { dsh._setPhase('running'); dsh.healthy = true; dsh.startedAt = dsh.startedAt || new Date().toISOString(); }
    else if (ph === 'STARTING' || ph === 'RESTARTING' || ph === 'BACKOFF') { dsh._setPhase('starting'); }
    dsh._monitoring = true; // DSH 纳管（守卫 tick 对 desired=running 的 DSH 负责拉起——本就是守卫职责）
  }

  // ── 3. 插件管理（插件生命周期聚合）──
  if (pluginManager) {
    const plc = new ManagedLifecycle({
      id: 'plugins',
      kind: 'plugins',
      name: '插件管理',
      ...capsOf('plugin'), // MANAGED_KINDS.plugin：startable=false / guardable=false（聚合视图）
      logger,
      start: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      status: () => null,
    });
    mgr.register(plc);
  }

  return mgr;
}

module.exports = { registerAll };
