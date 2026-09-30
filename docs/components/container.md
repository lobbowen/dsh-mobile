# 容器层（L0 / container/）

OS（`container/`）是**冻结的安卓 APK**：原生 Kotlin 容器 + 随包 Runtime（node）+ 能力桥 + 签名 Program OTA + 生命周期/Journal + 诊断。
只在 OS/Runtime/能力桥变更时才重编；Program（console 等）靠签名 OTA 热更新承载。

## 目录

| 路径 | 内容 |
|---|---|
| `container/app/` | Android App（Kotlin）。`src/main/java/lobos/` 按域分包：`os/`（OsHost/OsInit/状态机/Journal）、`capability/`（CapabilityBroker）、`ota/`（ProgramOta/SystemOta）、`bridge/`（能力桥服务端）、`runtime/`（InstanceHost）、`appmgr`/`registry`、`native/`（原生资产）、`permissions/`、`ui/` |
| `container/engine/` | 零依赖 Node 实现：Program 包打包/验签/解包、桥协议参考实现、CI 逻辑测试 |
| `container/native/` | C 源：`d1/`（Linux 语义兑现：link/open/tmp/exec-path）、`d2/`（Android 平台件库）。来源与许可见 [native.md](native.md) |
| `container/app/src/main/assets/` | 随包资产：`node/program-verify.js`（验签器）、`node/adb-client/`（ADB 客户端）、`ota-public.pem`（公钥锚点）、`program-feed.json`（OTA feed 配置）、`node-versions.json` |

> `container/_artifacts/` 已删除：它曾是签入的 Program 包样本（feed/baseline/release 三份同一 sha256），
> 随 **ADR-0005**（Program 不随 APK 分发、本地 feed 与内置基线整体删除）失去存在理由。
> Program 产物现在只由 `program-ota.yml` 构建、签名后投递（见 [../runbook/program-ota.md](../runbook/program-ota.md)）。

## 两条热更新通道

- OS → Program：**签名 OTA**（ed25519，公钥焊进 APK；见 [../runbook/release.md](../runbook/release.md)、[../adr/0005-program-via-ota-only.md](../adr/0005-program-via-ota-only.md)）。
- Program → 生态依赖：运行时 **npm integrity**（sha512）。

## 构建与出包

| 场景 | 走哪条 | 耗时 |
|---|---|---|
| 改 Kotlin / res / assets / gradle | `fast-apk.yml`（推 `os-release-*` tag 才投递） | 分钟级 |
| 改 `scripts/build-node-android.sh` / 升级 Node | `build-apk.yml`（推 `runtime-release-*` tag 同轮固化） | 2~3 小时 |
| 改 `container/engine/**` | `ci.yml` 的 container job | 分钟级 |

硬约束（W^X / `DT_RUNPATH` / Ed25519）见 [../architecture.md](../architecture.md)。
