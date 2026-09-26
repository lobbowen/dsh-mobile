# 容器层（L0 / container/）

L0 是**冻结的安卓 APK**：Node 运行时 + npm 客户端 + HostBridge 能力桥 + 签名 OTA 引擎 + 生命周期 + 诊断。
只在 Node / 桥能力变更时才重编；L1 内核与 L2 Agent 都靠热更新承载。

## 目录

| 路径 | 内容 |
|---|---|
| `container/app/` | Android App（Kotlin）。`src/main/java/io/github/lobbowen/dshmobile/` 按域分包：`bridge/`（HostBridge UDS）、`kernelota/`（OTA）、`capability/`（能力登记与取法）、`lifecycle/`（保活/监督）、`native/`（原生资产）、`permissions/`、`runtime/`（启动装配）、`ui/` |
| `container/engine/` | 零依赖 Node 实现：内核包打包/验签/解包、桥协议参考实现、CI 逻辑测试 |
| `container/native/` | C 源：`flock/`（上游 vendored）、`posix/`（自有 link/open 垫片）、`ptyprobe/`（PTY 探针）。来源与许可见 [native.md](native.md) |
| `container/app/src/main/assets/` | 随包资产：`node/kernel-verify.js`（验签器）、`node/adb-client/`（ADB 客户端）、`ota-public.pem`（公钥锚点）、`kernel-feed.json`（OTA feed 配置）、`node-versions.json` |

> `container/_artifacts/` 已删除：它曾是签入的内核包样本（feed/baseline/release 三份同一 sha256），
> 随 **ADR-0005**（内核不随 APK 分发、本地 feed 与内置基线整体删除）失去存在理由。
> 内核产物现在只由 `kernel-ota.yml` 构建、签名后投递（见 [../runbook/kernel-ota.md](../runbook/kernel-ota.md)）。

## 两条热更新通道

- 容器 → 内核：**签名 OTA**（ed25519，公钥焊进 APK；见 [../runbook/release.md](../runbook/release.md)、[../adr/0005-kernel-via-ota-only.md](../adr/0005-kernel-via-ota-only.md)）。
- 内核 → Agent：运行时 **npm integrity**（sha512）。

## 构建与出包

| 场景 | 走哪条 | 耗时 |
|---|---|---|
| 改 Kotlin / res / assets / gradle | `fast-apk.yml` | 分钟级 |
| 改 `scripts/build-node-android.sh` / 升级 Node | `build-apk.yml`（手动）+ pin | 2~3 小时 |
| 改 `container/engine/**` | `ci.yml` 的 container job | 分钟级 |

硬约束（W^X / `DT_RUNPATH` / Ed25519）见 [../architecture.md](../architecture.md)。
