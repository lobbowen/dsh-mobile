# ADR-0006：单一生命周期 —— `:node` 独立进程与 binder 监督边作废，**不做复活**

- 状态：**重写 / 已决定**（2026-09-28 v4）
- 关联：[ADR-0010 容器形态](0010-lob-os-container-form.md) · [ADR-0008 OS 原生 init 主轴](0008-agent-os-init-authority.md) · [ADR-0005 Program OTA](0005-program-via-ota-only.md) · [provisioning.md](../runbook/provisioning.md)
- 取代：本 ADR 旧版（`:main`/`:node` 双进程 + bindService(BIND_AUTO_CREATE) 监督边 + node.pid/node.birth/三态清账）
- 本 ADR 只回答一件事：**常驻与生命周期**。产品边界与形态见 ADR-0010。

---

## 1. 问题与真机定罪

真机（OnePlus PLP120 / ColorOS / Android 17，2026-09-25 全字段诊断）证明「Node 几分钟后中断」是**三个机制叠加**，且全在 AOSP 语义之外：

1. **冻结方 = 厂商私有 HANS + 内核冻结**，按 UID 生效，退后台 2~15s 即冻；Binder 被代理缓冲、wakelock 被收走、网络按 UID 拉黑。
2. **`:node` 不是被冻，是被杀**（`Cached(lowmem)` / `smart-force`），带前台服务也照杀；而旧设计里重拉 `:node` 的监督循环就住在 `:node` 自家进程 —— 进程死它同归于尽，`:node` 永不重生。
3. **AOSP 层豁免牌全部实证无效**：双 FGS、deviceidle 白名单、`RUN_ANY_IN_BACKGROUND`、targetSdk 28 —— 一个都挡不住厂商清理。

**定性**：把 OS 内部实现（第二进程 + 多条 binder 监督边）暴露成 Android 可管理对象，是根因。
**结论**：`:node` 独立进程与 binder 监督链**作废**；Android 侧只保留单一生命周期。

---

## 2. 决定

### D1 单一进程 / 单一前台服务 / 单一通知 / 单一控制台承载面

- **唯一进程**：`lobos.app` 主进程。所有 Runtime/Program 进程都是它的**子进程**（AMS 不可见）。
- **唯一 FGS**：`OsHost`（`specialUse`，诚实申报「常驻本地运行时」），只此一个前台服务。
- **唯一通知**：状态出口，非媒体样式；内容 = 通道 / Runtime / 各 Program 状态（低频）。
- **唯一承载面**：`ConsoleHost`（今天 WebView）。

**作废清单**（删而不得回潮）：

| 作废项 | 说明 |
|---|---|
| `android:process=":node"` | 第二 Android 进程 |
| `NodeRuntimeService`（FGS 1001） | 降为宿主内 InstanceHost |
| `HostBridgeService`（FGS 1002） | 收进 `CapabilityBroker` |
| `ContainerConsole`（FGS 1004） | 升为唯一 `OsHost` |
| `ScreenCaptureService` 独立 FGS | 合入 `OsHost` 动态 FGS 类型 |
| `NodeWatchdogPolicy` + 单测 + 门禁条目 | 整条删 |
| **binder 监督链**（bindNode / strikes / born / 三态清账） | 整条删 |
| `node.pid` / `node.birth` | 删 |
| BootReceiver 直启 `:node` 兜底边 | 只唤醒 `OsHost` |

### D2 唯一权威与唯一机制

- **生命周期权威 = `OsHost`（原生）**：进程/端口/存储/日志/journal 由一个原生 init 统一裁决（ADR-0008）。
- **保活 = 五层组合（唯一路径）**：锚（AccessibilityService 绑定）/ 载体（唯一 FGS + 通知）/
  豁免（电池·Doze 白名单 + OEM 用户开关引导）/ 唤醒（**按需短持** wake/wifi 锁 + Doze 兜底）/
  可见（QS Tile + 通知 + `os-state.json` 三处同源）。**不采用媒体形态**。

### D3 不设兜底、不设续跑、不做复活

- **agent 断即停**。进程被杀后**不做任何进程外复活**：复活回来的只是壳，任务早已判死，
  且常驻通知会写「运行时在线」，把打断伪装成没打断 —— 与判据层「实测优先、不许假绿」冲突。
- **journal 只做「打断可见」**：每拍盖心跳戳；只有干净退出才留 clean 戳。下次启动没有 clean 戳
  即如实定罪（上次存活到 HH:mm:ss、中断多久、是否设备重启），写在常驻通知首行 + 首页「最近动作」+ 导出报告，同一份文案源。
- **删掉一切 checkpoint / replay / 续跑设计**；力气全部放在「怎么不被杀」。

### D4 明确不做

- **闹钟心跳 / setAlarmClock 自唤醒**：找到可行保活路径后不再叠加第二机制（过度设计只增加不稳定面）。
- **悬浮窗保活**：实测方向存疑且 appops 无法程序化授予；浮层可见 ≠ 进程不被冻。
- **AOSP 豁免组合单独使用**（doze 白名单 / 电池优化豁免 / `RUN_ANY_IN_BACKGROUND`）：已证伪，不单独依赖（只作五层中的「豁免层」）。
- **Kotlin 侧常驻 TCP / 推送模拟 Packet 解冻**：同机制风险。
- **进程外复活边 / JobScheduler 周期戳 / 补生边**：已否决，门禁列入 DEAD 防回潮。

---

## 3. 后果

**正面**：单一机制、单一归因链。设备上只有两种可观测状态 —— 五层锚在册（不冻、子进程被监督）与
锚未在册（后台被冻，前台恢复时由 `OsHost` 拉起子进程）。

**代价与约束**：

- **用户必须手动启用无障碍服务**（系统政策不允许 adb/代码代授）；首启引导把 accessibility 标为保活必选项。
- 无障碍是重权限（可读全屏内容），本产品用途（ui_automation）与该权限相称，须如实申报。
- **不承诺 100% 不被杀**（无 root / 无 DO 下厂商二次回收确实杀得掉）：承诺的是「被杀一定能看见」。
- **验收判据**（真机，装上含本改造的 APK 后）：
  1. `dumpsys activity processes` 本 UID **1 条 ProcessRecord**、`isForeground=true` **=1**、通知 **=1**；
  2. 绑定 a11y 后退后台，`importance=accessibility` 持续、jiffies 推进；
  3. 后台 10 分钟子进程存活率 100%（含被系统短暂冻结-解冻，无重启）；
  4. 锁屏 5 分钟后解锁：常驻状态通知仍在、点开即进首页；
  5. 全新安装后不进任何界面、只解锁屏幕：`OsHost` 被拉起；
  6. 定罪边（心跳 + clean 戳）：设置里「强行停止」→ 重开首页，通知首行与首页首行都写「常驻被打断：上次存活到 HH:mm:ss，中断 …」；
     而 `am stop-service` 之后重开**不该**出现这一行（说明 clean 戳真在写）。设备重启后首启应写「结束于设备重启」。
