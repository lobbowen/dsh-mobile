# Lob OS v4 一次性执行方案（含清债、目录重构与命名迁移）

> 架构见 `os-architecture-v4.md`。本文件是施工图。原则：**不保留兼容层、不留旧目录、不留旧名字、不留旧判据。**
> 本版已按"**内核不是一层，它只是 console 这个 Program**"修正。

---


## 决策台账与文档地图（单一入口 · 2026-09-28 终版）

本文件是**总施工图**；下面把整轮讨论的每一项决策登记到唯一位置，确保"清的东西、改的东西"都在册。

### A. 背景结论（为什么动这一刀）
本机 4 次被杀：**3× `bgLimit_level_thermal_10`（subreason 1030）+ 1× `o-kill(4008)`（subreason 6008 = lowmem）**；整 UID 成组清、前台服务不豁免。
结论：根因不在"内存/温度"单一因子，而在**形态**（把 OS 内部实现暴露成 Android 管理对象）。
取证入口：`kill-audit.json`、`dumpsys activity exit-info`、`oplus-services.jar` 反编译。

### B. 产品与边界（架构源：`os-architecture-v4.md`）
| 决策 | 位置 |
|---|---|
| 产品 = Android 上的一套 Agent OS 容器；可装 dsh / pi / codex | v4 §0 |
| 公理 A–D：单一生命周期 / 内部自治 / 对外做强 / 载荷不碰 Android | v4 §1 |
| **"内核"不是一层**，只是 console 这个 Program（临时控制面板，可替换） | v4 §2.1 |
| 命名规则：OS 层只允许 Lob OS 标识 | v4 §2.2 |
| **常驻能力 = 五层组合**（锚/载体/豁免/唤醒/可见），**非媒体形态**；**不设兜底/续跑** | v4 §2.3 + survey §2 |
| 对象模型：Runtime / Program / Instance / Task / Capability / Journal | v4 §3 |
| Program 契约（manifest）+ Runtime 适配器契约 | v4 §4 / §5 |
| 进程与资源模型：AMS 不可见子进程 / 自冻结 / 配额 / phantom 上限 / 端口经纪 | v4 §6 |
| 能力模型：Android 权限只归原生；Program 只调 OS 能力 API | v4 §7 |
| 存储与**三版本流**（OS / Runtime / Program） | v4 §8 |
| 安装管理：原生 AppManager 执行 + console 编排；**console 可停可换** | v4 §9 |
| 状态机 / journal / 对外唯一状态（三处同源） | v4 §10 |
| 故障语义：Program 崩溃=内部事件；OsHost 被杀=系统级，**journal 仅做"打断可见"，不续跑** | v4 §11 |
| **内核拆解表**（哪些下沉原生、哪些留 console） | v4 §12 |

### C. 目录与命名（执行方案 §1/§1.5 + brand 规范/总账）
| 决策 | 值 |
|---|---|
| 目录 | `container/`（OS 原生）· `programs/console` · `programs/{dsh,pi}` · `container/rom/`（原 `system/`） |
| 产品名 / 显示名 | **Lob OS** |
| applicationId / namespace | **`lobos.app`** / **`lobos`** |
| 仓库名 | **`lobos`**（`lobbowen/lobos`，28 处引用待改） |
| OTA 域名 | **不变** `https://hubcdn.zll.ink` |
| OS 命名空间 | `LOBOS_*` · `liblobos*.so` · `lobos_hostbridge` · `.lobos/` · `lobos:runtime` · `lobos-os` · `lobos_os` · `init.lobos.rc` |
| 载荷边界 | `dsh` 只许出现在 `programs/dsh/**` 与适配器；`docs/**` 可事实引用 |

### D. 清债台账（本文件 §2）
`A1–A14`（结构性）· `B1–B12`（命名/归属）· `C1–C6`（重复事实源）· `D1–D9`（死代码）· `E1–E8`（逻辑错误）——每条含文件/处置。

### E. 常驻能力（`android-residency-survey.md`）
五层保活组合（**唯一路径**）+ 不采用清单（伪装媒体 / Device Owner / LockTask / CDM / persistent / systemExempted）+ 可选"真用途换真豁免"（mediaProjection / VpnService / dataSync）+ `targetSdk=28` 既有资产说明。**不设兜底/续跑机制。**

### F. 施工顺序（本文件 §4）
`D0` 冻界清场 → `D1` 目录重构+品牌改名 → `D2` 合生命周期 → `D3` 原生 OS+锚/可见 → `D4` 职责下沉 → `D5` console 收敛 → `D6` 续命+豁免/唤醒 → `D7` 清账门禁与文档 → `D8` 验收出包。

### G. 验证（`residency-verification-plan.md`）
`V-A`…`V-F` 逐层验证项 + `S1`…`S6` 端到端场景 + 指标定义 + 判据/观测分离 + 产物模板。

### H. 门禁（本文件 §6）
禁词门 · 债表门 · 孤儿门 · **品牌门** · 文档门。

### I. 文档地图
| 文档 | 角色 | 状态 |
|---|---|---|
| `plans/os-architecture-v4.md` | 架构（决策源） | 有效 |
| `plans/os-v4-execution-plan.md` | **总施工图（本文件，单一入口）** | 有效 |
| `plans/android-residency-survey.md` | 常驻机制选型调查 | 有效 |
| `plans/residency-verification-plan.md` | 验证执行 | 有效 |
| `standards/branding.md` · `plans/brand-cleanup-registry.md` | 品牌规范与清理总账 | 有效 |
| `plans/apk-form-v2.md` · `plans/apk-form-v3-single-lifecycle.md` | 被取代 | **已删除** |
| `plans/agent-os-execution.md` | 旧方案（PC 路线） | D7 归档/合并 |
| `components/kernel*.md` · `runbook/kernel-*.md` · `contracts/kernel-bundle.schema.json` | 旧"内核"命名 | D7 重命名/重写 |
| ADR-0004 / 0005 / 0006 / 0008 | 需修订或重写 | D7 完成；新增 **ADR-0010** |

### J. Device Owner：全面退出（能力与路径都不保留）
- 决策：**DO 既不做常驻机制，也不做能力保留**——它已退出本产品。
- 待清残留（D 阶段执行）：`contracts/bridge-protocol.md` 的 device_policy / `policy.*` / 依赖 DO 的静默装卸；`lifecycle/DeviceAdminReceiver.kt`；`capability/` 里的 device-owner 探针与目录项；onboarding 的 `S1 Device Owner` 步骤；`runbook/provisioning.md` 的 DO 章节；ADR-0007/0008 中的 DO 依赖。
- 说明：**用户手动同意**的安装（`REQUEST_INSTALL_PACKAGES` + PackageInstaller + 用户点确认）不属于 DO 能力，可保留；凡"静默/免确认"的都必须删。
- 全仓禁词门加入 `DeviceOwner|Device Owner|dpm|set-device-owner|LockTask|setKiosk`。

### K. 遗留（限定在 D 阶段内完成，不得悬空）
1. ADR-0010 新增 + 0004/0005/0006/0008 修订；
2. `agent-os-execution.md` 归档；`components/kernel*.md` / `runbook/kernel-*` / `contracts/kernel-bundle.schema.json` 重命名或重写；
3. 105 个含 `dshmobile` 文件、37 个 `DSH_*`、14 个含 dsh 文件名、仓库名 28 处引用 —— 全部清零；
4. 五层保活落地 + 验证报告归档（`verify/<run>/`）。

---

## 0. 三条判定原则

1. **单一生命周期**：Android 侧只允许 1 进程 / 1 前台服务 / 1 通知 / 1 控制面板承载面。
2. **一层一职责**：OS 原生层只做系统事（生命周期/init/端口/存储/安装校验/能力裁决）；Program 只做产品事。
3. **一名一义**：`kernel`、`dsh`、`:node`、`os-init`、`managedAgents` 不得出现在通用层。

---


### 1.5 命名与身份：Lob OS（本轮定名）

- **产品名**：**Lob OS**；APK 显示名：`Lob OS`
- **applicationId**：**`lobos.app`**（Android 要求 ≥2 段）· **namespace / Kotlin 包根**：**`lobos`**
- **Kotlin 包**：`lobos.*`（源目录 `lobos/`；实际子包见 §3.2：`os/capability/permissions/bridge/lifecycle/runtime/native/ota/ui`）
- **OS 命名空间**：env `LOBOS_*` · 原生库 `liblobos*.so` · 桥套接字 `lobos_hostbridge` · 家目录 `files/.lobos/` · 唤醒锁 `lobos:runtime` · 系统清单 `name=lobos-os` · sepolicy 域 `lobos_os` · init `init.lobos.rc`
- **OS 侧不得有任何 `DSH_*`**：仓内实测 37 个 `DSH_*`（DSH_ANDROID / DSH_BRIDGE_SOCKET / DSH_HOME / DSH_SUPERVISOR_HOME / DSH_UI_DIR / DSH_PERMISSION_MODE / DSH_FLOCK_NATIVE / DSH_NPM_ENTRY / DSH_ADB_DIR / DSH_APK_CERT_FILE / DSH_KEYSTORE_PASSWORD …）**全部是 OS/CI 级**，一个都不是 dsh 载荷的私有契约 → **全部改 `LOBOS_*`，清零**
- **载荷命名空间自持**：dsh 自己那套 `DSH_*`（`DSH_PROFILE`/`DSH_SESSION_ID`/`DSH_WEB_URL`…，在 npm 包里）由**载荷自己**定义与消费；OS 不生成、不保证、不依赖
- **命名边界判据**：`dsh` 只允许出现在 `programs/dsh/**` 与该载荷的适配器里；其它任何位置出现 `dsh` 即为债
- **两处必须切断的泄漏**：① `DSH_HOME` 名字撞车（OS 的家目录事实 vs 载荷自己的 DSH_HOME）→ OS 侧改 `LOBOS_HOME`；② `GuestAdapter` 现在给**所有** Program 注入 `DSH_*`（把载荷品牌烧进 OS 的 spawn 面）→ 改 `LOBOS_*`，dsh 需要的那几个由 dsh 适配器自己补
- **影响面（仓内实测）**：含 `dshmobile` 文件 **105** 个；`dsh*` 标识符 **~874**、`DSH` **~361**；`io.github.lobbowen.dshmobile.*` 全量包路径；文件名含 dsh **14** 个；`DSH_*` 环境变量 **28** 个（其中约一半是 OS 级、一半是 dsh 载荷级，必须逐条分类）

**不可逆后果（必须排期、必须告知用户）**：applicationId 改变 = **新应用身份**：
- 不能覆盖升级旧包；旧包的 `files/`（会话、`.dsh` 家目录、ADB 配对密钥、已装 Runtime/Program）**不继承**；
- 无障碍 / 通知监听 / 设备管理 / 全文件访问 / 悬浮窗 / 未知来源 / 电池优化等授权**全部要重走**；无线调试**重新配对**；
- 迁移路径：**新旧并存安装 → 新包重新 provisioning → 再卸载旧包**（两个 applicationId 可共存，不做原地改名）。

> 注：**签名密钥不变**，变的是包身份；OTA 锚（证书指纹）与 keystore 都不受影响。

---

## 1. 目标目录树（实体）

```
/
├── container/                 # OS 本体（原生，冻结，随 APK）
│   ├── app/                   #   Kotlin：OsHost / OsInit / CapabilityBroker / AppManager / ConsoleHost
│   ├── engine/                #   L0 侧：桥协议镜像 + 打包/签名/OTA 工具（建议改名 toolchain/）
│   ├── native/                #   C 原语（d1 Linux 语义 / d2 平台件）
│   └── rom/                   #   Tier S：Android.bp / init.rc / sepolicy / privapp 权限   ← 原 system/
├── programs/                  # 载荷（含默认控制面板程序）                ← 原 kernel/
│   ├── console/               #   现 kernel/ 全量：面板 Program（临时过渡）
│   │   ├── manifest.json      #     role=system、entry=panel.js            ← 原 program-manifest.json
│   │   ├── bin/panel          #     入口                                  ← 原 bin/dsh-console
│   │   ├── src/  ui/  public/  test/
│   ├── dsh/manifest.json      #   第一个 agent 载荷                        ← 原 kernel/adapters/dsh/agent.json
│   └── pi/manifest.json       #   第二个载荷（验证"可装任意生态"）
├── docs/  scripts/  gradle/  version.json  …
```

**关键取舍**
- `container/app` **路径不动**（gradle/签名/资产/CI 全指向它）。
- 原 `system/` 是 Tier S（ROM 集成），不是"系统用户态" → 移入 `container/rom/`。
- `kernel/` → `programs/console/`：**它是 Program，不是一层**；入口从 `os-init` 改为 `panel`。
- 载荷实现不进仓；仓内只留默认 Program 的 manifest。

---

## 2. 债务总账（`🔴`结构性 / `🟠`命名归属 / `🟡`死代码 / `🔵`逻辑错误）

### A. 结构性（🔴）
| # | 债务 | 位置 | 处置 |
|---|---|---|---|
| A1 | `android:process=":node"` 第二 Android 进程 | AndroidManifest.xml | 删 |
| A2 | `InstanceHost` 独立 Service + FGS 1001 | runtime/ | 降为宿主内 `InstanceHost` |
| A3 | `HostBridgeService` 独立 Service + FGS 1002 | bridge/ | 收进宿主 `CapabilityBroker` |
| A4 | `OsHostService` FGS 1004 | lifecycle/ | 升为唯一 `OsHost` |
| A5 | `ScreenCaptureService` 独立 FGS | bridge/ | 合入 OsHost 动态 FGS 类型 |
| A6 | `NodeWatchdogPolicy` + 单测 + 门禁条目 | lifecycle/、test/、convicted-cases | 整条删 |
| A7 | binder 监督链（bindNode/strikes/born/三态/清账） | OsHostService.kt | 删 |
| A8 | `node.pid` / `node.birth` | runtime/、lifecycle/ | 删 |
| A9 | BootReceiver 直启 `:node` 兜底边 | BootReceiver.kt | 只唤醒 OsHost |
| **A10** | **"内核"被当作特权层 / 有 `os-init` 入口** | kernel/、部署结构 | **定性为 Program；入口改 `panel`；系统职责下沉原生（见 A11）** |
| **A11** | **系统级职责住在 console Program 里**（进程监督/端口/装配/安装/任务） | kernel/src/{guard,assembler,platform,domains} | **全部下沉 OS 原生（Kotlin）**（拆解表见 §3.3） |
| **A12** | **OS 依赖 console 才能被管理/运行** | 现状 | **原生最小管理面**；console 可停可换 |
| **A13** | 前台服务类型申报与实际不符（历史用过 `specialUse` 兜底、也曾考虑媒体类型） | AndroidManifest | **保持 `specialUse`**（诚实申报"常驻本地运行时"）；`mediaProjection` 等**按真实用途**动态附加；**不伪装媒体** |
| **A14** | 缺少可见性/唤醒的显式载体 | 无 | 新增 **QS TileService**；唤醒改"按需持锁 + Doze 兜底"（见五层组合）；**不新增媒体组件** |
| **A15** | Device Owner 相关能力/路径残留（bridge device_policy、policy.*、静默装卸、DeviceAdminReceiver、capability 探针、onboarding S1 DO 步骤、provisioning DO 章节、ADR 0007/0008 依赖） | 见台账 J | **全部删除**；仅保留"用户手动同意"的安装路径 |
| **A16** | 兜底/续跑机制（checkpoint、replay 恢复） | 设计各处 | **全部删除**；journal 降级为"打断可见"；唯一路径 = 保活 |

### B. 命名/语义（🟠）
| # | 债务 | 处置 |
|---|---|---|
| B1 | 目录 `kernel/` | → `programs/console/`（全量改引用：docs/scripts/CI/门禁） |
| B2 | `program-manifest.json`、`name=dsh-kernel`、`managedAgents` | → `programs/console/manifest.json`、`role=system`、`programs[]` |
| B3 | `bin/dsh-console` | → `programs/console/bin/panel` |
| B4 | Kotlin `ota/Kernel*` | → `ota/SystemOta*` + `appmgr/App*`（OS 自己 + Program 的 OTA） |
| B5 | `OsAccessibilityService`/`OsNotificationListenerService` | → `OsAccessibilityService`/`OsNotificationListenerService` |
| B6 | `NodeContainerApp`/`InstanceHost` | → `OsApplication`/`InstanceHost` |
| B7 | 通用层 dsh 专名（`registerAdapter('dsh')`、`adapters/dsh`、`agent-defaults.json`） | 泛化为 Program 描述 |
| **B10** | **37 个 OS/CI 级 `DSH_*` 环境变量** | **全部改 `LOBOS_*`**（含 CI/签名/OTA 变量） |
| **B11** | **`GuestAdapter` 给所有 Program 注入 `DSH_*`** | 改 `LOBOS_*`；dsh 私有变量由 dsh 适配器补 |
| **B12** | **`DSH_HOME` 与载荷 `DSH_HOME` 撞名** | OS 侧改 `LOBOS_HOME`，切断歧义 |
| B8 | `docs/components/kernel*.md`、glossary"内核=L1" | 重写；glossary 删"内核"条目，改"OS / Runtime / Program" |
| B9 | `system/privapp-permissions-*.xml` | → `container/rom/` |

### C. 重复事实源（🔴/🔵）
| # | 债务 | 处置 |
|---|---|---|
| C1 | 状态文案三处（ResidencyAudit / KillAudit / statusLine） | 合并为 **Journal + os-state.json 单一源** |
| C2 | 桥协议两份镜像（container/engine ↔ 原 kernel） | 保留，靠跨语言一致性测试钉死 |
| C3 | `runtime-contract`（写侧在壳、读侧在内核） | 写读两侧都归原生 |
| C4 | `docs/contracts/layout.json` | 重写 v3 |
| C5 | 退避两份（ConsolePolicy / NodeWatchdogPolicy） | 只留一份（`os/instances/backoff`） |
| C6 | KillAudit 判定 vs 系统退出史原文 | 口径重写（E1） |

### D. 死代码/废弃（🟡）
| # | 债务 | 处置 |
|---|---|---|
| D1 | `docs/plans/apk-form-v2.md` | ✅ 已删（2026-09-28） |
| D2 | `docs/plans/apk-form-v3-single-lifecycle.md` | ✅ 已删（2026-09-28） |
| D3 | `convicted-cases.txt` 指向将删测试的条目 | 删条目 + 删测试 |
| D4 | 仓外 `files/_impl6/{A..E,base,merge}` 与 `_*.txt/_*.js` | 归档后清理 |
| D5 | `docs/components/kernel-android-plan.md` | 归档/删 |
| D6 | 原 `system/` 占名 | 移入 `container/rom/` |
| D7 | 面向将删模块的 kernel 测试（freeze-recovery / managed-lifecycle-failure / orphan-lock-reap / shadow-decision / daemon-lifecycle…） | 逐条：删 / 迁 `programs/console/test/` |
| D8 | `docs/contracts/kernel-bundle.schema.json` | → `program-manifest.schema.json` |
| **D9** | `kernel/src/console.js`（守卫主体） | **整体删除**（职责下沉原生） |

### E. 逻辑错误（🔵，迁移中必修）
| # | 错误 | 修法 |
|---|---|---|
| E1 | KillAudit 口径漏 `bgLimit_level_thermal_*`、lowmem(6008) | Journal reason 词表统一解释 |
| E2 | `forward()` InterruptedIOException → 整进程 FATAL（D10） | 确认 catch + 回归单测 |
| E3 | 每进程都跑 `ensureProtectionActive`（binder+shell 风暴） | 单进程后只跑一次 |
| E4 | 永久 `PARTIAL_WAKE_LOCK` | 短时锁 + JobScheduler |
| E5 | 5s tick / 20s 通知 / 25s shadow 永久心跳 | 事件驱动 + ≥60s 低频 |
| E6 | **错误假设：被杀后可以"续跑/兜底"** | **删除该假设与一切 checkpoint/续跑设计**；journal 只做"打断可见"；全部投入放在保活（见 survey §2.1） |
| E7 | `RuntimeDiagnostics` 自由文本 | 结构化事件 |
| E8 | `MainActivity`/`OnboardingActivity` 职责混杂 | 拆 Console / Setup |

---

## 3. 实体迁移映射

### 3.1 仓库目录
| 旧 | 新 |
|---|---|
| `kernel/` | `programs/console/` |
| `kernel/bin/dsh-console` | `programs/console/bin/panel` |
| `kernel/program-manifest.json` | `programs/console/manifest.json` |
| `kernel/ui`、`kernel/test` | `programs/console/ui`、`programs/console/test` |
| `kernel/adapters/dsh/agent.json` | `programs/dsh/manifest.json` |
| `system/` | `container/rom/` |

### 3.2 Kotlin 实际包结构（**以代码为准**，2026-09-28 复检对齐）
```
lobos/
├── OsApplication.kt · MainActivity.kt · ProvisioningProbe.kt · RuntimeDiagnostics.kt
├── os/            OsState · OsInit · Journal · PortBroker · AppRegistry · AppManager · KillAudit · METHOD-GAPS.md
├── capability/    CapabilityCatalog · CapabilityCriteria · CapabilityEvidenceCollector · BridgeTokens · 取法链 · 审批流
├── permissions/   PermissionCatalog · PermissionCenter
├── bridge/        CapabilityBroker（唯一能力桥）· AdbClientRunner · ScreenCaptureController · OsNotificationListenerService · MdnsWatcher · NotificationStore · ConnectEndpointResolver
├── lifecycle/     OsHostService（唯一 FGS）· OsAccessibilityService · AnchorPolicy · AccessibilityAnchor · BootReceiver · PackageInstallReceiver · ResidencyAudit · StatusTileService（QS 磁贴）
├── runtime/       InstanceHost · GuestAdapter · ConsolePolicy · NodeProvisioner · NodeVersionManager · PrefixProvisioner · SupplyProvisioner
├── native/        NativeAssetRegistry · NativePreparer · NativeExecutable（liblobos*）
├── ota/           ProgramManager · ProgramInstaller · ProgramArchive · ProgramVerifier · ProgramOtaUpdater · ProgramOtaStateStore/Versions/Resolution/SelfCheck · OtaPolicy · ResumableDownloader · SelfCheckReport
└── ui/            ProbeJournal · PairingProbeService · setup/SetupActivity · console/ConsoleActivity
```

> **已实现**（2026-09-28 清债）：豁免层 = `lobos/capability/OemGuards.kt` + 目录里四条 S2 能力项（自启动/卡片锁/完全后台/速冻）+ `files/os/oem-guards.json` 回执；唤醒层 = `PowerLocks`（WifiLock）+ `MdnsWatcher` 组播锁超时 + `DozeBackstop`/`DozeBackstopReceiver`；门禁 R8/R9 钉死。真机实测仍留 P9。
>
> 与早期草案的差异（复检结论）：**没有** `cenv/`（供给在 `runtime/SupplyProvisioner`）、`sys/`（Android 绑定就在 `lifecycle/` 与 `bridge/`）、`diag/`（诊断在包根 `RuntimeDiagnostics`）。
> `os/` 下也**不再细分** `instances/registry/appmgr/state` 子包——同类文件平铺，减少空目录与 import 噪声。
### 3.3 内核拆解表（关键交付）
**下沉原生（Kotlin）**
| 现 JS | 去向 |
|---|---|
| `guard/lifecycle/objects.js`（ManagedRegistry） | `os/registry` AppRegistry |
| `guard/console/*`、`guard/lifecycle/managed.js` | `os/instances` InstanceManager |
| `guard/monitor/*`、`guard/proc/*` | `os/instances` |
| `guard/lifecycle/ports.js` | `os/ports` PortBroker |
| `platform/runtime-contract.js`（写侧）、`assembler/*` | `os/instances/runtime` + `cenv` |
| `platform/tasks.js` | `os/state` Journal |
| `platform/host-bridge/client.js` | `capability` |
| `domains/dist/*`、`domains/plugin/*`（安装动作） | `os/appmgr` |
| `platform/{exec,log,logcore,events,config,os,matrix,env-status,registry-contract}` | 原生原语或最小共享库 |

**留在 console Program**
| 现 JS | 去向 |
|---|---|
| `ui/*`、`public/*` | 面板前端 |
| `api/*` | 面板自身 API |
| `domains/plugin/pluginmarket.js` | 市场索引/展示（安装动作调原生） |
| `domains/router/*` | **判定项**：PortBroker/NetProxy 下沉原生；上层 LAN/穿透组件留 console（"小组件"） |
| `console.js` | **删**；面板入口另立 `panel.js` |

---

## 4. 一次性施工顺序（D0→D8，每步带门禁）

| 阶段 | 动作 | 出口门禁 |
|---|---|---|
| **D0 冻界+清场** | D1/D2 已删、D5 归档；落 `os-v4-debt-registry.json`；落 `docs/standards/branding.md` + `docs/plans/brand-cleanup-registry.md`；建**禁词门**（`:node`/`kernel/`/`os-init`/`dsh-console`/`dsh-kernel`/`managedAgents`/`NodeWatchdogPolicy`/`node.pid`）与**品牌门**（`dsh`/`DSH`/`dshmobile`/`deepseek`/`@deepseek-ai`/`harness`/`Android Node Container`） | 两门生效；`_impl6` 归档 |
| **D1 目录重构 + 品牌改名** | ① `kernel/→programs/console/`、`system/→container/rom/`、建 `programs/{dsh,pi}/manifest.json`；② 按 `brand-cleanup-registry.md` H1–H7 做完包身份/运行期契约/原生件/文案/CI/仓库名（**Lob OS 主导，别人品牌清零**） | `layout.json v3` 绿；`kernel/`=0；**brand-scan 白名单外命中 = 0** |
| **D2 合生命周期（Kotlin）** | 删 `:node`；3 FGS→1（`specialUse` 诚实申报）；删 A6–A9；桥收进宿主；截屏改动态类型 | 实测 1 进程 / 1 FGS / 1 通知 + V-B1/B2 |
| **D3 立原生 OS + 锚/可见层** | OsHost/OsInit/AppRegistry/AppManager/PortBroker/Journal；**保留无障碍锚**；常驻通知 + QS Tile；**唤醒改按需**（去永久裸锁） | state.json=通知=控制台同源；V-A1/A2、V-D1/D2、V-E1/E2；S1 |
| **D4 职责下沉** | 按 §3.3 把系统级 JS 迁 Kotlin；删 `console.js`；console 立 `panel.js` 入口 | 原生侧单测覆盖监督/端口/安装；console 不再是 init |
| **D5 console 收敛** | 按 §3.2 留 UI/API/市场；router 判定 | **停用 console：OS 仍启动、Program 仍跑、仍可管理** |
| **D6 豁免/唤醒层**（不含续跑） | 自冻结/配额；**电池/Doze 白名单 + OEM 四项用户开关引导与适配**；按需 wake/wifi 锁 + Doze 兜底唤醒；journal 仅做"打断可见" | V-C1/C2、V-D3/D4/D5、V-F1/F3；S2/S3 |
| **D7 清账门禁+文档** | layout v3、glossary、ADR（新增 0010；改 0004/0005/0006/0008）、components/plans 收敛、CI 更名 | 债表全 `done`；`legacyForbidden`=0 |
| **D8 一次性验收** | 真机全量验收 | §5 全绿，release 出包 |

---

## 5. 验收判据

1. `dumpsys activity processes` 本 UID **1 条 ProcessRecord**；
2. `isForeground=true` **=1**；常驻通知 **=1**；
3. 所有 Program 进程均为宿主**子进程**；
4. **停用 console：OS 仍启动、已装 Program 仍运行、仍可被管理（原生最小面）**；
5. 装第二个 Program（pi）并运行，第 1/2 条不变；
6. 装 3 个 Program：未运行者冻结，常驻内存不随安装数线性增长；
7. 杀宿主→重启：`os-state.json` / journal **可解释中断点**（打断如实可见）；**不提供任务续跑/复活**（唯一路径是保活，见 A16/E6）；
8. Program 代码 **0 处 Android API**；**`kernel` 一词在仓内消失**；
9. 禁词门 0；债表 `pending` 0；`convicted-cases` 地板达标；单测/引擎测/集成测全绿；
10. APK 以 **release（非 DEBUGGABLE）** 出包；
11. 全仓 `dshmobile`、`io.github.lobbowen.dshmobile`、以及 **任何 `DSH_*`** 残留 **= 0**；`dsh` 一词只允许出现在 `programs/dsh/**` 与该载荷适配器内；
12. **锁屏常驻验收（五层保活，非媒体形态）**：见 `residency-verification-plan.md` —— 硬门槛 1/1/1 + C1 锁屏 CPU 增量 + C2 网络成功率 ≥95% + C4 锁屏可控 + C5 零预置复现 + 存活率/存活时长达标；**不设"被杀后恢复"项**；
13. **零预置**：全新安装（不置备、无特殊账号要求）后，上述全部可复现。

---

## 6. 门禁与死代码清算（2026-09-28 复检后按**实际实现**对齐）

| 门 | 实现 | 判据 | 模式 |
|---|---|---|---|
| **禁词门 / 品牌门** | `scripts/gate-scan.js` + `.github/gate-policy.json` | 白名单外命中任何禁词（含裸词 `kernel`、连字符 `android-node-container`、`dshmobile`、`DSH_`）即红；并做 Kotlin 未解析 import 检查 | **强制**（`enforce=true`，CI `gate` job） |
| **文档门** | `scripts/doc-gate.js` | `docs/**` 与根 README 的相对链接必须指向存在的文件 | **强制**（CI `--strict`；本地报告模式） |
| **债表门** | `scripts/debt-gate.js` | 读 `docs/plans/os-v4-debt-registry.json`，列出 `status!=done` | 报告模式（收口后加 `--strict` 即红） |
| **链完整性门** | `container/engine/test/test-chain-completeness-test.js` | `test/` 下每个测试脚本必须入 `test:logic` 链，且链中无死引用 | 强制（engine job） |
| **已删产物复活门** | `container/engine/test/dead-path-gate-test.js` | 已否决并删除的产物若复活即红；生成报告/词表按设计跳过 | 强制（engine job） |

> 说明：计划早期写的 `.github/banned-terms.txt` / `scripts/brand-scan` / `.github/brand-policy.json` 均**未实现**，实际以 `gate-policy.json` + `gate-scan.js` 承载同一职责（复检 AUD-G15/G43 结论）。「通用孤儿门」（无人 import/require 即红）没有单独实现——真正把守它的是链完整性门与依赖规则门（`dependency-rule-test.js`）。

- 每个删除项给"死亡证明"（引用方=0 的证据），汇成一条"清债"提交。

---

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 目录重命名打断 CI/脚本 | D1 单阶段全量改引用 + 零残留门禁；`container/app` 不动 |
| 系统职责下沉工作量大 | D4 只做"搬迁+改名+收口"，行为不变；既有 72 个 JS 测试 + 跨语言桥测试作回归网 |
| 单进程内存峰值上升 | D6 自冻结 + 准入（先限"同时在跑 ≤2"） |
| console 替换后管理面缺失 | D3 必须先有"原生最小管理面"，D5 才允许收敛 console |
| 一次性变更过大 | 强制 D0→D8 顺序与阶段门禁；每阶段可独立回滚（分支） |

---

## 附录 R：复检报告（2026-09-28 终版）

| # | 复检项 | 旧写法 | 终版 |
|---|---|---|---|
| R1 | 载体形态 | "播放器会话 / mediaPlayback 为主" | **改为五层保活组合**（锚/载体/豁免/唤醒/可见），**不采用媒体形态、不设兜底** |
| R2 | 前台服务类型 | mediaPlayback | **保持 `specialUse`**（诚实申报）；`mediaProjection` 等按真实用途附加 |
| R3 | 常驻通知 | MediaStyle | 普通 ongoing 通知（状态出口）；**不要求媒体样式** |
| R4 | 唤醒锁 | "去永久锁" | 保留纪律；**按需短持**（干活/联网），空闲立即释放 |
| R5 | 权限 | +FOREGROUND_SERVICE_MEDIA_PLAYBACK | **不加媒体权限** |
| R6 | 状态同源 | 四处（含媒体 metadata） | **三处同源**：state.json = 通知 = 控制台 |
| R7 | console 可替换 | 已要求 | 不变；常驻能力全部归 OsHost，与 console 无关 |
| R8 | 身份类机制 | DO / CDM | **明确不采用**（非本业务）；见 survey §4 |
| R9 | 验收 | 媒体会话 active | 改为**锁屏常驻验收**（见 residency-verification-plan.md） |
| R10 | 债务表 | 只收敛 FGS 数量 | 明确 A13/A14 为"类型与可见性"，**不含媒体件** |

**复检结论**：v4 主干（单一生命周期 / 原生 OS / 可替换 Program / 品牌主导）不变；常驻能力最终定为**五层保活组合**（唯一路径），媒体只是能力标尺而非实现，**不设兜底/续跑**。

---

## 8. 明确不做

- 不给"内核/控制面板"任何特权层位置，不保留 `os-init` 入口；
- 不让 OS 依赖 console 才能运行或被管理；
- 不保留旧名兼容层；不做双目录过渡；
- 不为任何 Program 在 Android 侧开专有生命周期；
- **按本文 §1.5 更名为 Lob OS**：applicationId → `lobos.app`、namespace → `lobos`；OS 命名空间 → `LOBOS_*`/`liblobos*`/`.lobos/`；OTA 域名不变；**旧包不原地改名**，走"并存安装→重新 provisioning→卸载旧包"。
