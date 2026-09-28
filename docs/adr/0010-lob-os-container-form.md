# ADR-0010：Lob OS 容器形态 —— 单一生命周期 / 原生 OS / 可替换 Program / 五层保活 / DO 退出

- 状态：**已接受**（2026-09-28，用户拍板 v4 主轴）
- 关联：ADR-0004（三版本流）· ADR-0005（System/Runtime/Program OTA）· ADR-0006（重写：单一生命周期与不复活）· ADR-0008（OS 原生 init 主轴）· ADR-0009（交付分层）
- 架构源：[os-architecture-v4.md](../plans/os-architecture-v4.md) · 施工图：[os-v4-execution-plan.md](../plans/os-v4-execution-plan.md) · 常驻选型：[android-residency-survey.md](../plans/android-residency-survey.md)
- 上位定位：**产品名 Lob OS。我们做的不是「一个装了 DSH 的 App」，而是 Android 之上的一套 Agent OS 容器。**

---

## 1. 问题（为什么必须立这一条）

本机实测 4 次被杀：**3× `bgLimit_level_thermal_10`（subreason 1030）+ 1× `o-kill(4008)`（subreason 6008 = lowmem）**；
整 UID 成组清理、**前台服务不豁免**。历史形态把 OS 的内部实现（第二进程 `:node`、多个前台服务、binder 监督边）
直接暴露成 Android 可管理对象，于是「怎么不被杀」变成了「怎么在 Android 的进程/服务语义里求生存」——
根因不是内存或温度，而是**形态**。

结论：**Android 侧只该看见一个东西：这套 OS。** OS 里装了什么、跑几个 Program、怎么管，Android 无权知道也不该管。

---

## 2. 决定

### D1 单一生命周期（Android 只看见 1/1/1/1）

Android 侧**最终只允许**：

- **1 个进程**（`lobos.app` 主进程，含所有 Program 的子进程树，AMS 不可见）；
- **1 个前台服务**（`OsHost`，`foregroundServiceType="specialUse"` 诚实申报「常驻本地运行时」）；
- **1 条常驻通知**（状态出口，非媒体样式）；
- **1 个控制台承载面**（`ConsoleHost`，今天 WebView）。

`:node` 第二进程、`NodeRuntimeService`（FGS 1001）、`HostBridgeService`（FGS 1002）、
`ScreenCaptureService` 独立 FGS、`ContainerConsole` FGS 1004 —— **全部取消/合并**。
详见 ADR-0006。

### D2 OS 原生：系统职责必须归 Kotlin，Program 只做产品事

**「内核」不是一层，它只是 `programs/console` 这个 Program（可停可换）。** 系统职责下沉 OS 原生：

| 系统职责 | 原生落点 |
|---|---|
| 生命周期 / init / 状态机 / journal | `OsHost` · `OsInit` · `StateMachine` · `Journal` |
| 进程与端口 | `PortBroker` · InstanceHost |
| Program 目录 / 装配 / 安装管理 | `AppRegistry` · `AppManager` |
| Android 能力裁决与代持 | `CapabilityBroker` |
| Runtime 取回/校验/落位 | `cenv`（Android 原生，不得依赖 node） |

**硬判据**：把 `console` 停掉/卸载，OS 仍能启动、已装 Program 仍能运行、仍可被管理（原生最小管理面）。
做不到，说明它非法占用了系统职责。

### D3 对象模型与三版本流

对象：**Runtime / Program / Instance / Task / Capability / Journal**。
三条独立版本流：**OS（APK）· Runtime（node 等）· Program（载荷）**，互不比较，各自 OTA/供给。
Program 契约 = manifest（`docs/contracts/program-manifest.schema.json`）；Runtime 走适配器契约。
详见 ADR-0004、ADR-0005。

### D4 常驻能力 = 五层保活（唯一路径），不设兜底/续跑

常驻**不是**媒体形态，而是五层组合：

1. **锚**：AccessibilityService 绑定（用户一次性授权）；
2. **载体**：`OsHost` 唯一前台服务 + 常驻通知；
3. **豁免**：电池/Doze 白名单与 OEM 四项用户开关引导与适配；
4. **唤醒**：按需短持 wake/wifi 锁 + Doze 兜底唤醒（**去永久裸锁**）；
5. **可见**：QS TileService + 常驻通知 + `os-state.json` 三处同源。

**不设兜底、不设续跑**：agent 断即停；被杀之后唯一诚实的动作是**让打断可见**（Journal 记中断点），
不做任何进程外复活（复活只把壳点回来，任务早已判死，且会把打断伪装成没打断）。详见 ADR-0006。

### D5 Device Owner 全面退出（能力与路径都不保留）

DO 既不做常驻机制，也不做能力保留 —— 它已退出本产品：

- 不保留 DO 能力面与路径（`device_policy` / `policy.*` / 静默装卸 / `DeviceAdminReceiver` / capability 探针 / onboarding 的 S1 / provisioning 的 DO 章节）；
- **只保留「用户手动同意」的安装**：`REQUEST_INSTALL_PACKAGES` + `PackageInstaller` + 用户点确认，不属于 DO 能力；
- 全仓禁词门加入 `DeviceOwner|Device Owner|dpm|set-device-owner|LockTask|setKiosk`。

---

## 3. 后果

- **正面**：Android 只面对 1/1/1/1，形态与「Android 管理对象」脱钩；系统职责与产品职责分离；
  Program 可停可换、可装多个生态（dsh / pi / codex）。
- **代价**：单进程内存峰值上升 → 靠自冻结 + 准入（同时在跑 ≤2）与 Program 配额控制；
  Runtime/Program 的 OTA 与供给链必须自建（见 ADR-0004/0005）。
- **不可逆**：applicationId 由旧包改为 `lobos.app` = 新应用身份；旧包 `files/` 不继承，
  授权/配对/无线调试全部重走；迁移走「新旧并存安装 → 新包重新 provisioning → 卸载旧包」。

---

## 4. 验收判据（真机）

1. `dumpsys activity processes` 本 UID **1 条 ProcessRecord**；
2. `isForeground=true` **=1**、常驻通知 **=1**；
3. 所有 Program 进程均为宿主**子进程**（AMS 不可见）；
4. **停用 console：OS 仍启动、已装 Program 仍运行、仍可被管理**；
5. 装第二个 Program（pi）运行，第 1/2 条不变；装 3 个 Program，未运行者冻结，常驻内存不随安装数线性增长；
6. 锁屏常驻验收按 `residency-verification-plan.md`（五层组合，非媒体形态）；**不设「被杀后恢复」项**；
7. 全仓 `dshmobile`、`io.github.lobbowen.dshmobile`、任何 `DSH_*` 残留 **= 0**（白名单外）；
8. APK 以 **release（非 DEBUGGABLE）** 出包。

---

## 5. 明确不做

- 不给「内核/控制面板」任何特权层位置，不保留 `os-init` 入口；
- 不让 OS 依赖 console 才能运行或被管理；
- 不保留旧名兼容层、不做双目录过渡；
- 不为任何 Program 在 Android 侧开专有生命周期；
- **不采用 Device Owner**；**不设兜底/续跑**。
