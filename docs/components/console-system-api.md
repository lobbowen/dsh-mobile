# SYSTEM-API.md — console 卸载的系统级职责 → OS 原生接口清单

> 权威来源：[../plans/os-architecture-v4.md](../plans/os-architecture-v4.md) §12、[../plans/os-v4-execution-plan.md](../plans/os-v4-execution-plan.md) §3.3。
> 本文件是 **W2 console 与 W1 原生 OS 之间的接口契约**（债 A11/D9 的交付物）。
> 状态：v1（2026-09-28）。调用方 = `programs/console`；实现方 = `container/app/**`（Kotlin，包 `lobos.os.*`）。

## 0. 边界与传输

- console 是**普通 Program**（manifest `role=system`），**不是 init / 不是特权层**。
- console **没有** Android 语义；所有系统能力经 OS 原生能力 API 获取。
- 传输：Linux 抽象命名空间 Unix 域套接字 `lobos_hostbridge`（Node：`net.connect('\0lobos_hostbridge')`）。
  可用环境变量 `LOBOS_BRIDGE_SOCKET` 覆盖名称（OS 拉起 console 时注入）。
- 协议：JSON-RPC 2.0，换行分隔帧。连接后 Program 先发 `bridge.handshake{protocol,requires}`，
  OS 回 `{protocol,capabilities,groups}`；之后 `call(method,params)`。
  协议常量镜像：`programs/console/src/platform/host-bridge/protocol.js`
  ↔ `container/engine/src/bridge/protocol.js`（跨语言一致性测试钉死）。
- **降级不变量**：桥不可用/超时 → 调用返回 `null`，console 照常提供自身 API 并标注
  `osOnline=false / degraded=true`，**绝不伪造系统状态**。
- 每个调用都携带 Program 身份（握手 token）；`CapabilityBroker` 按授权表放行/拒绝/审计。

调用方统一入口：`programs/console/src/api/_os.js` 的 `call(send, panel, method, params)`；
面板门面：`programs/console/src/panel.js` 的 `panel.call(method, params)`。

### 0.1 WebView 原生桥（OS 提供，属本契约的能力面）

OS 承载控制面板时会在 WebView 里注入一个原生桥；**payload 只许使用这里声明的方法**，
不得依赖任何其它注入名或 Android 全局（公理 D：payload 不碰 Android API —— 桥是 OS 暴露的 API，不是 Android API）。

| 注入名 | 方法 | 方向 | 说明 |
|---|---|---|---|
| `window.LobosNative` | `onRequest(json)` | payload → OS | 面板更新请求（`lobos:panel-update-request`） |
| `window.lobosDeliverResult` | OS → payload 回调 | OS → payload | OS 回灌结果/进度（`lobos:panel-update-*`） |

判据（门禁）：`programs/console/ui/public/host-frame.js` 只允许引用上表两个名字。

## 1. 被移除的 console 模块 → 需要 OS 提供的接口

| 被移除的 JS（W2 已删） | 原职责 | OS 原生归属 | 新接口 |
|---|---|---|---|
| `src/console.js`（D9） | 总监督/状态机/退避/心跳 | OsHost + OsInit + InstanceManager | `os.state.get`、`os.instances.*` |
| `src/guard/lifecycle/objects.js` | 受管对象目录 | AppRegistry | `os.instances.list/get`、`os.registry.apps` |
| `src/guard/lifecycle/managed.js`、`src/guard/console/*` | 进程监督/健康/退避 | InstanceManager | `os.instances.action` |
| `src/guard/monitor/*`、`src/guard/proc/*` | 监控 / 回收 | InstanceManager | `os.instances.*`、`os.journal.*` |
| `src/guard/lifecycle/ports.js` | 端口分配/持久化 | PortBroker | `os.ports.claim/release/list` |
| `src/assembler/*`、`src/d2/*` | 运行时/原生件装配投放 | Runtime 供给（随 APK 投放） | `os.runtime.status` |
| `src/platform/runtime-contract.js` | 运行时契约写侧 | Runtime 供给 | `os.runtime.status` |
| `src/platform/tasks.js` | 任务注册/进度 | Journal | `os.journal.tasks/task` |
| `src/platform/host-bridge/client.js` | 能力调用 | CapabilityBroker（服务端） | 见 §2 全部方法 |
| `src/domains/dist/*` | 下载/校验/安装/镜像 | AppManager | `os.appmgr.*`、`os.registry.*` |
| `src/domains/plugin/plugins.js` | 插件安装/启停 | AppManager | `os.appmgr.pluginAction` |
| `src/domains/router/*` | 端口分配/网络代理监督 | PortBroker/NetProxy（上层 LAN 组件待定） | `os.ports.*`、`os.net.*`（预留） |
| `src/platform/token.js` | 会话令牌节点 | CapabilityBroker | `os.programs.webAccess` |
| `src/platform/env-status.js`、`env-catalog.js` | 环境/能力矩阵 | OsInit | `os.env.status/programs` |

## 2. 接口清单（方法名 + 语义 + 参数 + 结果 + 调用方）

> 命名空间 `os.*` 仅是本文件的逻辑命名；W1 可映射为 `lobos.os.state.get` 等。实现时
> 以 `bridge.handshake` 的 `groups` 声明可用组，console 端按组降级。

### 2.1 状态 / Journal（打断可见，非续跑）

| 方法 | 语义 | params | result | console 调用方 |
|---|---|---|---|---|
| `os.state.get` | 对外唯一状态：读 **`files/os/state.json` 那一份**（= 常驻通知 = 控制台首行，三处同源），面板侧**不现场重算结论**。相位集合 `BOOTING/RUNNING/DEGRADED/STOPPING`（`RECOVERING` 因零生产者已删，见债表 D11） | `{}` | `{ phase, label, since, uptimeMs, degraded, statusLine, facts: { readingsCollected, controlPlaneUp, channel, anchor }, programs: [...] }`（`degraded` 就是 `phase == DEGRADED`，不是第二把尺子） | `statusSummary()`（`programs/console/src/panel.js:120`）经 `GET /status`（`programs/console/src/api/lifecycle.js:17`）与 `bin/panel status` |
| `os.journal.read` | 增量事件（gseq 全局有序，跨 OS 重启连续） | `{ after, limit, internal }` | `{ seq, events: [{ seq, ts, type, source, data, internal }] }` | `GET /events` |
| `os.journal.logTail` | 各 stream 日志尾部 | `{ stream, n }`（stream: os/programs/error） | `{ stream, lines: [...] }` | `GET /logs/tail` |
| `os.journal.export` | journal JSONL 导出（审计） | `{ after, limit }` | `{ seq, exported, lines }` | `GET /logs/export` |
| `os.journal.metrics` | 事件流派生遥测（只读投影） | `{}` | `{ gseq, events, bySource, topTypes, sinceLastMs }` | `GET /metrics` |
| `os.journal.tasks` | 安装/升级/卸载任务列表 | `{ kind?, running? }` | `{ tasks, current }` | `GET /tasks`、`GET /tasks/{kind}/current` |
| `os.journal.task` | 单任务详情 | `{ id }` | `{ task }` | `GET /tasks/{id}` |
| `os.diagnostics.events` | 启动链**逐事件**机读面：读 `files/os/diag.jsonl` 已落盘的结论（含探针 `data`），不重跑探针 | `{ stage?, level?, limit? }`（stage 为**前缀**匹配，level ∈ `INFO/OK/FAIL`，limit=读取窗口 1..2000，默认 200） | `{ collected, total, matched, events: [{ at, stage, level, message, detail, data? }] }` | `GET /diagnostics/events` |
| `os.provisioning.get` | 开机体检快照 `files/provisioning.json` 原文（五项体检 + 三条版本流身份） | `{}` | `{ present, snapshot }`（探针未跑过 = `present:false` + `snapshot:null`） | `GET /diagnostics/provisioning` |

**取证这三条的分工**（别混成一条）：`os.journal.*` 是**事件流水**（面向时间线，镜像诊断时把
detail 截到 300 字且不带 `data`）；`os.nativeAssets.status` 只给三个核验 stage 的**最新一条**；
`os.diagnostics.events` 给**任意 stage 的原始事件**（含结构化 `data`）。发布包不再 debuggable 后
`adb shell run-as` 这条路就断了，这三条 + `/diagnostics/*` 是设备私有目录读数的**唯一常规通道**
（回环 HTTP，见 [../runbook/system-device-verification.md](../runbook/system-device-verification.md) §0）。

**语义边界（ADR-0006 / 债 A16）**：journal **只做「打断可见」**，**不提供 checkpoint / replay / 续跑**。
不得出现任何「恢复/续跑」接口。

### 2.2 实例生命周期（InstanceManager）

| 方法 | 语义 | params | result | 调用方 |
|---|---|---|---|---|
| `os.instances.list` | 全部实例生命周期一览 | `{}` | `{ modules: [{ id, kind, name, desired, phase }] }` | `GET /lifecycle` |
| `os.instances.get` | 单实例快照 | `{ id }` | `{ id, kind, name, desired, phase, pid?, port? }` | `GET /lifecycle/{id}` |
| `os.instances.action` | 启/停/重启（唯一入口） | `{ id, action: start\|stop\|restart }` | `{ ok, desired, phase }` | `POST /lifecycle/{id}/{action}` |
| `os.session.get` | 会话态（容器退出握手读口） | `{}` | `{ sessionState }` | `GET /session/status` |
| `os.session.stop` | 停全部被管对象并回执（OS 不停自己由容器决定） | `{}` | `{ ok }` | `POST /session/stop` |

### 2.3 Program 目录 / 安装管理（AppRegistry + AppManager）

| 方法 | 语义 | params | result | 调用方 |
|---|---|---|---|---|
| `os.programs.overview` | 已装 Program 概览 + 版本 + 升级状态机 | `{}` | `{ installed, programs, versionInfo, upgrade }` | `GET /native/status` |
| `os.programs.list` | Program 目录（可按 role 过滤） | `{ role? }` | `{ programs: [{ id, name, version, role, phase }] }` | `GET /plugins/installed` |
| `os.programs.settings` | Program 元数据补丁（含 guardian 等开关） | `{...}` | `{ ok }` | `POST /native/settings` |
| `os.appmgr.install` | 下载/校验/落位/注册一个 Program（异步任务） | `{ id?, spec?, version? }` | `{ ok, accepted, taskId }` | `POST /native/install` |
| `os.appmgr.upgrade` | 升级 Program（失败回滚，单写入者） | `{ id?, version? }` | `{ ok, accepted, taskId }` | `POST /native/upgrade` |
| `os.appmgr.uninstall` | 卸载 Program（清理落位/版本指针） | `{ id? }` | `{ ok, accepted, taskId }` | `POST /native/uninstall` |
| `os.appmgr.checkUpdate` | 检测可升级版本 | `{}` | `{ updateAvailable, latest, checkedAt }` | `POST /native/check-update` |
| `os.registry.info` | 镜像源状态 | `{}` | `{ programs }` | `/dist/registry` |
| `os.registry.set` | 固定某源 | 见路由 | `{ ok }` | `/dist/registry/set` |
| `os.registry.refresh` | 重新测速/刷新 | 见路由 | `{ ok }` | `/dist/registry/refresh` |
| `os.registry.probe` | 单源探活 | 见路由 | `{ ok, latencyMs }` | `/dist/registry/probe` |

### 2.3.1 v4 不提供（已移出 OS 面）

| 方法 | 去向 |
|---|---|
| `os.programs.webAccess` | 面板由 OS 的 `ConsoleActivity` 直接承载，OS 不签发 Web 令牌 |
| `os.appmgr.pluginAction` / `checkPluginUpdates` / `jobStatus` | 组件/扩展是 **Program 自己**的 npm 依赖，执行体归 Program |
| `os.runtime.provision` | 运行时随 APK 投放（`assets/node`），没有"OS 现场装运行时"这条路径 |

### 2.4 端口（PortBroker）

| 方法 | 语义 | params | result | 调用方 |
|---|---|---|---|---|
| `os.ports.list` | 端口记录（固定/用户/已分配，含 owner） | `{}` | `{ fixed, user, allocated, capacity }` | `GET /ports` |
| `os.ports.claim` | 确定性分配并持久化绑定（唯一权威） | `{ segment, owner, preferred? }` | `{ port, mode }` | 上层 LAN 组件（W1 落地后） |
| `os.ports.release` | 按 owner 释放 | `{ port, owner? }` | `{ ok }` | 同上 |

**不变量**：端口分配**只**在 OS PortBroker。console 不再持有 `ports.json`，也不再做存活探测/回收。

### 2.5 运行时供给（Runtime）

| 方法 | 语义 | params | result | 调用方 |
|---|---|---|---|---|
| `os.runtime.status` | 当前运行时（node 等）版本/路径/健康 | `{}` | `{ name, version, path, ok }` | `GET /env/status` |
| `os.runtime.provision` | 取回/校验/落位运行时（受控字节） | `{ name, range }` | `{ ok, version, path }` | OS 内部 / 面板触发（可选） |
| `os.runtime.nodeLts` | 当前 vs 官方最新 LTS | `{}` | `{ current, latest, updateAvailable }` | `GET /env/node-lts` |
| `os.env.status` | 平台能力矩阵 + 环境 | `{}` | `{ platform, apiLevel, capabilities, catalog }` | `GET /env/status` |
| `os.env.programs` | Program 环境条目 | `{}` | `{ programs }` | `GET /env/programs` |
| `os.nativeAssets.status` | 上一轮原生件/能力件核验的**落盘结论**（读 `files/os/diag.jsonl`，不重跑探针） | `{}` | `{ collected, rounds: [{ stage, at, level, message, report? }] }` | `GET /native/capabilities` |

`os.nativeAssets.status` 与桥方法 `sys.nativeAssets` 是两个问题，不许合用一个读法：后者「现在就验一次」
（会真 spawn exec-probe），前者「启动链最近那一轮验出了什么」。没有落盘记录时 `collected=false` 且不编造
结论 —— 判据与落盘时点见 [../runbook/system-device-verification.md](../runbook/system-device-verification.md) §9。

### 2.6 Android 能力（CapabilityBroker）

| 方法 | 语义 | params | result | 调用方 |
|---|---|---|---|---|
| `shell.status` | ADB 无线调试状态（只读透传） | `{}` | `{ paired, keys, port }` | `GET /adb/status` |
| `notify.post` | 投递通知（能力，非模块） | `{ title, body }` | `{ posted }` | 面板小组件（预留） |
| `app.openUrl` | 经 OS 打开 URL/Program UI | `{ url }` | `{ opened }` | 面板小组件（预留） |
| `capability.invoke` | 通用能力调用（按 Program 授权） | `{ name, params }` | `{}` | 预留 |

## 3. 可停可换（硬判据）

console 停止/卸载后，OS 必须仍满足：

1. `dumpsys activity processes` 本 UID 进程数不变（OS 宿主仍在）；
2. 已装 Program 实例继续运行（`os.instances.list` 由 OS 自身可读）；
3. OS 仍可被管理（原生最小管理面：state/journal/appmgr 不依赖 console）；
4. 常驻通知 / 前台服务不因 console 退出而消失。

console 侧这三格今天的实际状态（2026-10-01 面板回到 .47 世代后逐条核过）：
- `manifest.json` `role=system`、`entry=bin/panel`，且 `package.json` `bin.panel` —— 成立；
- 桥不可用时 `call()` 返回 null 且**不抛**、`handshake()` 返回 null —— 由 `programs/console/test/host-bridge-test.js` 的 H-3 判；
- 「源码不存在锁文件/daemon 自拉起/子进程监督」整条判据原先住 `programs/console/test/console-not-init-test.js`，
  该文件属 .48 世代、随面板回归移除；替换判据（从「不许出现某个词」改判「不得自持常驻权威」＋双向夹具）
  尚未落地，欠账在册债表 **ENV-21**；
- 面板 API 在桥不可用时**不返回显式 `OS_OFFLINE`**（.47 代码里没有这个词，逐 src 核过），它只按上面那条降级成
  null。要把「不声称 OS 在线」做成可见语义，是 W1 侧要补的一格，不是 console 已完成的事实。

## 4. W1 落地顺序建议（解除阻塞）

1. `lobos.os.state.get` + `lobos.os.journal.read`（面板 /status、/events 立即可用）；
2. `lobos.os.instances.list/get/action`（生命周期页可用）；
3. `lobos.os.programs.*` + `lobos.os.appmgr.*`（Program 管理与市场动作可用）；
4. `lobos.os.ports.*`（PortBroker 权威，替换 console 旧 `ports.json`）；
5. `lobos.os.runtime.*` + `lobos.os.env.*`（环境页）；`shell.status` 透传保持。
