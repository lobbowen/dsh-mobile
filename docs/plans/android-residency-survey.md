# Android 常驻能力方案总览（Lob OS 用）

> 业务前提（不可跑偏）：**Lob OS 就是一个普通的 Android 应用**——用户在任意一台已使用的手机上装上它，它内部是一套小型 OS（可装 dsh / pi / codex 等程序）。
> 产品要求：**像音乐播放器一样常驻**（锁屏也运行、锁屏也联网、长期在线）。
> **注意：我们不是媒体应用**——媒体播放器只是能力标尺；除媒体外 Android 没有单一等价门票，等价能力必须组合。
> 因此本文件只讨论**普通已安装应用能用的手段**（含用户一次性授权的特殊权限）。设备管理/外设配对不属于本业务。

---

## 0. 目标能力（用音乐播放器做标尺）

| 代号 | 能力 | 播放器靠什么 |
|---|---|---|
| C1 | 息屏/锁屏持续运行（CPU 推进） | mediaPlayback FGS + 播放期 WAKE_LOCK |
| C2 | 锁屏可联网 | WifiLock + 活跃播放态（Doze 不切断活跃媒体） |
| C3 | 不被系统/OEM 后台治理清掉（**唯一路径，无兜底**） | 媒体豁免 + OEM 白名单（音频播放记录） |
| C4 | 用户可见/可控、诚实 | 锁屏媒体控件 + 常驻通知 |
| C5 | 不依赖 root、不依赖任何设备预置 | 全部走"用户授权一次"的普通应用路径 |

---

## 1. 普通应用可用的机制（按用途分四类）

### 1.1 载体：前台服务 + 媒体会话（C1/C2/C4 的日常实现）

| 机制 | 官方语义 | 前置 | 强度 | 适配 |
|---|---|---|---|---|
| mediaPlayback FGS + MediaSession + 播放记录 | 播放音频/视频 | 存在播放态（AudioPlaybackConfiguration） | ★★★★★ | ❌ **评估过但不采用**（伪装媒体；最终形态见 [os-architecture-v4](os-architecture-v4.md) §2.3 五层保活） |
| mediaProjection FGS | 投屏/录屏 | 用户每次授权 | ★★★★ | ✅（截屏能力） |
| location FGS | 导航/定位 | 定位权限 + 真实用途 | ★★★★ | 视产品是否有定位场景 |
| microphone/camera FGS | 录音/拍摄 | 权限 | ★★★ | 视场景 |
| dataSync FGS | 同步 | — | ★★（Android 14 每日限时） | ❌ |
| shortService | ≤3 分钟 | — | ★ | ❌ |
| specialUse | 兜底无保活语义 | — | ★ | 仅兜底 |

媒体套件：MediaSessionService/MediaSession → MediaStyle 通知（锁屏可见可控） → MediaButtonReceiver（媒体键） → MediaBrowserService（系统媒体中心/车机可见） → 活跃 AudioTrack → 音频焦点 → setWakeMode 持锁。
本机验证入口：dumpsys media_session、dumpsys audio（PlaybackActivityMonitor.players）。

### 1.2 系统绑定服务（C3 的锚）

| 机制 | 前置 | 强度 | 备注 |
|---|---|---|---|
| **AccessibilityService** | 用户手动开启一次 | ★★★★ | 本机已生效：HANS 拒冻本 uid —— **当前唯一被实证的强锚** |
| NotificationListenerService | 用户开启一次 | ★★ | 顺带是我们的一项能力 |
| DeviceAdmin（传统） | 用户激活 | ★★ | 弱 |

### 1.3 豁免与唤醒（C1/C2/C3 的补充）

| 机制 | 说明 | 限制 |
|---|---|---|
| REQUEST_IGNORE_BATTERY_OPTIMIZATIONS | 电池优化豁免 | OEM（osense）不认（已证） |
| deviceidle whitelist | Doze 白名单 | 同上（已证） |
| **OEM 用户开关**（ColorOS：卡片锁 / 允许完全后台行为 / 应用速冻白名单 / 启动管理） | 用户手点 | 各 ROM 不同，走引导 |
| PARTIAL_WAKE_LOCK + WifiLock(HIGH_PERF) | 锁屏保 CPU/网络 | **仅在播放态合理持有**；暂停即释放 |
| setExactAndAllowWhileIdle | Doze 下有限唤醒 | 有配额 |
| **setAlarmClock** | **唯一能穿透 Doze 精确唤醒** | 系统 UI 显示"闹钟"图标；高频=滥用 |
| WorkManager / JobScheduler | 系统配额内调度 | 不保证及时 |

### 1.4 可见性与用户面（C4）

| 机制 | 说明 |
|---|---|
| 常驻通知（MediaStyle） | 唯一状态出口，锁屏可见可控 |
| Quick Settings Tile | 一键状态/挂起 |
| SYSTEM_ALERT_WINDOW（悬浮窗） | 可选；可见性提升，用户需授权 |
| **设为默认桌面（用户选择）** | 可选强形态：任何普通应用都能被用户设为 Home，常驻几乎不可能被清；代价是 UX 让渡 |

---

## 2. 我们怎么拿到"同级能力"（组合，非单一门票）

Android 上**除媒体外没有单一等价物**。同级能力 = 下面**五层**叠加（全部是普通应用能力），**不设兜底**：

| 层 | 手段 | 作用 |
|---|---|---|
| 锚 | **AccessibilityService** + NotificationListenerService | 系统绑定 + OEM 冻结豁免（本机唯一实证强锚） |
| 载体 | **`specialUse` 前台服务** + 常驻通知 | 进程不降级；唯一生命周期 |
| 豁免 | 电池优化豁免 + Doze 白名单 + **OEM 四项用户开关** | 降低被清概率（OEM 侧是主战场） |
> 2026-09-28 落地：豁免层见 `lobos/capability/OemGuards.kt`（跳厂商页 + 用户回执 `files/os/oem-guards.json`），唤醒层见 `PowerLocks`/`DozeBackstop`；真机实测留 P9。

| 唤醒 | 按需短持 wake 锁（干活/联网期间，`finally` 释放）；WifiLock / Doze 兜底唤醒为**待补项**（债 `AUD-G22`） | 尽量在 Doze 下推进；**不设复活**（ADR-0006 D4） |
| 可见 | 常驻通知 + QS Tile；（可选）悬浮窗 / 默认桌面 | 排序档位 + 用户可控 |

**可选"真用途换真豁免"**：远程屏幕 → `mediaProjection`；内置隧道 → `VpnService`；同步为主 → `dataSync`。

**不采用**：伪装媒体应用（静音播放）；DO/LockTask；CDM；persistent/systemExempted。

### 2.1 唯一路径：**不被杀**（本产品不设兜底）
OS 里跑的 agent 一旦被切断就是停了——事后"续跑"是假信息（ADR-0006 同判）。因此**没有第二条路**：全部工程投入放在"不被杀"这一条上。
journal 只承担**把打断如实显示出来**（问责/可见），**不承担恢复**。

这也意味着：上面五层不是"尽力而为"，而是**产品承诺的全部内容**；任何"反正杀了也能续"的想法都必须从设计与验收里删除。

## 3. ROM 适配层（兼容，不是契约）

| 适配项 | 触发 | 缺失时 |
|---|---|---|
| 媒体播放记录豁免 SKIP_REASON_AUDIO_PLAY_PROCESS_RECORD | 有播放记录即生效 | 少一层保护，仍运行 |
| 媒体控制临时保护 mMediaControlTempProtectApp | ROM 内部 | 同上 |
| 卡片锁 / 速冻白名单 / 完全后台行为 | 引导用户开启 | 文案降级，不阻断 |
| HANS 冻结豁免 | 无障碍锚（通用） | 已覆盖 |

**原则**：ROM 适配只做"探测 + 引导 + 降级"，绝不成为安装或运行的前置。

---

## 4. 明确不属于本业务（不再作为选项）

- **Device Owner / LockTask / 设为 Home via DPM**：Android 的平台安全门，只允许**置备期或工作资料**授予 → 属"受管设备/企业 MDM"场景，与"用户随手安装的通用产品"互斥；
- **Companion Device（CDM）**：原义是**与物理外设配对**（手表/车机/USB），我们没有这个业务对象，不采用；
- android:persistent、systemExempted FGS、系统 role、隐藏 API：需系统签名/root。

> 将来若有客户要"整机托管的专有设备形态"，那是**另一条产品线**（受管部署包），不是本通用产品的常驻方案。

---

## 5. 真机验证清单（可 shell 复核）

1. dumpsys media_session → Lob OS 会话 active=true；
2. dumpsys audio → 本 uid/pid 的 AudioPlaybackConfiguration（按 A/B/C 方案对照）；
3. 锁屏 10/30 分钟：CPU 推进、网络请求成功率、Program 不掉；
4. dumpsys deviceidle whitelist / dumpsys power（无永久裸锁）；
5. OEM 用户开关开启前后，dumpsys activity exit-info 的被杀口径变化（(service){fg-service} 是否上移）；
6. 媒体键/锁屏控件是否真能控制 OS（PLAY/PAUSE/STOP）。
