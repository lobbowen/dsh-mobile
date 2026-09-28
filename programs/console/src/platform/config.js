'use strict';

// 配置地基（面板 Program）：默认值 + 归一化。纯函数、无副作用。
// 面板只持有「面板自身」的配置；OS / Program 的配置由 OS 原生持有（见 docs/components/console-system-api.md）。

const os = require('node:os');
const path = require('node:path');
const stateRoot = require('./state-root');

const STATE_DIR = stateRoot.stateDir();

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const DEFAULTS = {
  // 面板 HTTP 服务：默认仅回环；「局域网访问」开关由面板自身设置切换为 0.0.0.0。
  apiHost: '127.0.0.1',
  apiPort: 36360,
  // 可选出回环访问密钥：配置后，非回环请求必须携带 Bearer / ?access_key=。
  apiAccessKey: null,
  // 面板静态资源目录覆盖（容器经 OTA 注入；缺省用本仓 ui/dist）。
  uiDir: null,
  // 面板自身状态/日志/市场缓存。
  stateFile: path.join(STATE_DIR, 'state.json'),
  logFile: path.join(STATE_DIR, 'log', 'panel.log'),
  marketCacheFile: path.join(STATE_DIR, 'market.json'),
  marketTtlMs: 30 * 60 * 1000,
  marketBuildBudgetMs: 4 * 60 * 1000,
  // 日志 / 缓存上限（面板自身，不涉及 OS）。
  logMaxBytes: 5 * 1024 * 1024,
};

function normalize(raw) {
  const cfg = { ...DEFAULTS, ...(raw || {}) };
  cfg.stateFile = expandHome(cfg.stateFile);
  cfg.logFile = expandHome(cfg.logFile);
  cfg.marketCacheFile = expandHome(cfg.marketCacheFile);
  cfg.apiPort = Number.isInteger(Number(cfg.apiPort)) && Number(cfg.apiPort) > 0 && Number(cfg.apiPort) <= 65535
    ? Number(cfg.apiPort)
    : DEFAULTS.apiPort;
  cfg.apiHost = cfg.apiHost === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  cfg.marketTtlMs = Number(cfg.marketTtlMs) > 0 ? Number(cfg.marketTtlMs) : DEFAULTS.marketTtlMs;
  cfg.marketBuildBudgetMs = Number(cfg.marketBuildBudgetMs) > 0 ? Number(cfg.marketBuildBudgetMs) : DEFAULTS.marketBuildBudgetMs;
  if (typeof cfg.apiAccessKey !== 'string' || !cfg.apiAccessKey) cfg.apiAccessKey = null;
  return cfg;
}

module.exports = { DEFAULTS, normalize, expandHome, STATE_DIR };

