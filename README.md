# Android Node Container（DSH 容器底座 / L0）

> 把手机变成「工作台」的**地基**：一个冻结的安卓 APK，内含原生 Node 运行时 + HostBridge 能力桥 + 签名 OTA 引擎 + 生命周期/诊断。
> 真正的产品（控制面板内核 L1、Agent L2）由这套底座**热更新**承载 —— APK 只在 Node/桥能力变更时才重编。

架构与硬约束见 [docs/architecture.md](docs/architecture.md)；契约见 [docs/contracts/](docs/contracts/)；**全部文档索引见 [docs/README.md](docs/README.md)**。

---

## 1. 三层架构（base-spec §2）

| 层 | 名称 | 更新方式 | 冻结？ | 职责 |
|---|---|---|---|---|
| **L0** | 容器（本仓库 APK） | 仅 Node/桥能力变更才重编 | ✅ | Node 运行时 + npm 客户端 + **HostBridge（UDS 能力桥）** + **OTA 引擎** + 生命周期 + 诊断 |
| **L1** | 内核 = 控制面板 / Manager | 容器**签名 OTA** 热更新 | ❌ | 控制面板代码 + `kernel.json`；运行在 Node 运行时内；运行时经 npm 安装/管理 Agent |
| **L2** | Agent 产品 | 内核运行时 **npm（公共源）** | ❌ | Codex / Claude Code / DeepSeek Harness 等标准公共产品，由内核拉取 |

L0/L1/L2 是**发布维**（更新通道与冻结度）。容器内部的**职责维**分层（L-A 生命周期 / L-B 能力桥 / L-C 运行时环境 / L-D 生态适配 / L-E 内核工具箱）见 [docs/architecture.md](docs/architecture.md) §1.1。

**两条热更新通道**（双信任根，互不替代）：
- 容器 → 内核：**签名 OTA**（容器 ed25519 私钥签内核包，公钥焊进 APK 验签）。
- 内核 → Agent：运行时 **npm 标准完整性**（sha512 integrity）。

---

## 2. 仓库结构

```
dsh-mobile/                                  # 单仓双子项目（M）
├─ container/                                # ── L0 容器（冻结 APK）──
│  ├─ app/src/main/
│  │  ├─ jniLibs/arm64-v8a/libnode.so       # NDK 产出的 node（构建时注入）
│  │  ├─ assets/{node/, node-versions.json, ota-public.pem, kernel-feed.json}
│  │  └─ java/io/github/lobbowen/dshmobile/    # 服务 / HostBridge / OTA / 诊断 / 原生资产
│  ├─ engine/                               # 可测 OTA 引擎（Node，零依赖）
│  └─ native/{posix,flock,ptyprobe}/        # C 源：随包原生桥与探针
├─ kernel/                                  # ── L1 内核（签名 OTA 热更新）──
├─ system/                                  # ── Tier S（ROM/priv-app 集成）──
├─ docs/                                    # ★ 全部文档的唯一归宿（源码目录内不放文档）
│  ├─ README.md                             # 文档索引
│  ├─ architecture.md                       # 架构与硬约束（唯一事实来源）
│  ├─ adr/ · contracts/ · standards/ · runbook/ · components/ · plans/
├─ scripts/                                 # 跨层构建/发布工具
├─ _archive/                                # 历史归档（只读）
├─ gradle*/settings.gradle.kts              # 根构建（:app → container/app）
└─ .github/workflows/                       # CI（唯一合法验证通道）
```

### 2.1 规范索引（改动前先读）

| 主题 | 文件 |
|---|---|
| **全部文档索引** | [docs/README.md](docs/README.md) |
| 架构与硬约束（唯一事实来源） | [docs/architecture.md](docs/architecture.md) |
| 存储位置 / 目录契约 / 对账 | [docs/standards/storage.md](docs/standards/storage.md)、[docs/contracts/layout.json](docs/contracts/layout.json) |
| 开发流程（改什么走哪条） | [docs/runbook/contributing.md](docs/runbook/contributing.md) |
| Git / 提交 / 令牌使用 | [docs/runbook/git.md](docs/runbook/git.md) |
| **测试（本地禁止执行仓内代码）** | [docs/standards/testing.md](docs/standards/testing.md) |
| **发布 / 版本 / 密钥 / PAT** | [docs/runbook/release.md](docs/runbook/release.md) |
| **内核 OTA（怎么推 / 怎么下）** | [docs/runbook/kernel-ota.md](docs/runbook/kernel-ota.md) |
| 决策记录（含已否决方案） | [docs/adr/](docs/adr/) |
| 契约（内核包 / 运行时 / 桥协议） | [docs/contracts/](docs/contracts/) |
| **L0 GUI 开场管线 / S0 配对交互** | [docs/contracts/ui-onboarding-spec.md](docs/contracts/ui-onboarding-spec.md)、[ADR-0007](docs/adr/0007-l0-gui-onboarding-and-pairing-ux.md) |

### 2.2 为什么 node 以 `libnode.so` 放在 jniLibs

这是本项目踩过的最大一个坑，也是**真机 `error=13, Permission denied` 的根因**。但要注意一个关键前提：

> **W^X 的适用面取决于 `targetSdk`，而本产品刻意钉在 `targetSdk = 28`**
> （`container/app/build.gradle.kts`）。28 落在 SELinux 的 `untrusted_app_27` 域，
> **允许 app home 内 exec** —— `$PREFIX` 下的 bash/rg/node 全靠这一条。取舍见
> [ADR-0001](docs/adr/0001-android-execution-domain.md)。
>
> 所以「`filesDir` 一律禁 execve」是**不准确**的说法（旧文档里有过，ADR-0001 D1 已纠正）。
> 对 targetSdk ≥ 29 的应用，Android 10 起强制 W^X：app home 禁 exec，只有
> `/data/app/<pkg>/lib/<abi>/`（`exec_type`）可执行。官方认定"设计如此"（Google issuetracker 128554619）。

本项目把**要被 exec 的 ELF**（`libnode.so`）放在 `nativeLibraryDir`（jniLibs 免解压落点），
把**被 node 解释的脚本**（`dsh-supervisor`）按参数交给 node。三个配套条件：

1. 文件名必须是 `lib*.so` 形式，否则 AGP 不会当 native lib 处理；
2. `android:extractNativeLibs="true"`（Manifest 与 gradle 两处都写了）—— 否则 `.so` 压缩在 APK 内不落盘；
3. 二进制解释器必须是 Android 的 `/system/bin/linker64`（交叉编译产物天然满足）。

> **还有一个链接期条件**：二进制的 `DT_RUNPATH` 必须含 `$ORIGIN`。Android linker 查找依赖库的目录只有
> `$LD_LIBRARY_PATH` / `DT_RUNPATH` / 系统默认路径三者，`nativeLibraryDir` 不在其中。依赖解析不能靠调用方补环境变量。
> 由 `scripts/build-node-android.sh` 链接期注入，`scripts/verify-runtime-elf.sh` 在五个出口把住。
> 完整论证见 [docs/architecture.md](docs/architecture.md) 第 3 节。

> **一个隐蔽的陷阱**：`File.canExecute()` 对上述限制**完全无感** —— 它只查 stat 的 x 权限位。
> **判断能否执行，唯一可靠的办法是真去执行一次**（`NativePreparer.probe`：以**清空后的环境**跑 `node -v`）。

---

## 3. 内核启动流程（base-spec §9）

`NodeRuntimeService`（独立 `:node` 进程，`START_STICKY` 前台通知）由 `ContainerSupervisor`
（:main，L-A 监督者）持有 binder 边并负责复活；进入链路后 :node 的 boot 循环依次：

1. **预置体检**（`ProvisioningProbe`）：按 `CapabilityCatalog.ALL` 的能力登记表（schema 2）逐项落 `diagnostics.txt` + `provisioning.json`。
2. 确保 **HostBridgeService**（UDS 监听，内核侧主动 connect）。
3. 读 `files/kernel/CURRENT`；启动链 OTA（`autoCheck` 缺省 true）在 spawn **之前**查一次远端 feed，无内核/有更新即下载+校验+安装（ADR-0005：**APK 不内置基线，本地 feed 已删除**）。
4. 确认内置 node 就位 → 自检两个 `.so` → **exec-probe 真跑一次 `node -v`**。
5. 确认冻结的 Node 版本（读 `container/app/src/main/assets/node-versions.json` 的 `default`；不存在 `files/node/CURRENT` 这条运行时路径）。
6. 写 **runtime.json（schema 2，容器写内核读）** 到 `files/supervisor/runtime.json`。
7. 装配安卓环境（**唯一装配点 `runtime/GuestAdapter`**）。
8. `spawn node bin/dsh-supervisor daemon`；无内核包时回落到 `assets/node/server.js` 探针（:3080）。
9. 轮询控制面（有内核看 `36360/status`；探针模式看 `3080`）；失败/进程退出 → 退避重启。

> 一次内核升级 = 重启**内核子进程**（:node 宿主进程不重启）：面板发 `ACTION_RESTART`，
> :node destroy 子进程后由自家 boot 循环按退避重拉。

---

## 4. HostBridge（能力桥，职责维 L-B）

- **传输**：Unix 域套接字（抽象命名空间 `dsh_hostbridge`）；内核经 `net.connect('\0dsh_hostbridge')` 主动连接。**严禁 TCP 暴露控制面**（base-spec §8）。
- **协议**：JSON-RPC 2.0，换行分隔 JSON 帧；握手协商 `capabilities` / `groups`。
- **8 组方法**：`app_control / ui_automation / shell / device_policy / storage / build / notification / system`。
- **鉴权**：**两层门禁** —— 组级（握手按每组**代表能力**协商）+ 方法级（每次调用按 `caps` 精确拦截）。未授权 → `ERR_CAPABILITY_MISSING (-32001)`；未知方法 → `METHOD_NOT_FOUND (-32601)`。
- **审计**：所有特权操作落 `files/bridge-audit.log`。

| 方法组 | 状态 | 说明 |
|---|---|---|
| `app_control` / `notification` / `system` | ✅ | 真实实现 |
| `device_policy` | ✅ | `dpm.*` 真实调用（需 Device Owner） |
| `ui_automation` | ✅ | 手势/节点树/文本注入 + `ui.screenshot`（MediaProjection） |
| `storage` | ✅ | `fs.read/write/list/mkdir` 真实实现 |
| `shell` | ✅ | **壳自带 ADB 客户端（无线调试）**：`shell.pair/status/exec/forget`，exec 以 shell uid(2000) 执行（能力 `adb_shell`）。Shizuku 已删除（ADR-0003 勘误） |
| `build` | ✅ | 语义 = **经 OTA 安装已签名内核**（`build.kernelInstall/kernelStatus`）；`build.apk` 返回 `-32602` |

> 协议细节见 [docs/contracts/bridge-protocol.md](docs/contracts/bridge-protocol.md)；
> 权限预置见 [docs/runbook/provisioning.md](docs/runbook/provisioning.md)。

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

**路径 B（本地，逃生通道 —— 需 SDK/NDK/JDK；项目政策是构建一律走 CI）：**

```bash
export ANDROID_HOME=/path/to/sdk ANDROID_NDK=/path/to/ndk   # NDK r27+
./scripts/build-apk-local.sh
adb install -r container/app/build/outputs/apk/debug/app-debug.apk
```

### 5.4 构建并签名内核 OTA 包

```bash
./scripts/build-kernel-bundle.sh <内核源码目录> <版本> node24-arm64-android35 <url_base>
# 产物（release/，gitignored）：kernel-<版本>.zip + kernel-manifest.json
```

CI 等价流程见 `.github/workflows/kernel-ota.yml`（用 `OTA_PRIVATE_KEY_PEM` 签名，绝不进 APK）。

### 5.5 内核更新桥（dsh:kernel-update）

内核 WebView 加载**内核同源托管的宿主帧** `GET /__host`（`kernel/ui/public/host.html`），其内 iframe 嵌面板。

- **为什么同源**：内核 `originAllowed` 闸② 要求驱动页面 Origin = `<本机/局域网>:<apiPort>`；`file://` 宿主页 Origin 为 null → 写操作 403。
- **链路**：面板 iframe `postMessage` → 宿主帧 `window.DshNative.onRequest` → 重启 `:node` → 回灌结果。⚠ 回灌必须含 `v` 与 `ok`。

---

## 6. container/engine（可测 OTA 引擎）

纯 Node、零外部依赖。测试**只在 CI 跑**（`scripts/require-ci.js` 拦截本地执行）：

```bash
# CI: cd container/engine && npm run test:logic   （25 个套件，前置 require-ci 守卫）
```

说明（ADR-0005）：曾经的 `test:baseline`（验 APK 内置基线产物）已随"内核不随 APK 分发"整体删除。
`bridge-interop` 读**同仓子目录** `kernel/`；`DSH_KERNEL_REPO=<路径>` 可指向 fork。

---

## 7. 已核实事实

- **Node LTS = 24 Krypton**（默认 24.21.0，见 `container/app/src/main/assets/node-versions.json`）；Node 24 自带 OpenSSL 3.5。
- **16KB 页对齐**：NDK r27+ 编译满足安卓 15+ (API 35) `dlopen` 要求。
- **双信任根**：容器 ed25519 私钥签内核、公钥焊进 APK；npm 标准 integrity 验 Agent。
- **传输私有**：Agent↔HostBridge 走 UDS，不走 TCP（base-spec §8）。
