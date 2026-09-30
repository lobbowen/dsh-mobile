# ADR-0004：三版本流（OS / Runtime / Program）

- 状态：**已决定**（2026-09-23 双流；**2026-09-28 v4 修订为三流**）
- 关联：ADR-0005（System/Runtime/Program OTA）· ADR-0008（OS 原生 init）· ADR-0010（容器形态）
- 背景：OS、Runtime、Program 是**三条独立的交付与升级通道**，必须各有自己的版本号与发布节奏。
  把任意两条绑成一个版本号，就会出现「内容变了但版本没变」（设备静默不更新）或「另一条没变却被迫发版」。

---

## 1. 三条流，各自独立

| | **OS 流（APK / 原生）** | **Runtime 流（node 等）** | **Program 流（载荷）** |
|---|---|---|---|
| 内容 | `container/app`（Kotlin 原生 OS）· rom | node/python/go/java 等运行时 | console / dsh / pi … |
| 版本事实源 | 仓根 `version.json`（`shell.versionName` + `versionCode`） | `container/app/src/main/assets/node-versions.json` 及供给清单 | 各 `programs/<id>/manifest.json` + `package.json` |
| 交付形态 | APK → Release `apk-latest` | 随 APK 冻结（jniLibs/assets）或 C 通道清单供给 | 签名 OTA 包 `program-<version>.zip` + `program-manifest.json` |
| 设备侧身份 | 系统 `PackageManager`（versionCode） | nativeLibraryDir / `$PREFIX` 落位 | `files/programs/<id>/CURRENT` 指针 |
| 升级机制 | 同签名覆盖安装 | 随 OS 或按 C 清单供给 | 下载 → 验签 → sha256 → 原子切指针 |
| 唯一性约束 | `versionCode` **单调递增** | 运行时版本**不可复用** | Program `version` **不可复用** |

**关键**：三条流的版本号**从不互相比较**。「OS 1.2.0、Runtime node 24.21.0、Program 0.1.0」是完全正常的状态。

---

## 2. 为什么 Program 版本必须「不可复用」

设备的更新判定是**版本比较**：只有「比当前新」才会切换 `CURRENT` 指针。
把**同一个版本号**重新打包发布（内容变了、版本没变）：设备判定「没有更新」→ **静默不生效**，且无任何报错。
这与 OS 流 `versionCode` 回退是同一类不可逆事故。

→ 各流各有一道「防静默失效」门禁：

| 流 | 门禁 | 拦的是 |
|---|---|---|
| OS | `scripts/verify-apk-version-gate.sh`（fast-apk / build-apk / release-admin 四个发布口共用）：回退硬红；同版本仅显式通道放行；线上读数取**两格并取严**（归档族/Release 清单 + 回执账本） | 已升级设备收不到新版本；同号换字节；参照物被人删小后门自动变松 |
| Program | `program-ota` 发布前检查 `program-<version>` Release 是否已存在 → 已存在即硬红 | 版本复用导致设备永不更新 |
| Runtime | 供给清单版本 + 哈希核验 | 运行时换字节而版本不变 |

> OS 流的门禁加了一条 2026-09-30 补的不变量（债 DS-14）：**参照物必须是发起比对的那条链路自己会写的通道**。
> 判据唯一（`scripts/verify-apk-version-gate.sh`，参照物名由调用方必填传入），取数按通道形状分两处——
> 发布面读 `apk-latest` 的 `version.json` 资产，日常链读它自己写的 `v<versionName>` 归档族资产名
> （`scripts/read-archived-shell-version.sh`）。日常链原先拿发布面别名当参照物，而它从不写那条 ⇒ 门每次落
> 「首次发布」侧放行，从未比过任何一个数。
>
> 同日 DS-16 再补一条，它修正的是上面那句「取数按通道形状分两处」还**不够**：**线上那份参照物本身是可以被删的**，
> 所以它不能是唯一下界。实测 2026-09-30 当天日常链的归档族从 44 掉到 34（6 个 `v<数字>` Release 消失，删除动作
> 不在本仓任何代码里），门拿着变小了的参照物继续判绿。现在 OS 流的门禁吃**两格**：线上那一格（形状同上）+
> 回执账本那一格（`ci-receipts` 分支上只追加的 `apk-receipts.log`，写入唯一入口 `scripts/append-apk-receipt.sh`、
> 取数 `scripts/read-apk-receipts.sh`，四个发布口发布成功后各自记一笔，推送永不 `--force`），
> 两格**取严**（按高的那格比）；「有一次发布没记上账」与「线上那格被删小」都必须是看得见的事。
> 账本未起账时自动通道判红，起账只能由显式通道（`fast-*` tag / 人工触发）做一次——
> 这与「不存在 / 取不到」的三态纪律是同一条（宿主：`scripts/read-release-asset.sh`，退 0=取到 / 10=确实没有 / 2=看不清，
> 退 2 一律禁止发布，见 `docs/runbook/release.md` §6）：「没有」与「看不清」不许混成一个结局。


---

## 3. 兼容契约（Program 声明，OS 校验）

Program 跑在 OS 提供的环境里，必须在 manifest 里**显式声明它要什么**，由 OS 在**安装前**校验：

| 字段 | 位置 | 含义 | 现状 |
|---|---|---|---|
| `runtime.range` | `programs/<id>/manifest.json` | 要求的 Runtime 版本范围 | ✅ 已有 |
| `capabilities[]` | manifest | 要求的能力组 | ✅ 已有 |
| `requiresProtocol` | manifest（`lobos.requiresProtocol`） | 要求的最低**桥协议版本** | ✅ 已迁至 `lobos` 命名空间 |
| `bridgeProtocol` | `version.json`（OS） | OS 实现的桥协议版本 | ✅ 已有 |

校验：`requiresProtocol <= bridgeProtocol`，否则拒绝安装，reason = `protocol-unsatisfied`。

> 这三者合起来回答「**这个 Program 包能不能装在这套 OS 上**」——与「版本哪个更新」是两个正交问题。

---

## 4. 发布解耦规则（改哪层 bump 哪个）

| 改动范围 | 必须 bump | 不动的 |
|---|---|---|
| `programs/<id>/**` | 该 Program 的 `package.json` + `manifest.json` `version` | OS / Runtime 不动 |
| `container/app/**`（Kotlin / res / manifest） | `version.json` 的 `shell.versionCode`(+1)、`versionName` 视语义 | Runtime / Program 不动 |
| Runtime 版本（升级 node 等） | Runtime 事实源 + OS `versionCode` | Program 不动 |
| 桥协议语义变更 | **两侧都动**：OS `bridgeProtocol` +1；受影响 Program `requiresProtocol` 跟上 | — |

---

## 5. 设备端必须能同时回答「我是谁」

`files/provisioning.json` 同时给出**三个身份**，缺一不可：

- `appVersion` / `appVersionCode` —— OS；
- `runtimeVersion` —— Runtime（如 node 24.x）；
- `programVersion`（或各 Program 指针）—— Program（`files/programs/<id>/CURRENT`）；
- `bridgeProtocol` —— OS 实现的协议版本（用于判断某 Program 包是否可装）。

排查「为什么某功能没生效」时，第一件事就是看这几个值。
