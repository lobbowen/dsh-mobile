# ADR-0008：OS 原生 init 主轴 —— 域模型与权威收归原生

- 状态：**已升级为形态主轴**（2026-09-26 立域模型；**2026-09-28 v4 升为 OS 原生 init 主轴**）
- 关联：[ADR-0010 容器形态](0010-lob-os-container-form.md) · [ADR-0005 Program OTA](0005-program-via-ota-only.md) · [ADR-0006 单一生命周期](0006-background-lifecycle-keepalive.md) · [ADR-0009 交付分层](0009-delivery-layers.md)
- 上位定位：**我们做的是 Agent OS —— 以 Android 为硬件/特权抽象层的操作系统。** 它有 init（原生权威）、
  有可插拔 Runtime（node 现役，python/go 未来）、有 Program（agent 载荷）、有设备能力总线。
  判定任何设计对不对的唯一提问：**在 OS 里这件事归 init 管，归驱动管，还是根本不该存在？**

---

## 1. 核心校准

**校准① 「node 活，它下面的 agent 就必须活」——后半句在这台机器上做不到。**
真机实证（ADR-0006）：厂商清理连带 FGS 的进程都杀。OS 层可验收的表述是：
被杀之后**如实可见**（journal 记中断点），而不是「保证工作连续」。**不设续跑/兜底。**

**校准② 「内核管理一切生命周期」——方向对，但监督必须住在原生 OS 里，而不是一个 Program。**
`programs/console` 是**可停可换的 Program**；它不能拥有任何生命周期权威。
权威归 `OsHost`/`OsInit`：`AMS ── OsHost（唯一进程/唯一 FGS）── 子进程树（Runtime / Program 实例）`。
**每一层只看守紧邻的下层、只向上报状态、绝不跨层发号施令。**

**校准③ 「App 负责拿权限、建通道、兜底补权限」——对，但发起方要反过来。**
OS 语义是 **init 域申报所需能力，特权域去满足并回递证据**（§3 C2）。反向绑定后
「配对流程」与「默认启动流程」统一为一件事：**特权域状态机收敛到 desired == actual**。

---

## 2. 域划分（职责维，OS/Runtime/Program 三段）

| 域 | OS 类比 | 唯一职责 | 唯一权威载体 |
|---|---|---|---|
| **init 域（OS 原生）** | init / systemd | 进程树以下**一切生命周期**：出生、退避、开关、adopt、记账；desired-state 唯一持久处 | `OsHost` + `OsInit` + `StateMachine` + `Journal` |
| **特权/驱动域（OS 原生）** | 驱动 + 安全模块 | 拿权限、维护 adb 通道、桥接 Android 独有能力；**零生命周期策略** | `CapabilityBroker` + `capability/` |
| **Runtime 供给域（OS 原生）** | 软件源 | Runtime 的取回/校验/落位 + 能力核验（node 现役；python/go 在此注册） | `cenv` + 供给清单 + `capability-probe` |
| **Program 管理域（OS 原生）** | 包管理 | Program 目录/版本/期望态、下载/校验/落位/卸载 | `AppRegistry` + `AppManager` |
| **Runtime（共享）** | 库 / 服务 | 承载 Program：node 24 / 未来 python…；被 OS 供给与管理 | 运行时本体（jniLibs/assets/C 通道） |
| **Program（载荷）** | 用户态进程 | 干活；只调 OS 能力 API；**不得实现任何保活假设**；可停可换 | `programs/<id>` + 其 manifest |
| **观测域（OS 原生）** | /proc + 日志 | 一切结论 = 读数投影；同一真值多出口同句式 | `os-state.json` + Journal + 通知 |

> **作废**：旧「机器域」= `:node` + `NodeWatchdogPolicy`。它把宿主生命周期交给了一个会被杀的 Android 进程，
> 是形态错误的根源（ADR-0006）。**init 域不再有任何 Program 参与。**

---

## 3. 跨域合同

### C1 出生与存活（init 域 ↔ Runtime/Program）
- 出生由 `OsInit` 在原生侧裁决：spawn → 健康探针（端口/句柄/心跳）→ 记录 journal。
- **不引入「补生边」**、不引入进程外复活；观察不到存活即如实投到状态出口。
- adopt-or-start：init 重启后先扫描幸存子进程，收养优先于重 spawn（cmdline 一致性核对）。

### C2 能力合同（Program ↔ 特权域）
Program 按 manifest 申报 capability → 特权域按「可静默 / 需人点 / 不可得」三出口执行 →
「不可得」在实现里的归宿是**实测账**的 `AttemptOutcome.UNSUPPORTED`（试过且被系统拒绝，带归因），
不是一个静态档位 —— 见 `docs/contracts/ui-onboarding-spec.md` §2.1 与债表 `D10`。
结果以类型化 Evidence 回递（不扫日志、不猜）。桥的每次调用带 capability id 记进 bridge-audit。

### C3 死亡与归因合同（全层 → 观测域）
每层死亡只留一种形状：**下次启动可复原的落盘事实**。产品承诺边界仍是「被杀看得见」，
**不做任何进程外复活兜底**（否决词汇在册，见 ADR-0006）。journal 只做「打断可见」。

### C4 投递合同（发布维 → 共享通道）
共享发布通道（`apk-latest` 滚动别名、`v<versionName>` 版本化归档）**唯一合法写者 = main 的 head 字节**。
判据不是「谁有权 dispatch」而是「写进去的东西是否可追溯到已合入的 main commit」。

---

## 4. 废止：旧「ARCHITECTURE.md 铁律」

旧条文：「新运行时 = 在 `ContainerConsole` 再注册一条 binder 边」。
**废止理由**：它是 Android 思维残留 —— 照它做，python/go 都得是 Android 服务、各挂 FGS。
替代条文：**新运行时 = 供给域注册一个单元 + init 域注册一类受管对象；Android 侧零改动。**
判据：加运行时时如果 `container/` 需要改代码，说明分层没成立。

不变式（与本 ADR 一致）：**`OsHost` 不死，运行时环境就不死。**

---

## 5. 落地状态

| 项 | 状态 |
|---|---|
| 单一进程 / 单一 FGS / 单一通知 | 随 ADR-0006 落地 |
| init 权威收归原生（`OsHost`/`OsInit`/StateMachine/Journal） | v4 施工（D3） |
| AppRegistry / AppManager / PortBroker / CapabilityBroker | v4 施工（D3） |
| Runtime 供给原生化（`cenv`，不得依赖 node） | v4 施工（D4） |
| 新增第二 Program（pi）验证「可装任意生态」 | v4 验收（D5/D8） |
| adopt-or-start + Program 状态握手 | 待落 |

## 6. 不做清单

- 不承诺「不被杀」（ADR-0006）。
- 不给主进程加第二监督进程，不加闹钟心跳/周期任务。
- python/go 不建 Android 服务（§2/§4）。
- 不在 Program 域写任何保活假设。
- 不做「补生」式兜底边（§3 C1）。
