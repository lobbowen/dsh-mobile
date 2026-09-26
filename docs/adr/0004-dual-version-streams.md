# ADR-0004：双版本流（壳流 / 内核流）

- 状态：**已决定**（2026-09-23）
- 背景：APK 与内核是**两条独立的交付与升级通道**；很多时候**只更新内核、不动 APK**。
  若把两者绑成一个版本号，就会出现"内核变了但版本没变"（设备静默不更新）
  或"APK 没变却被迫发版"两种错误。

---

## 1. 两条流，各自独立

| | **壳流（L0 / APK）** | **内核流（L1 / kernel）** |
|---|---|---|
| 版本号 | `versionName`(semver) + `versionCode`(单调整数) | `version`(semver，可带 `-android.N`) |
| 单一事实源 | **`version.json`**（仓根） | **`kernel/package.json`** |
| 交付形态 | APK → Release `apk-latest` | 签名 OTA 包 `kernel-<version>.zip` + `kernel-manifest.json` |
| 设备侧身份 | 系统 `PackageManager`（versionCode） | `files/kernel/CURRENT` 指针 + `files/kernel/<version>/` |
| 升级机制 | **同签名覆盖安装** | 下载 → 验签 → sha256 → 原子切换指针 |
| **唯一性约束** | `versionCode` **单调递增**（只增不减） | `version` **不可复用**（发布即冻结） |
| 变更来源 | `container/app/**` | `kernel/**` |
| 谁触发更新 | 用户 / 外部 OTA 升级 APK | **容器 OTA 引擎是唯一写入者**（内核只"请求"，不自更新） |

**关键**：两条流的版本号**从不互相比较**。"APK 是 0.2.0、内核是 0.1.0-android.11" 是完全正常的
状态，不表示任何不一致。

## 2. 为什么内核版本必须"不可复用"

设备的更新判定是**版本比较**（`KernelManager.compareKernelVersions`）：
只有"比当前新"才会切换 `CURRENT` 指针。

因此若把**同一个版本号**重新打包发布（内容变了、版本没变）：
设备会判定"没有更新可用" → **静默不生效**，且没有任何报错。
这与壳流 `versionCode` 回退是**同一类不可逆事故**，只是发生在另一条流上。

→ 两条流各有一道"防静默失效"门禁：

| 流 | 门禁 | 拦的是 |
|---|---|---|
| 壳 | 判据 `scripts/verify-apk-version-gate.sh`（四个发布口共用：`fast-apk` / `build-apk` / `release-admin` 的 publish 与 repack）：回退一律硬红，**同版本只有显式通道放行** | 已升级设备收不到新版本；同号换字节让 latest 地址指向的东西变了而版本号看不出来（正是上面那句「静默不生效」在壳流的形态） |
| 内核 | `kernel-ota` 发布前检查 `kernel-<version>` Release 是否已存在 → 已存在即硬红 | 版本复用导致设备永不更新 |

## 3. 兼容契约（内核声明，壳校验）

内核运行在壳提供的环境里，所以必须**显式声明它要什么**，由壳在**安装前**校验：

| 字段 | 位置 | 含义 | 现状 |
|---|---|---|---|
| `engines.node` | `kernel.json` | 要求的最低 Node 运行时 | ✅ 已有（不满足 → `node-engine-unsatisfied`） |
| `requires[]` | `kernel.json` | 要求的能力组 | ✅ 已有（不满足 → `capability-missing`） |
| `requiresProtocol` | `kernel.json` | 要求的最低**桥协议版本** | ➕ 本 ADR 引入 |
| `bridgeProtocol` | `version.json`（壳） | 壳实现的桥协议版本 | ➕ 本 ADR 引入 |

校验：`requiresProtocol <= bridgeProtocol`，否则拒绝安装，reason = `protocol-unsatisfied`。

> 这三者合起来回答："**这个内核包能不能装在这台壳上**"——与"版本哪个更新"是两个正交问题。

## 4. 发布解耦规则（改哪层 bump 哪个）

| 改动范围 | 必须 bump | 不动的 |
|---|---|---|
| `kernel/**`（内核逻辑 / 面板） | `kernel/package.json` 的 `version` | **壳版本不动**（这正是"只更新内核"） |
| `container/app/**`（Kotlin / 资源 / 清单） | `version.json` 的 `shell.versionCode` (+1)，`versionName` 视语义 | 内核版本不动 |
| 桥协议语义变更 | **两边都动**：壳 `bridgeProtocol` +1；内核 `requiresProtocol` 跟上 | — |
| 只改 `kernel/ui/**` | `kernel/ui/package.json` 的 `version` | 以上都不动 |

## 5. 设备端必须能同时回答"我是谁"

`files/provisioning.json` 同时给出**两个身份**，缺一不可：

- `appVersion` / `appVersionCode` —— 壳
- `kernelVersion` —— 内核（`files/kernel/CURRENT`）
- `bridgeProtocol` —— 壳实现的协议版本（用于判断某内核包是否可装）

排查"为什么某功能没生效"时，第一件事就是看这三个值。
