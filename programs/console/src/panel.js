'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Lob OS 控制面板 Program（console）
//
// 定位（架构 v4 §2.1）：console 不是内核、不是 init、不是特权层 —— 它只是一个
// 普通 Program（role=system），负责「展示 OS 状态 / 发起 Program 安装管理 / 承载
// 小组件」。它**不**持有：进程监督、端口分配、运行时装配、安装校验、任务续跑。
// 这些系统级职责全部归 OS 原生（见 docs/components/console-system-api.md 的接口清单）。
//
// 判据（硬）：停掉本 Program，OS 仍能启动、已装 Program 仍能运行、仍可被管理。
// 因此本文件**没有**：锁文件、daemon 自拉起、子进程监督、端口分配、恢复/续跑点机制。
//
// 与 OS 的唯一通道：src/platform/host-bridge/client.js（UDS + JSON-RPC 能力 API）。
// 桥不可用时面板自身 API 照常提供（降级），绝不冒充系统状态。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const { HostBridgeClient } = require('./platform/host-bridge/client');
const stateRoot = require('./platform/state-root');
const configMod = require('./platform/config');
const { panelVersion } = require('./platform/version');
const { ProgramMarket } = require('./domains/plugin/pluginmarket');
const api = require('./api');

const STATE_DIR = stateRoot.stateDir();
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const SETTINGS_FILE = path.join(STATE_DIR, 'settings.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

class Panel {
  constructor(opts) {
    opts = opts || {};
    const fileCfg = readJson(CONFIG_FILE, {});
    this.config = configMod.normalize(Object.assign({}, fileCfg, opts.config || {}));
    this.version = panelVersion();
    this._startedAt = null;
    this._server = null;
    this._settings = readJson(SETTINGS_FILE, {});
    this.os = new HostBridgeClient({ onLog: (m) => this.log(m), requires: opts.requires || [], program: opts.program || 'console' });
    this.pluginMarket = new ProgramMarket({
      stateFile: this.config.marketCacheFile,
      cacheDir: path.dirname(this.config.marketCacheFile),
      ttlMs: this.config.marketTtlMs,
      buildBudgetMs: this.config.marketBuildBudgetMs,
      logger: { info: (m) => this.log(m), warn: (m) => this.log(m), error: (m) => this.log(m) },
    });
  }

  /** 面板自身日志（绝不写 OS 的 journal —— 那是 OS 的单一状态源）。 */
  log(msg) {
    const line = new Date().toISOString() + ' ' + msg + '\n';
    try {
      fs.mkdirSync(path.dirname(this.config.logFile), { recursive: true });
      fs.appendFileSync(this.config.logFile, line);
    } catch {}
  }

  /** 面板自身偏好（lan/accessKey 等；与 OS 配置无关）。 */
  setting(key, dflt) {
    return this._settings[key] === undefined ? dflt : this._settings[key];
  }
  setSetting(key, value) {
    this._settings[key] = value;
    writeJson(SETTINGS_FILE, this._settings);
    return { ok: true };
  }

  lanStatus() {
    return { host: this.config.apiHost, enabled: this.config.apiHost === '0.0.0.0' };
  }
  /** 切换面板 HTTP 绑定；持久化到面板配置，下次启动生效。 */
  setLan(enabled) {
    this.config.apiHost = enabled ? '0.0.0.0' : '127.0.0.1';
    writeJson(CONFIG_FILE, { apiHost: this.config.apiHost, apiPort: this.config.apiPort });
    return { ok: true, host: this.config.apiHost, restartRequired: true };
  }
  accessKeyStatus() {
    return { configured: !!this.config.apiAccessKey };
  }
  setAccessKey(key) {
    this.config.apiAccessKey = key ? String(key) : null;
    writeJson(CONFIG_FILE, { apiHost: this.config.apiHost, apiPort: this.config.apiPort, apiAccessKey: this.config.apiAccessKey });
    return { ok: true, configured: !!this.config.apiAccessKey };
  }

  /** 面板静态资源目录（容器经 LOBOS_UI_DIR 注入；缺省本仓 ui/dist）。 */
  uiDir() {
    const candidates = [
      process.env.LOBOS_UI_DIR || this.config.uiDir || null,
      path.join(__dirname, '..', 'ui', 'dist'),
    ].filter(Boolean);
    for (const d of candidates) {
      try { if (fs.existsSync(path.join(d, 'console.html'))) return d; } catch {}
    }
    return null;
  }

  /** 调用 OS 原生能力 API（桥不可用 → null，调用方降级）。 */
  call(method, params) {
    return this.os.call(method, params);
  }

  /**
   * 对外状态摘要：只汇总 OS 的单一状态源（os.state.get）+ 面板自身事实。
   * `degraded` 在整份载荷里只说一件事：OS 相位等于 DEGRADED（读 state.json 那一份）。
   * OS 未接线是面板自己的事实，只说 `osOnline=false` —— 顶层再放一个 `degraded:true`
   * 就是第二把尺子：同一份 JSON 里两个 degraded 各说各话。
   */
  async statusSummary() {
    const base = {
      panel: { id: 'console', name: '控制面板', version: this.version, pid: process.pid, startedAt: this._startedAt, apiPort: this.config.apiPort },
    };
    const st = await this.os.call('os.state.get', {});
    if (st && st.ok) return Object.assign(base, { osOnline: true, os: st.result });
    return Object.assign(base, { osOnline: false, os: null, note: 'OS 原生能力 API 未接线（接口清单见 docs/components/console-system-api.md）' });
  }

  /** 启动面板 HTTP 服务（唯一对外承载面；不拉任何子进程）。 */
  start() {
    const server = api.createServer(this);
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.apiPort, this.config.apiHost, () => {
        this._server = server;
        this._startedAt = new Date().toISOString();
        const addr = server.address();
        this.log('panel listening on ' + addr.address + ':' + addr.port);
        resolve(addr);
      });
    });
  }

  stop() {
    this.os.close();
    if (!this._server) return Promise.resolve();
    return new Promise((resolve) => this._server.close(() => resolve()));
  }
}

module.exports = { Panel, STATE_DIR, CONFIG_FILE, SETTINGS_FILE };

