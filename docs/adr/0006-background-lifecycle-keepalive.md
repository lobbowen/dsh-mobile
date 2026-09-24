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
[动] :main 的 ContainerSupervisor（L-A 监督服务，无通知位）
     → bindService(:node, BIND_AUTO_CREATE) 持一条 binder 边
       （:node.onBind 必须返回真 binder —— 返回 null 是 null-binding，既不保活也无断开回调）
     → onServiceDisconnected（= :node 进程死亡，实测无障碍也保不住 :node）
        → 立即 rebind（后台合法，AMS 重建进程并重投 onStartCommand）
     → 卡死（binder 边在但 node.pid 进程记录连丢 3 拍）
        → stopService + unbind/rebind 清账，且带 60s 冷却
        → binder 断开则先给 AMS 30s 自愈预算，超时才清账
     → 每次被戳都 ensureBridge()：L-A 确保 L-B（桥归监督者拉起，BootReceiver 不再直启）
       判据 = lifecycle/NodeWatchdogPolicy（纯逻辑，CI 钉死）
```

**互保闭环（四条边，任一存活者都能把环转起来）**：监督者不能只靠 :node 拉起（:node
若死在拉监督者之前即成自锁），反之亦然。落地的四条边：① BootReceiver 开机拉
ContainerSupervisor + NodeRuntimeService；② DshAccessibilityService.onServiceConnected
→ ensureRunning；③ HostBridgeService.onCreate → ensureRunning；④ :node onCreate 及
每次内核 boot 尝试 → ensureRunning。监督者自己经 ①–④ 之外还以 bindService 边持有
:node。全部是普通 startService/bindService —— **绝不在死亡路径上调
startForegroundService**（:main 刚从 HANS 解冻时满足不了 5s FGS 契约，真机 ANR 栈实锤）。

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
  3. 后台 10 分钟 :node 存活率 100%（含被杀-复活循环）。
