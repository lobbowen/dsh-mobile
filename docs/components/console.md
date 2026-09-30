# console —— 控制面板 Program（`programs/console`）

`console` 是 Lob OS 上**默认的控制面板 Program**：状态监控 / 安装管理编排 / 小组件。
它是 `role=system` 的 Program，**不是系统层，也不是 init** —— **可停可换**，
系统职责（生命周期 / 进程 / 端口 / 存储 / 安装校验 / 能力裁决）全部归 OS 原生（Kotlin）。

> **本目录 = 单仓 `lobbowen/lobos` 内的 Program 源码**。历史上它叫「内核」（`dsh-android-kernel`、`kernel/`），
> 从 PC 端 `dsh-console-core` 剥离而来；v4 定性为 Program 并改名 `console`。
> 清理政策：**不做「忽略 / 占位 / 降级 / 兼容保留」** —— 已移出的系统职责真删，不留空壳实现。

---

## 1. 分层定位

```
┌─ OS 原生（Kotlin，冻结随 APK）────────────────────────────┐
│  OsHost（唯一 FGS/进程）· OsInit · StateMachine · Journal   │
│  AppRegistry / AppManager · PortBroker · CapabilityBroker   │
│  ConsoleHost（承载控制台）· cenv（Runtime 供给）             │
└──────────────────────────────────────────────────────────┘
                    ▲ OS 能力 API（桥）
┌─ Program（本目录 console；dsh / pi 同级）──────────────────┐
│  api/（控制面 HTTP）· ui/（面板）· domains/（市场/编排）     │
│  platform/（host-bridge 客户端 + 平台抽象）                  │
└──────────────────────────────────────────────────────────┘
```

一句话：**console = 看状态、发起安装/管理、承载小组件；OS = 提供运行时、能力桥、保活与 OTA。**

- console **不做**：原生打包、APK 构建、进程监督、端口分配、存储落位、安装校验、能力裁决、自更新。
- console 的入口是 `bin/panel`（不再是 `os-init`）；manifest 见 [manifest.json](../../programs/console/manifest.json)。
- console 更新走 **Program OTA**（签名包热更新；见 [ADR-0005](../adr/0005-program-via-ota-only.md)）。

---

## 2. 保留域（本 Program 内）

| 域 | 路径 | 职责 |
|---|---|---|
| **api** | `src/api/` | 控制面 HTTP 契约（`surface.js` 为单一事实源） |
| **domains** | `src/domains/` | 插件市场索引 / 展示（安装动作调 OS 原生能力） |
| **platform** | `src/platform/` | 平台抽象 + HostBridge 客户端（`host-bridge/`） |
| **ui** | `ui/` | React 面板（容器 WebView / 手机浏览器同源加载） |
| **bin** | `bin/panel` | 入口（被 node 解释的脚本） |

> 曾经住在「内核」里的系统级域（`guard/` 生命周期、`assembler/` 装配、`d2/` 平台件、`supply/` 供给、
> `adapters/` 适配器）已按 §3 整体删除并下沉 OS 原生；相关 move 记录见
> [layout.json](../contracts/layout.json) 的 `retiredMoves`。

---

## 3. 已下沉 OS 原生 / 已删除的域（勿回潮）

| 旧域 / 机制 | 删除内容 | OS 原生归属 |
|---|---|---|
| **进程监督**（`guard/console/*`、`guard/lifecycle/managed.js`） | 整段删除 | `OsHost` + InstanceHost |
| **端口**（`guard/lifecycle/ports.js`） | 删除 | `PortBroker` |
| **进程/健康监控**（`guard/monitor/*`、`guard/proc/*`） | 删除 | `OsHost` 探针 + Journal |
| **装配器**（`assembler/*`） | 删除 | `cenv`（Runtime 供给）/ `AppManager` |
| **平台件库**（`d2/*`） | 删除 | OS 原生件清单 |
| **环境目录/供给**（`platform/env-catalog.js`、`supply/*`） | 删除 | OS 原生 `os.env.*` |
| **适配器/默认值**（`adapters/dsh/*`、`platform/agent-defaults.json`） | 迁至载荷目录 | `programs/dsh/manifest.json` |
| **PC 桌面域**（instance / relay / shell / 服务管理 / 开机自启 / 桌面会话 / 自更新） | 真删 | 无对应物（OS 承担） |
| **console.js**（守卫主体） | 整体删除 | `OsHost`/`OsInit` |

> ⚠ 上述每一项在测试里都有**反向门禁**锁死（见 §7）：复活即测试失败。

---

## 4. HostBridge（Program → OS 能力桥）

Program 侧客户端：`src/platform/host-bridge/`（`client.js` + `protocol.js`）。
在 OS 内运行时，**需要设备能力的功能经此桥交给原生层执行**：

- **传输**：Linux **抽象命名空间** Unix 域套接字，路径 `'\0' + socketName`（默认 `lobos_hostbridge`，
  可由 OS 注入的 `LOBOS_BRIDGE_SOCKET` 覆盖）。**不走 TCP**（控制面不经网络暴露）。
- **协议**：JSON-RPC 2.0，换行分隔 JSON 帧；连接后先 `bridge.handshake{protocol,requires}` 协商能力分组。
- **降级不变量**：桥不可用 → 所有调用**快速失败且不抛**，Program 照常运行。
- **两层门禁**：组级（握手时按代表能力协商 `bridge:*` 分组）+ 方法级（每次调用按 `caps` 精确拦截，
  越权返回 `-32001 ERR_CAPABILITY_MISSING`；未知方法 `-32601`）。

> 协议须与 OS 侧逐字段一致，任一侧语义变更同步递增 `PROTOCOL_VERSION`。

---

## 5. 运行

console 由 OS 拉起，不在本机手动安装系统服务。

```bash
# 入口（由 OS 以 node 解释执行）
node programs/console/bin/panel serve
```

命令面与状态根由 `src/platform/config.js` + `bin/panel` 定义；状态根默认来自 OS 注入的环境变量
（`LOBOS_*` 命名空间），不再有 `dsh-console` 式的自安装/自启命令。

---

## 6. 控制面 API（默认 `127.0.0.1:36360`）

> **权威清单 = `src/api/surface.js`**（机器可校验的单一事实源：每个路由的分类 / 方法 / 消费者 / 用途），
> 由测试强制「源码 ↔ 清单」双向一致：**新增路由不登记即测试失败**。

覆盖：生命周期 `/status` `/events` `/healthz`；会话 `/session/*`；Runtime `/native/*`；
面板/环境/设置 `/env/*` `/settings/*` `/ports`；插件/路由/镜像源/任务 `/plugins/*` `/router/*` `/dist/*` `/tasks`；
运维观测 `/metrics` `/logs/*`。完整清单以 `surface.js` 为准。

**安全模型（无鉴权设计）**：默认只绑回环；「局域网访问」开启后仅放行 RFC1918 私有网段 Host/Origin；
零 CORS（面板由同源托管）。出回环访问可选访问密钥。

---

## 7. 测试与门禁

```bash
npm test   # 见 package.json 的测试链
```

| 门禁 | 作用 |
|---|---|
| `test/_preload.js` | 测试运行器/夹具（不单独入链） |
| `test/api-surface-test.js` | 契约面双向一致 + **已删端点不得复活** |
| `test/host-bridge-test.js` | 桥传输（`lobos_hostbridge` UDS）与降级不变量（H-3：桥不可用时不抛、不伪造） |
| `test/program-update-single-writer-test.js` | 面板「零自更新面」：单写入者是容器 OTA |
| `test/sigterm-desired-test.js` | 守卫被停时不改期望状态（面板可停可换的那一侧） |
| `test/test-port-discipline-test.js` | 测试端口纪律（不自持端口权威） |

「console 不是 init」这条硬不变量原先由 `test/console-not-init-test.js` 判，该文件属 .48 世代、随 2026-10-01 的
.47 面板回归移除；它的替换判据（改判「不得自持常驻权威」＋双向夹具）尚未落地，在册债表 ENV-21。
其余链上判据见 [console-tests.md](console-tests.md)。

**接口契约（console 卸载的系统级职责 → OS 原生）**：见 [console-system-api.md](console-system-api.md)（W2↔W1 的 `os.*` 方法清单）。

---

## 8. 面板（UI）

`ui/` 为 React + Vite 面板源码，构建产物由**同源托管**（容器 WebView / 手机浏览器直接打开
`http://127.0.0.1:<apiPort>/`）。详见 [console-ui.md](console-ui.md)。

---

## 9. 边界与非目标

- 单一 OS 单实例；console 只是其中一个可替换 Program。
- 不提供公网暴露（远程访问归 OS 层）。
- 生命周期、端口、安装校验、能力裁决**一律不经 console**。
- **停用 console：OS 仍启动、已装 Program 仍运行、仍可被管理**（ADR-0010 硬判据）。
