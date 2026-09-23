# 内核 OTA（完整链路）

> 两条通道要分开看：**发布侧**（把新内核推到 feed）与**设备侧**（检测 → 下载 → 安装）。
> 版本语义见 [ADR-0004](../adr/0004-dual-version-streams.md)，版本规则见 [versioning.md](versioning.md)。

---

## 1. 发布侧：怎么推

```
① 改 kernel/** → bump kernel/package.json 的 version
     ⚠ 必须**比已发布的更大**（保持同一套写法：要么都带 -android.N 且 N 递增，要么都不带）
② 触发 kernel-ota（Actions → Run workflow；或推 tag kernel-ota-*）
③ CI 自动：
     a. 从 kernel/package.json 取版本（唯一源，不再有第二个写死的地方）
     b. 用 OTA 私钥签名 → kernel-<v>.zip + kernel-manifest.json + kernel-feed-<v>.zip
     c. 门禁①：**版本前进**（与 kernel-latest 上已发布版本比较，不前进即红）
        门禁②：**版本唯一**（kernel-<v> tag 不存在，防复用）
     d. 发布 Release kernel-<v>（版本化归档，可追溯）
     e. 发布/更新 Release kernel-latest（**滚动 feed**：manifest + 本次 zip，并清理旧 zip）
```

**产物与稳定 URL**（`<base>` 见下）：

| 用途 | URL |
|---|---|
| 判断有没有更新 | `<base>/kernel-latest/kernel-manifest.json` |
| 下载内核包 | `<base>/kernel-latest/kernel-<version>.zip`（或 manifest 里的 `url`） |

`<base>` 由 **`container/app/src/main/assets/kernel-feed.json`** 决定（默认指向本仓 Release 下载地址，public 仓无需鉴权）。

## 2. 设备侧：怎么下

启动链（`NodeRuntimeService`）：

```
0b    本地 feed（/sdcard 等，adb 投放）        ← 明确意图，优先级最高
0b.5  远端 OTA（autoCheck=true，启动即检测）
      ① GET manifest（受 startupBudgetMs 约束）
      ② 比对 isNewer(remote, CURRENT)          ← 只升不降
      ③ 下载 zip 到 cacheDir（同样受预算约束）
      ④ KernelInstaller.install —— 唯一校验链：
           sha256 → ed25519 验签 → engines.node → requires 能力 → requiresProtocol 协议
           → 原子切换 files/kernel/CURRENT
      ⑤ 删除临时包
0c    内置基线兜底（APK 自带 baseline，只升不降）
spawn :node  ← CURRENT 此时已是新版 → **本次启动就跑新内核，无需额外重启**
```

**手动入口（等价）**：面板「检查内核更新」按钮 → `postMessage dsh:kernel-update-request` → `MainActivity` → 同一个 `KernelOtaUpdater`；或桥方法 `build.kernelUpdate { checkOnly? }`。

## 3. 失败语义（不假装成功）

| 情况 | 行为 |
|---|---|
| 离线 / 超出启动预算 | 本次跳过，诊断落 `kernel-ota`，**开机照常** |
| manifest 缺失/非法/无 version | 跳过 + 诊断（不猜） |
| 远端版本不新 | 不下载、**不重启** |
| 下载失败 / 校验不过（签名/sha256/协议） | **不切换 CURRENT**，诊断带真实 reason |
| 安装成功（启动路径） | 切 CURRENT，无需重启（spawn 在后） |
| 安装成功（手动路径） | 切 CURRENT + 重启 `:node`，回执 `restartUncertain:true` |

## 4. 为什么这样设计

- **单写入者**：内核包只能由容器 OTA 安装；内核自己不发布、不自更新（与 ADR-0002 同源）。
- **校验链唯一**：远端拿到的包**不比本地文件更可信** —— 两条路都过 `KernelInstaller`。
- **只升不降**：比较器与设备端同一规则（`container/engine/src/kernel-version.js` ↔ Kotlin `KernelManager.compareKernelVersions`）。
- **预算兜底**：开机不被网络绑架；超时下次启动或手动再试。

## 5. 排查

| 看什么 | 位置 |
|---|---|
| 壳/内核/协议三个身份 | `files/provisioning.json`（`appVersion` / `kernelVersion` / `bridgeProtocol`） |
| OTA 检查结果 | `files/diagnostics.txt` 的 `kernel-ota` 行 |
| 本地 feed / 基线 | `kernel-feed` / `kernel-baseline` 行 |
| 当前内核指针 | `files/kernel/CURRENT` |

## 6. 已知限制

- **没有推送通知**：检测时机只有"启动时"与"手动"两种（无 FCM/长连接）。推送新内核后，设备要下次启动或用户手动点才会拿到。
- `baseUrl` 硬编码在 APK 资产里：换仓库/换托管需重新出 APK。
- 内核包签名私钥（`OTA_PRIVATE_KEY_PEM`）是**独立信任根**，丢失则只能靠 APK 内置基线回退。
