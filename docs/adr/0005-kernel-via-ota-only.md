# ADR-0005：内核不随 APK 分发 —— 内核安装**全部收敛到 OTA**

- 状态：**已决定**（2026-09-23），实施分步进行
- 关联：[ADR-0004 双版本流](0004-dual-version-streams.md) · [kernel-ota.md](../runbook/kernel-ota.md)

---

## 1. 前提（先立住，否则后面全是错的设计）

- **网络是产品前提**：本产品没有网络运行不了。**不把"离线可用"当作设计约束**，
  也不为它保留并行的降级路径 —— 那正是"逻辑分散"的来源。
- **内核不是 APK 的一部分**：APK 是容器宿主（运行环境 + 桥 + OTA + 诊断面）。
- **内核安装只有一套实现**，就在 OTA 里；启动链、面板、桥方法**都调同一套**。

## 2. 目标形态

```
APK（L0 宿主）= Node 运行时 + 原生库 + HostBridge + **OTA 子系统**（焊死验签公钥）+ 诊断面
                 **不含内核**

内核（L1）    = OTA 产物：首次安装与后续更新走**同一条**代码路径
```

## 3. 一条链，两个场景

```
启动 → OTA.ensureInstalled()
        ├─ CURRENT 缺失 → 首次安装（= 从 feed 安装最新版）
        └─ CURRENT 存在 → 版本比较 → 需要则更新
        → 校验（sha256 → ed25519 → engines.node → requires → requiresProtocol）
        → 原子切 CURRENT
     → spawn :node（跑的就是刚装/刚升的内核）

手动（等价）→ 面板按钮 / 桥方法 → OTA.installOrUpdate()     同一套实现
```

**"首次安装"不是特例**：它只是 `isNewer(remote, null) === true` 的那一格。
没有"另一条首装通路"，也就没有第二处会腐烂的逻辑。

## 4. 要收敛/删除的重复路径（这就是"做扎实"）

| 现在存在的东西 | 处置 | 理由 |
|---|---|---|
| 启动链 0b：`LocalKernelFeed.scan` + `KernelInstaller.install`（本地 feed / adb 投放） | **删除** | 为"离线"保留的第二条安装路径；产品必须联网，它只增加分叉 |
| 启动链 0c：`assets/kernel/baseline.zip`（APK 内置基线） | **删除** | APK 不含内核；这也是"每次内核改动都要重出 APK"的根因 |
| `KernelManager.ensureBaseline()` + `BaselineResult` 一族 | **删除** | 随基线取消 |
| `build.kernelInstall` 的 `{feed}` / `{zipPath}` 语义 | **重定义** | 改为"从 OTA 源安装/升级"，与启动链同一实现 |
| `build.kernelUpdate`（上一轮刚加） | **合并** | 与 `kernelInstall` 是同一件事的两个名字 → 只留一个 |
| `KernelOtaUpdater` + `KernelInstaller` + `KernelManager` 的安装相关方法 | **合并为一个 OTA 子系统** | 对外一个入口，内部一段校验链 |
| `fast-apk` 的 baseline 产出步骤 + APK 审计的"必须有 baseline" | **删除并反转** | 改为"**不允许**有内核资产" |

**收敛后应只剩**：
- 一个 OTA 子系统（查 feed / 比对 / 下载 / 校验 / 原子安装 / 回滚）
- 一个桥方法（安装或升级）+ 一个状态查询（`build.kernelStatus`）
- 一个启动调用点

## 5. 必须回答清楚的四个问题

### Q1 首次安装由谁触发？
**启动链的 OTA 调用**（`OTA.ensureInstalled()`）—— 在内核 spawn **之前**完成，
所以面板出现时内核已经在跑。**不需要"原生侧安装按钮"作为主路径**：
那条链只在安装失败时用于显示原因与重试。

> 由此避免了自举悖论（面板由内核 serve → 没内核就没面板）：**安装发生在面板之前**。

### Q2 安装失败（服务器不可达/feed 缺失/校验不过）怎么办？
**如实失败**：不切换 CURRENT、不伪造成功，诊断落 `kernel-ota`；
界面显示"内核未安装：原因 + 重试"。**不做离线兜底**（网络是前提，但失败仍必须可见）。

### Q3 要不要校验？
**要，且只有一条校验链**：sha256 → ed25519（公钥焊在 APK）→ `engines.node` →
`requires` → `requiresProtocol`。首次安装与更新**完全一致**。

### Q4 回滚？
保留旧版本目录 + `CURRENT` 指针；新内核健康检查失败 → 指针回退。
首次安装失败 → 停在"无内核"，下次启动重试。

## 6. 不变量

- **容器 OTA 是内核的唯一写入者**（内核不自更新）。
- **校验链唯一**（只有一处 `KernelInstaller` 语义）。
- **只升不降**（比较器两侧同规则）。
- **内核版本不可复用且必须前进**（CI 门禁，ADR-0004 §2）。
- **壳与内核两个身份互不比较**（ADR-0004）。
- **APK 不含内核资产**（本 ADR 新增）。

---

## 7. 工业完备性补强（收尾条款）

对照 **TUF 规范**（安全更新的事实标准，其列明的攻击面为 rollback / freeze / mix-and-match）
与 **Android Mainline/APEX、A/B + Verified Boot 回滚索引**，本方案的核心已成立，
但**离工业完备还差四项**。以下为**必须补**的收尾条款：

| # | 条款 | 对齐的规范 | 为什么必须有 | 验收（可判定） |
|---|---|---|---|---|
| C1 | **持久化版本下限（anti-rollback floor）** | Android rollback index；TUF rollback 防护 | 现在只与 `CURRENT` 比较：内核回退后 floor 会跟着降；且直接调 `KernelInstaller` 可装更旧版本 | 落盘"曾**成功提交**的最高版本"；任何安装（含手动）低于它即拒绝，即使签名合法 |
| C2 | **形式化 commit / rollback 协议** | Android A/B `markBootSuccessful` | 有健康检查与旧版目录，但"启动成功才提交"没有成为显式状态机 | 新内核 spawn 后健康检查通过 → 写 `committed`；未通过 → 指针回退且**下限不降** |
| C3 | **元数据新鲜度（防 freeze）** | TUF timestamp/snapshot | manifest 未签名、无 expires：可被"一直返回当前版本"冻结（伪版本/混搭已被**版本交叉校验**挡住） | manifest 增加签名 + 单调 `sequence` + `expires`；设备校验失败即拒绝 |
| C4 | **灰度通道 + 放量** | Chrome/Android staged rollout | **内核无法真实推送测试**（没有灰度就只能全量赌） | 通道 canary/stable（✅ 本次已落地）；再补按比例放量（`rolloutPercent` + 设备确定性分桶）与**可中止** |

**已落地**：C4 的**通道部分**（`kernel-canary` / `kernel-stable`，提升时归档不重建，版本前进门禁按通道比较）。
**待实施**：C1、C2、C3、C4 的放量部分。

> 说明：C1/C2/C3 都属于**设备端**的能力，必须与"路径收敛（删本地 feed / 删内置基线）"一起做 ——
> 因为收敛正好消掉那条"可绕过下限"的手动降级入口（`build.kernelInstall` 的 `zipPath` 语义）。
