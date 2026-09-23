'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 统一生命周期抽象（ManagedLifecycle）—— 归一化架构核心（2026-09 用户定稿）。
//
// 定位：所有模块（DSH / 实例 / 智能路由 / 反代实例 / 远程控制 / 插件）的生命周期
// 统一收敛到同一个抽象。DSHSUP（守卫）是「监测者」：通过 LifecycleManager 看每个
// 模块的状态，按策略监测/拉起；模块各自独立生命周期——守卫重启 ≠ 模块重启。
//
// 关键语义：
// - phase 状态机统一：stopped → starting → running → draining → stopped
// - 启停只经 LifecycleManager 统一入口（start/stop/restart），模块不对外自出接口；
// - 阶段由 start/stop 迁移驱动；周期拉起在守卫侧（supervisor daemon 监督 tick /
// 实例 watchdog+guardian）——本对象不内置探活（2026-09 债务清理：未接线的 probe 已删）；
// - 进程独立性：本抽象描述「管理视图」，模块的实际进程可独立于守卫存在——
// 守卫重启只重置自己的观测，不重置模块运行态。
// ═══════════════════════════════════════════════════════════════════════════

// phase 词表的**唯一源**是 guard/lifecycle/objects.js（控制平面 v3 canonical）。
//
// K3 修复（2026-09-11）：此处曾自建一份副本 ['stopped','starting','running','draining','degraded']，
// 与 canonical **两个方向都不一致**：
// · 多了 `degraded` —— 全仓 0 处使用（死词）；
// · 少了 `installing` / `backoff` / `failed` / `restarting` ——
// 而 `_setPhase` 对不在表内的值**静默丢弃**，故本对象永远表达不了这些真实状态。
// 副本还会随 canonical 演进而静默漂移。现改为直接引用，消除第二个状态源。
const { PHASES } = require('./objects');

/** 统一生命周期状态对象（每个模块实例一个，注册到 LifecycleManager）。 */
class ManagedLifecycle {
  /**
   * @param {object} opts
   * - id: 模块唯一标识（如 'dsh' / 'router' / 'router.proxy.<keyId>' / 'inst.<id>' / 'lan'）
   * - kind: 模块类别（'dsh' | 'router' | 'proxy-instance' | 'instance' | 'lan' | 'plugin'）
   * - name: 显示名
   * - logger / events：可选（日志与事件总线）
   * - start(ctx)：async —— 启动该模块（由生命周期管理器调用）
   * - stop(ctx)：async —— 停止该模块（守卫 shutdown 或用户启停时调用）
   * - status()：返回模块自身细节状态（供面板展示，可选）
   */
  constructor(opts) {
    this.id = opts.id || ('lc-' + Math.random().toString(36).slice(2, 8));
    this.kind = opts.kind || 'module';
    this.name = opts.name || this.id;
    // 能力声明（B1 断点修复：原 MANAGED_KINDS.startable/guardable 声明后无人消费）。
    // startable=false → LifecycleManager.start/stop/restart 显式拒绝（不再「返回 ok 但什么都不做」）；
    // guardable=false → 构造期锁定 guardian=false（不可被误开为守护）。
    this.startable = opts.startable !== false;
    this.guardable = opts.guardable !== false;
    this.logger = opts.logger || null;
    this.events = opts.events || null;
    this._start = opts.start || null;
    this._stop = opts.stop || null;
    this._restart = opts.restart || null;
    this._status = opts.status || null;
    // 状态机
    this.phase = 'stopped';       // 观测到的阶段（守卫视角）
    this.desired = 'stopped';     // 期望状态（running = 应保持运行；stopped = 应停止）
    this.healthy = false;         // 最近一次观测（启停/守卫镜像）结果
    this.lastProbeAt = null;      // 保留字段（契约兼容；无内置探活时不更新）
    this.lastTransitionAt = null;
    this.error = null;            // 最近一次错误
    this.startedAt = null;
    this.restartCount = 0;        // 守卫代其拉起的累计次数（守护动作侧 +1）
    // 守护开关：true=健康异常时守卫自动拉起（router/lan/dsh 由 adapters 置 true）；false=仅观测不自动拉起。
    // guardable=false 的模块**恒为 false**（能力锁，不依赖调用方自律）。
    this.guardian = this.guardable && opts.guardian === true;
    this._monitoring = false;     // 是否纳入统一启停管理
  }

  /* ── 状态查询（统一，供 LifecycleManager / API / 面板）── */
  snapshot() {
    return {
      id: this.id,
      kind: this.kind,
      name: this.name,
      phase: this.phase,
      desired: this.desired,
      healthy: this.healthy,
      startedAt: this.startedAt,
      lastProbeAt: this.lastProbeAt,
      lastTransitionAt: this.lastTransitionAt,
      error: this.error,
      restartCount: this.restartCount,
      guardian: this.guardian === true,
      startable: this.startable, // 能力声明可视化（UI 据此灰化启停入口）
      guardable: this.guardable,
      monitoring: this._monitoring,
      detail: this._status ? (this._status() || null) : null,
    };
  }

  /* ── 内部状态迁移（由 LifecycleManager 驱动，模块不直接改 phase）── */
  /** 状态迁移。**非白名单值静默丢弃**（不是 bug，是执法）：
   * phase 只能取 canonical 词表内的值，防止调用方写入手写字符串造成新的分叉。
   * 代价：写错值时**没有报错**。故词表必须引用唯一源（见文件头 K3 说明），
   * 否则合法值会被无声拒绝。 */
  _setPhase(p) {
    if (!PHASES.includes(p)) return;
    if (this.phase !== p) {
      this.phase = p;
      this.lastTransitionAt = new Date().toISOString();
    }
  }

  /* ── 供 LifecycleManager 调用的统一操作 ── */

  /** 期望保持运行。 */
  wantRunning() {
    this.desired = 'running';
    this.error = null;
  }

  /** 期望停止。 */
  wantStopped() {
    this.desired = 'stopped';
  }

  /** 启动模块（幂等：已在运行则 no-op）。
   *
   * 必须尊重回调的**显式失败**（K4 修复，2026-09-11）：
   * 适配器的 start 可能返回 `{ok:false, error}`（如 `setRouterRunning` 在 daemon 拉不起来时）。
   * 旧实现**不看 `r.ok`**，无条件把 phase 置 running / healthy=true ——
   * 于是 `/lifecycle/status` 谎报成功，而模块实际没起来（用户看到「运行中」但服务是死的）。
   *
   * 兼容性：`r.ok !== false` 视为成功 —— 保留「回调只返回 undefined / 无 ok 字段」的既有语义，
   * 避免把历史上合法的返回值误判为失败。
   */
  async start() {
    if (this.phase === 'running' || this.phase === 'starting') return { ok: true, already: true };
    this.error = null;
    this._setPhase('starting');
    try {
      const r = this._start ? await this._start() : { ok: true };
      if (r && r.ok === false) {
        // 回调**明确**报告失败：不得置 running/healthy。
        this.error = r.error || 'start 返回 ok:false（未提供 error）';
        this._setPhase('stopped');
        this.healthy = false;
        this.desired = 'stopped';
        if (this.logger && this.logger.warn) this.logger.warn('[lifecycle] ' + this.id + ' start 被拒: ' + this.error);
        return { ok: false, error: this.error, ...this.snapshot() };
      }
      this.startedAt = this.startedAt || new Date().toISOString();
      this.desired = 'running';
      this._setPhase('running');
      this.healthy = true;
      return r || { ok: true };
    } catch (e) {
      this.error = (e && e.message) || String(e);
      this._setPhase('stopped');
      if (this.logger && this.logger.warn) this.logger.warn('[lifecycle] ' + this.id + ' start 失败: ' + this.error);
      return { ok: false, error: this.error };
    }
  }

  /** 停止模块（守卫 shutdown 或用户显式停）。
   *
   * 同样必须尊重回调的**显式失败**（K4 修复的对称面）：
   * 旧实现在 stop 回调返回 `{ok:false}` 时仍置 phase=stopped / desired=stopped ——
   * 于是面板显示「已停止」而进程可能还在跑。
   * 现：显式失败 → 保持运行态（与异常分支同一语义），并把错误如实上报。
   */
  async stop(reason) {
    if (this.phase === 'stopped') return { ok: true, already: true };
    // P3 修复（2026-09-13，失效模式 g）：失败时恢复**进入 stop 之前的那个 phase**，
    // 而不是硬编码 'running'。
    // 缺陷：原实现在 stop 被拒/抛错时一律 `_setPhase('running')`（注释写「回到运行态」）——
    // 这只对「停之前确实是 running」成立。若停之前是 failed / backoff / installing
    // （例如对一个失败模块点「停止」而底层 stop 又失败），phase 会被改写成
    // 'running' → 面板把一个**已知失败**的模块显示成**运行中**，与观测相反。
    // 修法：记下 prevPhase，失败时如实恢复它（对 running/starting 等情形行为不变）。
    const prevPhase = this.phase;
    this._setPhase('draining');
    try {
      const r = this._stop ? await this._stop(reason) : { ok: true };
      if (r && r.ok === false) {
        this.error = r.error || 'stop 返回 ok:false（未提供 error）';
        this._setPhase(prevPhase); // 未能确认停止 → 恢复原相位（不谎报 running）
        if (this.logger && this.logger.warn) this.logger.warn('[lifecycle] ' + this.id + ' stop 被拒: ' + this.error);
        return { ok: false, error: this.error, ...this.snapshot() };
      }
      this.desired = 'stopped';
      this._setPhase('stopped');
      this.healthy = false;
      return r || { ok: true };
    } catch (e) {
      this.error = (e && e.message) || String(e);
      this._setPhase(prevPhase); // 同上：恢复原相位
      if (this.logger && this.logger.warn) this.logger.warn('[lifecycle] ' + this.id + ' stop 失败: ' + this.error);
      return { ok: false, error: this.error };
    }
  }

  /** 重启（stop → start 语义由调用方决定；这里提供便捷）。
   *
   * 2026-09-12（P1 修复）：**回退路径必须尊重 stop/start 的显式失败**。
   *
   * 缺陷：原实现在无 `_restart` 回调时 `await this.stop(); await this.start(); return {ok:true}`
   * —— **两个返回值都被丢弃**，`{ok:true}` 无条件返回。
   * 于是 `POST /lifecycle/{id}/restart`（api/lifecycle.js:73）在「停不掉」或「起不来」时
   * 仍报成功 → 面板显示「已重启」而模块实际是死的/还活着。
   *
   * 这是 K4 修复（start/stop 尊重 `{ok:false}`）的**对称面被遗漏** ——
   * 同一纪律只覆盖了两条路径中的两条，第三条（restart 回退）漏了。
   *
   * 现：任一步骤显式失败即如实上报（并把该步的 error 带出）。
   * 语义：`stop` 失败 → 模块仍在跑，重启未发生；`start` 失败 → 已停但未起。
   */
  async restart() {
    if (this._restart) {
      const r = await this._restart();
      // 同上：snapshot 含 `error`，必须放前，否则回调的 error 被覆盖（实测 error=null）。
      if (r && r.ok === false) return { ...this.snapshot(), ok: false, error: r.error };
      return { ...this.snapshot(), ok: r && r.ok !== false };
    }
    const wasDesired = this.desired;
    const rs = await this.stop('restart');
    if (rs && rs.ok === false) {
      // `...this.snapshot()` 必须**在前** —— 它也含 `error` 字段，放后面会覆盖这里的显式错误。
      return { ...this.snapshot(), ok: false, error: 'restart: 停止失败 — ' + (rs.error || '未知') };
    }
    if (wasDesired === 'running') {
      const rt = await this.start();
      if (rt && rt.ok === false) {
        return { ...this.snapshot(), ok: false, error: 'restart: 启动失败 — ' + (rt.error || '未知') };
      }
    }
    return { ...this.snapshot(), ok: true };
  }
}

module.exports = { ManagedLifecycle, PHASES };
