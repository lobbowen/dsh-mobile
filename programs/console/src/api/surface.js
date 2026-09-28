'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// API 契约面（单一事实源）
//
// 面板对外承诺的路由都登记在此；test/api-surface-test.js 断言源码里的每条路由
// 都已登记（双向一致）。系统级入口（进程监督/端口分配/安装执行/续跑）**不在**
// 本表——它们归 OS 原生，面板只经 ctx.panel.call 消费（见 docs/components/console-system-api.md）。
//
// 分类语义：
//   public      一方客户端消费（前端 UI / 容器 / CLI）
//   operational 运维/监控/审计面
//   internal    面板自身内部消费
//   deprecated  兼容保留（明确移除条件）
// ═══════════════════════════════════════════════════════════════════════════

const CATEGORIES = ['public', 'operational', 'internal', 'deprecated'];

/** 精确路由（pathname ===）。 */
const SURFACE = [
  // ── 生命周期域（lifecycle.js）──
  { path: '/status',         methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['UI(polling)', 'CLI(status)'], note: '面板 + OS 状态摘要（OS 未接线时显式 osOnline=false；degraded 只由 OS 相位给）' },
  { path: '/events',         methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['UI(timeline)'], note: 'OS journal 增量事件（打断可见）' },
  { path: '/healthz',        methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['容器(握手探针)'], note: '面板存活探针' },
  { path: '/readyz',         methods: ['GET'],  domain: 'lifecycle', category: 'operational', consumers: ['监控/编排探针'], note: '面板就绪探针' },
  { path: '/session/status', methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['容器(会话态)'], note: '会话态读取口' },
  { path: '/session/stop',   methods: ['POST'], domain: 'lifecycle', category: 'public',      consumers: ['容器(退出握手)'], note: '请求 OS 停全部被管对象（面板不自停 OS）' },
  { path: '/metrics',        methods: ['GET'],  domain: 'lifecycle', category: 'operational', consumers: ['监控接入'], note: 'OS journal 遥测投影' },
  { path: '/logs/tail',      methods: ['GET'],  domain: 'lifecycle', category: 'operational', consumers: ['远程诊断'], note: 'OS 各 stream 日志尾部' },
  { path: '/logs/export',    methods: ['GET'],  domain: 'lifecycle', category: 'operational', consumers: ['审计/离线备份'], note: 'OS journal JSONL 导出' },
  { path: '/lifecycle',      methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['UI'], note: '实例生命周期一览（=/lifecycle/status）' },
  { path: '/lifecycle/status', methods: ['GET'], domain: 'lifecycle', category: 'public',     consumers: ['UI'], note: '同上（显式别名）' },

  // ── Program 原生管理（native.js）──
  { path: '/native/status',       methods: ['GET'],  domain: 'native', category: 'public', consumers: ['UI(OverviewPage)', 'CLI(status)'], note: 'OS 已装 Program 概览 + 升级状态机' },
  { path: '/native/capabilities', methods: ['GET'],  domain: 'native', category: 'operational', consumers: ['诊断/远程核验'], note: '上一轮原生件核验的落盘结论（读 files/os/diag.jsonl，不重跑探针）' },
  { path: '/native/check-update', methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)'], note: '触发 OS 版本检查' },
  { path: '/native/install',      methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)', 'CLI'], note: '经 OS AppManager 安装 Program' },
  { path: '/native/uninstall',    methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)'], note: '经 OS AppManager 卸载 Program' },
  { path: '/native/upgrade',      methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)', 'CLI(upgrade)'], note: '经 OS AppManager 升级 Program' },
  { path: '/native/settings',     methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)'], note: 'Program 元数据补丁（经 OS）' },
  { path: '/native/access',       methods: ['GET'],  domain: 'native', category: 'public', consumers: ['UI(进入 Program)'], note: '带令牌 Program Web 直连 URL（仅回环下发）' },

  // ── 任务（tasks.js）──
  { path: '/tasks', methods: ['GET'], domain: 'tasks', category: 'public', consumers: ['UI(TasksPage)'], note: 'OS journal 任务列表（+ /tasks/{id}）' },

  // ── 镜像源（dist.js）──
  { path: '/dist/registry',         methods: ['GET'],  domain: 'dist', category: 'public', consumers: ['UI(RegistryCard)'], note: 'OS registry 状态' },
  { path: '/dist/registry/refresh', methods: ['POST'], domain: 'dist', category: 'public', consumers: ['UI(RegistryCard)'], note: 'OS registry 测速刷新' },
  { path: '/dist/registry/set',     methods: ['POST'], domain: 'dist', category: 'public', consumers: ['UI(RegistryCard)'], note: 'OS registry 手动固定' },
  { path: '/dist/registry/probe',   methods: ['POST'], domain: 'dist', category: 'public', consumers: ['UI(RegistryCard 测试按钮)'], note: '同源单源探活（服务端）' },

  // ── 面板设置 + OS 环境视图（guard.js）──
  { path: '/changelog',           methods: ['GET'],  domain: 'guard', category: 'public', consumers: ['UI(AboutCard)'], note: '面板更新日志（text/plain）' },
  { path: '/guard/changelog',     methods: ['GET'],  domain: 'guard', category: 'public', consumers: ['UI(AboutCard)'], note: '面板 CHANGELOG.md' },
  { path: '/guard/version',       methods: ['GET'],  domain: 'guard', category: 'public', consumers: ['UI(AboutCard)'], note: '面板本地版本' },
  { path: '/guard/version/check', methods: ['POST'], domain: 'guard', category: 'public', consumers: ['UI(AboutCard)'], note: '面板版本检查（由 OS OTA 决定）' },
  { path: '/ports',               methods: ['GET'],  domain: 'guard', category: 'public', consumers: ['UI(PortPanel)'], note: 'OS PortBroker 端口视图' },
  { path: '/env/status',          methods: ['GET'],  domain: 'guard', category: 'public', consumers: ['UI(OverviewPage)'], note: 'OS 环境 + 平台能力矩阵' },
  { path: '/env/programs',        methods: ['GET'],  domain: 'guard', category: 'public', consumers: ['UI(OverviewPage)'], note: 'OS 已装 Program 目录' },
  { path: '/env/node-lts',        methods: ['GET'],  domain: 'guard', category: 'public', consumers: ['UI(OverviewPage)'], note: 'OS 运行时当前 vs 最新 LTS' },
  { path: '/settings/access-key', methods: ['GET', 'POST'], domain: 'guard', category: 'public', consumers: ['UI(AccessCard)'], note: '面板访问密钥' },
  { path: '/settings/lan',        methods: ['GET', 'POST'], domain: 'guard', category: 'public', consumers: ['UI(AccessCard)'], note: '面板局域网访问开关' },

  // ── 市场（plugins.js）──
  { path: '/plugins/market',         methods: ['GET'], domain: 'plugins', category: 'public', consumers: ['UI(PluginsPage)'], note: 'Program 市场索引（TTL 缓存）' },
  { path: '/plugins/installed',      methods: ['GET'], domain: 'plugins', category: 'public', consumers: ['UI(PluginsPage)'], note: '已装第三方组件（经 OS）' },
  { path: '/plugins/check-updates',  methods: ['GET'], domain: 'plugins', category: 'public', consumers: ['UI(PluginsPage)'], note: '已装组件更新检测（经 OS）' },
  { path: '/plugins/install-status', methods: ['GET'], domain: 'plugins', category: 'public', consumers: ['UI(PluginsPage, job 轮询)'], note: '组件任务进度（经 OS）' },

  // ── ADB 环境状态（adb.js）──
  { path: '/adb/status', methods: ['GET'], domain: 'adb', category: 'public', consumers: ['UI(环境状态面板)'], note: 'ADB 配对/密钥状态（OS 桥只读透传）' },
];

/** 前缀路由（pathname.startsWith）。 */
const PREFIXES = [
  { prefix: '/dist/',     domain: 'dist',      category: 'public',      consumers: ['UI'], note: '/dist/registry/{refresh|set|probe}' },
  { prefix: '/guard/',    domain: 'guard',     category: 'public',      consumers: ['UI'], note: '/guard/version|changelog 等' },
  { prefix: '/lifecycle', domain: 'lifecycle', category: 'public',      consumers: ['UI', 'CLI'], note: '/lifecycle/{id}[/{action}]（唯一启停入口）' },
  { prefix: '/lifecycle/', domain: 'lifecycle', category: 'public',     consumers: ['UI', 'CLI'], note: '同上（显式前缀）' },
  { prefix: '/logs',      domain: 'lifecycle', category: 'operational', consumers: ['诊断/审计'], note: '/logs/{tail|export}' },
  { prefix: '/native/',   domain: 'native',    category: 'public',      consumers: ['UI', 'CLI'], note: '/native/{status|install|uninstall|upgrade|...}' },
  { prefix: '/plugins/',  domain: 'plugins',   category: 'public',      consumers: ['UI'], note: '/plugins/{install|enable|disable|uninstall|update}' },
  { prefix: '/settings/', domain: 'guard',     category: 'public',      consumers: ['UI'], note: '/settings/{lan|access-key}' },
  { prefix: '/tasks/',    domain: 'tasks',     category: 'public',      consumers: ['UI'], note: '/tasks/{id}' },
];

function summary() {
  const byCat = {};
  for (const c of CATEGORIES) byCat[c] = 0;
  for (const e of SURFACE) byCat[e.category] = (byCat[e.category] || 0) + 1;
  return { exact: SURFACE.length, prefixes: PREFIXES.length, byCategory: byCat };
}

module.exports = { SURFACE, PREFIXES, CATEGORIES, summary };

