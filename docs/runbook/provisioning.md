# 能力启用指南（CAPABILITY ENABLEMENT）

> 状态：v2（2026-09-28）· 上游决策：[ADR-0010](../adr/0010-lob-os-container-form.md)、台账 §J（Device Owner 全面退出）
> 定位：Lob OS 是**普通安装即可运行**的产品；本文件只讲"哪些能力需要在系统里点一下才能用"，**不涉及任何需要设备管理员（Device Owner）的步骤**。

---

## 1. 结论先行：不需要 Device Owner

- **Device Owner 已全面退出**：本产品既不把它当常驻机制，也不保留以它为前提的能力（见 `docs/plans/os-v4-execution-plan.md` 台账 §J）。
- 因此**没有"预置期"**：装上即用；缺的能力在应用内引导用户开启，或经应用自带的 ADB 通道（用户在自己的设备上点"无线调试"）补齐。
- 安装应用走 **PackageInstaller + 用户点确认**；代码与文档中不得出现静默装卸、`policy.*`、`device_policy` 等方法面。

## 2. 能力清单（按"是否必须"分级）

| 能力 | 机制 | 启用方式 | 不启用的后果 |
|---|---|---|---|
| **无障碍（锚）** | `AccessibilityService` | 设置 → 无障碍 → Lob OS → 开启 | 失去国产 ROM 上唯一实证的后台冻结豁免（ColorOS：`importance=accessibility` 挡 HANS）；UI 自动化不可用 |
| **电池/Doze 白名单** | `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` + `deviceidle whitelist` | 应用内引导（跳系统页） | 息屏后更易被回收 |
| **通知使用权** | `NotificationListenerService` | 设置 → 通知 → 通知使用权 → Lob OS | `notif.read` 能力缺失（Agent 读不到通知） |
| **OEM 自启/后台开关** | 厂商设置项（ColorOS：卡片锁/允许完全后台/速冻白名单/启动管理） | 应用内引导（跳厂商设置页） | 厂商后台治理仍可能清场（机型相关） |
| **无线调试配对** | 壳自带 ADB 客户端 | 设备开「无线调试」→ 面板输入 host:pairPort + 配对码（`shell.pair`） | `adb_shell` 能力缺失（`shell.exec` 等不可用） |
| **所有文件访问** | `MANAGE_EXTERNAL_STORAGE` | 设置 → 应用 → Lob OS → 权限 → 所有文件访问 | `fs.*` 能力受限 |
| **悬浮窗 / 勿扰 / 使用情况** | 各自系统开关 | 对应设置页 | 对应能力降级 |
| **屏幕感知** | `MediaProjection` | 运行时系统弹窗（用户点一次）；授权结果经宿主转发 | `ui.screenshot` 不可用 |

> 组合 = **无障碍锚 + 电池白名单 + 通知使用权 + ADB 配对 + MediaProjection + 标准特殊权限**。
> 常驻能力是**五层保活组合**（锚/载体/豁免/唤醒/可见），**不设兜底/续跑**——详见 [residency-verification-plan](../plans/residency-verification-plan.md)。

## 3. 启用流程（都在应用内/系统设置里）

### 3.1 无障碍（保活必选，非可选优化）
- 设置 → 无障碍 → **Lob OS** → 开启。
- 作用有两层：① `ui.*` 自动化（手势/节点树/输入）；② **判决锚**：ColorOS 上服务绑定后 HANS 拒绝把本 uid 转出 Running（`cannot transition from R to M, importance=accessibility`）。
- 完整论证见 [ADR-0006](../adr/0006-background-lifecycle-keepalive.md)。

### 3.2 电池与厂商后台开关
- 电池优化：应用内引导到「电池 → 不受限制」；实现读 `isIgnoringBatteryOptimizations` 并与 `deviceidle whitelist` 回读一致。
- 厂商四项（ColorOS）：**卡片锁 / 允许完全后台行为 / 应用速冻白名单 / 启动管理** —— 应用内逐项引导（当前为待补项，见债表 `AUD-G21`）。

### 3.3 通知使用权
- 设置 → 通知 → 通知使用权 → Lob OS → 允许。
- 注意：**无法静默授予**（DO 已退出，也不再需要）；只能由用户手动开。

### 3.4 无线调试配对（shell 通道，Android 11+）
- 设备：开发者选项 → 无线调试 → 「使用配对码配对设备」；面板填 host:pairPort + 6 位码（桥 `shell.pair`）。
- ADB 身份密钥由壳首配自动生成，存 `files/adb/`（0600）；**设备重启后端口会变，需重新配对**。
- 免 PC、免第三方（Shizuku 已删除，理由见 ADR-0003 勘误）。

### 3.5 MediaProjection
- 由控制台触发系统授权弹窗；授权结果经 **OsHostService** 转发给进程内的截屏组件（不再有独立前台服务）。

### 3.6 特殊权限
- `MANAGE_EXTERNAL_STORAGE`：设置 → 应用 → Lob OS → 权限 → 所有文件访问。
- 通知访问、使用情况访问、悬浮窗、勿扰：对应设置页。

## 4. 部署后自检

复用 `RuntimeDiagnostics` 与能力登记表逐项核对：
- `accessibility`：锚是否在位（`AccessibilityAnchor.state`）；
- `adb-shell`：通道是否配对且可用（`shell.exec("echo ok")`）；
- `notifications` / `storage` / `mediaprojection` / `special-perms`：逐项确认。

全部开启后能力面完整；任一缺失，对应桥方法返回 `ERR_CAPABILITY_MISSING`，上层**如实降级**（不得伪造可用）。

## 5. 安全与边界
- 所有敏感能力（无障碍、MediaProjection、通知使用权、全盘访问）都必须由**用户在系统界面明确同意**；应用只做引导，不做规避。
- **不做**：静默装卸、强制密码、远程擦除、kiosk/LockTask、代授特殊权限（这些都属于已退出的 Device Owner 能力面）。
- 审计日志（见 [bridge-protocol](../contracts/bridge-protocol.md) §5）记录所有特权操作，便于追溯。
