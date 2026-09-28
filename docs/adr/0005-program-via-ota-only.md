# ADR-0005：三条通道的投递 —— OS / Runtime / Program 各自**只有一条**安装实现

- 状态：**已决定**（2026-09-23 内核单通道；**2026-09-28 v4 修订为三通道**）
- 关联：[ADR-0004 三版本流](0004-three-version-streams.md) · [program-ota.md](../runbook/program-ota.md)
- 上位结论：**任何一层都只允许一条安装/升级实现**；启动链、面板、桥方法都调同一套。

---

## 1. 前提（先立住，否则后面全是错的设计）

- **网络是产品前提**：本产品没有网络运行不了。**不把「离线可用」当作设计约束**，也不为它保留并行的降级路径。
- **Program 不是 APK 的一部分**：APK 是 OS 宿主（原生容器 + 能力桥 + OTA + 诊断面），**不含 Program 载荷**。
- **Runtime 随 OS 冻结或由 C 通道供给**：基础运行时（node/python/go/java）随 APK；工具由环境自装（只发清单）。

## 2. 目标形态

```
APK（OS / L0） = 原生容器 + Runtime（随包冻结） + CapabilityBroker + Program OTA 子系统（焊死验签公钥） + 诊断面
                  不含 Program 载荷
Program（L1）  = OTA 产物：首次安装与后续更新走**同一条**代码路径
Runtime（共享）= 随 APK 冻结（jniLibs/assets）或按 C 通道签名清单供给
```

## 3. 一条链，两个场景（以 Program 为例）

```
启动 → ProgramOta.ensureInstalled(id)
        ├─ CURRENT 缺失 → 首次安装（= 从 feed 安装最新版）
        └─ CURRENT 存在 → 版本比较 → 需要则更新
        → 校验（sha256 → ed25519 → runtime.range → capabilities → requiresProtocol）
        → 原子切 CURRENT
     → 由 OsHost 拉起该 Program 实例

手动（等价）→ 面板按钮 / 桥方法 → ProgramOta.installOrUpdate()   同一套实现
```

**「首次安装」不是特例**：它只是 `isNewer(remote, null) === true` 的那一格。没有第二条首装通路。

## 4. 要收敛/删除的重复路径

| 曾经存在的东西 | 处置 | 理由 |
|---|---|---|
| 启动链本地 feed / adb 投放 | **删除** | 为「离线」保留的第二条安装路径 |
| APK 内置 baseline.zip | **删除** | APK 不随 Program 分发；这是「每次改动都要重出 APK」的根因 |
| `ensureBaseline()` 一族 | **删除** | 随基线取消 |
| `build.programInstall` 的 `{feed}` / `{zipPath}` 语义 | **重定义** | 改为「从 OTA 源安装/升级」，与启动链同一实现 |
| KernelOtaUpdater + 安装器 + 版本管理器 的安装相关方法 | **合并为一个 Program OTA 子系统** | 对外一个入口，内部一段校验链 |
| fast-apk 的 baseline 产出步骤 + APK 审计「必须有 baseline」 | **删除并反转** | 改为「**不允许**有 Program 资产」 |

**收敛后每层应只剩**：一个 OTA 子系统（查 feed / 比对 / 下载 / 校验 / 原子安装 / 回滚）+ 一个桥方法 + 一个启动调用点。

## 5. 四个必须回答清楚的问题

### Q1 首次安装由谁触发？
启动链的 OTA 调用（`ProgramOta.ensureInstalled()`）—— 在实例 spawn **之前**完成。
**不需要「原生侧安装按钮」作为主路径**：那条链只在失败时用于显示原因与重试。

### Q2 安装失败怎么办？
**如实失败**：不切换 CURRENT、不伪造成功，诊断落 `program-ota`；界面显示「未安装：原因 + 重试」。**不做离线兜底。**

### Q3 要不要校验？
**要，且每层只有一条校验链**：sha256 → ed25519（公钥焊在 APK）→ `runtime.range` → `capabilities` → `requiresProtocol`。
首次安装与更新**完全一致**。

### Q4 回滚？
保留旧版本目录 + CURRENT 指针；新版本健康检查失败 → 指针回退。首次安装失败 → 停在「无该 Program」，下次启动重试。

## 6. 不变量

- **每层只有一个写入者**（OS 由 APK 覆盖安装；Runtime 由供给器写；Program 由 Program OTA 写）。
- **校验链唯一**。
- **只升不降**（比较器两侧同规则）。
- **版本不可复用且必须前进**（CI 门禁，ADR-0004 §2）。
- **三层身份互不比较**（ADR-0004）。
- **APK 不含 Program 载荷资产**（本 ADR 新增）。

---

## 7. 工业完备性补强（收尾条款）

对照 **TUF 规范**（rollback / freeze / mix-and-match）与 **Android Mainline/APEX、A/B + Verified Boot 回滚索引**：

| # | 条款 | 为什么必须有 | 验收（可判定） |
|---|---|---|---|
| C1 | **持久化版本下限（anti-rollback floor）** | 只与 CURRENT 比较时回退会跟着降；直接调安装器可装更旧版本 | 落盘「曾**成功提交**的最高版本」；任何安装低于它即拒绝，即使签名合法 |
| C2 | **形式化 commit / rollback 协议** | 「启动成功才提交」必须成为显式状态机 | 新版本 spawn 后健康检查通过 → 写 `committed`；未通过 → 指针回退且**下限不降** |
| C3 | **元数据新鲜度（防 freeze）** | manifest 未签名/无 expires 时可被「一直返回当前版本」冻结 | manifest 增加签名 + 单调 `sequence` + `expires`；设备校验失败即拒绝 |
| C4 | **灰度通道 + 放量** | 无法真实推送测试就只能全量赌 | 通道 canary/stable + `rolloutPercent` 确定性分桶 + 可中止 |

**落地状态**：C1/C2/C3/C4 均已落地（`FLOOR`/`PENDING` 指针、启动健康检查提交、manifest ed25519 签名 + sequence + expires、
canary/stable 通道 + rolloutPercent 分桶）。**迁移到 Program OTA 时这些条款必须原样保留。**

> 说明：C1/C2/C3 都是**设备端**能力，必须与「路径收敛（删本地 feed / 删内置基线）」一起做 ——
> 收敛正好消掉那条「可绕过下限」的手动降级入口。
