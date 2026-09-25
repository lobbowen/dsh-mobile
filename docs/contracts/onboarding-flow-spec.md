# L0 开场流程规范（F0–F6 状态机）

> 状态：**v1 定稿（2026-09-25，真机定罪后）**。
> 本文件是**运行时驱动器**的规范：App 打开后按什么顺序做、每一步的判据从哪来、
> 什么事件触发下一次转移、卡住时用户看到什么。
> [ui-onboarding-spec.md](ui-onboarding-spec.md) 的 §2.2 能力登记表继续作为**判据**的唯一事实源；
> 本文件补的是它缺失的另一半 —— **流程**。表回答「这项绿了没」，本文件回答「现在该干什么」。

---

## 0. 为什么必须另立本文件

`ui-onboarding-spec.md` 立了能力模型（判据/证据/取法/DAG/段投影），但**没有定义执行顺序**。
后果是真机上从第一步就走不下去，四处失守均可查行号：

| # | 失守 | 证据 |
|---|---|---|
| 1 | 段投影每段只给**一个**按钮，取的是段内**首个**并列最差的待办；用户看到的是一个顺序不明的按钮墙，没有「第一步做什么」 | `capability/PipelineProjection.kt:78-92`（`minByOrNull { rank(...) }` + 同 rank 取声明序首项） |
| 2 | **首启拿权限的代码在门后**：`POST_NOTIFICATIONS` 的系统弹窗只在 `MainActivity.onCreate` 发，而 MainActivity 是 S4 放行后才去的那一页 | `MainActivity.kt:104-111`；入口是 `AndroidManifest.xml:188-196`（launcher = `OnboardingActivity`） |
| 3 | **S0 主路径依赖通知，却没人保证通知可见**：输码走通知栏 RemoteInput，而 `nm.notify()` 在 Android 13+ 无 `POST_NOTIFICATIONS` 时**不抛异常、只是不显示** → 用户按下「开始配对」后通知栏什么都没有，向导永远停在「① 监听中」 | `ui/PairingProbeService.kt:171-197`（全函数无任何权限检查）；`runCatching{...}.onFailure` 只在抛异常时留案底，抓不到「静默不显示」 |
| 4 | 配对成功后**没有任何转移**：既不进面板，也不自动发起下一步采集；用户必须自己回首页、自己找按钮 | `ui/PairingProbeService.kt:161-168`（只 `renderStatus` + `notifyChanged`）；`ui/OnboardingActivity.kt:228-250`（动作全部由按钮点击驱动） |
| 5 | 「实时」只有 2s 轮询 + 30s TTL，且**页面不可见就彻底不刷新**；mDNS 已经看见端口变化，但那个事实没有喂给通道探针 | `ui/OnboardingActivity.kt:72-76`（`onDestroy` 移除 poller）、`capability/AdbChannelProbe.kt:44-49`（TTL 内直接复用缓存） |

`ui-onboarding-spec.md` §3.4 早就用「S0 依赖 S2 的能力 = 顺序倒挂」否决过 overlay 与无障碍抓码，
**但同一把尺子没量到通知权限**——第 3 条就是漏掉的那个倒挂：`adb_credentials`（S0）物理依赖
`perm:post_notifications`（S2），而表里没有任何地方登记这条依赖。

> 上表的行号是**定罪当时**的现场证据，不是现状：五条的修法就是 §1–§5，落地位置见 §2.3 的「现落点」列。
> 留旧行号是故意的 —— 规范必须说得出「为什么会写成这样」，否则下一次还会有人再犯同一版。

---

## 1. 流程总则（写死，不可裁剪）

1. **一条链，不是一张表**：开场是一个有限状态机。任意时刻只有**一个**「当前主动作」在主视图上，
   其余状态折叠成一行判据核对（首页底部）与逐项报告（`copyReport`）。
   表（段投影）降级为该核对视图，不再是首页的驱动器。
   唯一例外：「欠账但不挡路」的行（F1 剩余冲刺、F6 补齐）可以带一个**次要**动作，
   它不参与主链推进，也不许挤掉主动作 —— 阶段机用 `action` / `extra` 两个字段把这个区别写实。
2. **先拿能拿的**：App 第一次打开就把「无 ADB 也能拿到」的权限一次要完，
   再进 ADB 链。理由不是体验偏好，是物理依赖 —— 配对交互本身要发通知。
3. **检测先于引导，引导先于操作**：任何步骤在要求用户动手之前，必须已经**读过**该项的当前状态；
   已满足就直接跳过，不许让用户白走一趟设置页。
4. **转移由事件驱动，轮询只是兜底**：授权结果返回、mDNS 记录变化、Settings 键变化、配对回执
   都必须在 ≤1s 内触发重采；2s 轮询只负责「什么都没发生时也别把旧的当新的」。
5. **每步失败必有归因**：状态机的每条边都有「走不过去时上屏的那句话」，且这句话来自类型化读数
   （`ProbeOutcome` / `PairAttempt` / 缺失的 grant），不许用字符串猜测（ui-onboarding-spec §2.0 的老路）。
6. **入口判据 ≠ 能力全绿**：能进控制面板只要求「通道 + 运行时 + 内核」三项；
   其余权限是面板内各功能的**能力位**：缺了功能自己降级。补齐入口**只有一个** —— 开场页的 F6 卡；
   面板不催授权（`MainActivity.kt:95` 写明发起权属于 F1），也不挡入口。

---

## 2. 状态机定义

### 2.1 阶段表

| 阶段 | 名称 | 进入条件 | 判据（唯一事实源） | 动作（当且仅当判据未满足才发） | 出口转移 |
|---|---|---|---|---|---|
| **F0** | 环境自检 | App 打开（launcher `onCreate`） | `dev_options` / `wireless_debug` / `adb_credentials` / `adb_channel` 一次采集；`grants` 全集 | **无**（只读，不发 intent、不弹窗） | 通道已 LIVE → **F5**；凭据未在册 → **F1**；否则按缺项进 **F2** |
| **F1** | 首启授权冲刺 | F0 完成，且冲刺清单（§2.2）有未授予项 | `PermissionCenter.isGranted`（表内 RUNTIME+APPOP 档、无 ADB 也能拿的五项） | 见 §2.2 清单，**逐个**发系统弹窗/跳页，回来即重采 | **只有第 1 项（通知）未授予时 F1 才挡路**；其余欠账以次要动作留在卡上 → **F2** |
| **F2** | 引导开发者环境 | 未配对 | `Settings.Global.development_settings_enabled` / `adb_wifi_enabled`（回前台立即重采 + 可见期 2s 轮询，见 §2.3；不靠点完 600ms 猜） | 一个动作：「去开发者选项页」（深链落点唯一 —— 无线调试深链在 ColorOS 无 Activity 响应，见 [ui-onboarding-spec §7③](ui-onboarding-spec.md)） | 两个开关都 1 → **F3** |
| **F3** | 配对 | F1、F2 满足且 `credentials != PAIRED` | 活探针 + `PairAttempt`（类型化回执） | **自动**起 `PairingProbeService`（不等人点「开始配对」）：browse pairing → 通知输码 | `AttemptStore.ok == true` → **F4** |
| **F4** | 通道校验 | 刚配对完 | `AdbChannelProbe`：现问 mDNS connect 记录 → `id` 输出含 `uid=2000` | AUTO；失败 5s 冷却内允许手动「重测」 | LIVE → **F5**；DEAD 且归因为端口轮换 → 回 **F3** 提示重开对话框 |
| **F5** | 进工作台 | F0 直连或 F4 成功 | `runtime`（/status 200）+ `kernel_bundle`（自检无失败项） | AUTO：`ContainerSupervisor` 拉起；失败 → 灾难兜底诊断页 | **自动跳转**面板（本次改完不再需要用户点第二下）；S3 未绿则停在「运行时未就绪」并给重试 |
| **F6** | 补齐不挡门的能力 | 主链（F1–F5）已成立但仍有非 optional 能力未达成 | 登记表内其余项逐项（`secure:notification_listener` / `accessibility` 在通道在册时主路径为 `SILENT_VIA_ADB`） | 开场页 F6 卡的一个动作：按该项 `acquirer` 首项派发（能静默就静默，不能就跳页） | 逐项变绿；清单空 → 「全部就位」。**面板内不做任何补齐 UI** |

**F0 不上屏**：它就是首页的首次 `CapabilityEvidenceCollector.collect()`（`OnboardingActivity.refreshSoon`），
只产出读数、不产出卡片 —— 卡面从 F1 起共六张（`OnboardingFlow.SKELETON`）。

**F5 与 F6 的顺序不能反**：通道一通就静默能办的两项（通知读取、无障碍）不必挡在入口前 ——
它们留在开场页的 **F6 卡**上，用户先把主链走通、先看到面板能干什么，回来再补剩下的权限。
补齐 UI 只在开场页：面板是产品界面，不是第二个向导（§5 无流程分支红线）。

### 2.2 首启授权冲刺清单（F1，顺序固定）

| 序 | 能力 | 取法 | 为什么在这个位置 | 挡主链？ |
|---|---|---|---|---|
| 1 | `perm:post_notifications` | `RUNTIME_DIALOG` | **F3 的物理前置**：输码走通知栏（§1 总则 2）。没有它整条 ADB 主路径死在 F3 | **是** |
| 2 | `perm:battery_optimization` | `USER_TAP`（`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`，一次弹窗） | ROM 冻结是后台存活的头号死因（ColorOS HANS 定罪）；成本 = 一次点按 | 否 |
| 3 | `perm:system_alert_window` | `USER_TAP` | 面板内浮层/截屏提示依赖；跳页代价低，放在门后 | 否 |
| 4 | `perm:manage_external_storage` | `USER_TAP`（AppOps 档，Android 17 已无 shell 通道） | 落盘/日志读取用得上，但与 F3/F5 无关 | 否 |
| 5 | `perm:request_install_packages` | `USER_TAP` | 装机是面板内功能，开场拿它只是省一次以后的跳转 | 否 |

顺序与名单的**代码事实源**是 `OnboardingFlow.SPRINT`（本表逐项同序）。前两项的顺序由
`OnboardingFlowTest` 钉住（通知授予后冲刺首项必须变成电池），改序不改测试会红。

「挡主链？」这一列就是流程与表的分工：**第 1 项未授予 → 当前步停在 F1**；2–5 项欠着只以
次要动作留在 F1 卡上，当前步照常推进到 F2。少了这一列，「开屏先拿最大授权」就会变成
「开屏先卡五道设置页」——那是把用户挡在面板外面的另一种走不下去。

**不进冲刺**：
- `secure:notification_listener`、`accessibility` —— 有 ADB 后 `settings put secure` 静默开（F6），
  让用户手点是无谓成本；无 ADB 时才回落逐项跳页。
- `mediaprojection` —— 每次会话授权，物理不可预置。
- `device_owner` —— 加速器，且多用户设备不可得（`several users`，真机 2026-09-25）。

冲刺的容错规则：用户在**任何一项**上拒绝，流程**继续**（记为 gap，F1 卡的次要动作与 F6 清单各提示一次），
只有 `post_notifications` 被拒时 F3 必须改走降级链（§3）。

认领规则（防「同一项两处催」）：F6 的补齐清单 = 全部非 optional 且未达成的能力，**减去**
当前未成立行所认领的那些（F1→冲刺五项、F2→两个开关、F3→凭据、F4→通道、F5→运行时/内核）。
老设备走短路时 F1–F4 都是「已成立」，于是被 ROM 回收掉的授权重新落回 F6 清单 —— 这条
在 `OnboardingFlowTest.老设备打开就走短路_缺的授权落到补齐清单` 里钉着。
F3/F4 之所以在通知权限被回收后仍算成立，靠的是判据层的**实测优先**规则
（judge 直接读到为真就不下 BLOCKED，见 [ui-onboarding-spec §2.1](ui-onboarding-spec.md) 的 `requires` 条）；
否则一条被回收的授权会把整条主链判红，用户看到的是「明明能用却说不能用」。

### 2.3 转移的触发事件（实时性契约）

| 事件 | 必须发生什么 | 现落点 | 状态 |
|---|---|---|---|
| `onResume` | 作废通道缓存 + 立即全量重采 + 重新起轮询 | `OnboardingActivity.kt:87-92`（`AdbChannelProbe.invalidate()` → `refreshSoon()` → `handler.post(poller)`） | ✅ |
| RemoteInput 配对回执 | 记账 + 作废通道缓存 + 广播重采；成功即由阶段机把 F5 顶成当前步并**自动跳转** | `PairingProbeService.kt:196`、`OnboardingActivity.kt:223-228` | ✅ |
| mDNS connect 记录变化（端口轮换） | 立即作废通道缓存并写案底，不等 TTL | `PairingProbeService.kt:126-133` | ✅ |
| 权限弹窗结果 | 立即重采 | `OnboardingActivity.kt:68-75`（`RequestPermission` 回调 `refreshSoon()`）＋ `:264-277`（`dispatch` 发完动作 800ms 补采） | ✅ |
| 运行时权限**被拒**（含「不再询问」） | 弹窗不会再来 → 必须给一条能走的替代路径 | `OnboardingActivity.kt:73`（拒绝分支）→ `:294-302`（`openAppDetailsAfterDenial` 跳 `CapabilityNavigation.appDetailsIntent`） | ✅ |
| 页面不可见 | 停轮询；缓存读数不得靠 TTL 续绿（过期即降级，见 §4） | `OnboardingActivity.kt:94-97` + `AdbChannelProbe.kt:33`（`REPROBE_MS=10s` 与 `CHANNEL_TTL_MS=30s` 分层） | ✅ |
| `Settings.Global.adb_wifi_enabled` / `development_settings_enabled` 变化 | 用户从设置页回来即判定 | 靠 `onResume` 立即重采 + 可见期 2s 轮询 + 动作后 800ms 补采承担；**未注册 `ContentObserver`** | ⚠ 已知取舍 |

> 最后一条是**明写的取舍**，不是遗漏：`ContentObserver` 需要跨生命周期注册/注销与 Handler 配对，
> 而本仓唯一编译器在 CI（`docs/runbook/testing-standard.md` §2），未在本仓出现过、未经真机验证的
> 平台 API 不进入主链。现有三层兜底已把最坏延迟压到 ≤2s（页面可见）/ 0s（回前台）。
> 真机若测出「拨完开关 >2s 才变色」，再按本表补 observer，并把它变成 ✅。

---

## 3. S0 死锁的解法（本次必须先修的那一条）

`adb_credentials` 的取法是「通知栏输码」，物理依赖 `POST_NOTIFICATIONS`。规范上把这条依赖**登记进表**，
并在两处同时收口：

1. **F1 保证先拿**：冲刺清单第 1 项就是通知权限（§2.2）。
2. **F3 入口自证**：`PairingProbeService.startProbe()` 第一件事检查
   `PermissionCenter.isGranted(POST_NOTIFICATIONS)`；未授予则
   - 不发 `notify()`（发了也不显示，白挂一个探针），
   - 改为把类型化事实写进 `ProbeJournal` + 上屏「通知权限未开，无法在通知栏输码」，
     并把 F1 的第 1 项重新推给用户。
3. **登记表的真实修法**：`adb_credentials.requires` 增加 `perm:post_notifications`
   （这是 S2→S0 的**唯一**允许的反向依赖，因为它是物理依赖而非优先级偏好）。
   若 §2.5 门禁的「requires 必须指向更早声明项」因此不成立，则把通知权限能力**上移到 S0 段**
   （它本来就是开场第一步，登记在 S2 是历史错位），并保持门禁不动。

> 采纳的解法：**上移到 S0**。理由是门禁的拓扑序约束（`CapabilityCatalog.kt:250` —— `require(idx in 0 until i)`，
> 前置必须是**更早声明**的项）与「optional 不得当前置」两条都不能破；而通知权限的语义确实是
> S0 的前置而非 S2 的收获。这条改动同时移动了 `PipelineProjection` 的段归属与 golden 测试，
> 并由 `capability-single-source-gate-test.js` 规则 4 钉住（`adb_credentials.requires` 少了它就红）。

降级链（`POST_NOTIFICATIONS` 拿不到）：四段各有落点，少一段就是「按了没反应的按钮」——

1. **F1 把缺口变成动作**：冲刺第 1 项未授予时，F1 是唯一 `blocking` 的冲刺行，
   主按钮 = 「系统弹窗授权」，卡片文案直说「配对要在通知栏输码，没有它走不到下一步」。
2. **拒绝即改道详情页**：`RequestPermission` 回调拿到 `false`（勾了「不再询问」后弹窗永不再现）
   → 写案底并跳本应用详情页（`OnboardingActivity.kt:294-302`，见 §2.3 表第 5 行）。
   **明确不做**首页内联输码框：详情页足以覆盖永久拒绝，而内联框要求用户先在系统配对对话框与本
   App 之间来回切，其失焦销毁行为未在本机定罪过（[ui-onboarding-spec §7①](ui-onboarding-spec.md) 只证明了通知栏路径可用）。
3. **F3 入口自证**兜最后一格：`startProbe()` 缺权限时**不起 browse、不发 `notify()`**
   （`PairingProbeService.kt:88-104`），并置 `notificationBlocked` —— 向导因此不会停在「监听中」这种误导文案。
4. **灾难兜底**：仍走不通时导出案底（`copyReport` → 判据核对 + `ProbeJournal`），
   或退回 `bridge` 手工配对（`shell.pair`，`container/engine/src/bridge/methods.js:68`）。

---

## 4. 新鲜度与假绿免疫（把「实时」写成可判红的规则）

- **通道读数的三种有效态**：`LIVE 且 age < CHANNEL_TTL_MS(30s)` → 可显示绿；
  `LIVE 但 age ≥ TTL` → **不再绿**（判据唯一入口 `Evidence.channelLive()`，`Evidence.kt:76`；常量在 `:70`），
  并由下一次采集现探；`NEVER_RUN` → 灰色「未校验」，**永不**当作绿。
- **两个窗口不能混为一谈**：`REPROBE_MS = 10s`（`AdbChannelProbe.kt:33`，用 `:54` 判定「上次读数可否复用、
  要不要再 spawn 一次 adb」）≠ `CHANNEL_TTL_MS = 30s`（`Evidence`，判据可信期）。
  前者是成本节流，后者是假绿免疫；10s < 30s 是刻意的 —— 只要页面可见，读数在过期前一定被刷新过一次。
  事件（§2.3）通过 `AdbChannelProbe.invalidate()` **穿透**节流，0s 生效。
- **端口**：`state.json` 里的历史端口**只作为最后兜底**，每次 shell 前现问 mDNS（已实现，
  `ConnectEndpointResolver.resolve`）；探针拿到与缓存不同的 connect 端口即视为事件，立即作废缓存重探
  （`PairingProbeService.kt:126-133`）。
- 任何「绿」若超过一个可信期没有对应的现读证据支撑，UI 必须降级显示 —— 宁可黄，不可假绿。

---

## 5. 与 §2.2 段投影的关系（不推翻，只降级）

- 段投影（S0–S4 五行）**保留**，作为首页底部的判据核对行与探针期报告来源（`copyReport` 依赖它）。
- 首页主视图是 §2 的阶段卡：**当前阶段 + 一个动作 + 已通过的步骤列表**（`OnboardingFlow.stages`）。
- 放行判据改写：`workbench` 从「所有非 optional 能力 GRANTED」改为
  「`adb_channel` + `runtime` + `kernel_bundle` GRANTED」（§1 总则 6）。
  实现落点：这张三要素表只在 `PipelineProjection.kt:39-47`（`GATING` + `workbenchReady`），
  `OnboardingFlow.readyToEnter`（`OnboardingFlow.kt:70-71`）与首页自动跳转都转发它，UI 不自己算。
  **不要**把 `workbench` 建成 `Capability` —— 它的 requires 含 `adb_channel`，
  一旦入表会撞 `capability-single-source-gate-test.js` 的
  「非 optional 能力的 requires 闭包不得含 adb-channel」不变式（`ui-onboarding-spec.md` §2.5 表第 2 行）。

---

## 6. 验收判据（F 系列，缺一不可）

1. **全新安装、零 DO、零 adb 手工干预**：打开 App → 第一个要求是**通知**（RUNTIME 弹窗）→
   给了之后当前步立刻变成「去开发者选项页」，电池/悬浮窗/存储/安装以**次要**动作留在 F1 卡上
   （点不点都能往下走）→ 回来自检两个开关 → 通知**自动**出现「等待配对码」→ 输一个 6 位码 →
   **自动**进入控制面板。走完主链所需的主行动点击数 ≤ 3（通知弹窗确认 / 去开发者选项页 / 输码）；
   F6 的补齐动作全在开场页卡上，不计入主链。
2. **通知缺席必须可见**：拒绝通知权限后，S0 向导不得显示「监听中」这种误导文案，
   必须明确「通知权限未开 → 无法在通知栏输码」（§3 第 1 段），且再点一次该动作能落到
   本应用详情页（§3 第 2 段）——替代路径必须真实可走，不接受「按钮按了没反应」。
3. **假绿免疫**：关掉无线调试或端口轮换后，页面可见时 ≤10s、回前台时 ≤1s 内变黄/红。
4. **配对即跳转**：配对回执成功且通道 LIVE 后，不需要用户再点任何按钮就到达面板（F5 自动化）。
5. **门禁同步**：§3 的 `perm:post_notifications` 归属变更、§5 的放行判据变更，
   都要有 golden 测试用例钉住（能红：把放行改回「全绿」时测试必须失败）。
6. **主行动唯一性**：任意读数下 `OnboardingFlow.stages()` 至多一行带 `action`；
   带 `extra` 的行只可能是「未成立且不挡路」的 F1/F6。
   这条同时由 `OnboardingFlowTest` 与 CI 侧
   `capability-single-source-gate-test.js` 的规则 4（配对的 requires 必含通知、冲刺首项不得自带 requires）守住。
