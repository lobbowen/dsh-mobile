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
| 交付形态 | APK → 版本化归档 Release `v<versionName>`（资产名 `app-debug-<name>+<code>.apk`） | 随 APK 冻结（jniLibs/assets）或 C 通道清单供给 | 签名 OTA 包 `program-<version>.zip` + `program-manifest.json` |
| 设备侧身份 | 系统 `PackageManager`（versionCode） | nativeLibraryDir / `$PREFIX` 落位 | `files/programs/<id>/CURRENT` 指针 |
| 升级机制 | 同签名覆盖安装 | 随 OS 或按 C 清单供给 | 下载 → 验签 → sha256 → 原子切指针 |
| 唯一性约束 | `versionCode` **单调递增** | 运行时版本**不可复用** | Program `version` **不可复用** |

**关键**：三条流的版本号**从不互相比较**。「OS 1.2.0、Runtime node 24.21.0、Program 0.1.0」是完全正常的状态。

> 每流**只有一个发布口，且发哪一版写在 ref 名里**（OS `os-release-<name>-<code>`、Runtime
> `runtime-release-<ver>-<abi>`、Program `program-ota-<channel>-<version>`，另加 C 层
> `userland-<channel>-<revision>`）。这条纪律本身、以及被删掉的分支发布/管理模式的账，在
> ADR-0011（`docs/adr/0011-one-release-chain-per-stream.md`）—— 本 ADR 只讲版本身份与升级判定，
> 发布拓扑以 ADR-0011 为准。

---

## 2. 为什么 Program 版本必须「不可复用」

设备的更新判定是**版本比较**：只有「比当前新」才会切换 `CURRENT` 指针。
把**同一个版本号**重新打包发布（内容变了、版本没变）：设备判定「没有更新」→ **静默不生效**，且无任何报错。
这与 OS 流 `versionCode` 回退是同一类不可逆事故。

→ 各流各有一道「防静默失效」门禁：

| 流 | 门禁 | 拦的是 |
|---|---|---|
| OS | `scripts/verify-apk-version-gate.sh`（唯一投递口 fast-apk 调用）：回退硬红；同版本仅显式通道放行；线上读数取**两格并取严**（归档族资产名 + 回执账本） | 已升级设备收不到新版本；同号换字节；参照物被人删小后门自动变松 |
| Program | `program-ota` 发布前检查 `program-<version>` Release 是否已存在 → 已存在即硬红 | 版本复用导致设备永不更新 |
| Runtime | 供给清单版本 + 哈希核验 | 运行时换字节而版本不变 |

> OS 流的门禁加了一条 2026-09-30 补的不变量（债 DS-14）：**参照物必须是发起比对的那条链路自己会写的通道**。
> 判据唯一（`scripts/verify-apk-version-gate.sh`，参照物名由调用方必填传入），取数按通道形状分——
> 发布面当时读 `apk-latest` 的 `version.json` 资产，日常链读它自己写的 `v<versionName>` 归档族资产名
> （`scripts/read-archived-shell-version.sh`）。日常链原先拿发布面别名当参照物，而它从不写那条 ⇒ 门每次落
> 「首次发布」侧放行，从未比过任何一个数。
> 归一之后（ADR-0011）别名那条路整格消失：**壳 APK 只剩一个投递口，参照物只剩归档族**，
> `scripts/check-apk-release-version.sh` 现在对非 `archive` 的参照物名直接退 2 —— 「两个通道各读自己的参照物」
> 这种形状本身已经被删掉了，不是被修好了。
>
> 同日 DS-16 再补一条，它修正的是上面那句取数分工还**不够**：**线上那份参照物本身是可以被删的**，
> 所以它不能是唯一下界。实测 2026-09-30 当天日常链的归档族从 44 掉到 34（6 个 `v<数字>` Release 消失，删除动作
> 不在本仓任何代码里），门拿着变小了的参照物继续判绿。现在 OS 流的门禁吃**两格**：线上那一格（形状同上）+
> 回执账本那一格（`ci-receipts` 分支上只追加的 `apk-receipts.log`，写入唯一入口 `scripts/append-apk-receipt.sh`、
> 取数 `scripts/read-apk-receipts.sh`，投递口发布成功后记一笔，推送永不 `--force`），
> 两格**取严**（按高的那格比）；「有一次发布没记上账」与「线上那格被删小」都必须是看得见的事。
> 账本未起账时自动通道判红，起账只能由显式通道做一次——这条门在归一后**刻意没有调用方**
> （唯一保留它的理由：它是账本未起账这格的对照组出口，见 ADR-0011 §4）。
> 这与「不存在 / 取不到」的三态纪律是同一条（退码住在取数口：0=取到 / 10=确实没有 / 2=看不清，退 2 一律
> 禁止发布，见 `docs/runbook/release.md` §6；而**怎么把一句 gh 报错分成这两态**只住 `scripts/gh-absence.sh`，
> 三个取数口 `read-release-asset.sh` / `read-apk-receipts.sh` / `gh-release-upload.sh` 各自 source 它）：
> 「没有」与「看不清」不许混成一个结局，而一份词表抄三遍会让三条链对同一件线上事实得出相反结论。


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

这条要求**今天只兑现了一半**，下面先写代码里真有的那一半，再写缺的那一格（在册债 ENV-28）。

`files/provisioning.json` 的唯一写侧是 `container/app/src/main/java/lobos/ProvisioningProbe.kt`
（`writeSnapshot`，键全集见 :137-166；OTA 切指针后由 `refreshProgramOtaVersions` :118-132 只刷新版本那几格），
它现在给出的是：

- `appVersion` / `appVersionCode` —— OS；
- `programVersion` / `programFloor` / `programPending` —— Program（指针在 `files/programs/<id>/CURRENT`）；
- `bridgeProtocol` —— OS 实现的协议版本（用于判断某 Program 包是否可装）。

**缺的两格**（这一版文档原先把它们写成「已经有了」，是契约空指，与债表 ENV-19/ENV-20 同一形状）：

- Runtime 身份 —— 快照里**没有** `runtimeVersion` 这个键。真值源在设备上是有的（`assets/node-versions.json`
  由 `container/app/src/main/java/lobos/runtime/NodeVersionManager.kt` 的 `loadManifest` 读出 `default` 与 `abi`），
  缺的只是把它写进快照这一步；
- C 层清单身份 —— 线上清单的 `revision` 由 `userland-<channel>-<revision>` tag 给（仓内没有它的文件源），
  设备侧那份落在 `files/usr/lib/toolchain/userland-manifest.json`（放置与对账在 `lobos/runtime/SupplyProvisioner.kt`），
  同样从不写进快照，所以设备上「这次投的到底是哪一份清单」看不见（ENV-26 那轮 npx 的问题就卡在这里）。

排查「为什么某功能没生效」时，先看上面那三个真有的值；缺的两格今天只能 adb 进容器现算 —— **不许**把
「文档写了」当成「设备上有」。补这两格的在册债 = ENV-28（两格的真值源都在，缺的是写侧那一步与钉住它的门禁）。
