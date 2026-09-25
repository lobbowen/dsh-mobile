# L0 GUI 开场管线规格（能力模型 v2）

> 状态：**v2 定稿（2026-09-25）**。v1 的串行五段模型经真机定罪证伪（§2.0），本版把
> 「能力」立为一等对象。决策依据见 [ADR-0007](../adr/0007-l0-gui-onboarding-pairing-ux.md)
> 与本文 §2.0。本文件是 GUI 开工的契约：能力登记表、依赖图、配对交互时序、验收判据。

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

## 2. 能力模型（一等对象）与管线投影

### 2.0 v1 串行五段为什么被证伪（真机定罪，2026-09-25）

v1 把**页面顺序**当成了**依赖关系**，由此产生四处硬伤，全部有行号可查：

| # | v1 的说法 | 事实 | 后果 |
|---|---|---|---|
| 1 | v1 §2.1 写「S0 判据 = shell.status 报已连接」 | 实现用的是 `files/adb/state.json` 存在性（`AdbClientRunner.isPaired`），而 `assets/node/adb-client/index.js` 的 `status()` 只是 `paired: !!readState()` —— 全栈**没有一处连通性探针** | 端口轮换后（§3.1）首页长期假绿，shell 实打不通 |
| 2 | v1 §2.1 自己写了 S2 的降级动作「DO 不在位→逐项跳设置页」 | 代码把 S2 硬 BLOCKED 在 S1 之后（`PipelineState.evaluate`：`s1.status != DONE -> BLOCKED`） | DO 在多用户设备不可得（`dpm set-device-owner` 报 `several users`；ColorOS 应用分身即 CLONE 用户）⇒ **S2/S3/S4 永久锁死** |
| 3 | v1 §2.1 写「S3 判据 = /status 200 + 内核版本自检通过」 | 代码只做了 HTTP 200，`KernelSelfCheck` 从未接入管线 | 内核坏了首页照样绿 |
| 4 | v1 §4 写「判据与体检/桥用同一把尺子」 | 那是**四处手写复制**（`AdbClientRunner` / `ProvisioningProbe` / `HostBridgeService.deviceCapabilities` / `KernelSelfCheck`），只有注释约束 | 三套「绿」互不等价：无障碍与 MediaProjection 根本不在 `PermissionCatalog.ALL` 里 ⇒ S2 能显示 DONE 而 `bridge:ui_automation` 仍未解锁 |

结论：缺的不是补丁，是「能力」这个对象本身 —— 每项能力要有自己的**判据 / 证据源 / 取法 /
降级 / 归因**，串行五段只是它的一张投影。另有一处实测修正：Android 17 shell 仍保有
`WRITE_SECURE_SETTINGS`（`settings put secure` 可静默开无障碍与通知监听，`dumpsys` 见 Bound），
v1 §2 的「S2 静默授予主路径必须经 DO」不成立；`AndroidManifest.xml` 里「通知使用权 DO 也无法
静默授予、必须用户手开」的注释同样按本条改写。

### 2.1 能力规格（Capability）

一条能力的完整规格 = 下列八项，缺一项即视为规格不合格（评审否决）：

```
Capability(id, title, segment, judge, evidence, acquirableBy, requires, failure)
```

- `judge`：**纯函数** `证据 -> 状态`，不住 GUI 层、不碰 Android 类型，JVM 单测钉死；
  判据表达式（`adb/state.json`、`isDeviceOwnerApp`、`canDrawOverlays` …）**只允许出现在
  `capability/` 层**（§2.5 门禁）。
- `evidence`：**类型化**读数快照（含时间戳），禁止从日志文本反解状态（v1 的
  `lastPairError = substringAfter("[pair]") + "失败" in it` 是反面教材）。
- `acquirableBy`：**有序**取法链，第一项就是主路径，失败才落下一项；档位 ∈
  `AUTO / USER_TAP(intent) / USER_CODE(6位码) / SILENT_VIA_ADB / SILENT_VIA_DO`。
  `SILENT_VIA_DO` 一律排在降级位 —— DO 是**加速器**，不是前置。
- `requires`：**硬**前置能力 id 集合。只有这里产生的未达成才允许显示 BLOCKED。
- `optional`：加速器/旁路能力置 true（DO、截屏授权）。`optional` 能力**永不**下 BLOCKED、
  **永不**参与 S4 放行判定。
- `failure`：类型化归因枚举（不是字符串猜测），上屏时再渲染成人话。

状态枚举：`GRANTED`（判据为真）/ `ACTION`（前置就绪，差用户一步）/ `BLOCKED`（硬前置未达成）/
`FAILED`（试过且失败，带归因）/ `UNREACHABLE`（平台拒绝且非用户可补救，例如多用户设备上的 DO ——
灰显「不可得」，**不阻塞下游**）。

### 2.2 能力登记表（唯一事实源）

| id | 段 | 判据（绿） | 取法链（主 → 降级） | 硬前置 | optional |
|---|---|---|---|---|---|
| `dev_options` | S0 | `Settings.Global.development_settings_enabled == 1` | USER_TAP → 开发者选项页 | —— | |
| `wireless_debug` | S0 | `Settings.Global.adb_wifi_enabled == 1` | USER_TAP → 开发者选项页（PLP120 定罪：无线调试深链无 Activity 响应，落点只有这一页） | —— | |
| `adb_credentials` | S0 | 凭据在册（`adbkey.pem` + `state.json`）**且**最近一次配对尝试非 FAILED | USER_CODE：通知栏 RemoteInput 输 6 位码（§3） | dev_options, wireless_debug | |
| **`adb_channel`** | **S0** | **活探针为真：现问 mDNS 端点 → `id -u` 返回 `uid=2000`，且读数未过期（TTL 内）** | AUTO：`AdbChannelProbe`（缓存 TTL 30s；失败 5s 后允许重探） | adb_credentials | |
| `device_owner` | S1 | `isDeviceOwnerApp(packageName)`（系统侧回读；`dpm` 命令 exit 0 不算数，真机 2026-09-25 17:12） | SILENT_VIA_ADB：`dpm set-device-owner` → 输出含 `several users` 归因 UNREACHABLE | adb_channel | **是（加速器）** |
| `perm:manage_external_storage` | S2 | `Environment.isExternalStorageManager()` | USER_TAP（AppOps 档：Android 17 shell 已无 `MANAGE_APP_OPS_MODES`，实测只能人点）→ SILENT_VIA_DO | —— | |
| `perm:request_install_packages` | S2 | `canRequestPackageInstalls()` | USER_TAP → SILENT_VIA_DO | —— | |
| `perm:system_alert_window` | S2 | `Settings.canDrawOverlays()` | USER_TAP → SILENT_VIA_DO | —— | |
| `perm:post_notifications` | S2 | `checkSelfPermission(POST_NOTIFICATIONS)` | USER_TAP：系统弹窗（shell 侧 `pm grant` 在 Android 17 不可用） | —— | |
| `perm:battery_optimization` | S2 | `isIgnoringBatteryOptimizations()` | USER_TAP：`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | —— | |
| `secure:notification_listener` | S2 | `Secure.enabled_notification_listeners` 含本包 | **SILENT_VIA_ADB**：`settings put secure`（§2.0 实测）→ USER_TAP 通知使用权页 | —— | |
| `accessibility` | S2 | 服务实例已连（`DshAccessibilityService.isReady()`，与桥 caps 同一把尺子；设置串残留不作数） | **SILENT_VIA_ADB**：`settings put secure enabled_accessibility_services` → USER_TAP 无障碍页 | —— | |
| `mediaprojection` | S2 | `ScreenCaptureService.isReady()` | USER_TAP：App 内「授权屏幕捕获」（每次会话，物理不可预置） | —— | 是 |
| `runtime` | S3 | 控制面 `/status` 200 | AUTO：`ContainerSupervisor` 重拉 → 手动重试 | —— | |
| `kernel_bundle` | S3 | `KernelSelfCheck` 无失败项 | AUTO → 灾难兜底诊断页 | runtime | |
| `workbench` | S4 | 全部非 optional 能力为 GRANTED 或 UNREACHABLE | USER_TAP：进入控制面板 | adb_channel, runtime, kernel_bundle | |

两点必须钉住：

1. **S0 的绿 = `adb_channel`，不是 `adb_credentials`。** 凭据在册只回答「密钥与配对记录在不在」，
   通道通不通必须靠活探针 —— 这条区分是 §2.0-1 的唯一解。
2. **`device_owner` 不在任何能力的 `requires` 里。** 它只出现在取法链的降级位。

### 2.3 依赖图与管线投影

```
dev_options ┐
            ├─→ adb_credentials ─→ adb_channel ─┬─→ device_owner (optional，加速器)
wireless_debug ┘                                ├─→ secure:notification_listener
                                                └─→ accessibility
        perm:*（USER_TAP，与 DO 无关）   runtime ─→ kernel_bundle
                       └──────────────────────────────────────→ workbench
```

- S0–S4 五段是能力按 `requires` **拓扑排序后的呈现视图**（用户要的简单），不再是模型本身。
- 段状态聚合规则（写死，便于单测）：段内**任一 FAILED → FAILED**；否则**任一 ACTION → ACTION**；
  否则**任一 BLOCKED → BLOCKED**；否则**存在 UNREACHABLE → UNREACHABLE**；否则 DONE。
  `optional` 能力不参与取 worst（它只把自己单列一行灰字，供极客核对）。
- **退化恢复**：任一能力日常退化（权限被 ROM 回收、端口轮换、内核掉线）→ 该段变黄/红并直达
  该能力的取法动作。活探针的 TTL 保证「拔开关后 ≤30s 必然变红」，不允许凭缓存续绿。

### 2.4 证据采集与新鲜度

- 采集器（`capability/CapabilityEvidenceCollector`）是**唯一**允许碰 Android 侧读数的地方；
  系统属性/权限走现读，`adb_channel` 走探针缓存，配对失败走类型化 `PairAttempt`
  （由 §3 的配对流程直接写入，不经过日志文本）。
- 证据必须带 `judgedAt`；除 `adb_channel` 外一次采集一次读数，不缓存（成本低）。
- 采集在 IO 线程；GUI 线程只做渲染与发 intent（§4）。

### 2.5 单一真值与反向门禁（能红）

判据表达式在 `capability/` 层之外出现即 CI 失败。门禁文件
`container/engine/test/capability-single-source-gate-test.js`，扫描范围含**注释与字符串**
（v1 的教训：注释「同一把尺子」约束不住复制）：

| 表达式 | 唯一合法宿主 |
|---|---|
| `adb/state.json`、`adbkey.pem` 的存在性判定 | `capability/`（凭据判据）+ `assets/node/adb-client/`（写方） |
| `isDeviceOwnerApp(` | `capability/CapabilityCriteria.kt` |
| `canDrawOverlays(`、`isExternalStorageManager(`、`canRequestPackageInstalls(`、`isIgnoringBatteryOptimizations(` | `permissions/PermissionCenter.kt` |
| `enabled_notification_listeners`、`enabled_accessibility_services`（**裸串**） | `permissions/PermissionCatalog.kt` 各声明一次（`SECURE_KEY_*`）；读侧 PermissionCenter 与下发侧 `CapabilityAcquisitionRunner` 都引用它 |

`SECURE_KEY_*` 用串而非平台常量：`Settings.Secure.ENABLED_NOTIFICATION_LISTENERS` 不在
compileSdk 35 的公开桩里（run 36135584213 编译失败为证），两半统一走串才不会出现半常量半串。
| 日志文本反解状态（`substringAfter("[pair]")` 之类） | 禁止（零命中） |

门禁必须自证非空转：报告每条规则的命中数，命中数为 0 的规则视为门禁失效并报错
（防止我把规则写成永不匹配的空壳）。扫描到的 `.kt` 文件数也有地板值，低于地板值同样报错。

同一文件还静态钉住 §2.1 的三条 DAG 不变式（纯层逻辑本机没有 JDK 跑不了，故用文本解析而非
运行时断言；`CapabilityCatalog.init` 的运行时校验是第二道，两者同向）：

| 不变式 | 违规形态 |
|---|---|
| `optional` 能力不得出现在任何 `requires` 里 | `runtime.requires(device-owner)` —— v1 锁死 S2/S3/S4 的根因 |
| 非 optional 能力的 `requires` 闭包不得含 `adb-channel` | 无 ADB 的机器上永久走不到绿 |
| `perm(PermissionCatalog.X)` 引用的 id 必须在 PermissionCatalog 有定义 | 表与登记表漂移，judge 永远拿不到读数 |

解析器自身也要能红：`requires = setOf(` 的声明次数与解析出的边数不等即失败（写法漂移），
登记表里没有 `perm()` 能力同样失败。

该门禁已接入 `container/engine/package.json` 的 `test:logic` 序列，由 `ci.yml` 的
`container` job 执行；纯层退化路径 golden 在
`container/app/src/test/java/io/github/lobbowen/dshmobile/capability/CapabilityDegradationTest.kt`，
由同一 workflow 的 `app-tests` job 跑 `:app:testDebugUnitTest`（JDK 17 + runner 自带 SDK）。
出包用的 `build-apk.yml` 是 `workflow_dispatch` 专用，刻意**不**在那里重复跑一遍单测。

## 3. S0 无线 ADB 配对交互（核心设计）

### 3.1 物理约束

系统「无线调试」配对对话框**一经失焦即销毁**，配对码随之消失。推论：
- 配对期间我方**绝不允许任何 Activity 抢到前台**（包括自己的）；
- 通知栏下拉、悬浮通知不夺焦 → **输码交互放通知栏（RemoteInput 快捷回复）**；
- 平板/手机同机无线调试的端口是随机的且每次开关会变 → **IP:Port 必须 mDNS 自动发现，
  不让用户找端口号**。而且这个轮换发生在**配对成功之后**仍在继续（真机 2026-09-25：
  17:08 记下的 35633 到 17:36 已 ECONNREFUSED，同一时刻 mDNS 发布 44019，打 44019 立刻
  拿到 uid=2000）→ 推论：`files/adb/state.json` 只承载**身份/凭据**，连接端点必须
  每次 shell 前现问 mDNS（`bridge/ConnectEndpointResolver`），旧端口不得作为兜底之外的默认。

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
                              活探针（现问端点 + id -u）→ adb_channel 变绿 → 通知收起
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
- 新代码包：`io.github.lobbowen.dshmobile.capability`（判据层）+ `.ui`（渲染层），与 E2 重构后的
  `lifecycle/ bridge/ runtime/ kernelota/ permissions/` 并列。
- **四层职责钉死**（v1 的 §4 只有口号没有归属，本版按可门禁的方式写）：

| 层 | 允许做什么 | 禁止做什么 |
|---|---|---|
| `capability/`（纯） | `Capability` 登记表、`judge` 纯函数、DAG 拓扑、段投影、类型化证据 | import Android 类型；读写文件 |
| `capability/CapabilityCriteria`、`CapabilityEvidenceCollector`、`AdbChannelProbe` | **唯一**允许读系统/文件/网络证据的地方 | 被 GUI 绕过自行判定 |
| `ui/`（Activity/Adapter） | 渲染枚举 + 发 intent + 起采集 | 出现判据表达式、`dpm`/`settings` 命令拼装、日志文本反解 |
| `bridge/HostBridgeService`、`ProvisioningProbe`、`KernelSelfCheck` | **调用** capability 层拿结论 | 自己重写一份判据（v1 的四处复制即此处失守） |

- 状态刷新：管线页可见时轮询采集（复用现有 handler 轮询模式），不可见即停；`adb_channel`
  的探针按 §2.2 的 TTL 缓存节流，其余读数每轮现取。
- 动作派发也从 capability 层派生（`acquirableBy` 的 intent / 命令模板），GUI 只负责「按第一项
  可用取法发出去」。v1 的 `buttonsFor(stepId)` 硬编码 + `requestNextPermission()` 按字符串
  缺项猜动作，属违规。

## 5. 首页之外的页面集合（本期范围）

| 页面 | 内容 | 备注 |
|---|---|---|
| 管线首页 | §1 两块（段投影 = §2.3 的拓扑视图） | 入口 Activity |
| S0 配对引导页 | 三步指引 + 状态回显（等码/已收到/配对中/成功/失败原因） | 打开即挂输码通知；离开即销毁（不常驻） |
| 能力明细页 | §2.2 登记表逐项 + 每项按其 `acquirableBy` 首项派发 | 段行「去处理」直达；DO 缺席时静默项自动落到 USER_TAP |
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

## 7. 真机验证清单（PLP120 / Android 17 已定罪，2026-09-25）

| # | 验证项 | 判据 | 定罪结果 |
|---|---|---|---|
| ① | 下拉通知栏快捷回复时「无线调试/配对设备」对话框存活；RemoteInput intent 可达 Service | 输码后对话框仍在、码仍有效；intent 侧收到码 | **成立**。端到端已从零跑通一次配对（对话框不碎，SPAKE2 成功，`state.json` 落盘） |
| ② | NsdManager 能否 browse 到 `_adb-tls-pairing._tcp` 与 `_adb-tls-connect._tcp` | 两条记录各至少一次解析出端口 | **成立**。且发现 connect 记录在配对**之后仍继续轮换**（→ §3.1 推论与 `adb_channel` 活探针判据） |
| ③ | `android.settings.WIRELESS_DEBUGGING_SETTINGS` 深链在 ColorOS 是否响应 | intent 直达无线调试开关页 | **不成立**。无 Activity 响应 ⇒ 主路径落点只能是开发者选项页（登记表 `dev_options`/`wireless_debug` 两项的 USER_TAP 同一页） |
| ④ | mDNS 发布时序 vs 配对码 10 分钟窗口 | browse→found 延迟 < 2s 且对话框开着期间记录在册 | **成立**，实测首记录 6~40ms。反向留案底要求：45s 内无 pairing 记录必须上屏归因（ROM 组播/对端未发布） |

## 8. 验收判据

- G0：§6 门禁 grep 0 命中；内核 CI 双绿；OTA 推到 canary 后设备面板不再出现 ADB 页，
  `/adb/status` 返回只读状态。
- G1（v2 修订，三条缺一不可）：
  1. **零 DO 全绿路径**：一台 DO 不可得的真机（装有应用分身即可）必须能从零走到 `workbench`
     放行。任何「等 S1」的 BLOCKED 都算架构缺陷 —— 这条正是 v1 的死穴。
  2. **假绿免疫**：关掉无线调试（或改端口）后，S0 必须在探针 TTL（30s）内自动变红；
     探针未跑/证据过期时不得显示 DONE。
  3. 配对主路径三步内完成，全程用户手输内容 ≤ 一个 6 位码。
- **门禁反向自证**：把 `isDeviceOwnerApp(` 随手抄进任一业务层文件，§2.5 门禁必须让 CI 变红；
  抄回去仍然绿 = 门禁是空壳，本轮不算完成。
- 首页无「状态+入口」之外的内容（人工评审一票否决制）。
