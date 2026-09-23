# ADR-0003：通用产品下的最大能力取向（包名 / 拆包 / shell）

- 状态：**已决定**（2026-09-23）
- 依据：Shizuku 官方 README / Shizuku-API README 与 LICENSE（GitHub API 实取）、
  Termux 三个 APK 的 manifest（前序实证）、Android 行为变更
- 一句话：**能力上限由「应用身份 + 设备预置」决定，不由 APK 数量决定。**

---

## 结论一：包名 —— 定 `io.github.lobbowen.dshmobile`

**证据**
- `com.example.*` 是占位符：Google Play 直接拒收；且它是 DO / 无障碍 / PackageInstaller 的组件串前缀，
  发布后改动 = 换 app（数据不继承、DO 与无障碍需重新预置）。
- Android 包名规范是反向域名；**没有自有域名时，`io.github.<user>.<app>` 是官方认可的免域名方案**
  （GitHub Pages 同款）。本产品 owner 为 `lobbowen`，仓名 `dsh-mobile`。
- 该名字不改变任何能力（包名与权限/域无关），只解决"身份合规"。

**决定**：`applicationId = io.github.lobbowen.dshmobile`。
**执行时机**：一次性机械替换（Manifest / build.gradle / DO 与无障碍组件串 / privapp xml / 文档 / 测试）。
⚠️ 代价：已装设备上它是**另一个 app**（数据不继承）。当前这台机器上的容器正托管本会话，
所以这一步需要一个明确的执行窗口（装完即切换）。

---

## 结论二：拆包 —— **不拆，单一 APK**

**证据（逐条反驳"拆包能拿更多能力"）**
1. **无权限互斥**：同一个 app 可以同时持有 Device Owner + 无障碍 + MANAGE_EXTERNAL_STORAGE +
   SYSTEM_ALERT_WINDOW + REQUEST_INSTALL_PACKAGES + 通知使用权 —— 不存在"必须分成两个包"的权限组合。
2. **能力由身份决定**：SELinux 域由 targetSdk 决定、签名身份由 keystore 决定、
   静默装卸/策略由是否 DO 决定 —— 与 APK 数量无关。
3. **Termux 拆包的真实动因是"可选安装 + Play 政策隔离"**，不是能力：Termux 本体不声明相机/SMS，
   由 Termux:API 承担，好处是"用户不装插件就看不到那些权限"。本产品的定位恰恰是"把能力都拿住"，
   拆了只会让用户多点几次安装，能力不变。
4. `sharedUserId`（Termux 同 UID 的前提）**自 API 29 起废弃**，只有 targetSdk<29 可用；
   它只在拆包时才需要 —— 不拆就没有这个负担。

**决定**：**单包**。`permissions/` 模块保留为**能力清单**；将来若因"可选安装/企业分发"要拆，
它就是现成的拆分依据（按 `PermissionCatalog` 分组直接切）。

---

## 结论三：`shell.exec` —— **加 Shizuku 作为可选通道（不绑架启动链）**

**证据（Shizuku 官方）**
- Shizuku = 一个以 **root 或 ADB(shell)** 身份运行的 server；app 通过 binder 调 **Java/JNI**，
  拿到**与 adb 同等的权限**（`pm/am/input/settings/dumpsys/screencap/appops`…），
  这是**非 root 设备上唯一的 shell uid(2000) 通道**（ADR-001 §6 已确认 proot 不采用）。
- 许可：**Shizuku = Apache-2.0；Shizuku-API = MIT** —— 商用可行。
- 集成：Maven 依赖 `dev.rikka.shizuku:api` + `:provider`；manifest 加
  `rikka.shizuku.ShizukuProvider`（`authorities="${applicationId}.shizuku"`，
  `permission="android.permission.INTERACT_ACROSS_USERS_FULL"`）；运行时按类似普通权限的流程请求。
- 代价（如实）：非 root 设备每次重启需用 adb 或"无线调试"重新启动 Shizuku；
  ADB 权限**随系统版本不同而受限**（需 `ShizukuService#checkPermission` 自检）。

**决定（2026-09-23 修订：Shizuku 是**必备能力**，默认集成，不做可选/降级）**：
- **常驻集成，没有"可选"分支**：Gradle 常驻依赖 `dev.rikka.shizuku:api` + `:provider`，
  manifest 常驻 `ShizukuProvider`。不做"有就用、没有就降级"的开关 —— 那是自欺：
  **能力要么有、要么没有，由能力门禁统一定性**，不给单个方法开特例。
- `shell.exec` **一律以 shell uid(2000) 执行，`privileged:true`**；**删除应用 uid 兜底形态**。
- 环境前提属**预置前提**（与 DO、Tier S 同级）：设备侧需安装 Shizuku 并以 adb / 无线调试启动。
  未满足时，`shell` 组在能力协商里不可用，方法按**既有契约**返回 `ERR_CAPABILITY_MISSING(-32001)`，
  不新增任何特判路径。
- 修正 ADR-001「不引入第三方 AAR」一刀切：该条针对"为垫片引入依赖"；Shizuku 是**能力本体**
  （Apache-2.0 / MIT），与 keystore、Tier S 同属"产品赖以成立的外部前提"，应作一等依赖。

---

## 附加：为拿满能力还差的项（按收益排序）

| # | 项 | 解锁 | 档 |
|---|---|---|---|
| 1 | **NotificationListenerService** | `notif.read`（当前 ⏳） | T1 用户手动 |
| 2 | Shizuku 可选集成 | shell uid 2000（T3） | T3 |
| 3 | phantom-killer / 电池优化引导 | 保活质量 | —（P3 已落地检测） |

**保持不变（这些就是最大能力的正确取值）**：`targetSdk=28`（app-home `execve` 地基）、
`minSdk=24`、仅 `arm64-v8a`、`specialUse` + `mediaProjection` 前台服务类型、
DO 与无障碍留在同一包（一次预置拿到全部策略面）。
