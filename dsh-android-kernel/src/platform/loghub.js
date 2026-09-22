'use strict';

// ═══════════════════════════════════════════════════════════════════════
// EventHub —— 守卫事件汇聚枢纽（系统日志框架）。
//
// 定位：守卫是唯一对外汇聚面。各进程事件文件单写者（guard / router-daemon），
// EventHub 只读聚合三源 → 转写入守卫唯一的聚合事件流文件（单写者=守卫），对外 /events 读它。
//  - 聚合流 seq 即 gseq：全局单调、meta 续号、跨守卫重启连续（UI after 游标稳定）。
//  - 不落 daemon 事件副本到 daemon 文件（daemon 文件仍为原始单写者真相）。
//  - daemon 增量经 ctl eventsTail(afterSeq) 拉取（复用既有 ctl 通道），失败降级跳过。
//
// 不变量：聚合流文件只由 EventHub 写；水位(watermark)只由 EventHub 写；对外 /events 只读聚合流。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const Events = require('../platform/events');

// Android 内核只保留两个事件源：守卫本体 + 智能路由 daemon（远程控制 daemon 随 relay 域删除）。
const SOURCES = ['guard', 'router-daemon'];

// 内部簿记事件（heartbeat 影子/注册机/目录簿记等）：进审计但不进默认用户时间线（/events 默认过滤，internal=1 显示）。
function isInternalEvent(type) {
  const t = String(type || '');
  if (t.startsWith('shadow_') || t.startsWith('managed_object_')) return true;
  // 守卫监督簿记（守护动作/受监督 daemon 拉起/孤儿实例审计）：进审计不进用户时间线。
  return t === 'guardian_action' || t === 'router_daemon_supervised' || t === 'orphan_audit';
}
// 事件人性化（穿透审计后）：给"裸类型"业务事件生成可读中文 message，写入 data.message——
// 前端事件行优先显示 data.message（fallback 才是原始 type/data）。
// 不覆盖前端已专门格式化（router_usage/router_pick/account_*/proxy_update_available 等）的类型。
function humaneMsg(type, data) {
  const d = data || {};
  const who = d.id === 'main' ? '主实例' : (d.id || '会话');
  switch (type) {
    case 'lan_cookie_exchanged': return who + ' 远程会话 cookie 已刷新';
    case 'lan_cookie_failed': return who + ' 远程会话 cookie 换取失败' + (d.error ? '：' + d.error : '');
    case 'dsh_token_captured': return who + ' DSH 令牌已捕获';
    case 'dsh_token_missing': return who + ' DSH 令牌缺失，等待捕获';
    case 'inst_added': return '新增沙箱实例：' + (d.id || '?');
    case 'inst_removed': return '删除沙箱实例：' + (d.id || '?');
    case 'inst_started': return '沙箱实例已启动：' + (d.id || '?');
    case 'inst_stopped': return '沙箱实例已停止：' + (d.id || '?');
    case 'inst_failed': return '沙箱实例失败：' + (d.reason || d.lastError || d.error || '?');
    case 'upgrader_started': return '开始升级 DSH' + (d.version ? ' 至 ' + d.version : '');
    case 'upgrader_done': return 'DSH 升级完成' + (d.version ? '，当前 ' + d.version : '');
    case 'upgrader_failed': return 'DSH 升级失败：' + (d.error || '未知原因');
    case 'upgrade_installed': return 'DSH ' + (d.version || '?') + ' 已安装';
    case 'adopt_token_reclaim_started': return (d.pid ? '接管实例 pid ' + d.pid : '接管实例') + ' 令牌不可达，进入受控重建';
    case 'api_failed': return 'API 请求失败：' + (d.error || d.message || '未知');
    default: return null;
  }
}

/** 调 daemon 的 ctl 通道（`POST /ctl {method,args}`），返回 `value`；失败抛错。
 *
 *  ⚠ 2026-09-12（P2 去重）：本函数是 ctl 客户端的**唯一实现**。
 *    此前 `guard/supervisor/control-view.js:_ctlCall` 有一份**逐行近似**的副本，
 *    两处已分叉：默认超时不同（此处 3s / 彼处 120s）、错误对象形状不同
 *    （彼处额外挂 `err.ok=false` / `err.error`）—— 同一协议两种行为。
 *    现由 `platform/` 统一提供（本层是跨域共享能力的正确归属），
 *    `control-view` 改为薄包装并显式传自己的默认超时。
 *
 *  @param {number} port ctl 端口（router 43107 / lan 43108）
 *  @param {string} method daemon 侧 RouterService/LanManager 的方法名
 *  @param {Array} args 方法参数
 *  @param {number} [timeoutMs=3000] 超时（超时即 destroy，不悬挂调用方）
 *  @param {object} [opts] { withErrorFields?: boolean } —— true 时在 Error 上挂 `ok/error`
 *    （control-view 的既有契约需要，便于上游判定 `r.ok === false`）
 */
function ctlCall(port, method, args, timeoutMs, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, args: Array.isArray(args) ? args : [] });
    const req = http.request({
      host: '127.0.0.1', port, path: '/ctl', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs || 3000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf || '{}');
          if (j && j.ok) return resolve(j.value);
          const err = new Error((j && j.error) || ('ctl:' + port + ' ' + method + ' failed'));
          if (o.withErrorFields) { err.ok = false; err.error = (j && j.error) || null; }
          return reject(err);
        } catch { reject(new Error('ctl:' + port + ' 响应解析失败')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('ctl:' + port + ' 超时')));
    req.on('error', reject);
    req.end(body);
  });
}

/** 读运行日志文件尾部（排障用 /logs/tail）。 */
function tailFile(file, n) {
  if (!file) return [];
  try {
    const all = fs.readFileSync(file, 'utf8');
    const lines = all.split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, Number(n) || 100));
  } catch { return []; }
}

class EventHub {
  /**
   * @param {object} opts
   *  - stateDir: 守卫状态目录（聚合流/水位落此）
   *  - guardEvents: 守卫 Events 实例（源之一）
   *  - guardLogFile / dshLogFile / upgradeLogFile: 守卫侧运行日志（/logs/tail 用）
   *  - daemonLogs: { router: '.../log/router-daemon.log' }
   *  - ctlPorts: { router: 43107 }
   *  - logger: 可选
   */
  constructor(opts) {
    this.stateDir = opts.stateDir;
    // 聚合流/水位按守卫 stateFile 派生唯一名（同 registry 隔离思路）：同一 stateDir 多守卫(测试 TMP)
    // 不得共写同一 aggregated 文件——否则 hub 自己制造多写者(seq 互踩)。生产 state.json → state.aggregated.*
    this.aggBase = opts.aggBase || 'state';
    this.guardEvents = opts.guardEvents || null;
    this.guardLogFile = opts.guardLogFile || null;
    this.dshLogFile = opts.dshLogFile || null;
    this.upgradeLogFile = opts.upgradeLogFile || null;
    // 装配键契约：外部（supervisor LogCore.init / 测试）用短键 { router }；内部源标识用长键
    // ('router-daemon'，SOURCES)。这里统一映射，避免『键不匹配→ctlPorts[长键]=undefined→
    // 静默跳过』的装配级空跑（曾致 daemon 事件永不入聚合）。
    this.daemonLogs = opts.daemonLogs || {};
    this.ctlPorts = opts.ctlPorts || {};
    this._warnedKey = {};
    this._shortKey = (which) => (which === 'router-daemon' ? 'router' : which);
    this._portFor = (which) => this.ctlPorts[this._shortKey(which)];
    // ⚠ 2026-09-12：删除 `_logFileFor` —— 全仓**零调用点**（`tailLog` 走直读路径）。
    //   它的存在还有副作用：`_log`（本类真正的告警出口）此前**未被定义**，
    //   而 `_logFileFor` 是唯一带 `_log` 前缀的成员 —— 极易让读者（和当初的调用者）
    //   误以为告警出口已存在（P1-1 的成因之一）。
    this.logger = opts.logger || null;
    this.aggDir = path.join(this.stateDir, 'events');
    this.aggFile = path.join(this.aggDir, this.aggBase + '.aggregated.events.log');
    this.watermarkFile = path.join(this.aggDir, this.aggBase + '.aggregated.watermark.json');
    this.writer = new Events(this.aggFile, (opts.eventsMaxBytes) || 5 * 1024 * 1024, { process: 'guard-hub' });
    // 水位默认 null=未初始化：启用时不回溯历史存量（历史在各自源文件可查），只聚合启用后增量——
    // 否则守卫重启会把 events.log 全量历史重复转写进聚合流（UI 时间线翻倍）。
    this.watermark = { guard: null, 'router-daemon': null };
    this._loadWatermark();
    // guard 源基线：启用即当前 seq（不回溯历史）。
    if (this.watermark.guard == null && this.guardEvents) this.watermark.guard = this.guardEvents.seq;
    this._tickSeq = 0;
  }

  /** 内部告警出口（P1-1 修复，2026-09-12）。
   *
   *  ⚠ 此前本类有 **4 处 `this._log('warn', …)` 调用，却从未定义 `_log`**
   *    （`_logFileFor` 是唯一带 `_log` 前缀的成员，且它是赋值而非同名方法）——
   *    与内核 `markNetFail` 同型：「声明了调用但方法不存在」。
   *
   *    后果（比一般 no-op 更严重：它是**抛异常**）：
   *      · `_ingest` 在「写盘失败」这一唯一应触发分支先调 `_log` → TypeError →
   *        被**同一条 try 的 catch** 捕获 → catch 里再调 `_log` → 再抛 → 逃出整个 for 循环；
   *        结果不是注释承诺的「水位不推进、下轮补齐」，而是**该批剩余事件直接丢弃**，
   *        且**告警本身也丢失**；
   *      · daemon 路径上该异常被 `_syncDaemon` 的 catch 记为「eventsTail 不可用」，
   *        把「本地写盘失败」误报成「daemon 不可达」→ 排障方向被带偏。
   *
   *    修法：定义本方法（与文件内既有用法一致：可选 logger + 不抛）。
   *    这是把「契约」补全，而非改语义 —— 调用点的意图从注释即可读出。
   */
  _log(level, msg) {
    try {
      const lg = this.logger;
      // 注：调用点的 msg 多已自带 '[hub] ' 前缀，故此处不再叠加。
      if (lg && typeof lg[level] === 'function') lg[level](msg);
    } catch { /* 告警出口本身绝不抛：它是失败路径上的最后一环 */ }
  }

  /** 事件人性化 data：浅拷贝源 data 并注入可读中文 message（前端优先显示 data.message）。
   *  不改源事件对象（审计源行仍为原始 data）。 */
  _humaData(type, data) {
    if (data !== null && typeof data === 'object' && typeof data.message === 'string') return data; // 源已自带 message
    const msg = humaneMsg(type, data);
    if (!msg) return data !== undefined ? data : null;
    return Object.assign({}, data || {}, { message: msg });
  }

  _loadWatermark() {
    try {
      const w = JSON.parse(fs.readFileSync(this.watermarkFile, 'utf8'));
      for (const s of SOURCES) if (typeof w[s] === 'number') this.watermark[s] = w[s];
    } catch {}
  }

  _saveWatermark() {
    try {
      fs.mkdirSync(this.aggDir, { recursive: true });
      const tmp = this.watermarkFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.watermark));
      fs.renameSync(tmp, this.watermarkFile);
    } catch (e) { this.logger && this.logger.warn && this.logger.warn('[hub] watermark save: ' + (e && e.message)); }
  }

  /** 转写事件到聚合流。@returns {number} 最后成功写入的源 seq（写失败不推进——RC5.2 契约） */
  _ingest(source, list) {
    let lastOkSeq = null;
    for (const e of list) {
      if (!e || typeof e.seq !== 'number') continue;
      try {
        const rec = {
          ts: e.ts || undefined,
          type: e.type,
          data: this._humaData(e.type, e.data),
          source,
          srcSeq: e.seq,
          internal: isInternalEvent(e.type),
        };
        if (e.producer) rec.producer = e.producer;
        this.writer.appendRaw(rec); // 聚合流 seq/ts 由 appendRaw 注入
        // 写盘失败（磁盘满/权限）→ 不推进水位，下轮 sync 补齐（RC5.2 契约；appendRaw 以 _lastAppendOk 报告）。
        if (this.writer._lastAppendOk === false) { this._log('warn', '[hub] ingest ' + source + ' seq=' + e.seq + ' 写盘失败，水位不推进'); break; }
        lastOkSeq = e.seq;
      } catch (e2) {
        // appendRaw 内部已兜底不抛；此分支防御性保留——失败的源事件不推进水位，sync 重试补齐
        this._log('warn', '[hub] ingest ' + source + ' seq=' + e.seq + ' failed: ' + ((e2 && e2.message) || e2));
        break;
      }
    }
    return lastOkSeq;
  }

  /** 守卫事件推模式（P1b）：守卫 Events.append 已同步调此——守卫事件零延迟入聚合流。 */
  pushGuard(rec) {
    if (!rec || typeof rec.seq !== 'number') return;
    // hub 来源标记：防御聚合流文件被误配为守卫事件文件时的递归（RC5.3 纵深防御之一）
    if (rec.source === 'guard-hub') return;
    const out = {
      ts: rec.ts || undefined,
      type: rec.type,
      data: this._humaData(rec.type, rec.data),
      source: 'guard',
      srcSeq: rec.seq,
      internal: isInternalEvent(rec.type),
    };
    if (rec.producer) out.producer = rec.producer;
    try {
      this.writer.appendRaw(out);
      if (this.writer._lastAppendOk === false) {
        // 写盘失败：水位不动——_syncGuard 会在后续拍补转写（事件不丢）
        this._log('warn', '[hub] pushGuard append failed (watermark held): ' + rec.seq);
        return;
      }
      this.watermark.guard = Math.max(this.watermark.guard || 0, rec.seq); // 只在成功后推进
    } catch (e) {
      this._log('warn', '[hub] pushGuard append failed (watermark held): ' + ((e && e.message) || e));
    }
  }

  /** 兼容守卫扫文件增量入口：推模式下守卫事件已同步入流，本方法不再转写（防重复），仅保水位。 */
  _syncGuard() {
    if (this.guardEvents && this.watermark.guard != null && this.guardEvents.seq > this.watermark.guard) {
      // 守卫重启间隙或推模式中断的兜底：把缺的增量补转写（推模式正常时水位已同步，无重复）。
      // RC5.2：水位只推进到"最后成功写入"的源 seq——写盘失败期间不丢事件（下轮补齐）。
      const list = this.guardEvents.tailSince(this.watermark.guard);
      const lastOk = list && list.length ? this._ingest('guard', list) : null;
      if (lastOk != null) this.watermark.guard = Math.max(this.watermark.guard, lastOk);
    }
  }

  /** 经 ctl 拉 daemon 事件增量并转写。失败降级（daemon 未监督/未起）。 */
  async _syncDaemon(which) {
    const port = this._portFor(which);
    if (!port) {
      if (!this._warnedKey[which]) {
        this._warnedKey[which] = true;
        this.logger && this.logger.warn && this.logger.warn('[hub] ' + which + ' ctlPort 未装配（检查 ctlPorts 键 router/lan）——daemon 事件不入聚合');
      }
      return;
    }
    try {
      const v = await ctlCall(port, 'eventsTail', [this.watermark[which] == null ? 0 : this.watermark[which]], 2000);
      if (v && typeof v.seq === 'number') {
        if (this.watermark[which] == null) {
          // 首拉：只建基线（daemon 存量历史不回溯转写）
          this.watermark[which] = v.seq;
          return;
        }
        if (v.seq < this.watermark[which]) {
          // daemon 事件文件被清/重置（seq 回退）：重建基线不 ingest 存量，防『水位高于 daemon seq → 永久不拉』。
          this.logger && this.logger.warn && this.logger.warn('[hub] ' + which + ' 事件 seq 回退(' + v.seq + '<' + this.watermark[which] + ')——按文件重置重建基线');
          this.watermark[which] = v.seq;
          return;
        }
        if (Array.isArray(v.events) && v.events.length) {
          const lastOk = this._ingest(which, v.events);
          // 水位推进到"最后成功转写"的源 seq 与源文件 seq 的较小者——写失败不越界
          this.watermark[which] = Math.max(this.watermark[which], lastOk != null ? Math.min(lastOk, v.seq) : this.watermark[which]);
        } else {
          this.watermark[which] = Math.max(this.watermark[which], v.seq);
        }
      }
    } catch (e) {
      // daemon 未运行/未受监督：降级（守卫 /events 仍含守卫事件）——非装配错误，保持 debug 防刷。
      this.logger && this.logger.debug && this.logger.debug('[hub] ' + which + ' eventsTail 不可用: ' + ((e && e.message) || e));
    }
  }

  /** 心跳每拍调用：聚合两源（守卫 + router daemon）→ 聚合流。 */
  async sync() {
    this._tickSeq += 1;
    try { this._syncGuard(); } catch (e) { this.logger && this.logger.warn && this.logger.warn('[hub] guard sync: ' + ((e && e.message) || e)); }
    // daemon 每 ~6 拍拉一次（约 30s；与监督节流一致，避免每拍 ctl）
    if (this._tickSeq % 6 === 1) {
      try { await this._syncDaemon('router-daemon'); } catch {}
    }
    this._saveWatermark();
  }

  /** 对外增量读：seq > after（gseq=聚合流 seq）。 */
  read(after, limit) {
    return this.writer.readSince(after, limit);
  }

  get seq() { return this.writer.seq; }

  /** /logs/tail: 读各运行日志尾部。 */
  tailLog(stream, n) {
    const file = {
      guard: this.guardLogFile,
      router: (this.daemonLogs && this.daemonLogs.router) || null,
      dsh: this.dshLogFile,
      upgrade: this.upgradeLogFile,
    }[stream];
    return tailFile(file, n);
  }


  /** 读聚合流全窗（供检索/导出/metrics；readAll 全量，无 readSince 500 上限）。 */
  window() {
    return this.writer.readAll();
  }

  /** 用户时间线读（穿透审计修正）：seq > after 且非 internal 的最近 limit 条业务事件。
   *  先全窗过滤再取尾——避免『先 limit 后过滤 → 被内部事件挤空/看不到存量业务』。 */
  readVisible(after, limit) { return visibleFrom(this.window(), after, limit); }

  /** 事件检索（P2）：filter { type?: 前缀, source?: guard|router-daemon } → 匹配事件。
   *  从聚合流过滤（事件已经全局有序）。limit 上限 2000。 */
  readFiltered(filter, after, limit) { return filteredFrom(this.window(), filter, after, limit); }

  /** 审计导出（P2）：把聚合流原文行导出为文本（JSONL），供离线备份/审计。limit 行数上限。 */
  exportLines(after, limit) { return exportFrom(this.window(), after, limit); }

  /** 遥测派生（P2 /metrics）：事件流上的只读投影——按 source 计数事件、top type、窗口事件率。
   *  不引入新采集通道（日志/事件即唯一采集面）。 */
  metrics() { return metricsFrom(this.window(), this.seq); }
}

/* ── 读路径共享实现（契约 §3.6：消除 EventHub 与降级读的双语义漂移）──
 * 所有「窗口派生读」只实现一次，EventHub 与 EventReader 共用，杜绝两处逻辑漂移。 */
function visibleFrom(win, after, limit) {
  const aft = Number(after) || 0;
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const out = [];
  for (const e of win) {
    if (e.seq <= aft) continue;
    if (e.internal === undefined ? isInternalEvent(e.type) : e.internal === true) continue;
    out.push(e);
  }
  return out.slice(-lim);
}
function filteredFrom(win, filter, after, limit) {
  const f = filter || {};
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 2000);
  const aft = Number(after) || 0;
  const out = [];
  for (const e of win) {
    if (e.seq <= aft) continue;
    if (f.source && e.source !== f.source) continue;
    if (f.type && !String(e.type || '').startsWith(f.type)) continue;
    out.push(e);
    if (out.length >= lim) break;
  }
  return out;
}
function exportFrom(win, after, limit) {
  const aft = Number(after) || 0;
  const lim = Math.min(Math.max(Number(limit) || 2000, 1), 20000);
  const lines = [];
  for (const e of win) {
    if (e.seq <= aft) continue;
    try { lines.push(JSON.stringify(e)); } catch {}
    if (lines.length >= lim) break;
  }
  return lines;
}
function metricsFrom(win, seq) {
  const total = win.length;
  const bySource = {};
  const byType = {};
  let lastTs = null;
  for (const e of win) {
    bySource[e.source || 'unknown'] = (bySource[e.source || 'unknown'] || 0) + 1;
    const t = String(e.type || 'unknown');
    byType[t] = (byType[t] || 0) + 1;
    if (!lastTs || (e.ts && e.ts > lastTs)) lastTs = e.ts;
  }
  const topTypes = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([type, count]) => ({ type, count }));
  const now = Date.now();
  const lastAt = lastTs ? new Date(lastTs).getTime() : null;
  return { gseq: seq, events: total, bySource, topTypes, lastEventAt: lastTs, sinceLastMs: lastAt ? Math.max(0, now - lastAt) : null, ts: new Date().toISOString() };
}

/** 降级读路径（空对象模式 null-object，契约 §3.6）：hub 不可用时（非守卫进程/初始化降级/测试）
 *  把守卫本地事件流适配成与 EventHub **完全相同**的读接口——使 /events、/logs/*、/metrics 全程
 *  只有一条读路径，彻底消除 `if (hub) … else …` 双语义漂移。 */
class EventReader {
  constructor(events) { this.events = events; }
  get seq() { return this.events.seq; }
  window() { return this.events.readAll(); }
  read(after, limit) { return this.events.readSince(after, limit); }
  readVisible(after, limit) { return visibleFrom(this.window(), after, limit); }
  readFiltered(filter, after, limit) { return filteredFrom(this.window(), filter, after, limit); }
  tailLog() { return []; } // 降级模式无聚合日志（各 stream 返回空）
  exportLines(after, limit) { return exportFrom(this.window(), after, limit); }
  metrics() { return metricsFrom(this.window(), this.seq); }
  sync() { return Promise.resolve(); } // 无聚合流水位需同步
}

module.exports = { EventHub, EventReader, tailFile, isInternalEvent, ctlCall };
