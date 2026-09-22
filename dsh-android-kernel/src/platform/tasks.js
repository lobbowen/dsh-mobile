'use strict';

// 统一安装/更新任务注册表（Task Registry）。
// 收敛系统内全部「安装 / 升级 / 卸载 / 更新」操作到同一个任务模型：
//  - 统一状态机：pending → running → succeeded|failed|skipped|canceled
//  - 明确状态：任何时刻任务都有可观测状态 + step 级进度 + 有界日志
//  - 持久化历史：~/.dsh/supervisor/tasks.json，守卫重启后仍可查看
//  - 各业务模块（native/instance/plugin/router）只保留执行逻辑，
//    任务生命周期统一交给本注册表。

const fs = require('node:fs');
const path = require('node:path');

const MAX_TASKS = 200;      // 历史保留上限（超出清理最旧）
const MAX_LOG_LINES = 200;  // 单任务日志有界行数
const MAX_STEP_LOG = 30;    // 单 step 日志行数

/** 任务 id 生成（跨守卫重启唯一：时间戳 + 随机）。 */
function taskId() {
  return 'task-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
}

class TaskRegistry {
  /**
   * @param {object} opts
   *   - stateDir: 状态目录（~/.dsh/supervisor），tasks.json 落于此
   *   - logger: 可选日志器
   *   - events: 可选事件总线（append('task_created'|'task_state'|...)）
   */
  constructor(opts) {
    this.stateDir = opts && opts.stateDir;
    this.logger = (opts && opts.logger) || null;
    this.events = (opts && opts.events) || null;
    this.file = this.stateDir ? path.join(this.stateDir, 'tasks.json') : null;
    this.tasks = [];      // 按创建时间倒序（最新在前）
    this._current = {};   // kind:target -> taskId（当前 running/pending 任务）
    this._load();
  }

  _log(lv, msg) {
    if (this.logger && this.logger[lv]) { try { this.logger[lv]('[tasks] ' + msg); } catch {} }
  }

  _emit(type, data) {
    if (this.events && this.events.append) { try { this.events.append(type, data); } catch {} }
  }

  /* ═══════ 持久化 ═══════ */
  _load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && Array.isArray(raw.tasks)) {
        this.tasks = raw.tasks;
        // running/pending 任务跨守卫重启视为 failed（进程已死）
        // 注：不重建 _current——重启后任务已全部落为终态（failed），isBusy/current 语义无需索引
        for (const t of this.tasks) {
          if (t.state === 'running' || t.state === 'pending') {
            t.state = 'failed';
            t.error = t.error || '守卫重启，任务中断';
            t.finishedAt = Date.now();
            this._log('warn', 'recovered interrupted task ' + t.id + ' as failed');
          }
        }
      }
    } catch {}
  }

  _save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // ⚠ P2 修复（2026-09-13，失效模式 i+b）：**跨进程写者必须合并，不能整份覆盖**。
      //
      //   缺陷：本文件有**两个进程**各持一个 TaskRegistry 实例写同一个 tasks.json ——
      //     守卫（supervisor.js:203）与 router-daemon（daemon.js:55），同一 stateDir。
      //     而 _load() 只在构造器跑一次，_save() 是「整份覆盖」→ **丢失更新**：
      //     实测：守卫 begin native/install → daemon begin proxy-app/update →
      //       磁盘上只剩 proxy-app/update，守卫那条任务**从磁盘消失**
      //       （反向亦然；两个进程同时跑时 /tasks 每 2s 轮询结果随机翻转）。
      //   修法：落盘前**重读磁盘并按 id 合并**（同 id 以本方为准，其余磁盘条目保留），
      //     再按创建时间倒序 + MAX_TASKS 截断。这样两个进程的条目都能留存。
      //     注：这是「多写者下不丢数据」的最小改动；长期应把 TaskRegistry 收敛为单进程持有。
      let merged = this.tasks;
      try {
        if (fs.existsSync(this.file)) {
          const disk = JSON.parse(fs.readFileSync(this.file, 'utf8'));
          if (disk && Array.isArray(disk.tasks)) {
            const mine = new Map(this.tasks.map((t) => [t.id, t]));
            // 磁盘条目里，本方没有的（= 另一进程写的）保留
            for (const t of disk.tasks) {
              if (t && t.id && !mine.has(t.id)) mine.set(t.id, t);
            }
            merged = Array.from(mine.values());
            // 按创建时间倒序（最新在前），与 _load/unshift 语义一致
            merged.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            if (merged.length > MAX_TASKS) merged = merged.slice(0, MAX_TASKS);
          }
        }
      } catch { /* 磁盘不可读/损坏：退化为只写本方（不因合并失败而丢本次写入）*/ }
      // ⚠ **只把合并结果写盘，不写回 this.tasks** ——
      //   否则本方内存会混入另一进程的任务，而 _current 索引并未同步建立，
      //   会出现「list() 里有、isBusy() 却 false」的不一致视图。
      //   本实例的语义（list/isBusy/current）严格只覆盖**自己创建**的任务；
      //   跨进程的完整视图由读盘方（面板/API 每次读盘）获得。
      // ⚠ tmp 名必须**唯一**：固定 '.tmp' 会让两个进程并发写同一临时文件 →
      //   rename 出混合内容（与 store.js 同类隐患）。
      const tmp = this.file + '.tmp.' + process.pid + '.' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify({ tasks: merged }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this._log('error', 'tasks persist failed: ' + e.message);
    }
  }

  _cleanup() {
    if (this.tasks.length > MAX_TASKS) {
      this.tasks = this.tasks.slice(0, MAX_TASKS);
      this._save();
    }
  }

  /* ═══════ 任务创建与查询 ═══════ */
  /**
   * 创建任务。
   * @param {string} kind    'native' | 'instance' | 'plugin' | 'proxy-app'
   * @param {string} action  'install' | 'upgrade' | 'uninstall' | 'update'
   * @param {object} target  { id, name }
   * @param {object} opts    { from, to, createdBy, meta }
   * @returns 任务对象
   */
  begin(kind, action, target, opts) {
    const o = opts || {};
    const now = Date.now();
    const task = {
      id: taskId(),
      kind,
      action,
      target: { id: String(target.id), name: target.name || String(target.id) },
      from: o.from || null,
      to: o.to || null,
      state: 'pending',
      steps: [],
      error: null,
      log: [],
      startedAt: now,
      finishedAt: null,
      createdBy: o.createdBy || 'user',
      meta: o.meta || {},
    };
    this.tasks.unshift(task);
    this._current[kind + ':' + task.target.id] = task.id;
    this._save();
    this._cleanup();
    this._emit('task_created', { id: task.id, kind, action, target: task.target });
    this._log('info', 'task ' + task.id + ' created (' + kind + '/' + action + ' ' + task.target.id + ')');
    return task;
  }

  /**
   * 统一作业执行器（RC4）：后台作业的唯一运行方式。
   * 内建契约——begin→start→fn 执行→（成功 succeed / 异常自动 fail）；
   * finally 清 _current 索引。作业 fn 内的任何异常都不再逃逸为
   * unhandledRejection / 任务永久 running（审计 P2-2：实例升级 IIFE 锁死）。
   * @param {string} kind 任务类别（instance|native|plugin|router|dist）
   * @param {string} targetId 目标 id
   * @param {string} action 动作名（install|upgrade|uninstall|...）
   * @param {object} opts 透传 begin()（from/to/meta/createdBy 等）
   * @param {(task: object) => Promise<any>} fn 作业体（async）
   * @returns {Promise<{ ok: boolean, task?: object, error?: string }>}
   */
  async run(kind, targetId, action, opts, fn) {
    if (this.isBusy(kind, targetId)) {
      const cur = this.current(kind, targetId);
      return { ok: false, error: '已有进行中任务', task: cur };
    }
    const task = this.begin(kind, action, { id: targetId }, opts);
    this.start(task.id);
    try {
      const result = await fn(task);
      const failed = result && typeof result === 'object' && result.ok === false;
      if (failed) this.fail(task.id, (result && result.error) || '任务失败');
      else this.succeed(task.id);
      return Object.assign({ ok: !failed, task: this.get(task.id) }, (result && typeof result === 'object') ? result : {});
    } catch (e) {
      // 崩溃兜底契约：任务落 failed、索引清空——绝不永久占用（native startInstall 同语义上收）
      this.fail(task.id, '作业异常: ' + ((e && e.message) || e));
      this._log('error', 'task ' + task.id + ' crashed: ' + ((e && e.stack) || e));
      return { ok: false, error: (e && e.message) || String(e), task: this.get(task.id) };
    } finally {
      // 双保险：无论 succeed/fail/crash，_current 指向的任务已终态即清索引
      const cur = this._current[kind + ':' + targetId];
      if (cur === task.id) {
        const t = this.get(task.id);
        if (!t || (t.state !== 'running' && t.state !== 'pending')) delete this._current[kind + ':' + targetId];
      }
    }
  }

  /** 目标当前是否已有运行中/排队任务。 */
  isBusy(kind, targetId) {
    const id = this._current[kind + ':' + targetId];
    if (!id) return false;
    const t = this.tasks.find((x) => x.id === id);
    return !!(t && (t.state === 'running' || t.state === 'pending'));
  }

  /** 目标当前运行中任务（无则 null）。 */
  current(kind, targetId) {
    const id = this._current[kind + ':' + targetId];
    if (!id) return null;
    const t = this.tasks.find((x) => x.id === id);
    return t && (t.state === 'running' || t.state === 'pending') ? t : null;
  }

  /** 按 id 查任务。 */
  get(taskId) {
    return this.tasks.find((t) => t.id === taskId) || null;
  }

  /** 全部任务（按时间倒序）；可按 kind 过滤。 */
  list(kind) {
    if (kind) return this.tasks.filter((t) => t.kind === kind);
    return this.tasks;
  }

  /** 所有当前运行中任务（跨 kind）。 */
  running() {
    return this.tasks.filter((t) => t.state === 'running' || t.state === 'pending');
  }

  /* ═══════ 任务推进 ═══════ */
  /** 标记任务运行中（从 pending 进入 running；首个 step 前调用）。 */
  start(taskId) {
    const t = this.get(taskId);
    if (!t || t.state !== 'pending') return null;
    t.state = 'running';
    this._save();
    this._emit('task_state', { id: taskId, state: 'running' });
    return t;
  }

  /** 添加一个 step（追加到 steps 尾部）。 */
  step(taskId, name) {
    const t = this.get(taskId);
    if (!t) return null;
    const s = { name, state: 'pending', ts: null, log: [] };
    t.steps.push(s);
    this._save();
    return s;
  }

  /** 推进某 step 状态。 */
  stepState(taskId, index, state, extra) {
    const t = this.get(taskId);
    if (!t || !t.steps[index]) return null;
    const s = t.steps[index];
    s.state = state;
    s.ts = Date.now();
    if (extra && extra.log) {
      s.log.push(extra.log);
      if (s.log.length > MAX_STEP_LOG) s.log.splice(0, s.log.length - MAX_STEP_LOG);
    }
    this._save();
    this._emit('task_step', { id: taskId, index, name: s.name, state });
    return s;
  }

  /** 记录任务日志（有界尾部）。 */
  log(taskId, line) {
    const t = this.get(taskId);
    if (!t) return;
    const ts = new Date().toISOString().slice(11, 19);
    t.log.push('[' + ts + '] ' + line);
    if (t.log.length > MAX_LOG_LINES) t.log.splice(0, t.log.length - MAX_LOG_LINES);
    this._save();
  }

  /** 任务成功。 */
  succeed(taskId, extra) {
    return this._finish(taskId, 'succeeded', null, extra);
  }

  /** 任务失败。 */
  fail(taskId, error, extra) {
    return this._finish(taskId, 'failed', error, extra);
  }

  /** 任务跳过（无需执行，如已是最新）。 */
  skip(taskId, reason, extra) {
    return this._finish(taskId, 'skipped', reason, extra);
  }

  /** 任务取消。 */
  cancel(taskId, reason) {
    return this._finish(taskId, 'canceled', reason, null);
  }

  _finish(taskId, state, error, extra) {
    const t = this.get(taskId);
    if (!t || t.state === 'succeeded' || t.state === 'failed' || t.state === 'skipped' || t.state === 'canceled') return null;
    t.state = state;
    t.error = error || null;
    t.finishedAt = Date.now();
    if (extra && extra.meta) t.meta = Object.assign({}, t.meta, extra.meta);
    delete this._current[t.kind + ':' + t.target.id];
    this._save();
    this._emit('task_state', { id: taskId, state });
    this._log('info', 'task ' + taskId + ' -> ' + state + (error ? ' (' + error + ')' : ''));
    return t;
  }

  /* ═══════ 视图 ═══════ */
  /** 前端视图：安全字段（不暴露内部细节）。 */
  view(task) {
    if (!task) return null;
    return {
      id: task.id,
      kind: task.kind,
      action: task.action,
      target: task.target,
      from: task.from,
      to: task.to,
      state: task.state,
      error: task.error,
      steps: task.steps.map((s) => ({ name: s.name, state: s.state, ts: s.ts })),
      logTail: task.log.slice(-50),
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      createdBy: task.createdBy,
      meta: task.meta,
    };
  }

  /** 概览：按 kind 聚合当前运行中任务。 */
  overview() {
    const cur = {};
    for (const t of this.running()) {
      cur[t.kind + ':' + t.target.id] = { id: t.id, action: t.action, state: t.state, to: t.to };
    }
    return { tasks: this.tasks.map((t) => this.view(t)), current: cur };
  }
}

module.exports = { TaskRegistry };
