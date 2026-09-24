# 内核 OTA（完整链路）

> 两条通道要分开看：**发布侧**（把新内核推到 feed）与**设备侧**（检测 → 下载 → 安装）。
> 版本语义见 [ADR-0004](../adr/0004-dual-version-streams.md)；目标形态与收敛项见 [ADR-0005](../adr/0005-kernel-via-ota-only.md)。

---

## 1. 通道（灰度）——内核推送必须先在 canary 真机跑过

| 通道 | 滚动 tag | 用途 |
|---|---|---|
| **canary** | `kernel-canary` | **灰度/测试**：新内核先发这里，真机验证 |
| **stable** | `kernel-stable` | 生产 |

- 设备通道由 `container/app/src/main/assets/kernel-feed.json` 的 `channel` 决定（默认 `stable`）。
- 设备端 URL：`<baseUrl>/kernel-<channel>/kernel-manifest.json`。
- **提升（promote）**：验证通过后，用**同一个版本**再发一次到 `stable`。
  版本化归档 `kernel-<version>` **只创建一次**，提升时跳过重建（否则"同版本发两次"会被误判为错误）。
- 版本前进门禁是**按通道**比较的：canary 可以领先 stable。

## 2. 发布侧：怎么推

```
① 改 kernel/** → bump kernel/package.json 的 version（必须比**目标通道**已发布的大）
② 触发 kernel-ota：channel=canary（默认）+ publish=true
③ CI: 从 kernel/package.json 取版本 → 签名打包 → 门禁（按通道前进）
     → 归档 kernel-<version>（仅首次）→ 更新 kernel-canary（manifest + 本次 zip，清理旧 zip）
④ 真机验证通过 → 再触发 kernel-ota：version=<同版本> channel=stable publish=true（提升）
```

**产物与稳定 URL**：

| 用途 | URL |
|---|---|
| 判断有没有更新 | `<base>/kernel-<channel>/kernel-manifest.json` |
| 下载内核包 | `<base>/kernel-<channel>/kernel-<version>.zip`（或 manifest 里的 `url`） |

`<base>` 由 APK 资产 `kernel-feed.json` 决定。**它必须是一个设备网络可达的对象存储/CDN**。

> ⚠️ **实测结论（2026-09-24，本设备网络）**：
> `github.com` / `raw.githubusercontent.com` **不可达** —— 因此 GitHub Release **不能**作为设备下载源；
> `hubcdn.zll.ink`（七牛 + 自有域名 + HTTPS）✅ 可达、`X-Reqid` 正常、延迟约 300–760ms；
> 阿里云 OSS / 腾讯云 COS / 华为云 OBS 默认域名亦实测可达（190–360ms）。
>
> 因此发布流程是：**GitHub Release = 归档**，**对象存储 = 设备真正读取的通道**
> （`kernel-ota` 里的 "Publish to Qiniu" 步骤；缺配置会**硬失败**，避免"发了个设备读不到的包"却显示成功）。

## 3. 设备侧：怎么下

```
启动 → OTA.ensureInstalled()
        ├─ CURRENT 缺失 → 首次安装
        └─ CURRENT 存在 → 版本比较 → 需要则更新
      ① GET <base>/kernel-<channel>/kernel-manifest.json（受 startupBudgetMs 约束）
      ② isNewer(remote, CURRENT)            ← 只升不降
      ③ 下载 zip → cacheDir（**断点续传 + 重试**，见下）
      ④ 校验链：sha256 → ed25519 验签 → engines.node → requires → requiresProtocol
                 （manifest 里的 version 还会与**包内已签名的 kernel.json** 交叉校验）
      ⑤ 原子切 files/kernel/CURRENT
      → spawn :node（跑的就是刚装/刚升的内核）
手动（等价）→ 面板按钮 / 桥方法 build.kernelInstall
```

## 3.5 manifest 新鲜度与灰度放量（ADR-0005 C3/C4）

发布侧（`scripts/sign-kernel-manifest.js`）给 `kernel-manifest.json` 追加并**签名**：

| 字段 | 含义 | 设备端行为 |
|---|---|---|
| `sequence` | **epoch 秒时间戳**（天然单调） | 低于本设备**已见水位**即拒（判为疑似重放）。用时间戳而非"上一份 +1"：后者依赖 Release 存在，删/重建会**倒退** → 设备水位高于它 → **永久卡住** |
| `expires` / `expiresEpochMs` | 有效期（默认 30 天） | 过期即拒（防"永久冻结在旧版本"） |
| `rolloutPercent` | 灰度放量 0–100 | 按 `安装ID+版本` **确定性分桶**：`bucket >= rolloutPercent` 则本次不装（下次启动再试） |
| `signature` | manifest 的 ed25519 签名 | ✅ 设备端**校验**（与 zip 同一个 Node 校验器进程、同一把焊死公钥；失败即 `manifest-signature-invalid`） |

**停发**：把 `rolloutPercent` 设为 `0` 重新发布该通道 manifest —— 尚未安装的设备不会再装。
（已安装的设备**不会**被"回退"，这是 OTA 的固有语义。）

**灰度流程**：`canary` + 小比例 → 真机观察 → 加大比例 → 提升到 `stable`。

### 3.6 下载：断点续传 + 重试（弱网可用性的关键）

内核包 ~1.2MB。弱网下单次 GET 经常中途断——如果失败就丢弃，**每次开机都从 0 开始**，
网络永远「差一点点」，内核永远装不上，签名/下限/灰度全都没机会生效。因此：

| 机制 | 说明 |
|---|---|
| **不删半包** | 下到 `kernel-ota-<ver>.zip.part`；失败或预算耗尽都**保留** |
| **Range 续传** | 下次带 `Range: bytes=<已下>-` 接着下（服务端支持，实测 `206`） |
| **预算到点就停** | 单次开机最多花 `startupBudgetMs`，**进度跨启动累积**（把一次大失败拆成多次小成功） |
| **重试 + 退避** | 3 次，退避 0.5s→1s→2s |
| **收齐后验 sha256** | 不一致立即丢弃重下（防传输损坏 / 拼接错误）；信任根仍是包内 ed25519 签名 |
| **安全回退** | 服务端不支持 Range（回 200）→ 从头写；返回 416 → 按「已收齐」交给 sha256 判定 |
| **identity 编码** | 显式 `Accept-Encoding: identity`——否则中间层压缩会让 Range 偏移指向压缩流，续传必然损坏 |

> 下载超时**不**按启动预算夹逼：预算是「总时长」约束（循环内检查），read timeout 是「单次阻塞」
> 约束。用预算夹逼它会把「慢但在稳定传输」的连接误杀，恰好破坏续传要解决的问题。

## 4. 失败语义（不假装成功）

| 情况 | 行为 |
|---|---|
| 服务器不可达 / 超预算 | 本次跳过，诊断落 `kernel-ota`（网络是产品前提，但失败必须可见） |
| manifest 缺失/非法/无 version | 跳过 + 诊断 |
| 版本不新 | 不下载、**不重启** |
| 下载失败 / 校验不过 | **不切 CURRENT**，诊断带真实 reason |
| 安装成功（启动路径） | 切 CURRENT，无需重启 |
| 安装成功（手动路径） | 切 CURRENT + 重启 `:node`，回执 `restartUncertain:true` |

## 5. 排查

| 看什么 | 位置 |
|---|---|
| 壳/内核/协议三个身份 | `files/provisioning.json`（`appVersion` / `kernelVersion` / `bridgeProtocol`） |
| OTA 检查结果 | `files/diagnostics.txt` 的 `kernel-ota` 行 |
| 当前内核指针 | `files/kernel/CURRENT` |
| 当前通道 | `assets/kernel-feed.json` 的 `channel` |

## 6. 已知限制 / 待补（见 ADR-0005 收尾条款）

- **无持久化版本下限**：仅与 CURRENT 比较；内核回退后 floor 会跟着降。
- **无形式化 commit/rollback**：有健康检查与旧版目录，但没有"启动成功才提交"的显式协议。
- **manifest 未签名、无 expiry**：无法防"一直返回当前版本"的**冻结攻击**（版本交叉校验已挡住伪版本/混搭）。
- **无按比例的放量**：通道是二档（canary/stable），没有百分比灰度。
- 检测时机只有"启动时 / 手动"（无推送通知）。
