# ADR-0007：L0 GUI 开场管线（S0–S4）与 S0 无线 ADB 配对交互 —— 通知栏 RemoteInput + mDNS 自动发现，禁 Activity 抢焦点

- 状态：**已决定**（2026-09-25；主路径细节待 §5 真机验证清单定罪，未定罪前不得写死）
- 关联：[ADR-0001 执行域](0001-android-execution-domain.md) · [ADR-0005 内核只走 OTA](0005-kernel-via-ota-only.md) · [ADR-0006 后台生命周期](0006-background-lifecycle-keepalive.md) · 完整设计见 [ui-onboarding-spec.md](../contracts/ui-onboarding-spec.md)

---

## 1. 问题

产品目前是无 GUI 的工程态：打开 APK 只有诊断流水文本 + 内核面板 WebView。要把它变成可交付
的「极客工作台」，必须回答两件事：

1. **首页承载什么？** 用户已拍板：首页 = 纯状态 + 入口，不做信息集合；真正的操作入口是
   打开控制面板（内核 UI）之后。
2. **S0（无线 ADB 配对）怎么交互？** 这是全部自动化的起点（拿到 ADB 通道后，DO 配置、
   权限补授都尽可能自动/引导）。难点：系统的「无线调试」配对对话框**一经失焦即销毁**
   （配对码随之消失），页面一关就连不上。若在配对期间打开我们自己的页面抢焦点，等于
   亲手毁掉用户手里唯一的码。这是本 ADR 的核心决策点。

## 2. 决定

### 2.1 开场管线 = S0→S4 五段状态机（L0 原生 GUI）

```
S0 ADB 通道 → S1 Device Owner → S2 权限集 → S3 运行时+内核就绪 → S4 工作台（进控制面板）
```

- 五段顺序即依赖顺序：ADB 是杠杆（未配 DO 前 shell 可 `dpm set-device-owner`），DO 是
  权限主路径（Android 17 实测 shell 已不能 `pm grant`/`appops set`，DO 经
  `setPermissionGrantState` 静默授予），权限齐了才有高质量的 S3，S3 绿了才谈 S4。
- 首页只渲染这五段的状态摘要 + 一个大入口；每段的引导细节在各自的次级页。
- 技术选型：**原生 View + Material**（不上 Compose；minSdk24/targetSdk28 下 Compose 收益为
  负、包体与坑都不划算）。检测逻辑全部放 `permissions/`、`lifecycle/` 的**纯函数**（JVM
  单测可钉死），GUI 只做两件事：渲染状态、发 intent。现有诊断文本面板降级为「灾难兜底
  页」保留（自检/复制/重试/授权截屏四按钮不删）。

### 2.2 S0 配对交互 = 通知栏 RemoteInput 输码 + mDNS 自动发现，绝不抢焦点

- **配对码输入走通知栏快捷回复（RemoteInput）**，PendingIntent 挂到 `:main` 的 Service，
  **不拉起任何 Activity** —— 通知栏下拉不销毁系统设置页，用户的配对码对话框原地存活。
- **端口发现走 mDNS**（NsdManager + multicast lock）：
  `_adb-tls-pairing._tcp` 记录只在配对对话框打开期间在册（配对用），
  `_adb-tls-connect._tcp` 在无线调试开关期间常驻（连接用）——用户不手输任何 IP:Port。
- 降级链：mDNS 不可用 → 通知栏里手动输 host:port（仍不离开设置页）→ 都失败才回落
  既有 `shell.pair` 桥方法的完整手工路径。
- **反馈契约（2026-09-26 修订补入，用户定罪「整个配对过程完全黑盒」）**：主路径不抢焦点的
  代价是用户看不见我方界面，因此**通知必须承担全部反馈**——
  ① 每一次输码送达（含空码、端口不在册、上一次仍在进行）都落一条类型化结论
  （`AttemptStore` 时间线），顶到探针通知第一行并响一次 heads-up；
  ② 结论行不随 `onLost` 消失（关框只作废**端口读数**，不许把「已配对」刷回「等待记录」）；
  ③ 回到开场页时，标题下「最近动作」与通知说同一句话（同一份 `humanPairTimeline`）。
  这三条与「不拉 Activity」不是两个方案，是同一个方案的两半：入口在通知栏，反馈就在通知栏。
- 被否决的替代方案：
  - ❌ **无障碍抓取配对码**：读的是系统对话框内容，脆弱且观感像恶意软件；
  - ❌ **overlay 悬浮输码层**：SYSTEM_ALERT_WINDOW 恰恰是 S2 才拿得到的权限，S0 依赖它
    是循环依赖；
  - ❌ **自己的 Activity 引导流程**：anything with focus kills the dialog——这是物理约束，
    不是工程偏好。

### 2.3 内核侧 ADB 逻辑本期彻底删光，零残留；内核只看状态

- 用户拍板：安卓原生业务逻辑（配对、密钥、传输）不住内核——内核是 OTA 可换件，凭据与
  审计不得交给可换件（与「shell.exec 换接下沉 L0」同一理由）。
- 内核 UI 里 ADB 配置/配对页**彻底删除**；`/adb/status` 保留为**只读环境状态**（经桥
  `shell.status` 透传），归入首页/面板的「环境状态」呈现，不是配置入口。
- 具体删除清单见 spec §6。

## 3. 后果

- S0 是全链路里唯一无法 100% 自动化的环节（系统对话框不可代点）；交互设计的全部目标
  是让用户「盯着码 → 在通知里输码 → 等自动完成」三步内结束。
- 新 APK 装上后 **Device Owner 与无障碍授权失效**（ComponentName 键控），需一次性重新
  `adb shell dpm set-device-owner io.github.lobbowen.dshmobile/.lifecycle.DeviceAdminReceiver`
  + 重开无障碍——写入发布说明。
- ColorOS「应用启动管理」三开关的自动化**明确排除在本期外**，列为下一阶段议题。

## 4. 影响面

- 新增：`ui/` 开场管线页集合（原生 View）、配对通知 Service、mDNS 发现器。
- 删除：内核 `src/adb/` 全套 + `/adb/pair|shell|forget` 路由 + 内核 UI 配对页及其客户端
  （见 spec §6 文件清单）——需一次内核 OTA 发布。
- 不动：桥协议（`shell.*` 方法组 already 在 L0，见 `container/engine/src/bridge/methods.js:67-70`）。

## 5. 真机验证清单（定罪前主路径不得写死）

| # | 待验证 | 失败时回落 |
|---|---|---|
| ① | ColorOS 上下拉通知栏快捷回复时，「无线调试」配对对话框是否存活；快捷回复 intent 可达 `:main` Service | 输码改走设置页内悬浮提示引导（不夺焦）或纯手动连接 |
| ② | NsdManager 能否发现本机 `_adb-tls-pairing._tcp` / `_adb-tls-connect._tcp` | 通知栏内手动输 host:port |
| ③ | 无线调试设置页深链（`android.settings.WIRELESS_DEBUGGING_SETTINGS`）在 ColorOS 是否响应 | 落开发者选项页 + 图文指引 |
| ④ | mDNS 记录发布时序 vs 配对码 10 分钟有效期 | 提示用户「重新生成配对码」再触发 browse |
| ⑤ | 反馈契约三件事（§2.2 修订）：每次输码都有结论行 + heads-up；关框后结论仍在；回开场页「最近动作」与通知同句式 | 若 ROM 吞掉 heads-up，则结论至少要留在常驻探针通知的第一行（不可回退成静默） |
