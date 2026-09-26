# ADR-0006：后台生命周期 —— 保活权威收归 L0，唯一机制 = 无障碍绑定 + :main 监督者（ContainerSupervisor）

- 状态：**已决定**（2026-09-25），随本 ADR 同批代码落地
- 关联：[ADR-0001 执行域](0001-android-execution-domain.md) · [ADR-0005 内核只走 OTA](0005-kernel-via-ota-only.md) · [provisioning.md](../runbook/provisioning.md)

---

## 1. 问题与真机定罪（OnePlus PLP120 / ColorOS 17 / Android 17，2026-09-25 全字段诊断）

产品形态要求 Agent（跑在 Node 里）在 App 退后台后持续工作。真机实测证明"Node
几分钟后中断"是**三个独立机制叠加**，且全部不在 AOSP 语义内：

1. **冻结方 = ColorOS 私有 OplusHansManager（HANS）+ OFreezer 内核冻结**，按 UID
   生效，退后台 2~15s 即冻（`freeze uid → FROZEN_TRANS`）。冻结特征：进程态恒 `S`
   （非 `T`）、cgroup 仍 foreground、oom_adj=200，唯 CPU jiffies 停走；Binder 被
   `OplusBinderProxy` 缓冲（实测显式广播 `result=0` 但进程没醒）；wakelock 被
   `OplusProxyWakeLock` 强制收走代理；`OAppNetControlService` 按 UID 拉黑网络
   （连回环都拒）。
2. **:node 不是被冻，是被杀**：`am_kill [..., :node, adj=200,
   Cached(lowmem)[(fg-service)]]`（`OsenseKillAction smart-force`）。带前台服务
   也照杀。而旧设计里唯一会重拉 :node 的 `supervisorLoop` 就住在 :node 自家进程
   —— 进程死它同归于尽；实测回前台 :main 解冻后 **:node 永不重生、控制面永久
   失联**。这就是用户感知的"退出后 Node 中断"。
3. **AOSP 层豁免牌全部实证无效**：双 FGS 在册（isForeground=true）、
   deviceidle 白名单（加了 90s 照冻）、`RUN_ANY_IN_BACKGROUND: allow`、
   targetSdk 28 —— 一个都挡不住 HANS。`sys.hans.enable` shell 不可写，ROM 未
   暴露任何白名单 cmd 接口。

## 2. 决定

**"永不冻结"在这类 ROM 上不是可争取的权利，而是需要绕开的依赖。** 对标实测：
微信同样被 HANS 冻结（分毫不差），它的"永远在线"是冻结↔解冻循环
（解冻理由统计：`Alarm / Packet / Activity / screen`）。我们不模仿这个循环，
而是走 Android 生态里被输入法/自动点击器验证过、且本机实证有效的**豁免路线**：

### 2.1 唯一保活机制（两级，一静一动）

```
[静] AccessibilityService 绑定（用户一次性授权）
     → HANS 拒绝让本 uid 降级
     （实证日志：cannot transition from R to M, importance=accessibility）
     → :main 常驻有 CPU、网络在册
[动] :main 的 ContainerSupervisor（L-A 监督服务；2026-09-26 起为 specialUse
     前台服务，占常驻状态通知 1004，见 §2.4）
     → bindService(:node, BIND_AUTO_CREATE) 持一条 binder 边
       （:node.onBind 必须返回真 binder —— 返回 null 是 null-binding，既不保活也无断开回调）
     → onServiceDisconnected（= :node 进程死亡，实测无障碍也保不住 :node）
        → 立即 rebind（后台合法。**2026-09-26 证伪修订**：rebind 只重建进程并跑 onCreate，
          **不会**重投 started-service 的 onStartCommand —— 旧文本此处写的是"随之重建进程
          并重投 onStartCommand"，那是空壳 :node 定罪的源头）
     → 每拍三态裁决（ADR-0008 §4 C1）：POWER=进程记录在 / BORN=node.birth 属于该 pid /
        ONLINE=控制面可达（只进状态出口，不做清账判据）
     → 卡死（进程记录连丢 3 拍）**或空壳**（POWER ∧ ¬BORN 超 30s）**或**断开超 30s 自愈预算
        → stopService + unbind/rebind 清账，三条升级路径共用 60s 冷却
     → 出生触发点 = :node 的 onCreate 自发起 boot 循环（幂等闸门 scheduleBootLoop 现成）；
        **不引入**"监督者向 :node 补投 startService"的补生边（用户 2026-09-26 判为架构失衡，
        已钉成 capability-single-source-gate 的死词汇）
     → 每次被戳都 ensureBridge()：L-A 确保 L-B（桥归监督者拉起，BootReceiver 不再直启）
       判据 = lifecycle/NodeWatchdogPolicy（纯逻辑，CI 钉死）
```

**互保闭环（2026-09-26 起五条拉起边，任一存活者都能把环转起来）**：监督者不能只靠 :node 拉起（:node
若死在拉监督者之前即成自锁），反之亦然。落地的五条边：① BootReceiver 开机拉
ContainerSupervisor + NodeRuntimeService；② DshAccessibilityService.onServiceConnected
→ ensureRunning；③ HostBridgeService.onCreate → ensureRunning；④ :node onCreate 及
每次内核 boot 尝试 → ensureRunning；⑤ Application.onCreate + 解锁/亮屏动态广播
（`ACTION_USER_PRESENT` / `ACTION_SCREEN_ON`）→ ensureRunning。①–④ 的前提是"某条边的宿主
进程还活着"，⑤ 补"用户回到设备"这个时机 —— ⑤ 与已否决的"进程外复活"不是一类：⑤ 的宿主
进程**还活着、任务还活着**，它只是把被 HANS 掐断的监督链戳回来。全部是普通
startService/bindService —— **绝不在死亡路径上调 startForegroundService**（:main 刚从 HANS
解冻时满足不了 5s FGS 契约，真机 ANR 栈实锤）。监督者的 `startForeground` 只发生在 onStartCommand 里。

**进程被整体杀掉后不做复活（2026-09-26 用户拍板，撤掉曾短暂落地的周期戳）**：复活回来的只是壳。
内核在重启时把所有 running/pending 任务一律判 failed（`kernel/src/platform/tasks.js` 的 `_load`，
注释原文「进程已死」），agent 的工作不会因为进程被点回来而继续；更坏的是复活后的常驻通知会写
「运行时在线」，把打断伪装成没打断 —— 与判据层「实测优先、不许假绿」正面冲突。本产品的形态是
类音乐播放器的**单链路系统服务**：力气全放在「不许被杀」，被杀之后唯一的诚实动作是**让打断可见**
（`lifecycle/ResidencyAudit`：每拍盖心跳戳、只有 `onDestroy` 才留 clean 戳；下次启动没有 clean 戳
即如实定罪，写在常驻通知首行 + 首页「最近动作」+ 导出报告，同一份文案源）。

**语义变化（明确接受）**：自 :main 的 bindService(BIND_AUTO_CREATE) 落地起，:node 的
存续由监督者保证，App 的语义从"用户显式启动内核"变为"容器活着内核就在"。本产品定位
MDM/设备管理员工作台（provisioning.md §1），这是目标行为而非副作用。

### 2.2 明确不做的（都是刻意决策，不是欠账）

- **闹钟心跳 / setAlarmClock 自唤醒**：找到了可行保活路径后不再叠加第二机制
  （用户拍板 2026-09-25：过度设计只增加复杂性与不稳定面）。Alarm 解冻向量
  仅在 QQ/微信身上有间接证据，我们不再依赖它。
- **悬浮窗保活**：实测方向存疑且 appops 无法程序化授予；浮层可见 ≠ 进程不被冻。
- **AOSP 豁免组合**（doze 白名单 / 电池优化豁免 / RUN_ANY_IN_BACKGROUND）：
  §1.3 已证伪，不再投入。
- **Kotlin 侧常驻 TCP/推送模拟 Packet 解冻**：同上，机制二风险。

### 2.3 职责边界（延续 ADR-0001/0005 的分层权威）

- :node 的 boot 循环（bootLoop）**保留**，但它只管内核进程（libnode 子进程）的
  拉起与退避重启（SupervisorPolicy，存活 ≥15s 才清零退避）；**:node 进程本身**的
  死活归 :main 的 ContainerSupervisor。监督分两半各归其位：父监子是正常职责，
  跨进程发号施令（AIDL 调用面）是 IPC 幻象 —— binder 代理调不了对端方法，
  为此上 AIDL 属过度设计。
- :node 收到 ACTION_RESTART 只 destroy 内核子进程，由自家 boot 循环按退避重启 ——
  面板"重启内核"按钮的落地语义；旧实现 stopService(:node) 在监督者 BIND_AUTO_CREATE
  绑定下已变成 no-op，故废弃。
- 内核（L1，可热更）**不得**再实现任何保活假设：JS 侧一律按"随时可能被冻结/
  死亡"设计 —— 任务要 checkpoint、重连要幂等、启动要能接住"上次留下的半截状态"。
- 监督者与保活权威全部在 L0（随 APK 冻结），与信任根同层 —— OTA 换不掉它。

### 2.4 修订（2026-09-26 真机定罪）：常驻必须**有形**，且不能只有一条唤醒边

用户定罪三句话：「锁屏之后 App 被清理掉」「我把 App 打开了就崩了」「运行时它是一个
持续化在线的状态」。逐条对上代码事实：

1. **监督者原本不占前台**：:main 是纯后台服务，HANS 之外还要吃 Doze/系统内存回收的刀；
   且全 App 没有一条通知说明"容器在不在"，用户无从判断。→ 决策（用户拍板）：
   ContainerSupervisor 升为 `foregroundServiceType="specialUse"`，常驻通知内容 =
   **通道 / 运行时 / :node 绑定** 三要素实况（限频 20s，点按开首页）。
2. **拉起边全部在"用户已经进了某个页面"之后**：Application 只建通知渠道，首页不戳
   监督者 → 安装后不进界面就没有运行时。→ 补边：`NodeContainerApp.onCreate` 直接
   `ContainerSupervisor.ensureRunning()`，并动态注册 `ACTION_USER_PRESENT` /
   `ACTION_SCREEN_ON`（解锁是比闹钟更干净的唤醒时机：它是真实用户事件，不产生周期性自扰）。
3. **进程被整体杀掉后无证据**：五条拉起边的前提都是"至少一条边的宿主进程还活着"，进程真死
   了就没人记得它死过 —— 用户看到的是"莫名从头来"。→ 加 `lifecycle/ResidencyAudit`（心跳落盘 +
   clean 戳 + 开机基准区分设备重启），把"上次常驻是被回收的、断了多久"如实显示。
   这里刻意**不**加进程外复活边：复活只把壳点回来，任务早已判死（见 §2.1「不做复活」）。
   本节此前落过一条 JobScheduler 周期戳，2026-09-26 经用户否决并整体删除，门禁把这套词汇
   列入 DEAD 防回潮。
4. **界面上有个会拆运行时的按钮**：F3 的"重启运行时"= 运行时服务的 destroy 语义，
   点开界面就可能亲手把正在跑的内核拆掉。→ 判据层删除该取法，运行时只给"看启动日志"；
   死活归监督链。门禁把 `ACTION_RESTART` 的归属钉在实现文件与诊断兜底页两处。

**代价**：常驻通知一条（用户已拍板接受）。纯预防路线的上限要说清：无 root / 无 Device Owner
的条件下，ROM 的二次回收（osense 一类）确实杀得掉前台服务，本产品因此**不承诺 100% 不被杀**，
承诺的是「被杀一定能看见」。**如果真机证明前台化 + 三锚仍不足以驻留，正确的问题是"怎么不被杀"
和"任务态怎么跨重启续上"，不是"要不要再加一条复活边"。**

## 3. 后果

**正面**：单一机制、单一归因链。设备上只有两种可观测状态：a11y 在册（:main
不冻，:node 死了 ≤5s 复活）与 a11y 未授权（回到旧行为：后台被冻，前台恢复时
:node 由监督者立刻拉回）。

**代价与约束**：
- **用户必须手动启用无障碍服务**（系统政策不允许 adb/代码代授）。首启引导把
  accessibility 标为保活必选项；ProvisioningProbe 已能探测"勾选但未绑定"的半死态。
- 无障碍权限是重权限（可读全屏幕内容）。本产品用途（ui_automation 桥能力）与
  该权限相称，但要在商店描述/隐私说明里如实申报。
- 监督者对 :node 的"死亡"判定依赖 binder（即时）+ node.pid 进程记录（cmdline 一致性
  核对防 pid 复用）。:node 若在 binder 连接前就卡死，走的是 a11y 未在册的同款
  前台恢复路径，不追求后台自愈 —— 这是有意的简化。
- 验收判据（真机，装上含本改造的 APK 后）：
  1. 绑定 a11y 后退后台，`logcat | grep 'importance=accessibility'` 持续出现、
     jiffies 持续推进；
  2. `adb shell am kill io.github.lobbowen.dshmobile:node` 后 ≤5s 内 binder 重连、
     `files/node.pid` 重写、控制面 36360 复活；
  3. 后台 10 分钟 :node 存活率 100%（含被杀-复活循环）；
  4. 锁屏 5 分钟后解锁：常驻状态通知仍在、点开它即进首页（§2.4-1）；
  5. 全新安装后**不进任何界面**、只解锁屏幕：:node 与桥被 ⑤ 这条边拉起（开机边与解锁边
     逐条各验一次，别把两条边混成一次观测）；
  6. 开屏 P0 冲刺依次问到无障碍与通知读取（它们是锚，不再推给"通道通了再静默办"）。
  7. 定罪边（`ResidencyAudit`）唯一验收口：设置里「强行停止」→ 重新打开首页，常驻通知首行
     与首页第一行都必须写「常驻被打断：上次存活到 HH:mm:ss，中断 …」；而 `am stop-service`
     之后重开**不该**出现这一行（说明 clean 戳真的在写）。设备重启后首启应写"结束于设备重启"
     而不是"App 被回收"。
