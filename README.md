# Lob OS

> **Lob OS = Android 之上的一套 Agent OS 容器。** 一个冻结的安卓 APK 里含原生 OS（Kotlin）+ 随包运行时（node）
> + 能力桥 + 签名 Program OTA + 生命周期/诊断；上面承载可替换的 **Program**（默认控制面板、agent 载荷…）。
>
> Android 侧只看见**一个东西**：1 进程 / 1 前台服务 / 1 常驻通知 / 1 控制台承载面。

架构与硬约束见 [docs/architecture.md](docs/architecture.md)；**全部文档索引见 [docs/README.md](docs/README.md)**。

---

## 1. 三层实体（OS / Runtime / Program）

| 层 | 名称 | 更新方式 | 冻结？ | 职责 |
|---|---|---|---|---|
| **OS** | 原生容器（本仓库 APK，Kotlin） | 同签名覆盖安装 | ✅ | `OsHost`/`OsInit` · 状态机/Journal · 端口 · 存储 · 安装校验 · 能力裁决 · ConsoleHost |
| **Runtime** | 可插拔运行时（node 现役，python/go 未来） | 随 OS 冻结或 C 通道清单供给 | 视件 | 承载 Program 的运行时本体 |
| **Program** | 载荷（`programs/console` 控制面板；agent 载荷各一套） | OS 的**签名 OTA** 热更新 | ❌ | 看状态 / 发起安装管理 / 干活；只调 OS 能力 API |

三条实体是**三条独立版本流**（OS / Runtime / Program），互不比较；见 [ADR-0004](docs/adr/0004-three-version-streams.md)。
「内核」不是一层 —— `programs/console` 只是默认控制面板 Program，**可停可换**；系统职责全归 OS 原生（[ADR-0010](docs/adr/0010-lob-os-container-form.md)）。

**两条更新通道**（双信任根，互不替代）：
- OS → Program：**签名 OTA**（ed25519 私钥签 Program 包，公钥焊进 APK 验签）。
- Runtime/生态：**npm 标准完整性**（sha512 integrity）与 C 通道签名清单。

---

## 2. 仓库结构

```
lobos/                                       # 单仓
├─ container/                                # ── OS（冻结 APK）──
│  ├─ app/src/main/
│  │  ├─ jniLibs/arm64-v8a/libnode.so        # NDK 产出的 node（构建时注入）
│  │  ├─ assets/{node/, node-versions.json, ota-public.pem, program-feed.json}
│  │  └─ java/lobos/                         # OS 原生：os/ capability/ ota/ runtime/ ui/ …
│  ├─ engine/                                # 可测 OTA 引擎（Node，零依赖）
│  ├─ native/{d1,d2}/                        # C 源：随包原生桥与探针
│  └─ rom/                                   # ── Tier S（ROM/priv-app 集成）──
├─ programs/                                 # ── Program（可替换载荷）──
│  ├─ console/                               # 默认控制面板 Program
│  └─ <agent>/manifest.json                  # 其他载荷（各一套 manifest）
├─ docs/                                     # ★ 全部文档的唯一归宿（源码目录内不放文档）
├─ scripts/                                  # 跨层构建/发布工具
├─ gradle*/settings.gradle.kts               # 根构建（:app → container/app）
└─ .github/workflows/                        # CI（唯一合法验证通道）
```

### 2.1 规范索引（改动前先读）

| 主题 | 文件 |
|---|---|
| **全部文档索引** | [docs/README.md](docs/README.md) |
| 架构与硬约束 | [docs/architecture.md](docs/architecture.md) |
| 形态与决策 | [ADR-0010](docs/adr/0010-lob-os-container-form.md) |
| 存储位置 / 目录契约 / 对账 | [docs/standards/storage.md](docs/standards/storage.md)、[docs/contracts/layout.json](docs/contracts/layout.json) |
| 开发流程 | [docs/runbook/contributing.md](docs/runbook/contributing.md) |
| Git / 提交 / 令牌 | [docs/runbook/git.md](docs/runbook/git.md) |
| **测试（本地禁止执行仓内代码）** | [docs/standards/testing.md](docs/standards/testing.md) |
| **发布 / 版本 / 密钥 / PAT** | [docs/runbook/release.md](docs/runbook/release.md) |
| **Program OTA（怎么推 / 怎么下）** | [docs/runbook/program-ota.md](docs/runbook/program-ota.md) |
| 决策记录（含已否决方案） | [docs/adr/](docs/adr/) |
| 契约（Program manifest / 运行时 / 桥协议） | [docs/contracts/](docs/contracts/) |
| control panel 组件说明 | [docs/components/console.md](docs/components/console.md) |

### 2.2 为什么 node 以 `libnode.so` 放在 jniLibs

这是本项目踩过的最大一个坑，也是**真机 `error=13, Permission denied` 的根因**。关键前提：

> **W^X 的适用面取决于 `targetSdk`，而本产品刻意钉在 `targetSdk = 28`**
> （`container/app/build.gradle.kts`）。28 落在 SELinux 的 `untrusted_app_27` 域，
> **允许 app home 内 exec** —— `$PREFIX` 下的 bash/rg/node 全靠这一条。取舍见
> [ADR-0001](docs/adr/0001-android-execution-domain.md)。

把**要被 exec 的 ELF**（`libnode.so`）放在 `nativeLibraryDir`（jniLibs 免解压落点），
把**被 node 解释的脚本**（`panel`）按参数交给 node。配套条件：文件名 `lib*.so`；
`useLegacyPackaging=true`；解释器为 `/system/bin/linker64`；`DT_RUNPATH` 含 `$ORIGIN`。
详见 [docs/architecture.md](docs/architecture.md) 第 3 节。

> `File.canExecute()` 对此**完全无感** —— 判断能否执行，唯一可靠的办法是真去执行一次（exec-probe，清空环境跑 `node -v`）。

---

## 3. 启动与保活（单一生命周期）

启动链（`OsHost`/`OsInit`，原生）：预置体检 → 起能力桥 → 读 Program 指针 → 启动链 OTA
（在 spawn **之前**查一次 feed，需要则下载+校验+安装）→ 确认内置 node 就位 → 装配环境 →
`spawn` 各 Program 实例（子进程，AMS 不可见）→ 轮询控制面，失败退避重启。

**常驻 = 五层保活（唯一路径）**：锚（无障碍绑定）/ 载体（唯一 FGS + 常驻通知）/
豁免（电池·Doze 白名单 + OEM 用户开关引导）/ 唤醒（**按需短持** wake/wifi 锁 + Doze 兜底）/
可见（QS Tile + 通知 + `os-state.json` 三处同源）。

> **不设兜底 / 续跑 / 复活**：agent 断即停；被杀之后唯一诚实的动作是**让打断可见**（Journal 记中断点）。
> 见 [ADR-0006](docs/adr/0006-background-lifecycle-keepalive.md)。

---

## 4. HostBridge（能力桥）

- **传输**：Unix 域套接字（抽象命名空间 `lobos_hostbridge`）；Program 主动 connect。**严禁 TCP 暴露控制面**。
- **协议**：JSON-RPC 2.0，换行分隔 JSON 帧；握手协商 `capabilities` / `groups`。
- **方法组**：`app_control / ui_automation / shell / storage / notification / system / program` 等。
- **鉴权**：组级 + 方法级两层门禁；未授权 → `ERR_CAPABILITY_MISSING (-32001)`；未知方法 → `METHOD_NOT_FOUND (-32601)`。
- **审计**：所有特权操作落 `files/bridge-audit.log`。

> 协议细节见 [docs/contracts/bridge-protocol.md](docs/contracts/bridge-protocol.md)。

---

## 5. 快速开始

### 5.1 编译 Node 二进制（一次性）

前置：`git python3 ninja cmake make zip` + **Android NDK r27+**。

```bash
ANDROID_NDK=/path/to/ndk ./scripts/build-node-android.sh 24.21.0
# 产物 -> container/app/src/main/jniLibs/arm64-v8a/libnode.so
```

### 5.2 生成 OTA 密钥对（开发期）

```bash
./scripts/keygen.sh
# 生成 keys/ota-private.pem（gitignored）+ 公钥焊进 container/app/src/main/assets/ota-public.pem
```

### 5.3 出包（APK）

**路径 A（推荐）：GitHub Actions 一键出包** —— `fast-apk.yml`（日常，分钟级）或 `build-apk.yml`（改了 Node 版本/编译脚本，2~3 小时）。

**路径 B（本地逃生通道 —— 需 SDK/NDK/JDK；项目政策是构建一律走 CI）：**

```bash
export ANDROID_HOME=/path/to/sdk ANDROID_NDK=/path/to/ndk   # NDK r27+
./scripts/build-apk-local.sh
adb install -r container/app/build/outputs/apk/debug/app-debug.apk
```

### 5.4 构建并签名 Program OTA 包

```bash
./scripts/build-program-bundle.sh <program-src-dir> <version> node24-arm64-android35 <url_base>
# 产物（release/，gitignored）：<program 包>.zip + program-manifest.json
```

CI 等价流程见 `.github/workflows/program-ota.yml`（用 `OTA_PRIVATE_KEY_PEM` 签名，绝不进 APK）。

---

## 6. container/engine（可测 OTA 引擎）

纯 Node、零外部依赖。测试**只在 CI 跑**（`scripts/require-ci.js` 拦截本地执行）：

```bash
# CI: cd container/engine && npm run test:logic
```

说明（ADR-0005）：曾经的 `test:baseline`（验 APK 内置基线产物）已随「Program 不随 APK 分发」整体删除。

---

## 7. 已核实事实

- **Node LTS = 24 Krypton**（默认 24.21.0，见 `container/app/src/main/assets/node-versions.json`）；Node 24 自带 OpenSSL 3.5。
- **16KB 页对齐**：NDK r27+ 编译满足安卓 15+ (API 35) `dlopen` 要求。
- **双信任根**：ed25519 私钥签 Program 包、公钥焊进 APK；npm 标准 integrity 验生态依赖。
- **传输私有**：Program ↔ OS 走 UDS，不走 TCP。
- **设备管理员模式已全面退出**：仅保留「用户手动同意」的安装路径。
