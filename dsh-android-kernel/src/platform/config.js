'use strict';

// 配置地基：默认值 + 归一化。守卫配置从 config.json 读取，经 normalize 校验并铺平。
// config.js 保持纯函数、无副作用，便于单元测试与跨领域复用。

const os = require('node:os');
const path = require('node:path');

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// 产品状态根（独立于 DSH 的 ~/.dsh）——单一事实源 = platform/state-root.js。
// 进程内固定：避免运行中环境变化导致状态目录半途切换。
const SUP = require('./state-root').supervisorDir();

const DEFAULTS = {
  probeIntervalMs: 5000,
  // 健康探测（三层）：L0 进程存活 + L1 端口监听 + L2 HTTP GET healthUrl。
  // probeTimeoutMs = 单次 HTTP 探测超时；failThreshold = 连续失败次数 → 判故障（防抖动）；
  // httpProbeEnabled=false 时退化为「端口在线即健康」（自定义非 HTTP 命令时使用）。
  probeTimeoutMs: 3000,
  failThreshold: 2,
  httpProbeEnabled: true,
  startTimeoutMs: 30000,
  stopGraceMs: 10000,
  portReleaseWaitMs: 10000,
  crashWindowMs: 600000,
  crashBurst: 5,
  backoff: [30000, 60000, 120000, 300000, 600000],
  apiHost: '127.0.0.1',
  // API 端口：高位不常用段起始（3100 常用端口易与本机程序冲突）。守卫启动被占则自动顺延并持久化。
  apiPort: 36360,
  // daemon 控制通道端口（router 独立进程 ctl）：集中定义，杜绝散落硬编码（2026-09 端口收敛）。
  routerCtlPort: 43107,
  // 动态端口池（工业标准：范围是配置项，非编译期常量）。默认避开 OS 动态端口范围
  // （Linux ip_local_port_range=32768-60999），落在 IANA User 段低位供监听池使用。
  // managed = proxyInstance/oauthCallback 共享池（K8s 单一范围思想，杜绝段碎片化）；
  // providerApi = 智能路由供应商独立端点池（按供应商规模调大）。null = 用内置默认池。
  portPools: null,
  stateFile: path.join(SUP, 'state.json'),
  // 系统日志框架目录布局：log/ 与 events/ 分目录；
  // 守卫(guard) 事件在 events/guard.events.log、分级日志在 log/guard.log（router daemon 用同构文件）。
  // 显式配置（既有生产 config.json / 测试）仍尊重用户给定路径——不强行改写。
  logFile: path.join(SUP, 'events', 'guard.events.log'),
  eventsMaxBytes: 5 * 1024 * 1024,
  supervisorLogFile: path.join(SUP, 'log', 'guard.log'),
  dshLogFile: path.join(SUP, 'log', 'dsh.log'),
  upgradeLogFile: path.join(SUP, 'log', 'upgrade.log'),
  logLevel: 'info',
  logMaxBytes: 5 * 1024 * 1024,
  notifyEnabled: true,
  routerAutostart: false, // 智能路由启动开关（旧键 switcherAutoStart 已迁移）
  // ⚠ 内核更新键 `corePackageName` 已删除：安卓内核不经 npm 分发，
  //   更新由容器 OTA 完成（单写入者 = 容器）；内核不查询也不安装自己。
  // ⚠ 旧 manifest 模式的残留键 `selfUpdateManifestUrl` / `selfUpdateDir` 同样已删除
  //   （全仓无赋值点）。既有用户 config.json 若仍含这些键，加载时忽略即可（未知键不报错）。
  pluginsProfileName: 'web',
  packageName: '@deepseek-ai/dsh',
  // **最小兜底**镜像源（2026-09-11 契约化）。
  //
  // ⚠ 完整目录与探测规格**不在这里** —— 它们是**壳**的产物：
  //   用户在装壳那刻机器上没有内核，壳必须先完成镜像选择才能装内核，
  //   故「镜像源管理」的所有权在壳，经 ~/.dsh/supervisor/registry.json 投放，
  //   内核由 domains/dist 的 DistributionManager 读取（见 platform/registry-contract.js）。
  //
  // 此处仅保留 2 条，覆盖「契约不可用时也能跑」这一底线（不变量 C2）：
  //   官方源（能上网）+ npmmirror（中国网络）。
  //
  // 历史：曾在此硬编码与 dist/index.js、壳 mirror.rs **逐字节相同的 6 条**，
  //   任何一处增删都会漂移；且因两侧探测方法不同，实测会**选到不同的源**。
  registries: [
    'https://registry.npmjs.org',
    'https://registry.npmmirror.com',
  ],
  updateCheckEnabled: true,
  updateCheckIntervalMs: 3600000,
  initialCheckDelayMs: 20000,
  upgradeTimeoutMs: 600000,
  // --ignore-scripts（容器边界拍板）：安卓容器无 sh 可 spawn（W^X），lifecycle
  // 脚本既必失败又是攻击面；git:/native 依赖在设备上永久不可用，不予支持。
  installCommandTemplate: ['npm', 'install', '-g', '--ignore-scripts', '{pkg}@{version}'],
  // apiAccessKey（可选，2026-09 D/F2 拍板）：出回环访问密钥——仅当配置了该键时，
  // 0.0.0.0（局域网）与 FRP 公网通道的 API 请求必须携带 Authorization: Bearer <key>
  // 或 ?access_key=<key>，否则 401；本地回环（127.0.0.1/localhost/::1）豁免。
  // 不配置 = 维持现状（LAN 受 RFC1918 白名单约束）。
  apiAccessKey: null,
};

function normalize(raw) {
  const cfg = { ...DEFAULTS, ...(raw || {}) };
  cfg.stateFile = expandHome(cfg.stateFile);
  cfg.logFile = expandHome(cfg.logFile);
  cfg.supervisorLogFile = expandHome(cfg.supervisorLogFile);
  cfg.dshLogFile = expandHome(cfg.dshLogFile);
  cfg.upgradeLogFile = expandHome(cfg.upgradeLogFile);
  // healthUrl 非法直接 fail-fast（静默降级会让探测永远失败且难排查）
  let u;
  try {
    u = new URL(cfg.healthUrl);
  } catch {
    throw new Error('config.healthUrl 无效: ' + JSON.stringify(cfg.healthUrl));
  }
  cfg.targetHost = u.hostname;
  cfg.targetPort = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  // 配置键迁移（2026-09）：switcherAutoStart（旧）→ routerAutostart（新）；旧键仍被尊重直到文件收敛
  if ((raw || {}).routerAutostart === undefined && (raw || {}).switcherAutoStart !== undefined) cfg.routerAutostart = raw.switcherAutoStart === true; // RC6：判 raw（DEFAULTS 已填 cfg），死分支复活
  // 动态端口注册：command 里的 --port/-p 是 DSH 实际启动参数（用户改端口时最真实）——
  // 若 command 指定了端口，以其为准覆盖 healthUrl 端口（用户使用场景各异，绝不硬编码 3080）
  const cmdPort = extractPortFromCommand(cfg.command);
  if (cmdPort !== null) cfg.targetPort = cmdPort;
  // 健康维度参数归一化：非法值回退默认，杜绝 NaN/负数进入探测链路
  cfg.probeTimeoutMs = Number.isFinite(Number(cfg.probeTimeoutMs)) && Number(cfg.probeTimeoutMs) > 0 ? Number(cfg.probeTimeoutMs) : 3000;
  cfg.failThreshold = Number.isInteger(Number(cfg.failThreshold)) && Number(cfg.failThreshold) >= 1 ? Number(cfg.failThreshold) : 2;
  cfg.httpProbeEnabled = cfg.httpProbeEnabled !== false;
  if (!Array.isArray(cfg.command) || cfg.command.length === 0) {
    throw new Error('config.command 缺失：需要一个命令数组');
  }
  return cfg;
}

/** 从启动命令提取端口（--port N / -p N）；无则返回 null。 */
function extractPortFromCommand(command) {
  if (!Array.isArray(command)) return null;
  for (let i = 0; i < command.length; i++) {
    const a = String(command[i]);
    if ((a === '--port' || a === '-p') && i + 1 < command.length) {
      const n = Number(command[i + 1]);
      if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
    }
    const m = /^--port=(\d+)$/.exec(a);
    if (m) { const n = Number(m[1]); if (Number.isInteger(n) && n > 0 && n <= 65535) return n; }
  }
  return null;
}

module.exports = { DEFAULTS, normalize, extractPortFromCommand }; // extractPortFromCommand 共享给 supervisor 运行期进程端口再推导（同一解析实现，防重复）
