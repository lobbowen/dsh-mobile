'use strict';

// ═══════════════════════════════════════════════════════════════════════
// LogCore —— 每进程唯一日志/事件核心（历史设计文档）。
//
// 定位：platform 层一等原语。每进程（守卫 / router-daemon）进程入口调用一次
// LogCore.init(...)，此后统一经 LogCore.get() 消费 logger/events/dshWriter/hub。
// 消灭散落 new Events/createLogger/Rotator/LineBuffer（守卫侧另有 EventHub 汇聚）。
//
// 单例语义：Node 模块缓存天然按「进程」——同一进程内 require 得到同一实例；
// init 同 process 幂等、异 process 抛错（防误用）。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const Events = require('./events');
const { createLogger, Rotator, LineBuffer } = require('./log');
const { EventHub, EventReader } = require('./loghub');

let _instance = null;
let _process = null;

class LogCore {
  /**
   * @param {object} opts
   *  - process: 'guard'|'router-daemon'（必填，行级 producer 与单例身份）
   *  - logFile:   分级日志主文件（createLogger 目标；守卫域名同历史 supervisor.log）
   *  - eventFile: 本进程事件文件
   *  - stateDir / aggBase: EventHub 聚合流目录与唯一基名（守卫侧）
   *  - logLevel / logMaxBytes / eventsMaxBytes: 保留/大小
   *  - dshLogFile / upgradeLogFile: 守卫侧被管目标/升级输出（仅守卫）
   *  - ctlPorts / daemonLogs: 守卫侧 daemon ctl 拉尾与日志路径（供 /logs/tail）
   */
  constructor(opts) {
    const o = opts || {};
    this.process = o.process || 'guard';
    this.logger = createLogger({
      file: o.logFile,
      level: o.logLevel || 'info',
      maxBytes: o.logMaxBytes,
      process: this.process,
    });
    this.events = new Events(o.eventFile, o.eventsMaxBytes, { process: this.process });
    this.dshWriter = o.dshLogFile ? new Rotator(o.dshLogFile, o.logMaxBytes) : null;
    // 守卫侧 EventHub 汇聚（guard 事件 push 零延迟 + daemon ctl 拉尾）；非守卫进程 hub=null。
    if (o.enableHub === true && o.stateDir) {
      try {
        // 构造期断言（RC5.3）：守卫事件文件与聚合流文件必须不同——同路径会让
        // events.append → pushGuard → writer.appendRaw → (同 hub attach) → pushGuard … 无界递归
        const aggFile = path.join(path.resolve(o.stateDir), 'events', (o.aggBase || 'state') + '.aggregated.events.log');
        const eventFileAbs = path.resolve(o.eventFile);
        if (aggFile === eventFileAbs) {
          throw new Error('logFile/eventFile 与聚合流文件冲突（' + eventFileAbs + '）：请调整 config.logFile');
        }
        this.hub = new EventHub({
          stateDir: o.stateDir,
          aggBase: o.aggBase || 'state',
          guardEvents: this.events,
          guardLogFile: o.logFile,
          dshLogFile: o.dshLogFile,
          upgradeLogFile: o.upgradeLogFile,
          daemonLogs: o.daemonLogs || {},
          ctlPorts: o.ctlPorts || {},
          eventsMaxBytes: o.eventsMaxBytes,
          logger: this.logger,
        });
        this.events.attachHub(this.hub);
      } catch (e) {
        this.hub = null;
        this.logger && this.logger.warn && this.logger.warn('[logcore] hub init: ' + ((e && e.message) || e));
      }
    } else {
      this.hub = null;
    }
    // 统一读路径（契约 §3.6，空对象模式）：hub 不可用时用 EventReader 适配本地事件流，
    // 使消费方（/events、/logs/*、/metrics）永远只有一条读路径，无需 if(hub)…else… 双语义。
    this.reader = this.hub || new EventReader(this.events);
  }

  event(type, data) { return this.events.append(type, data); }
  eventRaw(rec) { return this.events.appendRaw(rec); }
  get seq() { return this.events.seq; }
}

/** 进程入口初始化一次。同 process 幂等；异 process 抛错。 */
function init(opts) {
  const p = (opts && opts.process) || null;
  if (!p) throw new Error('LogCore.init 需要 process（guard|router-daemon）');
  if (_instance) {
    if (_process !== p) throw new Error('LogCore 已由 ' + _process + ' 初始化，进程内不允许二次换身份');
    return _instance;
  }
  _process = p;
  _instance = new LogCore(opts || {});
  return _instance;
}

/** 当前进程唯一 LogCore。未 init 时给惰性默认（不写盘）并告警，防测试误用。 */
function get() {
  if (_instance) return _instance;
  console.warn('[logcore] get() 在 init() 前调用——返回惰性默认(不落盘)；入口请先 LogCore.init()');
  _process = 'unknown';
  _instance = new LogCore({ process: 'unknown' });
  return _instance;
}

module.exports = { LogCore, init, get, _resetForTest: () => { _instance = null; _process = null; } };
