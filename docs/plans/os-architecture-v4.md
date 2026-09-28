# Lob OS：Android 上的 Agent OS 容器形态架构 v4

> 取代 `apk-form-v2.md`（方向错误）并继承 `apk-form-v3-single-lifecycle.md` 的**边界公理**。
> v4 回答两件事：**这套 OS 里装的 App 是什么、怎么装、怎么管**；以及**"内核"在这套 OS 里的真实位置**。

- 状态：提案（2026-09-28）
- 关联：ADR-0001 · ADR-0003 · ADR-0004（**三版本流**）· ADR-0005（**Runtime/OS OTA**）· ADR-0006（**重写**）· ADR-0008（**升为形态主轴**）

---

## 0. 产品定义

**产品名：Lob OS。** 我们不是"一个装了 DSH 的 App"，而是**在 Android 之上造的一套让 agent 生存的运行时环境（容器 / OS）**。

- DSH 只是**一个默认载荷**，和 pi / codex 同级；
- 用户通过**控制面板**安装任意"符合运行时生态"的产品；
- 只要运行时适配器支持，就装得上、跑得起来；
- Android 面向的**只有这套 OS**；OS 内部装了什么、跑了几个、怎么跑，Android 无权知道也不该管。

---

## 1. 边界公理

- **A 唯一生命周期**：Android 只看到一个进程、一个前台服务、一条通知、一个控制台承载面。
- **B 内部自治**：运行时、App、进程树、端口、健康、重启、冻结、升级，全部由 **OS（原生层）** 管理。
- **C 对外做强**：力气花在"对上只暴露一个强状态"。
- **D 载荷不碰 Android**：任何 Program（含控制面板）只调用 OS 能力 API，Android 的一切由 OS 代持。

---

## 2. 分层：OS（原生）/ Runtime / Program

**修正要点：所谓"内核"不是一层，它只是一个 Program。**

```
┌──────────────────────────── Android ────────────────────────────┐
│  只看见： 1 进程 / 1 FGS / 1 通知 / 1 控制面板承载面             │
└─────────────────────────────────────────────────────────────────┘
        ▲ 唯一生命周期边界
┌───────┴──────────── OS：原生容器（APK / Kotlin，冻结，信任根）──┐
│  OsHost      唯一前台服务 + 状态机                              │
│  OsInit      进程/端口/存储/日志/journal 的唯一权威             │
│  CapabilityBroker   Android 能力 → OS 能力（按 Program 授权）   │
│  AppManager  安装/校验/落位/版本/卸载（信任根，必须在原生）     │
│  ConsoleHost 承载控制面板（今天 WebView；未来原生面板）         │
│  Runtime 供给  node 等运行时（原生取回/校验/落位）              │
└───────┬─────────────────────────────────────────────────────────┘
        │ 子进程（AMS 不可见）
┌───────┴──────────── Runtime ────────────────────────────────────┐
│  node 24 / 未来 python…（由 OS 供给与管理）                     │
└───────┬─────────────────────────────────────────────────────────┘
        │ 每个 Program 一棵子进程树（AMS 同样不可见）
┌───────┴──────────── Program（载荷；含默认控制面板）──────────────┐
│  console  ← 现"内核"：状态监控 / 安装管理编排 / 小组件（临时过渡）│
│  dsh      ← 第一个 agent 载荷                                   │
│  pi / codex / …                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2.1 "内核"的定性（本次修正的核心）

现 `kernel/`（JS）**不是特权层，也不是 init**，它是 **console 这个 Program**：
- 它的入口**不是** `os-init`，而是"面板程序的入口"（如 `panel.js`）；
- 它做的是**监控系统状态、发起安装/管理、承载小组件**——这些是"一个系统程序"的职责，不是"操作系统内核"的职责；
- 它**临时**存在：因为原生面板还没做，先拿它当控制面板；原生面板就绪后，它可被替换/停用；
- 因此它**不能**拥有：进程监督、端口分配、存储落位、安装校验、能力裁决——这些必须在 OS 原生层。

**判据（硬）**：把 console 停掉/卸载，OS 仍能启动、运行已装 App、并被管理（至少经原生最小面）。做不到，说明它非法占用了系统职责。

### 2.2 命名规则（为什么 OS 里不该有 `DSH_*`）

现状仓内 37 个 `DSH_*` 环境变量、`liblobos*.so`、`dsh_hostbridge`、`.dsh/` 家目录、`dsh-console`，**全是 OS/CI 级**——它们是"容器从 DSH 专用壳长出来"的历史遗留，属于**载荷名泄漏进 OS**（债 A11/B7/B10）。

规则：
- **OS 命名空间 = `LOBOS_*`**（平台事实、桥、home、权限模式、原生件、npm 入口、CI/签名/OTA 变量）；
- **载荷命名空间自持**：dsh 的 `DSH_PROFILE`/`DSH_SESSION_ID`/`DSH_WEB_URL`… 由载荷自己定义与消费，OS 不生成、不保证、不依赖；
- **边界**：`dsh` 只允许出现在 `programs/dsh/**` 与该载荷的适配器里；
- **两处必须切断**：`DSH_HOME` 撞名（OS→`LOBOS_HOME`）；`GuestAdapter` 给所有 Program 注入 `DSH_*`（改 `LOBOS_*`，dsh 私有变量由 dsh 适配器补）。

### 2.3 载体形态：常驻能力**组合**（**不是**媒体播放器）

**产品定性**：Lob OS 不是媒体应用。媒体播放器只是"锁屏仍运行"的能力**标尺**，不是我们的实现形态。

**Android 的真相**：锁屏持续运行不是通用权利，而是**按用途授予**的（前台服务类型 / 系统绑定服务 / 用户豁免）。非媒体应用**没有单一等价门票**；等价能力只能**组合**出来。

**本产品不设兜底/恢复路径**：OS 里跑的 agent 一旦被切断就是停了，事后"续跑"只是假象（ADR-0006 同判）。因此**唯一路径是保活**；journal 只承担"把打断如实显示出来"，不承担恢复。

**我们的组合（全部是普通应用能力：安装即用 + 用户授权一次）**

| 层 | 手段 | 作用 | 现状 |
|---|---|---|---|
| **锚** | **AccessibilityService**（UI 自动化是真实产品能力）+ NotificationListenerService | 系统绑定；OEM 冻结豁免——本机 HANS 拒把本 uid 转出 Running，**是唯一被本机实证的强锚** | 已有，保留 |
| **载体** | **`specialUse` 前台服务**（诚实申报"常驻本地运行时"）+ 常驻通知 | 进程不降级；唯一生命周期（1 进程/1 FGS/1 通知） | 已有，需合成 1 个 |
| **豁免** | 电池优化豁免 + Doze 白名单；**OEM 用户开关**（ColorOS：卡片锁 / 允许完全后台行为 / 应用速冻白名单 / 启动管理） | 降低被清概率（OEM 侧才是主战场） | 部分已有，需引导与适配 |
| **唤醒** | 干活时短持 `PARTIAL_WAKE_LOCK`、联网时 `WifiLock`；`setExactAndAllowWhileIdle` 周期性自作；低频必要时 `setAlarmClock`（会显示闹钟图标） | Doze 下仍能推进与复活 | 待做（现在是永久裸锁，要改成按需） |
| **可见** | 常驻通知 + QS Tile；（可选）悬浮窗；用户设为默认桌面 | 提升调度排序档位、用户可控 | 部分已有 |

**明确不采用**：伪装成媒体应用（播静音音频）；Device Owner/LockTask；Companion Device；`android:persistent` / `systemExempted`。

**"真用途换真豁免"（仅当产品确实提供该功能时才用）**
- 远程屏幕查看/自动化 → `mediaProjection` 类型（每次会话用户授权，保护强）；
- 内置网络代理/隧道 → `VpnService`（always-on，保护强，需真实网络用途）；
- 同步为主功能 → `dataSync`（targetSdk 34+ 有每日限时；我们当前 targetSdk=28 不受限）。

**关于 targetSdk=28（既有资产，非长期策略）**：当前不受 Android 12+ 后台启动限制、Android 14+ FGS 类型强制与 dataSync 限时约束；**一旦升 targetSdk，这些豁免消失，届时只能靠上面的组合 + resumable 兜底**。

---

## 3. OS 对象模型
---

## 3. OS 对象模型

| 对象 | 定义 | 归属 |
|---|---|---|
| **Runtime** | node / python…，可多版本 | OS 供给 |
| **Program（包）** | 可安装载荷：id、版本、manifest、签名、哈希、**role** | AppManager |
| **Instance** | Program 的一次运行：进程树、端口、工作区、授权、状态 | OsInit |
| **Task** | 实例内工作单元 | Program + OS journal |
| **Capability** | fs/网络/通知/UI 自动化/截屏/安装… | CapabilityBroker |
| **Journal** | 状态迁移、实例事件、恢复点 | OsInit |

Program **role**：`system`（如 console）、`agent`（dsh/pi/codex）、`component`（小组件/代理）。

---

## 4. Program 契约（manifest）

```jsonc
{
  "id": "console", "name": "控制面板", "version": "0.x", "role": "system",
  "runtime": { "name": "node", "range": ">=24 <25" },
  "entry": "panel.js", "args": ["serve"],
  "ports": { "http": { "env": "PORT", "health": "/" } },
  "capabilities": ["state.read", "app.manage", "net.lan?", "ui.automation?"],
  "storage": { "workspace": true, "quotaMB": 256 },
  "resource": { "class": "resident|on-demand", "maxRssMB": 512 },
  "ui": { "kind": "http", "path": "/__panel" },
  "signature": "…", "sha256": "…"
}
```

硬规则：① 只声明 OS 能力，不声明 Android 调用；② 能力可拒并按 `?` 降级；③ 运行时中立（换 `runtime.name` 即换生态）。

---

## 5. Runtime 适配器契约

`resolve / spawn / health / stop / restart / freeze / thaw / probe`。
node 适配器今天已有全部要素（原生 runtime.json 契约 + native 资产投放 + 子进程装配），只是要**从 JS 侧收归原生**。

---

## 6. 内部进程与资源模型

- **唯一父进程**：所有 Program 都是 OsHost 子进程 → **AMS 不记录、不单杀、不计入后台进程数**（实测 `dumpsys activity processes` 只列 :main/:node）。
- **自冻结**：只让"期望态=running"的实例跑，其余 `SIGSTOP`；常驻开销与"已安装数"解耦。
- **配额/准入**：按 `resource.class` + 设备内存准入，超限自行冻结而非被 ROM 一刀切。
- **phantom 上限**：本机监控已开，OS 自设上限（系统+常驻 ≤8）并自管回收。
- **端口经纪 + 反代**：Program 端口由 OS 分配，控制面板经反代打开各 Program 的 UI。

---

## 7. 能力模型

Android 权限只由 **OS 原生层**持有；Program 经 UDS 调用 OS 能力 API；每次调用带 Program 身份，CapabilityBroker 按授权表放行/拒绝/审计。**Program 拿不到 Android 语义**（没有 Activity/Service/Context），因此无法在 Android 侧另立生命周期。

---

## 8. 存储 / 包 / 版本（三版本流）

```
files/
  os/         state.json · journal/ · ports.json · logs/
  runtimes/   node/24.21.0/
  programs/   console/0.x/ · dsh/0.1.7-rc.2/     # 不可变包
  data/       console/ · dsh/                     # 实例工作区
  cache/                                          # 内容寻址
```

**三流**：**OS（APK）** · **Runtime（node…）** · **Program（console / dsh / pi…）**。三层独立演进，任何升级都不得改变 Android 对我们的观察面。

---

## 9. 安装与管理

- **原生 AppManager**（信任根）：下载/校验/落位/版本指针/卸载——必须在 OS 内。
- **console Program**：监控状态、发起安装/升级/启停、打开各 Program 的 UI、看日志、管配额与授权（通过 OS 能力 API）。
- 二者是"执行体 vs 编排者"：console 只是**当前**的编排者，可替换。

---

## 10. 状态机、Journal 与对外状态

- `BOOTING → RUNNING ⇄ DEGRADED → STOPPING`；Program 状态是其子状态，对外只汇总成 OS 一个状态。
  - **DEGRADED 只由一拍实测产生**：判据唯一住在 `lobos/os/OsState.kt` 的 `OsPhaseRule`（控制面不在线 **或** 锚不在位），
    生产者唯一住在 `OsInit.refresh`（宿主节拍调用）。真机 2026-09-28 定罪的就是这一档**永远不可达**：
    全仓只有 RUNNING/STOPPING 两个迁移点，而通知正文自己现场拼「锚掉线·运行时未响应」——相位串同源、结论不同源。
  - `RECOVERING` 已删（债表 D11）：它和 D10 那条 `UNREACHABLE` 是同一个形状——有消费点、零生产者，
    留着就是允许散文里出现一句「正在恢复」而没有任何实测能产出它。恢复 = 读数不再构成降级，直接回 RUNNING。
  - 锚读数 `UNKNOWN`（采集失败）既不判降级也不判保护生效：相位维持不动，状态行必须显式写「锚未知」。
- Journal 追加落盘；重启按 journal 重放（这是"OS 的 boot"）。
- 对外唯一状态：`state.json` + **一条通知** + 控制面板首行，**三处同源**。

---

## 11. 故障语义

| 事件 | 归属 | 处置 |
|---|---|---|
| Program 崩溃/被冻结/成孤儿 | OS 内部 | InstanceManager 处理，不上屏为 OS 故障 |
| OsHost 被 Android 杀 | 系统级 | OS 停止；重启后**如实显示中断**（journal 只做可见）。**不提供任务续跑**——agent 已中断，续跑是假信息 |

承诺：**"只要不死就一直干；一旦被切断，如实告诉你，不假装没断。"**（因此全部工程投入放在"不被切断"这一条路径上）

---

## 12. 现状 → 目标：内核拆解表（关键交付）

### 12.1 从现 `kernel/` 下沉到 OS 原生（Kotlin）
| 现 JS | 职责 | 去向 |
|---|---|---|
| `guard/lifecycle/objects.js`（ManagedRegistry） | 受管对象目录 | **AppManager / InstanceRegistry** |
| `guard/console/*`、`guard/lifecycle/managed.js` | 进程监督/健康/退避 | **OsInit / InstanceManager** |
| `guard/monitor/*`、`guard/proc/*` | 监控与回收 | OsInit |
| `guard/lifecycle/ports.js` | 端口分配 | **PortBroker** |
| `platform/runtime-contract.js`（写侧）、`assembler/*` | 运行时装配/原生件投放 | **Runtime 供给（原生）** |
| `platform/tasks.js` | 任务注册 | **Journal** |
| `platform/host-bridge/client.js` | 能力调用 | CapabilityBroker（服务端本就在原生） |
| `domains/dist/*`、`domains/plugin/*` | 下载/校验/安装 | **AppManager（原生）** |
| `platform/{exec,log,logcore,events,config,os,matrix,env-status,registry-contract}` | 系统原语 | OS 原生（或最小共享库） |

### 12.2 留在 console Program（JS）
| 现 JS | 去向 |
|---|---|
| `ui/*`、`public/*` | 面板前端 |
| `api/*` | 面板自身的 API |
| `domains/plugin/pluginmarket.js` | 市场索引与展示（安装动作调原生） |
| `domains/router/*` | **判定项**：PortBroker/NetProxy 下沉原生；上层 LAN/穿透组件留 console（"小组件"） |
| `console.js` | **删除**（其职责已下沉）；面板入口另立 `panel.js` |

### 12.3 目录
| 旧 | 新 |
|---|---|
| `kernel/` | `programs/console/` |
| `kernel/bin/dsh-console` | `programs/console/bin/panel` |
| `kernel/program-manifest.json` | `programs/console/manifest.json` |
| `kernel/ui`、`kernel/test` | `programs/console/ui`、`programs/console/test` |
| `system/`（Tier S） | `container/rom/` |
| `kernel/adapters/dsh/agent.json` | `programs/dsh/manifest.json` |

---

## 13. 迁移顺序（详见执行方案）

清场 → 目录（kernel→programs/console、system→container/rom）→ **合生命周期（Kotlin）** → **立 OsHost/OsInit/AppManager（原生）** → **系统级职责下沉（12.1）** → console 收敛为纯 Program（12.2） → 控制面板可替换 → 续命（journal/checkpoint）→ 清账门禁。

---

## 14. 验收判据

1. `dumpsys activity processes` 本 UID **1 条 ProcessRecord**；
2. `isForeground=true` **=1**；常驻通知 **=1**；
3. 所有 Program 进程均为宿主**子进程**；
4. **停用 console：OS 仍启动、已装 Program 仍运行、仍可被管理**（原生最小面）；
5. 装第二个 Program 并运行，第 1/2 条不变；
6. 装 3 个 Program：未运行者冻结，常驻内存不随安装数线性增长；
7. 杀宿主→重启：带状态回来，任务续跑；
8. Program 代码 **0 处 Android API**；`kernel` 这个词在仓内消失；
9. **锁屏常驻验收（组合拳 = 五层）**：锁屏 10/30 分钟 CPU 有推进、网络请求成功、Program 不掉；`dumpsys activity exit-info` 的被杀口径由 `(service){fg-service}` 上移；**不设"被杀后恢复"项**（唯一路径是保活）。

---

## 15. 明确不做

- 不给"内核/控制面板"任何特权层位置；
- 不让 OS 依赖 console 才能运行；
- 不为某个 Program 在 Android 侧开专有生命周期；
- 不用"加保活边/加判据"换存活。

---

## 16. 需要产出/修订的 ADR

- **新增** ADR-0010「Agent OS 容器形态：单一生命周期 + 原生 OS + 可替换 Program」
- **修订** ADR-0004 双版本流 → **三版本流**（OS / Runtime / Program）
- **修订** ADR-0005 内核 OTA → **OS + Runtime + Program OTA**
- **重写** ADR-0006 后台生命周期（`:node` 与 binder 监督边作废）
- **升格** ADR-0008 agent OS init → **OS 原生 init 主轴**
