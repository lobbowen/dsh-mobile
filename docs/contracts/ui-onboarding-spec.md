# L0 GUI 开场管线规格（S0–S4）v1

> 状态：**设计定稿（2026-09-25），主路径实现待真机验证清单（§7）定罪**。
> 决策依据见 [ADR-0007](../adr/0007-l0-gui-onboarding-pairing-ux.md)。本文件是 GUI 开工的契约：
> 页面集合、状态机、配对交互时序、内核侧清理清单、验收判据。

---

## 1. 产品定位与首页边界

- 产品性质：**极客工作台**。不是仪表盘、不做信息聚合、不放运营内容。
- **首页 = 纯状态 + 入口**，只有两块：
  1. S0–S3 四段管线状态摘要（每段一行：绿/黄/红 + 一句话 + 「去处理」）；
  2. 一个大按钮「进入控制面板」——S3 绿后可点，打开现有 WebView 宿主帧
     （`http://127.0.0.1:<KERNEL_CONTROL_PORT>/__host`，见 `MainActivity` 现实现）。
- 一切「真正的操作」都发生在控制面板内。GUI 不与内核面板抢功能。
- 现有诊断文本页**不删**，降级为灾难兜底页（运行时起不来时它是唯一可见证据；自检/复制/
  重试/授权截屏四按钮保留，ADB 关闭的设备上剪贴板是唯一导出通道）。

## 2. 管线状态机

```
S0 ADB通道 ──→ S1 DeviceOwner ──→ S2 权限集 ──→ S3 运行时+内核 ──→ S4 工作台
   无线配对        dpm set-           DO 静默授予      boot 绿 +          进面板
   （用户3步）     device-owner       + 缺角引导       /status 200
```

依赖理由（不可调换顺序）：ADB 是一切提权的杠杆；Android 17 实测 shell 不能
`pm grant`/`appops set`，所以 S2 的静默授予主路径必须经 S1 的 Device Owner；S3 的保活
质量依赖 S2（电池豁免/无障碍，见 ADR-0006）。每段独立可测：状态 = 纯函数读数，动作 =
发 intent。

**退化恢复**：向导走完后任一环节日常退化（如权限被 ROM 回收、内核掉线），首页对应行
变黄/红并**直达该 Step**，不要求重走全程——管线状态机天然就是「修复横幅」。

### 2.1 各段规格

| 段 | 判据（绿） | 未绿时的动作 | 自动化程度 |
|---|---|---|---|
| S0 | `shell.status` 报已连接（拿到 shell 探针） | 配对引导页（§3） | 半自动：码必须人看人输，其余全脚本 |
| S1 | `DevicePolicyManager.isDeviceOwnerApp(packageName)` | 经 S0 通道跑 `dpm set-device-owner io.github.lobbowen.dshmobile/.lifecycle.DeviceAdminReceiver`；ColorOS 需用户手输一次锁屏密码确认 | 高：命令由我们下发，仅确认弹窗人手点 |
| S2 | `PermissionCatalog` 逐项读数全绿（SPECIAL 五项 + 电池豁免，见 `permissions/PermissionCatalog.kt`） | DO 在位→`setPermissionGrantState` 静默补齐；不在位→逐项跳设置页（APPOP/SETTINGS 档），RUNTIME 档走系统弹窗 | 高：DO 在位时接近全自动 |
| S3 | 控制面 `/status` 200 + 内核版本自检通过（`KernelSelfCheck`） | 复用现有重试/诊断链（ACTION_RESTART） | 全自动，异常才上屏 |
| S4 | ——（即入口本身） | 打开 WebView 宿主帧 | —— |

## 3. S0 无线 ADB 配对交互（核心设计）

### 3.1 物理约束

系统「无线调试」配对对话框**一经失焦即销毁**，配对码随之消失。推论：
- 配对期间我方**绝不允许任何 Activity 抢到前台**（包括自己的）；
- 通知栏下拉、悬浮通知不夺焦 → **输码交互放通知栏（RemoteInput 快捷回复）**；
- 平板/手机同机无线调试的端口是随机的且每次开关会变 → **IP:Port 必须 mDNS 自动发现，
  不让用户找端口号**。

### 3.2 主路径时序

```
用户                          我方 APK (:main)                     系统
────                          ─────────────                       ────
点「去开无线调试」  ──intent──→ 拉起 开发者选项·无线调试
                              （设置页深链；我方退后台，不残留界面）
                              挂出常驻通知：「等待配对码」
                              NsdManager browse _adb-tls-pairing._tcp
打开「配对设备」对话框 ────────→ 对话框出现即有 mDNS 记录 ──→  显示 6 位配对码
看到通知「输入配对码」         （若②未定罪：通知内已自动带出端口）
下拉通知栏，快捷回复输码 ────→ RemoteInput 收码
                              SPAKE2 配对（用 mDNS 的 pairing 端口）
                              对话框关闭后 browse _adb-tls-connect._tcp
                              （无线调试常驻记录，端口稳定）
                              adb connect 自动完成
                              shell.status 探针 → S0 变绿 → 通知收起
```

- 输码通知的 PendingIntent 目标是 `:main` 的 Service（RemoteInput 回 intent），
  **不拉 Activity、不开对话框**。
- 「自动捕捉」的正确形态 = 捕捉的是 **mDNS 端口**（机器可读），不是捕捉配对码（那必须
  人眼读、人手输——任何"自动读码"方案见 §3.4 否决清单）。
- 整个流程用户动作 = 开设置页 → 看码 → 通知里输码，共三步；其余零输入。

### 3.3 降级链（按序回落，每级都失败才进下一级）

1. **mDNS 发现失败**（§7②）→ 通知栏第二个快捷回复槽：手动输 `IP:Port`（配对页上显示的
   那对地址），其余不变。
2. **RemoteInput 不可用**（§7③）→ 输码改走常驻通知的「点按→浮层输码」；再不行走
   S1 前的桌面小组件。
3. **全部自动路径失败** → 手工页：完整走桥 `shell.pair(host, port, code)`
   （`container/engine/src/bridge/methods.js:67-70`，与现内核配对页删除前的能力等价，
   物理位置在 L0，不依赖面板）。
4. **彻底没救** → 灾难兜底诊断页 + 复制自检，交人工。

### 3.4 否决清单（写死前已排除，勿再翻烧饼）

| 方案 | 否决理由 |
|---|---|
| 无障碍监听/抓取配对对话框内容 | 读系统对话框敏感区，对话框文本一变体即碎；且 S0 阶段无障碍还没开（那是 S2），顺序倒挂 |
| 我方 Activity 悬浮/接管配对流程 | 夺焦 = 销毁系统对话框 = 毁掉码，物理不可行 |
| overlay 输码层 | SYSTEM_ALERT_WINDOW 属 S2 权限，S0 依赖它循环 |
| 让用户背下码再切回我方页面输码 | 对话框切走即销毁；且 6 位码 + 双步骤违背「简单快速」 |

## 4. 技术选型与分层纪律

- **原生 View + Material Components**；不上 Compose（minSdk24/targetSdk28，收益为负）。
- 新代码包：`io.github.lobbowen.dshmobile.ui`（Activity/Fragment/Adapter），与 E2 重构后的
  `lifecycle/ bridge/ runtime/ kernelota/ permissions/` 并列。
- 检测与决策逻辑**不进 GUI 层**：全部是 `permissions/`、`lifecycle/`、`ui/model/` 里的纯
  函数（输入读数 → 输出枚举），JVM 单测钉死；GUI 只渲染枚举 + 发 intent。
- 状态刷新：管线页可见时 500ms 轮询读数（复用现有 handler 轮询模式），不可见即停。

## 5. 首页之外的页面集合（本期范围）

| 页面 | 内容 | 备注 |
|---|---|---|
| 管线首页 | §1 两块 | MainActivity 改造或新 Launcher Activity |
| S0 配对引导页 | 三步指引 + 状态回显（等码/已收到/配对中/成功/失败原因） | 打开即挂输码通知；离开即销毁（不常驻） |
| S2 权限清单页 | PermissionCatalog 逐项 + 一键按档派发 | DO 在位时优先静默批处理 |
| 灾难兜底页 | 现有诊断文本页原样 | 仅 S3 红且有异常证据时可达 |

**不做**：设置页（内核面板有）、主题、多语言（中文单语）、引导动画。

## 6. 内核侧 ADB 清理清单（G0，本期彻底删光零残留）

物理位置从内核下沉 L0 的收尾（批次 1 已把 shell.exec 换接 L0 桥；本清单删掉内核残留）。

| 目标 | 动作 |
|---|---|
| `kernel/src/adb/`（`index.js pairing.js transport.js spake2.js ed25519.js x509.js adbkey.js`） | 整目录删除 |
| `kernel/test/adb-*-test.js` ×5 + `test/_adb-mocks.js`，及 `package.json` test 链中对应条目 | 随源同删（L0 侧 `assets/node/adb-client` 的测试在容器仓，不动） |
| `kernel/src/api/adb.js`（`/adb/pair` `/adb/shell` `/adb/forget` 路由） | 删除；`/adb/status` 改为只读透传桥 `shell.status` |
| `kernel/src/api/index.js:25` | 移除 `require('./adb')` 注册 |
| `kernel/src/api/surface.js:100-103` | 契约表同步：仅留 `/adb/status`（category 由 `public` 改只读语义），删其余三行 |
| `kernel/ui/src/features/supervisor/PairingPage.tsx` | 删除 |
| `kernel/ui/src/features/supervisor/nav.ts`（`"pairing"` 视图键 + 「ADB 配对」导航项）、`SupervisorApp.tsx`（lazy import + 路由分支 + PAGE_META 行） | 删除对应条目（6 域 → 5 域） |
| `kernel/ui/src/services/supervisor/client.ts` / `types.ts` / `client.test.ts` | 仅删**写面**：`adbPair/adbShell/adbForget` 与 `AdbPairResult/AdbShellResult` 及其测试；`adbStatus`（只读）保留 |
| `kernel/ui/src/features/supervisor/OverviewPage.tsx` | 新增只读「ADB 环境状态」瓦片（消费 `/adb/status`，使该端点有真实一方消费者，非幽灵） |
| 全内核 `grep -rn "PairingPage\|/adb/pair\|/adb/shell\|/adb/forget\|src/adb" kernel/` | 0 命中 = 零残留门禁（`/adb/status` 白名单放行） |

清理后需一次内核 OTA 发布（版本 bump + canary 链路，见 `docs/runbook/kernel-ota.md`）。

## 7. 真机验证清单（定罪前主路径不得写死）

| # | 验证项 | 判据 | 失败回落 |
|---|---|---|---|
| ① | ColorOS 下拉开通知栏快捷回复时，「无线调试/配对设备」对话框是否存活；且快捷回复 intent 可达 Service（RemoteInput 取出非空） | 输码后对话框仍在、码仍有效；intent 侧收到码 | §3.3-2 |
| ② | 本机 NsdManager 能否 browse 到 `_adb-tls-pairing._tcp`（对话框开时）与 `_adb-tls-connect._tcp`（开关开时） | 两条记录各至少一次回调 onServiceFound + 解析出端口 | §3.3-1 |
| ③ | 无线调试设置页深链（`android.settings.WIRELESS_DEBUGGING_SETTINGS`）在 ColorOS 是否响应 | intent 直达无线调试开关页 | 落开发者选项页 + 图文指引 |
| ④ | mDNS 发布时序 vs 配对码 10 分钟窗口：记录出现是否早于/同步于码可见 | browse→found 延迟 < 2s 且对话框开着期间记录在册 | 持续 browse + 失败提示引导重开对话框 |

验证方式：G1 第一里程碑做**探针版**（管线页 + 只挂日志的 Service/NsdManager 回调上屏 +
复制自检导出），四项各有结论后才锁死主路径。

## 8. 验收判据

- G0：§6 门禁 grep 0 命中；内核 CI 双绿；OTA 推到 canary 后设备面板不再出现 ADB 页，
  `/adb/status` 返回只读状态。
- G1：§7 四项各有书面定罪/否决结论；配对主路径三步内完成（真机计时）；S0→S4 管线在
  一台 ColorOS 真机上从零到 S4 全绿，全程用户手输内容 ≤ 一个 6 位码。
- 首页无「状态+入口」之外的内容（人工评审一票否决制）。
