# ADR-0008：Agent OS 的域模型与 init 权威

- 状态：已接受（2026-09-26 用户拍板方向；P0 落地形态见 §5）
- 关联：ADR-0005（内核只来自 OTA）、ADR-0006（常驻与保活）、ARCHITECTURE.md §1.1/§1.2
- 上位定位：**我们做的是 Agent OS —— 一个以安卓为硬件/特权抽象层的操作系统。**
  它有 init（生命周期权威）、有可插拔平台运行时（node 现役，python/go 未来）、有载荷（agent）、
  有设备能力总线（adb 通道 / 无障碍 / 安装器 = 驱动）。判定任何设计对不对的唯一提问：
  **在 OS 里这件事归 init 管，归驱动管，还是根本不该存在？**

## 1. 对用户三段表述的三处校准

用户明确说过「我表达的不一定正确」，以下为按 OS 语义的校准，不是照抄。

**校准 ①「node 活，它下面的 agent 就必须活，不受任何干扰」——前半句成立，后半句在这台机器上做不到。**
真机实证（ADR-0006，2026-09-25/26 两轮定罪）：这台 ColorOS 连挂着 FGS 的 `:node` 都按 cached 杀
（`am_kill Cached(nirvana)`）。OS 层可验收的表述是两条：

- **I1**：被杀 → **一个监督拍内恢复**（"恢复"的定义见 §4 C1），且断供期间状态如实可见。
- **I2**：恢复之后的**工作连续性**归 init 域（现做不到：`kernel/src/platform/tasks.js` 重启即判
  failed）。I2 是欠账，登记在执行案 P3，**不许用复活边伪装成已解决**。

**校准 ②「内核管理一切生命周期」——方向对，但监督链在物理上只能分层。**
guard 自己是进程，也会死，不能监管自己的父；OS 里 init 的父是内核，我们的"内核的父"是安卓 AMS。
所以监督链只能是：

```
AMS ──监管── :main（常驻体 + 无障碍锚）──父监子── :node（运行时宿主）──父监子── guard（init）
                                                                     └──监管── 运行时实例 ×N、router、agent
```

**每一层只看守紧邻的下层、只向上报状态、绝不跨层发号施令。**

**校准 ③「APP 负责拿权限、建通道、兜底补权限」——对，但发起方要反过来。**
现状由界面流程驱动权限；OS 语义是**init 域申报所需能力，特权域去满足并回递证据**（§4 C2）。
零件已在仓内：`capability/CapabilityCatalog`（DAG 登记表）+ 类型化 Evidence + ADB 通道实证
（settings put 类可静默、appops 类必须人点）。反转后"配对流程"与"默认启动流程"统一为一件事：
**特权域状态机收敛到 desired == actual**。

## 2. 六域划分（职责维）

| 域 | OS 类比 | 唯一职责 | 唯一权威载体 |
|---|---|---|---|
| 特权/驱动域 | 驱动 + 安全模块 | 拿权限、维护 adb 通道、桥接安卓独有能力；**零生命周期策略** | `ContainerSupervisor` + `HostBridgeService` + `capability/` |
| 机器域 | 机器 / 电源 | 让「init 存在且已出生」为真；进程级复活与活性判据 | `NodeRuntimeService` + `NodeWatchdogPolicy` |
| init 域 | init / systemd | 运行时宿主以下**一切进程**的生命周期：出生、退避、开关、adopt、记账；desired-state 唯一持久处 | 内核 `guard/`（lifecycle + registry） |
| 运行时供给域 | 软件源 | 二进制/运行时的下载期装配 + 能力核验（node 现役；python/go 在此注册单元） | `supply-table.json` + `capability-probe.js` + `NativePreparer`/`PrefixProvisioner` |
| 载荷域 | 用户态进程 | agent 干活；**不得实现任何保活假设**（ADR-0006 §2.3） | dsh 及后续 agent（内核的受管对象） |
| 观测域 | /proc + 日志 | 一切结论 = 读数投影；同一真值多出口同句式 | `controlPlaneUp` 读数 + `ResidencyAudit` + `RuntimeDiagnostics` |

目录落点与搬家序列不在本 ADR（那是执行案 `docs/plans/agent-os-execution.md`）。

## 3. 废止：ARCHITECTURE.md §1.1 铁律 2

旧条文：「新运行时 = 在 `ContainerSupervisor` 再注册一条 binder 边」。

废止理由：它是安卓思维残留 —— 照它做，python/go 都得是安卓服务、各挂一条 FGS、各被 AMS
语义坑一遍，而且"运行时宿主"这个概念会在安卓侧长出一堆并列的 FGS 进程，机器域重新变成上帝。

替代条文：**新运行时 = 供给域注册一个单元 + init 域注册一类受管对象；安卓侧零改动。**
这条替代同时也是执行案 P2 的验收判据：加运行时时如果 `container/` 需要改代码，说明分层没成立。

不变式仍然保留、且与本 ADR 一致：**APK（`:main` 常驻体 + 无障碍锚）不死，运行时环境就不死。**

## 4. 跨域合同

### C1 出生握手（机器域 ↔ init 域）

- **三态活性**（缺一维就会把"空壳"判成健康，2026-09-26 真机定罪的根因）：
  - `POWER` binder 边在册 ∧ `node.pid` 记录的进程还在（cmdline 一致）——只证明进程存在。
  - `BORN` 该进程的 boot 循环真的跑起来过（`node.birth` 记的 pid == 当前进程记录的 pid）。
  - `ONLINE` 控制面可达 —— **只进状态出口，不做清账判据**：内核起不来时 `:node` 自家
    已在按 `SupervisorPolicy` 退避重试，跨进程再发一道清账只会打断它。
- **出生触发点 = `:node` 的 `onCreate` 自出生。** 依据：`bindService(BIND_AUTO_CREATE)` 复活
  只跑 `onCreate`；ROM 的 cached-kill 之后 AMS **不会**重投 started-service 的 `onStartCommand`
  （ADR-0006 §2.1 旧叙述「rebind 随之…重投 onStartCommand」即此句被证伪）。
- **明确不引入「补生边」**（监督者向 `:node` 补投 `startService`）：那是拿重试伪装正常，
  且把机器域的职责倒过来糊。已写成门禁死词汇，复现即红。
  观察到 `POWER ∧ ¬BORN` 超窗 → 走**既有**的清账动作（stop + unbind + rebind），
  并把「运行时未出生」如实投到常驻通知。
- **adopt-or-start（未完成，属执行案 P1）**：init 域重启后先按 registry/ports 扫描幸存子进程，
  收养优先于重 spawn。前提存疑待实验：本机 `:node` 被杀时子进程是否同灭（19:57:13 现场
  `ps` 全表 libnode 零残留）。收养错对象的风险沿用 cmdline 一致性核对手法。

### C2 能力合同（init 域 ↔ 特权域）

init 域按 capability 清单申报 → 特权域按「可静默 / 需人点 / 不可得」三出口执行 →
结果以类型化 Evidence 回递（不扫日志、不猜）。桥的每次调用带 capability id 记进 bridge-audit，
审计归观测域。

### C3 死亡与归因合同（全层 → 观测域）

每层死亡只留一种形状：**下次启动可复原的落盘事实**（机器域 = `node.pid` + `node.birth`；
init 域 = events 日志 + watermark；特权域 = `ResidencyAudit`）。产品承诺边界仍是
「被杀看得见」，不做任何进程外复活兜底（否决词汇在册，见 ADR-0006）。

### C4 投递合同（发布维 → 共享通道）

共享发布通道（`apk-latest` 滚动别名、`v<versionName>` 版本化归档）**唯一合法写者 = main 的
head 字节**。判据不是「谁有权 dispatch」而是「写进去的东西是否可追溯到已合入的 main commit」：
分支/中途 commit 发的包会覆盖用户手里的下载地址，而 `ci-ok.txt` 的 sha 会指向一个不存在于
main 历史的 commit（2026-09-26 16:12 实证，见执行案 D8）。

同号换字节（`scripts/verify-apk-version-gate.sh:77` 显式通道放行）因此**只有一种合法用途**：
把已合入 main 的版本重投回通道，而不是用来发未合入的改动。

合同条文在册，**机器判据未落**：`fast-apk.yml` 全文不校验 `github.ref_name`，任何 ref 都能写通道。
落地归执行案 P2b（发布步骤硬失败 + 门禁活样本）。

## 5. 本 ADR 的落地进度

| 项 | 状态 |
|---|---|
| 三态判据（POWER/BORN/ONLINE）+ `onCreate` 自出生 + 出生标记单源 | **已落并真机自证**（壳 1.1.6(8)；含 JVM 单测与门禁出生链 6 处取证；真机 cached-kill 注入 t+4s 复活、t+11s 端口复听） |
| 空壳上屏（¬BORN 必须出现在常驻通知上） | 1.1.6(8) **真机判失败**：常驻通知 1004 有两个正文写者，`promoteToForeground()` 每次投递都盖掉三态结论（执行案 D9）⇒ 正文改单写者 = `statusLine()`，随壳 1.1.7(9) 出，**复点前本项不算落地** |
| ARCHITECTURE §1.1 铁律 2 废止改写 | 已随本 ADR 改写 |
| C2 desired==actual 状态机、通道 LIVE 后自动首次开机 | 未做（执行案 P1 之后） |
| C1 adopt-or-start、runtime.json schema 3 握手 | 未做（执行案 P1，先决实验在前） |
| 六域目录落点（`host/` + `runtime/init`） | 未做（执行案 PC-1…PC-3） |
| C4 投递合同成文 | 已写（本节） |
| C4 机器判据（发布步骤只认 main head 字节） | 未做（执行案 D8 → P2b）；本轮治标**已完成**：run #188 从 main `9d530d3` 重投，`apk-latest` 与 `v1.1.6` 两份资产 digest 一致（`sha256:8466cdaa…`），`ci-ok.txt` 记 `sha : 9d530d3` |

## 6. 不做清单（刻意决策，不是欠账）

- 不承诺「不被杀」（这台 ROM 上做不到，见 ADR-0006）。
- 不给 `:main` 加第二个监督进程，不加闹钟心跳/周期任务（ADR-0006 §2.2 已否决，门禁在册）。
- python/go 不建安卓服务（§3）。
- 不在载荷域（内核/agent）写任何保活假设。
- 不做「补生」式兜底边（§4 C1）。
