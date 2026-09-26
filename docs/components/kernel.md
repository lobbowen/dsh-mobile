# dsh-android-kernel

**DeepSeek Harness 移动端（Android）内核**：运行于「冻结 APK 容器」Node 运行时之上的
**控制面板 / 生命周期管理器（Manager）**。它经公共 npm 拉取并管理 Codex / Claude Code /
DeepSeek Harness 等 Agent 产品，对外提供 HTTP 控制面与同源托管的 Web 面板。

> **本目录 = 单仓 `lobbowen/dsh-mobile` 内的 L1 内核源码**（由 PC 端 `dsh-supervisor-core` 剥离而来；
> 2026-09-22 起两仓合并为单仓，容器层在同仓根部）。
> 清理政策：**不做「忽略 / 占位 / 降级 / 兼容保留」** —— PC 专属机制一律**真删**（删文件、
> 删路由、删类型、删字段、删断言），不留 410 下架桩与「返回 unsupported」的空壳实现。
>
> 架构与迁移全貌见 **[kernel-android-plan.md](kernel-android-plan.md)**（内核侧唯一架构文档）。

---

## 1. 分层定位

```
┌─ L0 容器层（冻结 APK）───────────────────────────────────┐
│  Node 运行时 · HostBridge(JS↔Kotlin) · OTA 引擎            │
│  负责：拉起/保活内核 · 通知 · 存储 · 自启 · 设备策略        │
└──────────────────────────────────────────────────────────┘
                        ▲ HostBridge / UDS（内核客户端已落，见 §platform/host-bridge）
┌─ L1 内核层（本仓 dsh-android-kernel）─────────────────────┐
│  guard（生命周期/健康/监控）· api（控制面）· ui（面板）      │
│  native（Agent 运行时管理）· dist（npm 分发）· plugin（扩展）│
│  router（模型网关）· platform（平台抽象）                   │
└──────────────────────────────────────────────────────────┘
                        ▲ 公共 npm
┌─ L2 Agent 产品 ──────────────────────────────────────────┐
│  Codex · Claude Code · DeepSeek Harness · …               │
└──────────────────────────────────────────────────────────┘
```

一句话：**内核 = 装、跑、管、观察 Agent；容器 = 提供运行时、能力桥、保活与 OTA。**

- 内核**不**负责：原生打包、APK 构建、应用市场分发、开机自启、系统通知、内核自更新。
- npm 的 `integrity` 即校验：Agent 产品的完整性**不需要内核自造签名机制**。

---

## 2. 保留域

| 域 | 路径 | 职责 |
|---|---|---|
| **native** | `src/guard/native/` | Agent 运行时（DSH 等）安装 / 升级 / 卸载 / 探活 |
| **dist** | `src/domains/dist/` | npm 分发、镜像源测速与固定 |
| **plugin** | `src/domains/plugin/` | 第三方插件市场 / 安装 / 启用 |
| **router** | `src/domains/router/` | 模型网关（多供应商 Key 轮换代理） |
| **guard** | `src/guard/` | 生命周期管理、健康监督、注册表、端口、任务 |
| **api** | `src/api/` | 控制面 HTTP 契约（`surface.js` 为单一事实源） |
| **ui** | `ui/` | React 面板（**待适配**移动端容器 WebView） |
| **platform** | `src/platform/` | 平台抽象（Android-only） |

---

## 3. 已删除的 PC 域（勿回潮）

| PC 域 / 机制 | 删除内容 | Android 归属 |
|---|---|---|
| **instance**（沙箱实例） | `src/domains/instance/`、`src/api/instances.js`、`/instances*` | 无；`multiInstance:false`，由容器 / Android Service 承载 |
| **relay**（远程控制 / frpc） | `src/domains/relay/`、`/lan-access`、`/lan/frp*` | 无；`frpExpose:false`，远程访问归容器层 |
| **shell**（桌面 Tauri 壳） | `src/domains/shell/`、`/shell/*`、`isEmbeddedShellOrigin`、tauri CORS 白名单 | APK 容器 / Android Service 即「壳」 |
| **服务管理** | `platform/os/service.js`（systemd / launchd / schtasks） | 无对应物 |
| **开机自启** | `platform/os/autostart.js`、`/autostart`、`guard/host-service.js` | 容器 + Android Service |
| **桌面会话** | `platform/os/desktop.js`、`/settings/close-action`（关窗隐藏到托盘） | 面板由容器 WebView 加载 |
| **内核自更新** | `/self-update/*`（含 410 下架桩）、`guardSelfUpdate*`、`platform/deploy.js` | 容器 OTA（单写入者） |
| **PC 构建 / 部署物** | `desktop/`、systemd unit、`release/`（SEA 打包）、`archive/`、`shared/version-vectors.json` | **无等价物（已真删）** |

> ⚠ 上述每一项在测试里都有**反向门禁**锁死（见 §8）：复活即测试失败。
>
> **口径收口（「容器仓」定义）**：「容器仓」= **L0 冻结 APK 容器仓**，其职责是
> APK 构建、OTA 引擎、OTA 签名与公钥焊接、HostBridge、系统通知、存储、自启、设备策略——
> **不含** `desktop/`、`systemd unit`、`release/`（SEA 打包）、`archive/`、`shared/version-vectors.json`
> 这些 PC 时代构建/部署物（本次**整仓真删、无处持有**；容器直接出 APK，无 SEA 打包 / launcher / 归档）。
> 注意区分：内核仓**没有** `release/` 目录（PC SEA 打包物已真删）；而 CI 的 `kernel-ota.yml` 在构建时会创建一个**临时** `release/` 输出目录，存放签好名的 OTA 包（`kernel-<v>.zip` + `kernel-manifest.json`），二者无关。

---

## 4. 平台抽象（Android-only）

`src/platform/os/*` 是**唯一平台 API 入口**。域层不得直接触碰
`systemctl` / `launchctl` / `schtasks` / `notify-send` / `osascript` / `xdg-open`。

安卓判定唯一真源 `src/platform/android.js` → `isAndroid()`：

```js
process.env.DSH_ANDROID === '1'      // 容器启动内核时注入（推荐）
process.env.DSH_PLATFORM === 'android'
process.env.ANDROID_ROOT !== undefined
```

> 为什么必须显式判定：安卓上 Node 的 `process.platform === 'linux'`、`arch === 'arm64'`，
> **无法仅靠平台分支与桌面 Linux 区分**。

能力矩阵（`DSH_ANDROID=1 node -e "require('./src/platform/os').capabilities()"`）：

```json
{"platform":"android","arch":"arm64","multiInstance":false,"pidAdoption":true,
 "processTreeKill":false,"desktopNotify":false,"autostart":false,
 "frpExpose":false,"hostService":"none"}
```

---

## 4.1 HostBridge（内核 → 容器能力桥）

内核侧客户端：`src/platform/host-bridge/`（`client.js` + `protocol.js`）。
内核在容器内（`DSH_ANDROID=1`）时，**需要设备能力的功能经此桥交给容器层执行**：

- **传输**：Linux **抽象命名空间** Unix 域套接字，路径 `'\0' + socketName`（默认 `dsh_hostbridge`，
  可由容器注入的 `DSH_BRIDGE_SOCKET` 覆盖）。**不走 TCP**（控制面不经网络暴露）。
- **协议**：JSON-RPC 2.0，换行分隔 JSON 帧；连接后先 `bridge.handshake{protocol,requires}` 协商能力分组。
- **已接线**：`platform/os/notify.js` → `notif.post`（容器 `NotificationManager`）；
  `platform/os/browser.js` → `app.openUrl`（容器 `ACTION_VIEW` Intent）。
- **降级不变量**：桥不可用（不在容器内 / socket 未就绪 / 超时）→ 所有调用**快速失败且不抛**，
  内核照常运行（`notify` 返回 `false` 且不触发 `onError`；`browser.open` 返回 `false`）。
- **两层门禁**：组级（握手时按代表能力协商 `bridge:*` 分组）+ 方法级（每次调用按 `caps` 精确拦截，
  越权返回 `-32001 ERR_CAPABILITY_MISSING`；未知方法 `-32601`）。

> 门禁：`test/host-bridge-test.js`（H-1…H-6，含真实 UDS 端到端、超时、降级）。
> 协议须与容器仓两侧逐字段一致，任一侧语义变更同步递增 `PROTOCOL_VERSION`。

---

## 5. 运行

内核由容器拉起，不在本机手动安装系统服务。

```bash
# 1. 准备内核本体配置（只写 config，不建服务/自启/软链）
dsh-supervisor install

# 2. 容器 / Android Service 拉起守护进程
dsh-supervisor daemon

# 3. 查看状态
dsh-supervisor status
```

可用命令：`daemon | status | start | stop | restart | install | self-check | events | logs | version | upgrade`
（`uninstall` / `gui-autostart` / `self-update` 已删，归容器）。

> 前置：Node ≥ 18；状态根由 `DSH_SUPERVISOR_HOME` 或 `$XDG_STATE_HOME` 决定（见 §7）。

---

## 6. 控制面 API（默认 `127.0.0.1:36360`）

> **权威清单 = `src/api/surface.js`**（机器可校验的单一事实源：每个路由的分类 / 方法 / 消费者 / 用途），
> 由 `test/api-surface-test.js` 强制「源码 ↔ 清单」双向一致：**新增路由不登记即测试失败**。

```
# 生命周期
GET  /status                    状态摘要（desired / phase / main / sessionState）
GET  /events?after=&limit=      增量事件（seq 跨守卫重启连续）
GET  /healthz /readyz           存活 / 就绪探针
GET  /lifecycle[/status]        模块生命周期一览
POST /lifecycle/{id}/{start|stop|restart}   唯一启停入口（模块 id：dsh | router | plugins）
# 会话（容器退出握手）
GET  /session/status            会话态
POST /session/stop              停全部被管对象 + 回执（守卫不自停，由容器停止进程）
# Agent 运行时（native）
GET  /native/status             安装状态 + 版本 + 升级状态机（含任务进度）
POST /native/check-update | install | uninstall | upgrade
POST /native/settings           main 元数据补丁（仅 guardian）
# 面板 / 环境 / 设置
GET  /changelog | /guard/changelog | /guard/version   DSH / 内核更新日志与版本
GET  /env/status | /env/dsh | /env/node-lts           环境 + 能力矩阵 + Node LTS
GET/POST /settings/lan | /settings/access-key         局域网访问 / 访问密钥
GET  /ports                     端口视图（聚合注册表）
# 插件 / 智能路由 / 镜像源 / 任务
GET  /plugins/market | installed | check-updates | install-status
POST /plugins/{install|enable|disable|uninstall|update}
GET  /router/status | /router/providers
POST /router/providers/*  ·  /router/proxy/{login,update}/*
GET/POST /dist/registry[/refresh|/set|/probe]
GET  /tasks[/{id}]              统一任务列表
# 运维 / 可观测（一方 UI 不调用）
GET  /metrics | /logs/tail | /logs/export
```

**安全模型（无鉴权设计）**：默认只绑回环；「局域网访问」开启后仅放行 RFC1918 私有网段 Host/Origin。
三层防护：Host 必须指向本机；**零 CORS**（面板由内核同源托管，不给任何 Origin 发 `Access-Control-Allow-*`）；
带 `Origin` 的写请求必须来自本机面板来源。出回环访问可选 `apiAccessKey`（Bearer / `?access_key=`）。

---

## 7. 配置与状态根

配置：`<状态根>/supervisor/config.json`（`dsh-supervisor install` 生成，mode 0600），
可用 `DSH_SUPERVISOR_CONFIG` 或 `-c <file>` 覆盖。

状态根（`src/platform/state-root.js`，与 DSH 的 `~/.dsh` **完全独立**）：

```
$DSH_SUPERVISOR_HOME  →  $XDG_STATE_HOME/dsh-supervisor  →  ~/.local/state/dsh-supervisor
                         └─ supervisor/{config.json, state.json, ports.json, dsh-main.json,
                                        events/guard.events.log, log/{guard,dsh,upgrade}.log}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `command` | `["node","dsh","web"]` | 被监管命令（数组） |
| `healthUrl` | `http://127.0.0.1:3080/` | HTTP 探活地址 |
| `probeIntervalMs` | 5000 | 探测周期 |
| `probeTimeoutMs` / `failThreshold` | 3000 / 2 | L2 单次探测超时 / 连续失败判故障 |
| `httpProbeEnabled` | true | 关闭后退化为「端口在线即健康」 |
| `startTimeoutMs` / `stopGraceMs` / `portReleaseWaitMs` | 30000 / 10000 / 10000 | 启动门 / SIGTERM 宽限 / 等端口释放 |
| `crashWindowMs` / `crashBurst` | 600000 / 5 | 崩溃窗口与阈值 |
| `backoff` | 30s→10m | 指数退避序列 |
| `apiHost` / `apiPort` | 127.0.0.1 / 36360 | 本地控制面（被占自动顺延并持久化） |
| `routerCtlPort` | 43107 | router 独立进程 ctl 通道 |
| `eventsMaxBytes` / `logMaxBytes` | 5 MiB | 日志轮转阈值（保留一代 `.1`） |
| `packageName` | `@deepseek-ai/dsh` | 被监管的 npm 包 |
| `registries` | npmjs → npmmirror | 最小兜底镜像源 |
| `updateCheckEnabled` / `updateCheckIntervalMs` | true / 3600000 | 版本检查（只检查不自动升级） |
| `upgradeTimeoutMs` | 600000 | npm 安装超时 |
| `apiAccessKey` | null | 出回环访问密钥（不配 = 仅 RFC1918 白名单） |

---

## 8. 单写入者契约：内核更新归容器 OTA

- 内核**不自更新、不自重启**：既无写端点（`/self-update/apply`、`/self-update/restart-guard`），
  也**无只读端点**（`/self-update/status` 已删 —— 内核不经 npm 分发，没有"自己的新版本"可查）。
- **唯一写入者 = 安卓容器 OTA**：签名包热更新，公钥焊进 APK（容器仓职责）。
- 面板侧经消息桥（`ui/src/services/supervisor/kernelUpdateBridge.ts`，协议 v1）
  请容器代执行；内核侧**不提供任何可被驱动的更新路径**。
- **宿主帧 `GET /__host`**（`ui/public/host.html` + `host-frame.js`，由内核**同源托管**）：
  容器 WebView 加载此页，页内以 iframe 嵌面板（`src="/"`，同源）。
  宿主帧只**转发** `dsh:kernel-update-request` 到容器原生层、回灌 `dsh:kernel-update-result`，
  自身不含任何写更新语义。**为什么要同源**：内核 `originAllowed` 闸② 要求驱动页面的
  Origin = `<本机/局域网>:<apiPort>` —— 容器 `assets/` 的 `file://` 宿主页 Origin 为 null，
  会导致**面板写操作一律 403**；同源托管即消除该跨源问题（面板仍在 iframe 内 → `hasHostBridge()` 为真）。

> ⚠ 本仓是全新仓库，**不保留 410 下架桩**。"已下架但仍在"的端点会让人误以为内核还能被
> 某个客户端驱动更新 —— 那正是双写入者错觉的来源。

---

## 9. 测试与门禁

```bash
npm test                                   # 64 个测试文件入链
npm run test:native-uninstall              # 真实卸载场景（不进主链）
npm run test:plugin-change-restart         # 含插件卸载场景（不进主链）
```

| 门禁 | 作用 |
|---|---|
| `test/test-safety-gate-test.js` | 测试沙箱前置校验（先跑） |
| `test/api-surface-test.js` | 契约面双向一致 + **已删 PC 端点不得复活** + 清单无 deprecated 桩 |
| `test/kernel-update-single-writer-test.js` | 内核「零自更新面」（KU-1…KU-8，含反向自检） |
| `test/test-chain-completeness-test.js` | 每个测试文件要么在链中、要么写明排除理由（防门禁静默不跑） |
| `test/test-port-discipline-test.js` | 测试端口纪律（避开 OS 动态端口与生产池） |
| `test/runtime-contract-test.js` | 运行期契约（内核 ↔ 容器握手） |

**卸载类测试政策**：`native-test.js`、`plugin-change-restart-test.js` 禁止进入自动链，
只允许按需单独调用。验证卸载逻辑时必须经**构造期依赖注入**（`new NativeManager({ npmBin: <假可执行> })`），
**绝不** patch 模块导出替换 npm —— 那对 `const { npmBin } = require(...)` 这类值绑定无效，
会让测试真的执行 `npm uninstall -g`。参考 `test/uninstall-timeout-behavior-test.js`。

---

## 10. 面板（UI）

`ui/` 为 React + Vite 面板源码，构建产物由**内核同源托管**（容器 WebView / 手机浏览器直接打开
`http://127.0.0.1:<apiPort>/`）。五个页面：概览、插件、智能路由、任务、设置。

- 已随 PC 三域删除：实例管理页、局域网/FRP 远程控制页、开机自启卡片、Tauri 桌面壳双版本线。
- **待办（P6）**：移动端容器 WebView 适配（见 `kernel-android-plan.md` §8 路线图）。

---

## 11. 路线图

UDS 控制面 → HostBridge（JS↔Kotlin）→ Android Service 接入 → 能力桥落地 →
UI 移动端适配。详见 [kernel-android-plan.md](kernel-android-plan.md) §6–§8。

---

## 12. 边界与非目标

- 单容器单内核、单主干进程（无多实例）。
- 不提供公网暴露（远程访问归容器层，内核 `frpExpose:false`）。
- Agent 无优雅关停保证：升级采用「先停后装」，中断窗口集中在安装期。
- 内核不做：原生打包 / APK 构建 / 应用市场分发 / 开机自启 / 系统通知 / 自更新。
