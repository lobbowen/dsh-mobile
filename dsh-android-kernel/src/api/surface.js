'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// API 契约面（单一事实源）—— P3 断点修复。
//
// 背景（功能断点审计 D1）：仓库长期**无受强制的 API 契约**，表现为：
//   1) README 的 API 清单已过期（仍文档化 R3 已删除的 POST /start|/stop|/restart，
//      却遗漏 /lifecycle、/session、/ports、/metrics、/logs、/env/status 等大半真实路由）；
//   2) 「端点是否有消费者」只能靠一次性 grep 审计，无法作为**常驻不变量**防回归。
//
// 本模块把「每个路由属于哪一类、谁在消费」显式声明；test/api-surface-test.js 断言
// 源码里出现的每个路由都在此处登记（双向一致）。新增路由若不登记 → 测试失败。
//
// 分类语义：
//   public      一方客户端消费（前端 UI / CLI / 安卓容器）
//   operational 运维/监控/审计面（外部工具消费，一方 UI 不调用——工业标准的可观测接口）
//   internal    守卫自身内部消费（不对外承诺稳定性）
//   deprecated  兼容保留（明确移除条件，避免静默删除破坏旧客户端）
// ═══════════════════════════════════════════════════════════════════════════

const CATEGORIES = ['public', 'operational', 'internal', 'deprecated'];

/** 精确路由（pathname ===）。methods 为实际支持的方法。 */
const SURFACE = [
  // ── 生命周期域（lifecycle.js）──
  { path: '/status',         methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['UI(polling)', 'CLI(status)'], note: '状态摘要' },
  { path: '/events',         methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['UI(timeline)'], note: '增量事件' },
  { path: '/healthz',        methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['容器(握手探针)'], note: '存活探针' },
  { path: '/readyz',         methods: ['GET'],  domain: 'lifecycle', category: 'operational', consumers: ['监控/编排探针'], note: '就绪探针（守卫已初始化且未停机）' },
  { path: '/session/status', methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['容器(Android Service, 会话态)'], note: '会话态读取口' },
  { path: '/session/stop',   methods: ['POST'], domain: 'lifecycle', category: 'public',      consumers: ['容器(退出握手)'], note: '停全部被管对象 + 回执（守卫不自停）' },
  { path: '/metrics',        methods: ['GET'],  domain: 'lifecycle', category: 'operational', consumers: ['监控接入'], note: '监控：事件流派生遥测（bySource/topTypes/事件率）' },
  { path: '/logs/tail',      methods: ['GET'],  domain: 'lifecycle', category: 'operational', consumers: ['远程诊断'], note: '诊断：各 stream 日志尾部（跨机排障；本机 CLI 直读文件）' },
  { path: '/logs/export',    methods: ['GET'],  domain: 'lifecycle', category: 'operational', consumers: ['审计/离线备份'], note: '审计：聚合流 JSONL 导出（离线备份/合规留痕）' },
  { path: '/lifecycle',      methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['UI'], note: '模块生命周期一览（=/lifecycle/status）' },
  { path: '/lifecycle/status', methods: ['GET'], domain: 'lifecycle', category: 'public',     consumers: ['UI'], note: '同上（显式别名）' },

  // ── 守卫/设置域（guard.js）──
  { path: '/changelog',            methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(AboutCard)'], note: 'DSH 更新日志（text/plain）' },
  { path: '/guard/changelog',      methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(AboutCard)'], note: '管家更新日志（CHANGELOG.md）' },
  { path: '/guard/version',        methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(AboutCard)'], note: '本地版本（无网络 I/O）' },
  { path: '/guard/version/check',  methods: ['POST'], domain: 'guard', category: 'public',      consumers: ['UI(AboutCard, 源码形态)'], note: 'git 上游检查（源码部署形态更新通道）' },
  { path: '/ports',                methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(PortPanel)'], note: '端口视图（聚合三注册表）' },
  { path: '/env/dsh',              methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['README 文档化（外部脚本）'], note: 'DSH 本体安装/纳管判定（bin/binOk/managed/phase）' },
  { path: '/env/status',           methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(OverviewPage 环境卡)'], note: '环境 + 平台能力矩阵 + catalog' },
  { path: '/env/node-lts',         methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(OverviewPage)'], note: 'Node 当前 vs 官方最新 LTS' },
  { path: '/settings/access-key',  methods: ['GET', 'POST'], domain: 'guard', category: 'public', consumers: ['UI(AccessCard)'], note: '访问密钥' },
  { path: '/settings/lan',         methods: ['GET', 'POST'], domain: 'guard', category: 'public', consumers: ['UI(AccessCard)'], note: '面板局域网访问开关' },

  // ── 原生 DSH（native.js）──
  { path: '/native/status',       methods: ['GET'],  domain: 'native', category: 'public', consumers: ['UI(OverviewPage)', 'CLI(status)'], note: '安装状态 + 版本 + 升级状态机' },
  { path: '/native/check-update', methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)'], note: '触发版本检查' },
  { path: '/native/install',      methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)', 'CLI'], note: '异步安装（202）' },
  { path: '/native/uninstall',    methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)'], note: '异步卸载（202）' },
  { path: '/native/upgrade',      methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)', 'CLI(upgrade)'], note: '一键升级（失败回滚）' },
  { path: '/native/settings',     methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)'], note: 'main 元数据补丁（仅 guardian）' },

  // ── 插件（plugins.js）──
  { path: '/plugins/market',         methods: ['GET'], domain: 'plugins', category: 'public', consumers: ['UI(PluginsPage)'], note: '市场索引（TTL 缓存）' },
  { path: '/plugins/installed',      methods: ['GET'], domain: 'plugins', category: 'public', consumers: ['UI(PluginsPage)'], note: '已装第三方插件' },
  { path: '/plugins/check-updates',  methods: ['GET'], domain: 'plugins', category: 'public', consumers: ['UI(PluginsPage)'], note: '已装插件更新检测' },
  { path: '/plugins/install-status', methods: ['GET'], domain: 'plugins', category: 'public', consumers: ['UI(PluginsPage, job 轮询)'], note: '插件任务进度（A2 接线）' },

  // ── 智能路由（router.js）──
  { path: '/router/status',          methods: ['GET'],  domain: 'router', category: 'public',   consumers: ['UI(RouterPage)'], note: '中转状态 + 用量' },
  { path: '/router/providers',       methods: ['GET'],  domain: 'router', category: 'public',   consumers: ['UI(RouterPage)'], note: '供应商 + 账号 + 实例视图' },
  { path: '/router/ports',           methods: ['GET'],  domain: 'router', category: 'internal', consumers: ['守卫内部（router 自治段端口视图，域分离验证）'], note: 'router 自治段端口视图（daemon 模式物理分离）' },
  { path: '/router/domain-summary',  methods: ['GET'],  domain: 'router', category: 'internal', consumers: ['守卫监督拍自消费（写目录 domainSummary）'], note: '域摘要只读缓存' },
  { path: '/router/providers/account/confirm', methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '账号确认' },
  { path: '/router/providers/account/discard', methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '账号丢弃' },
  { path: '/router/providers/activate',   methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '激活供应商' },
  { path: '/router/providers/add',        methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '新增供应商' },
  { path: '/router/providers/deactivate', methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '停用供应商' },
  { path: '/router/providers/key/use',    methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '切换使用中的 Key' },
  { path: '/router/providers/keys/set',   methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '设置供应商 Key' },
  { path: '/router/providers/proxy/key',        methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '反代 Key 写入' },
  { path: '/router/providers/proxy/key/remove', methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '反代 Key 移除' },
  { path: '/router/providers/proxy/select',     methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '选择反代' },
  { path: '/router/providers/refresh',    methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '刷新供应商' },
  { path: '/router/providers/remove',     methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '删除供应商' },
  { path: '/router/proxy/login/start',    methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: 'Command Code 一键登录（发起）' },
  { path: '/router/proxy/login/wait',     methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '登录等待' },
  { path: '/router/proxy/update/apply',   methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '反代更新（job）' },
  { path: '/router/proxy/update/check',   methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '反代版本检测' },
  { path: '/router/proxy/update/status',  methods: ['GET'],  domain: 'router', category: 'public', consumers: ['UI(RouterPage, job 轮询)'], note: '反代更新进度（A3 接线）' },

  // ── 镜像源（dist.js）──
  { path: '/dist/registry',         methods: ['GET'],  domain: 'dist', category: 'public', consumers: ['UI(RegistryCard)'], note: '镜像源状态' },
  { path: '/dist/registry/refresh', methods: ['POST'], domain: 'dist', category: 'public', consumers: ['UI(RegistryCard)'], note: '镜像源测速刷新' },
  { path: '/dist/registry/set',     methods: ['POST'], domain: 'dist', category: 'public', consumers: ['UI(RegistryCard)'], note: '镜像源手动固定' },
  // 同源单源探活：页面带 CSP connect-src 'self'，浏览器直连镜像必被拦截 →
  // 「测试」按钮必须经本端点由服务端探测（并复用内核选源的同一探测规格）。
  { path: '/dist/registry/probe',   methods: ['POST'], domain: 'dist', category: 'public', consumers: ['UI(RegistryCard 测试按钮)'], note: '同源单源探活（服务端，不受页面 CSP 限制）' },

  // ── 任务（tasks.js）──
  { path: '/tasks', methods: ['GET'], domain: 'tasks', category: 'public', consumers: ['UI(TasksPage)'], note: '统一任务列表（+ /tasks/{id}）' },

];

/** 前缀路由（pathname.startsWith）。{prefix} 表示动态段。 */

const PREFIXES = [
  { prefix: '/dist/',        domain: 'dist',      category: 'public',      consumers: ['UI'], note: '/dist/registry/{refresh|set}' },
  { prefix: '/guard/',       domain: 'guard',     category: 'public',      consumers: ['UI'], note: '/guard/version|changelog 等' },
  { prefix: '/lifecycle',    domain: 'lifecycle', category: 'public',      consumers: ['UI', 'CLI'], note: '/lifecycle/{id}[/{action}]（唯一启停入口）' },
  { prefix: '/lifecycle/',   domain: 'lifecycle', category: 'public',      consumers: ['UI', 'CLI'], note: '同上（显式前缀）' },
  { prefix: '/logs',         domain: 'lifecycle', category: 'operational', consumers: ['诊断/审计'], note: '/logs/{tail|export}（events-tail 已删除：与 /events 语义重复）' },
  { prefix: '/native/',      domain: 'native',    category: 'public',      consumers: ['UI', 'CLI'], note: '/native/{status|install|uninstall|upgrade|...}' },
  { prefix: '/plugins/',     domain: 'plugins',   category: 'public',      consumers: ['UI'], note: '/plugins/{install|enable|disable|uninstall|update}' },
  { prefix: '/router/',      domain: 'router',    category: 'public',      consumers: ['UI'], note: '/router/... （ports/domain-summary 为 internal，见 SURFACE）' },
  { prefix: '/settings/',    domain: 'guard',     category: 'public',      consumers: ['UI'], note: '/settings/{lan|access-key}' },
  { prefix: '/tasks/',       domain: 'tasks',     category: 'public',      consumers: ['UI'], note: '/tasks/{id}' },
];

/** 汇总统计（供审计/文档生成）。 */
function summary() {
  const byCat = {};
  for (const c of CATEGORIES) byCat[c] = 0;
  for (const e of SURFACE) byCat[e.category] = (byCat[e.category] || 0) + 1;
  return { exact: SURFACE.length, prefixes: PREFIXES.length, byCategory: byCat };
}

module.exports = { SURFACE, PREFIXES, CATEGORIES, summary };
