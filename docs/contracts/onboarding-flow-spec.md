# L0 开场流程规范（P0 静默冲刺 + F1–F4 阶段链）

> 状态：**v2（2026-09-25，第二次真机定罪后）**。v1 把「拿授权」做成了首页上的一排卡，
> 真机结论是：**开屏授权是默认行为，不是用户要读的一页**；而「开始配对」按下去既不检环境
> 也不跳页、端口读数还是上一轮的 —— 三条一起把流程改成本文件的三段式（§2）。
> 本文件是**运行时驱动器**的规范：App 打开后按什么顺序做、每一步的判据从哪来、
> 什么事件触发下一次转移、卡住时用户看到什么。
> ⚠ 本文内的 `file:line` 是**写作时**的落点，源码演进后会漂移；判据以**语义与符号名**为准，行号仅供定位。
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
| 5 | 「实时」只有 2s 轮询 + 30s TTL，且**页面不可见就彻底不刷新**；mDNS 已经看见端口变化，但那个事实没有喂给通道探针 | `ui/OnboardingActivity.kt:121-125`（`onDestroy` 移除 poller）、`capability/AdbChannelProbe.kt:44-49`（TTL 内直接复用缓存） |

`ui-onboarding-spec.md` §3.4 早就用「S0 依赖 S2 的能力 = 顺序倒挂」否决过 overlay 与无障碍抓码，
**但同一把尺子没量到通知权限**——第 3 条就是漏掉的那个倒挂：`adb-credentials`（S0）物理依赖
`post-notifications`（S2），而表里没有任何地方登记这条依赖。

> 上表的行号是**定罪当时**的现场证据，不是现状：五条的修法就是 §1–§5，落地位置见 §2.3 的「现落点」列。
> 留旧行号是故意的 —— 规范必须说得出「为什么会写成这样」，否则下一次还会有人再犯同一版。

---

## 1. 流程总则（写死，不可裁剪）

1. **一条链，不是一张表**：开场是一个有限状态机。任意时刻只有**一个**「当前主动作」在主视图上，
   其余状态折叠成一行判据核对（首页底部）与逐项报告（`copyReport`）。
   表（段投影）降级为该核对视图，不再是首页的驱动器。
   唯一例外：「欠账但不挡路」的行（F4 补齐）可以带一个**次要**动作，
   它不参与主链推进，也不许挤掉主动作 —— 阶段机用 `action` / `extra` 两个字段把这个区别写实。
2. **拿授权是默认行为，不是一页界面**：App 一打开（`onCreate` 后的第一次采集完成时）就把
   「无 ADB 也能拿到」的权限**依次静默**抛给系统弹窗/系统授权页（§2.2 的 P0），
   界面上**不出现**任何「请先授权」的卡片或按钮。理由不是体验偏好，是物理依赖 ——
   配对交互本身要发通知，而通知必须在用户第一次点「配对」之前就位。
   **保活锚（无障碍 / 通知读取 / 电池豁免）同样属于这一档**：它们不需要 ADB 就能拿，
   而缺了它们就没有「持续在线的运行时」可谈（2026-09-26 真机定罪「锁屏之后 App 被清理掉」，
   见 [ADR-0006 §2.4](../adr/0006-background-lifecycle-keepalive.md)）。旧版本按「能静默办就不打扰」
   把它们推到 F4，正是那条循环依赖的成因 —— 没有锚就没有通道，没有通道就永远静默不了。
3. **检测先于引导，引导先于操作**：任何步骤在要求用户动手之前，必须已经**读过**该项的当前状态；
   已满足就直接跳过，不许让用户白走一趟设置页。用户点「配对」那一下尤其如此：
   那一刻现场重采一次，按缺项把用户送到**能修那个缺项**的那一页（§2.1 F1 的 `PairingGate`），
   而不是先跳进设置页再指望他自己知道该拨哪个开关。
4. **转移由事件驱动，轮询只是兜底**：授权结果返回、mDNS 记录**出现或消失**、Settings 键变化、
   配对回执都必须在 ≤1s 内触发重采；2s 轮询只负责「什么都没发生时也别把旧的当新的」。
5. **每步失败必有归因**：状态机的每条边都有「走不过去时上屏的那句话」，且这句话来自类型化读数
   （`ProbeOutcome` / `PairAttempt` / 缺失的 grant），不许用字符串猜测（ui-onboarding-spec §2.0 的老路）。
6. **入口判据 ≠ 能力全绿**：能进控制面板只要求「通道 + 运行时 + 内核」三项；
   其余权限是面板内各功能的**能力位**：缺了功能自己降级。补齐入口**只有一个** —— 开场页的 F4 行；
   面板不催授权（`MainActivity.kt:95` 写明发起权属于开场页），也不挡入口。
7. **读数只在册才算数**：配对端口来自 `_adb-tls-pairing._tcp`，而这条记录只在系统配对对话框
   打开期间存在。因此「端口」不是一个记住的整数，而是**此刻有没有这条记录**：记录消失即作废读数
   （§2.3），无在册端点时**不发起配对**、不伪造地址（§4）。这一条是 v2 的立论核心 ——
   它决定「后面的流程对不对」有没有意义。
8. **运行时是底座，不是流程中间的一步**：权限给足之后它就应该持续在线（安装即由常驻链拉起，
   见 [ADR-0006 §2.4](../adr/0006-background-lifecycle-keepalive.md)）。因此开场流程里
   **不存在**「启动/重启运行时」这个动作 —— 该动作的实现是 destroy 正在跑的内核，
   把它交给界面等于让用户"点开界面就崩"（2026-09-26 定罪）。F3 只给一条「看启动日志」的观测路，
   运行时死活归监督链。这条边界由门禁 `运行时重启动作的归属` 钉住（`ACTION_RESTART` 只许住在
   实现它的服务与诊断兜底页）。
9. **每一次用户输入都要落一条结论**：配对输码的每一次送达（含空码、端口不在册、上一次仍在进行）
   都进 `AttemptStore` 时间线，并顶到探针通知与首页「最近动作」的第一行；成功另发一条 heads-up。
   「在无数次输入里莫名其妙地成功」是 2026-09-26 的定罪原话 —— 沉默的失败与沉默的成功同样是黑盒。

---

## 2. 状态机定义

### 2.1 阶段表

| 阶段 | 名称 | 上屏？ | 进入条件 | 判据（唯一事实源） | 动作（当且仅当判据未满足才发） | 出口转移 |
|---|---|---|---|---|---|---|
| **P0** | 首启授权冲刺 | **否**，静默 | 每次采集完成且冲刺清单（§2.2）仍有未授予项 | `PermissionSprint.ORDER`（由登记表推导，不手写第二张清单） | 链首项的**取法链首项**（`RUNTIME_DIALOG` / `USER_TAP`），一次一步、等系统把结果交回来才继续；仅 resumed 时推进 | 清单走完 → 界面上只剩 F1–F4 的四行 |
| **F1** | 无线配对 | 是 | `credentials != PAIRED` | `adb-credentials`（PAIRED / `PairAttempt` 失败归因 / ACTION） | 「开始配对」= `USER_CODE`。按下的**同一瞬间**做三件事：① 起 `PairingProbeService`（browse 必须早于系统配对对话框，才接得住那条记录）；② 现场重采一次 → `PairingGate.decide` → **缺哪个前置就送去那个前置自己的取法链首项**，前置全齐则跳无线调试页；③ **冻结 P0 冲刺 5 分钟**（到期自动解冻）—— 用户此刻在系统页输码，从那里回到本界面的那一帧再把他抛进下一个授权页，就是「回到界面一堆乱七八糟」的原型 | 通知栏输码 → `AttemptStore.ok == true` → **F2** |
| **F2** | 通道校验 | 是 | 凭据在册 | `AdbChannelProbe`：现问 mDNS connect 记录 → `id` 输出含 `uid=2000` | AUTO「重测通道」；DEAD 且归因为端口轮换 → 回 **F1** 提示重开对话框 | LIVE → **F3** |
| **F3** | 进入工作台 | 是 | 通道 LIVE | `runtime`（/status 200）+ `kernel-bundle`（自检无失败项），即 `PipelineProjection.GATING` 三要素 | **只观测、不拉起也不重启**：未绿的运行时给「看运行时启动日志」（`USER_TAP` → 诊断页），内核自检给 AUTO「重跑」。拉起责任在常驻链（`Application.onCreate` 戳 `ContainerSupervisor`，总则 8），不在这一行。三要素齐 → **自动跳转**（另置「进入工作台」按钮，未放行时禁用，比点了没反应诚实） | 进面板；S3 未绿则停在「运行时未就绪」并给一条看日志的路 |
| **F4** | 补齐不挡门的能力 | 是 | 主链（F1–F3）已成立但仍有非 optional 能力未达成 | 登记表内其余项逐项（`notification-access` / `accessibility` 在通道在册时主路径为 `SILENT_VIA_ADB`） | 该行的**一个次要**动作：按该项 `acquirer` 首项派发（能静默就静默，不能就跳页） | 逐项变绿；清单空 → 「全部就位」。**面板内不做任何补齐 UI** |

**P0 与「环境自检」都不上屏**：P0 是 `OnboardingActivity.advanceSprint()`（每次 `render` 后推进一步），
自检就是首次 `CapabilityEvidenceCollector.collect()`。两者只产出读数与系统弹窗，**不产出卡片** ——
首页卡面从 F1 起共四张（`OnboardingFlow.SKELETON`）。

**v1 的 F2「引导开发者环境」为什么不再是一行卡**：开发者选项与无线调试是 `adb-credentials` 的
**硬前置**（登记表 `requires`），把它们排成「开屏第二步」等于要求用户在没打算配对时先跑一趟设置页，
而且这一行和 F1 冲刺谁先上屏说不清（v1 真机上就是靠轮询顺序随机挑的）。现在它们只在**用户表达
配对意图的那一瞬间**被现场核对、按缺项引导 —— 判据住在 `PairingGate`，UI 不自己 `if (devOptionsOn)`。

**F3 与 F4 的顺序不能反**：F3 是「入口」，F4 是「不挡门的欠账」。旧版本把保活锚
（通知读取、无障碍）留在 F4，理由是「通道一通就能静默办」—— 那是循环依赖（总则 2）：
锚不在 → :main 被冻结清理 → 通道与运行时一起死 → 那条静默通道永远等不到。现在锚在 P0
就要掉，F4 只兜「P0 被拒 / 后来被 ROM 回收」的欠账。
补齐 UI 只在开场页：面板是产品界面，不是第二个向导（§5 无流程分支红线）。

### 2.2 P0 首启授权冲刺（静默，顺序由登记表推导）

冲刺清单**不是手写的第二张表**：`PermissionSprint` 从能力登记表推导出三段，
`ORDER = REQUIRED + ANCHORS + OPTIONAL`（`capability/PermissionSprint.kt`）。

| 段 | 来源 | 当前推导结果（改登记表 → 本列自动变） | 挡主链？ |
|---|---|---|---|
| `REQUIRED` | `requiresInOrder(adb-credentials)` ∩ 权限档 | `post_notifications` | **是**：它是 F1 输码的物理前置（§1 总则 2、§3） |
| `ANCHORS` | 登记表 `keepAliveAnchor = true` ∧ 不在 `REQUIRED` | `battery_optimization` → `notification_access` → `accessibility` | **是（长期）**：缺了就「锁屏被清」，运行时与通道一起没了（总则 2、ADR-0006 §2.4） |
| `OPTIONAL` | 权限档 ∧ 无 requires ∧ 非 optional ∧ 非锚 | `manage_external_storage` → `request_install_packages` → `system_alert_window` | 否，纯「现在拿最便宜」 |

「必要项在前」是硬事实：通知排在最前不是审美，是没通知就没有输码入口。
锚紧随其后：它们要的是系统页（无障碍）或一次性豁免（电池），闹一次就永久有效。
`OPTIONAL` 内部顺序 = 登记表声明序（`requires` 是 Set，迭代序不确定，不许流到用户动作序列上 ——
唯一允许的归一是 [CapabilityCatalog.requiresInOrder]，要把某项提前就挪它的声明位置）。
`ANCHORS` 同理取声明序；**新增锚只许改登记表的 `anchor` 位，手写第二张清单即违反总则 2**。

**不进冲刺**（每条都是判据，不是偏好）：
- `mediaprojection` —— 每次会话授权，物理不可预置。
- `device_owner` —— 加速器，且多用户设备不可得（`several users`，真机 2026-09-25）。
- `dev-options` / `wireless-debug` —— 环境开关不是「授权」，由 F1 的现场判定引导（§2.1）。

SECURE_SETTINGS 档的两项锚（`notification_access`、`accessibility`）**双轨**：它们在取法链里
仍保留 `SILENT_VIA_ADB` 主位（通道在册时先静默办，`permAcquirers` 决定），P0 拿到的是链首项 ——
于是「通道已通的老实设备」不会被人点一次无障碍页，「全新设备」也不会等到永远不来的通道。
这条由 `PermissionSprintTest.保活锚从登记表推导_不是手写第二张清单` 钉住。

容错规则：链**一次一步**，抛给系统后就等这一页的结果（`sprintWaiting`），回前台才续下一步；
`pending(e, asked)` 保证**一次开屏只闹一回** —— 用户在某项上拒了，不再把他推回同一个系统页，
欠账交给 F4 补齐行由用户主动催（`OnboardingActivity.kt:259-270`）。
只有 `post_notifications` 被拒时 F1 必须改走降级链（§3）。

认领规则（防「同一项两处催」）：F4 的补齐清单 = 全部非 optional 且未达成的能力，**减去**
当前未成立行所认领的那些（F1→配对的 `requires` + 凭据本身、F2→通道、F3→运行时/内核，
见 `OnboardingFlow.F1_OWNS` 等，`capability/OnboardingFlow.kt:53-57`）。
已配对的老设备走短路时 F1–F3 都是「已成立」，于是被 ROM 回收掉的授权重新落回 F4 清单 ——
这条在 `OnboardingFlowTest.已配对后通知被回收_欠账落到补齐行而不是消失` 里钉着。
F1/F2 之所以在通知权限被回收后仍算成立，靠的是判据层的**实测优先**规则
（judge 直接读到为真就不下 BLOCKED，见 [ui-onboarding-spec §2.1](ui-onboarding-spec.md) 的 `requires` 条）；
否则一条被回收的授权会把整条主链判红，用户看到的是「明明能用却说不能用」。

### 2.3 转移的触发事件（实时性契约）

| 事件 | 必须发生什么 | 现落点 | 状态 |
|---|---|---|---|
| 首次采集完成 | P0 冲刺抛出链上第一项（系统弹窗/系统页），界面上不出现「请先授权」 | `OnboardingActivity.kt:253`（`render` 末尾 `advanceSprint(e)`）＋ `:259-270` | ✅ |
| `onResume` | 作废通道缓存 + 立即全量重采 + 重新起轮询 + 放开冲刺 | `OnboardingActivity.kt:104-112` | ✅ |
| 用户点「开始配对」 | **同一瞬间**起探针 + 现场重采 + 按缺项跳页（缺开关→能拨开关的页，缺通知→授权弹窗，全齐→无线调试页） | `OnboardingActivity.kt:361-386`（`startPairing`）＋ `capability/PairingGate.kt:25` | ✅ |
| mDNS **pairing 记录出现** | 端口/主机进读数，通知文案切成「可输码」 | `ui/PairingProbeService.kt:130-134` | ✅ |
| mDNS **pairing 记录消失**（对话框关了） | **立即作废端口读数**，通知退回「等记录」；此后任何输码都不发起配对 | `bridge/MdnsWatcher.kt:32`（`Sink.onLost`）→ `ui/PairingProbeService.kt:152-171` | ✅ |
| mDNS connect 记录变化（端口轮换）/ 消失 | 作废通道缓存并写案底，不等 TTL | `ui/PairingProbeService.kt:136-144`（变化）、`:162-168`（消失） | ✅ |
| RemoteInput 配对回执 | 记账 + 作废通道缓存 + 广播重采；成功即由阶段机把 F2 顶成当前步。**每一次送达都落一条结论**（含空码 / 端口不在册 / 仍在进行），结论行顶到探针通知第一行并响一次 heads-up | `ui/PairingProbeService.kt`（`handleCode` → `conclude` / `notifyConclusion`） | ✅ |
| 结论停留 | `onLost`（对话框关了）只作废**端口读数**，不许把结论行刷回「等待记录」—— 否则用户以为什么都没发生（2026-09-26 定罪） | `PairingProbeService.renderStatus` 的 `history.firstOrNull()` 顶行 + 首页「最近动作」同源 | ✅ |
| 权限弹窗结果 | 立即重采 + 放开冲刺链走下一步 | `OnboardingActivity.requestRuntimePerm`（`RequestPermission` 回调）＋ `REFRESH_AFTER_TAP_MS`（任何动作发完补采） | ✅ |
| 运行时权限**被拒**（含「不再询问」） | 弹窗不会再来 → 必须给一条能走的替代路径 | `OnboardingActivity.requestRuntimePerm` → `openAppDetailsAfterDenial`（跳 `CapabilityNavigation.appDetailsIntent`） | ✅ |
| 页面不可见 | 停轮询、冲刺不再抛新系统页；缓存读数不得靠 TTL 续绿（过期即降级，见 §4） | `OnboardingActivity.onResume` / `onPause` + `AdbChannelProbe.kt:33` | ✅ |
| `Settings.Global.adb_wifi_enabled` / `development_settings_enabled` 变化 | 用户从设置页回来即判定 | 靠 `onResume` 立即重采 + 可见期 2s 轮询 + 动作后 800ms 补采承担；**未注册 `ContentObserver`** | ⚠ 已知取舍 |
| 解锁 / 亮屏 | 常驻链被重新戳一次（运行时与桥随之回来），界面不必在场 | `NodeContainerApp.registerWakeupEdges()` 动态注册 `ACTION_USER_PRESENT` / `ACTION_SCREEN_ON` → `ContainerSupervisor.ensureRunning` | ✅ |
| 进程被整体杀掉 | **不复活，只定罪**：被杀之后把壳点回来没有意义（内核重启即把 running/pending 判 failed，`kernel/src/platform/tasks.js` 的 `_load`），且复活后的「运行时在线」是假信息。要做的是让打断**一定看得见** | `lifecycle/ResidencyAudit.kt`（每拍心跳落盘 / 只有 onDestroy 留 clean 戳 / 开机基准区分设备重启）→ 结论单一文案源，消费方 `ContainerSupervisor.statusLine()`、`OnboardingActivity.recentActions()`、导出报告 | ✅ |

> 最后一条是**明写的取舍**，不是遗漏：`ContentObserver` 需要跨生命周期注册/注销与 Handler 配对，
> 而本仓唯一编译器在 CI（`docs/standards/testing.md` §2），未在本仓出现过、未经真机验证的
> 平台 API 不进入主链。现有三层兜底已把最坏延迟压到 ≤2s（页面可见）/ 0s（回前台）。
> 真机若测出「拨完开关 >2s 才变色」，再按本表补 observer，并把它变成 ✅。

---

## 3. S0 死锁的解法（v1 真机上第一步就断的那一条）

`adb-credentials` 的取法是「通知栏输码」，物理依赖 `POST_NOTIFICATIONS`。规范上把这条依赖**登记进表**，
并在三处同时收口：

1. **P0 保证先拿**：冲刺的必要项就是它（§2.2 的 `REQUIRED`，由 `requires` 推导），
   App 打开的第一次采集后就是它上弹窗 —— 不是等用户点了什么才要。
2. **F1 入口自证**：`PairingProbeService.startProbe()` 第一件事检查
   `PermissionCenter.isGranted(POST_NOTIFICATIONS)`（`ui/PairingProbeService.kt:98-113`）；未授予则
   - 不发 `notify()`（发了也不显示，白挂一个探针），也不起 browse，
   - 把类型化事实写进 `ProbeJournal`、置 `notificationBlocked`，让 F1 行上屏
     「通知权限缺失 → 输码通知发不出去」（`ui/OnboardingActivity.kt:234-237`）。
3. **登记表的真实修法**：`adb-credentials.requires` 实名带着 `post-notifications`
   （`capability/CapabilityCatalog.kt:88`；这是 S2→S0 的**唯一**允许反向依赖，因为它是物理依赖而非优先级偏好）。
   拓扑序约束（`capability/CapabilityCatalog.kt:263` —— `require(idx in 0 until i)`，前置必须是**更早声明**的项）
   与「optional 不得当前置」两条都不能破，所以采的解法是**把通知权限能力上移到 S0 段**
   （它本来就是开场第一步，登记在 S2 是历史错位）。
   这条改动由 `capability-single-source-gate-test.js` 的 DAG 规则 4 钉住
   （`adb-credentials.requires` 少了它就红；通知自己带 requires 也红）。

降级链（`POST_NOTIFICATIONS` 拿不到）：四段各有落点，少一段就是「按了没反应的按钮」——

1. **F1 把缺口变成动作**：`PairingGate.decide` 读到通知未授予（且两个开关已齐）时，
   jump 就是通知自己的取法链首项 = `RUNTIME_DIALOG`（`capability/PairingGate.kt:25-42`），
   toast 直说「还差一步：通知发送」。
2. **拒绝即改道详情页**：`RequestPermission` 回调拿到 `false`（勾了「不再询问」后弹窗永不再现）
   → 写案底并跳本应用详情页（`ui/OnboardingActivity.kt:84-92` → `:404-412`，见 §2.3 表第 9 行）。
   **明确不做**首页内联输码框：详情页足以覆盖永久拒绝，而内联框要求用户先在系统配对对话框与本
   App 之间来回切，其失焦销毁行为未在本机定罪过（[ui-onboarding-spec §7①](ui-onboarding-spec.md) 只证明了通知栏路径可用）。
3. **F1 入口自证**兜最后一格：`startProbe()` 缺权限时**不起 browse、不发 `notify()`**，
   并置 `notificationBlocked` —— 向导因此不会停在「监听中」这种误导文案。
4. **灾难兜底**：仍走不通时导出案底（`copyReport` → P0 冲刺实况 + 配对现场判定 + 判据核对 + `ProbeJournal`），
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
- **端口不是整数，是「这条记录此刻在不在册」**（§1 总则 7）：
  - pairing 记录：出现才写入 `pairingHost/pairingPort` 并置 `pairingLive`（`ui/PairingProbeService.kt:130-134`）；
    消失即整组作废（`:145-154`）。**无在册端点就不发起配对**（`:190-198`），
    也**绝不**回落一个编造地址 —— 历史上的 `127.0.0.1` 回落把「没发现」伪装成「配对失败」，
    用户于是对着一个从没存在过的端口重试。该写法已由门禁零容忍
    （`capability-single-source-gate-test.js` 的 `FORBIDDEN`）。
  - connect 记录：与缓存不同即作废通道缓存（`:129-137`）；记录消失同样作废端点与通道缓存（`:155-161`）。
  - `state.json` 里的历史端口**只作为连接侧的最后兜底**，每次 shell 前现问 mDNS
    （已实现，`ConnectEndpointResolver.resolve`）；配对侧没有兜底一说 —— 没记录就是没有。
  - browse 的重入门槛同样是 `pairingLive` 而不是「曾经见过端口」（`:112`）：端口在册时重复点「开始配对」
    不重抖 browse（stop/start 会丢记录），不在册则一律重挂监听。
- 任何「绿」若超过一个可信期没有对应的现读证据支撑，UI 必须降级显示 —— 宁可黄，不可假绿。

---

## 5. 与 §2.2 段投影的关系（不推翻，只降级）

- 段投影（S0–S4 五行）**保留**，作为首页底部的判据核对行与探针期报告来源（`copyReport` 依赖它）。
- 首页主视图是 §2 的阶段卡：**四行（F1–F4）+ 至多一个主行动**（`OnboardingFlow.stages`）。
  P0 冲刺与 F1 的现场判定都**不占**卡位 —— 它们是行为，不是待办条目。
- 放行判据：`workbench` = 「`adb-channel` + `runtime` + `kernel-bundle` GRANTED」（§1 总则 6）。
  实现落点：这张三要素表只在 `PipelineProjection.kt:39-47`（`GATING` + `workbenchReady`），
  `OnboardingFlow.readyToEnter`（`capability/OnboardingFlow.kt:59-60`）与首页自动跳转都转发它，UI 不自己算。
  **不要**把 `workbench` 建成 `Capability` —— 它的 requires 含 `adb-channel`，
  一旦入表会撞 `capability-single-source-gate-test.js` 的
  「非 optional 能力的 requires 闭包不得含 adb-channel」不变式（`ui-onboarding-spec.md` §2.5 表第 2 行）。

---

## 6. 验收判据（F 系列，缺一不可）

1. **全新安装、零 DO、零 adb 手工干预**：打开 App 第一眼就是四行阶段卡，**唯一主按钮 = 「开始配对」**，
   页面上**没有任何**「请先授权」的卡（§2.1 P0 不上屏）；系统弹窗在此刻自动出现，第一项必是通知。
   给完授权 → 点配对 → 缺开关就 toast + 跳到能拨开关的页 → 拨完回前台 → 再点配对 → 落到无线调试页 →
   点「与配对设备配对」→ 通知栏出现「配对端口 NNNNN 在册」→ 输 6 位码 → **自动**进面板。
   本 App 自己的按钮在全新安装上至多点 **2 次**（第一次被引导去开环境、第二次直达），其余点击都发生在系统页里。
2. **端口只在册才算数**（v2 新增，真机可判红）：配对对话框**关闭**后，通知文案必须退回
   「等待 mDNS 记录」，此时输码必须立刻得到「配对端口不在册 —— 请让对话框保持打开」，
   **不许**出现 30s 超时或任何编造地址（§4 第一条）。
3. **通知缺席必须可见**：拒绝通知权限后，S0 向导不得显示「监听中」这种误导文案，
   必须明确「通知权限缺失 → 输码通知发不出去」（§3 第 2 条），且再点一次该动作能落到
   本应用详情页（§3 降级链第 2 段）——替代路径必须真实可走，不接受「按钮按了没反应」。
4. **假绿免疫**：关掉无线调试或端口轮换后，页面可见时 ≤10s、回前台时 ≤1s 内变黄/红。
5. **配对即跳转**：配对回执成功且通道 LIVE、三要素齐后，不需要用户再点任何按钮就到达面板（F3 自动化）。
6. **门禁与 golden 同步**（每条都要能红，红在 CI 而不是靠人记住）：
   - §3 的 `post-notifications` 归属、§5 的放行判据 → DAG 规则 4 + golden；
   - 冲刺清单由登记表推导（手写第二张锚清单 / 把锚从 `ORDER` 里摘掉 → `PermissionSprintTest.保活锚从登记表推导_不是手写第二张清单` 红）；
   - 深链 action 与 mDNS 服务类型串只许住一处（`capability/CapabilityNavigation.kt`、`bridge/MdnsWatcher.kt`）；
   - 编造端点 `"127.0.0.1"` 零容忍（`FORBIDDEN`，且该规则自带样本自证，正则写坏就红）；
   - 运行时的「重启」动作不得回到开场界面（`ACTION_RESTART` 归属规则）；常驻链的边（Application 戳监督者 / 解锁广播 / `startForeground` / 定罪的 `auditPreviousExit`+`heartbeat`+`markCleanStop`+`interruption` 上屏）与 manifest `specialUse` 必须同时在场（`KEEP_ALIVE_EDGES`，缺一条即红）；**被用户否决的进程外复活边词汇（`SelfHeal` / `JobScheduler` / `JobService` / `setPeriodic` / `BIND_JOB_SERVICE`）列入 DEAD，连注释再出现即红**；通知 id 全仓唯一（撞号即红，真机案底：1002 曾被两处抢）。
7. **主行动唯一性**：任意读数下 `OnboardingFlow.stages()` 至多一行带 `action`；
   带 `extra` 的行只可能是未成立的 F4；F1 若给动作，它必是 `USER_CODE`（点了必然起探针）。
8. **运行时是常驻底座（真机可判红，§1 总则 8）**：全新安装后**不进任何界面**、只解锁屏幕，
   :node 与控制面就该在线（常驻边拉起，**不依赖任何"复活"机制**）；锁屏 5 分钟后解锁，
   常驻状态通知仍在且点按进首页；开场界面上**找不到**任何「启动/重启运行时」按钮
   （F3 只有「看运行时启动日志」）。
9. **配对有声（§1 总则 9，真机可判红）**：在通知栏每按一次「输入配对码」发送，
   探针通知的第一行立刻变成「第 N 次 HH:mm:ss 成功/失败：<归因>」并响一次 heads-up；
   关掉配对对话框（`onLost`）之后该结论行仍在；回到开场页，标题下的「最近动作」
   与通知说的是**同一句话**（同源 `AttemptStore.humanPairTimeline`）。
10. **冲刺不抢前台（§2.1 F1 的 ③）**：点「开始配对」后 5 分钟内，从系统页回到本界面
    不得被自动抛进下一个授权页；到期后冲刺自动续走（无需任何人解锁）。
11. **打断必须可见（§2.3 最后一行，ADR-0006 §2.1「不做复活」）**：设置里「强行停止」后重开
    → 常驻通知首行、首页第一块、导出报告三处都写同一句定罪文案（同源
    `ResidencyAudit.interruption()`）；`am stop-service` 之后重开**不该**出现该句
    （`markCleanStop` 的 clean 戳生效）；整机重启后首启文案是"结束于设备重启"而不是"被回收"。
    本条存在的理由：复活边已被否决，若被杀还静默显示「运行时在线」，判据层就自己在造假绿。
