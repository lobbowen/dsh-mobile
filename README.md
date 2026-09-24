# Android Node Container（DSH 容器底座 / L0）

> 把手机变成「工作台」的**地基**：一个冻结的安卓 APK，内含原生 Node 运行时 + HostBridge 能力桥 + 签名 OTA 引擎 + 生命周期/诊断。
> 真正的产品（控制面板内核 L1、Agent L2）由这套底座**热更新**承载——APK 只在 Node/桥能力变更时才重编。

架构与硬约束见 [`ARCHITECTURE.md`](ARCHITECTURE.md)；契约见 [`docs/contracts/`](docs/contracts/)；规范索引见 §2.1。

---

## 1. 三层架构（base-spec §2）

| 层 | 名称 | 更新方式 | 冻结？ | 职责 |
|---|---|---|---|---|
| **L0** | 容器（本仓库 APK） | 仅 Node/桥能力变更才重编 | ✅ | Node 运行时 + npm 客户端 + **HostBridge（UDS 能力桥）** + **OTA 引擎** + 生命周期 + 诊断 |
| **L1** | 内核 = 控制面板 / Manager | 容器**签名 OTA** 热更新 | ❌ | 控制面板代码 + `kernel.json`；运行在 Node 运行时内；运行时经 npm 安装/管理 Agent |
| **L2** | Agent 产品 | 内核运行时 **npm（公共源）** | ❌ | Codex / Claude Code / DeepSeek Harness 等标准公共产品，由内核拉取 |

L0/L1/L2 是**发布维**（更新通道与冻结度）。容器内部的**职责维**分层（L-A 生命周期 / L-B 能力桥 / L-C 运行时环境 / L-D 生态适配 / L-E 内核工具箱）见 [`ARCHITECTURE.md` §1.1](ARCHITECTURE.md)；旧的"L3"编号已废止（它指 HostBridge，现归 L-B）。

**两条热更新通道**（双信任根，互不替代）：
- 容器 → 内核：**签名 OTA**（容器私钥签内核包，公钥焊进 APK 验签）。
- 内核 → Agent：运行时 **npm 标准完整性**（sha512 integrity）。

---

## 2. 仓库结构

```
dsh-mobile/                                  # 单仓双子项目（M）
├─ container/                                # ── L0 容器（冻结 APK）──
│  ├─ app/src/main/
│  │  ├─ jniLibs/arm64-v8a/libnode.so       # NDK 产出的 node（构建时注入）
│  │  │                                      #   ⚠ 必须 lib*.so 且放 jniLibs（见 §2.1）
│  │  ├─ assets/{node/, node-versions.json, ota-public.pem}
│  │  └─ java/io/github/lobbowen/dshmobile/    # 服务 / HostBridge / OTA / 诊断 / 原生资产
│  ├─ engine/                               # 可测 OTA 引擎（Node，零依赖）
│  ├─ native/{posix,flock,ptyprobe}/        # C 源：随包原生桥与探针
│  └─ _artifacts/                           # 产物样本（可重建）
├─ kernel/                                  # ── L1 内核（签名 OTA 热更新）──
├─ system/                                  # ── Tier S（ROM/priv-app 集成）──
├─ docs/
│  ├─ adr/                                  # 决策记录 0001…
│  ├─ contracts/                            # base-spec / bridge-protocol / layout.json / *.schema.json
│  ├─ runbook/                              # git-repo / testing / versioning / kernel-ota / release-identity / handover / provisioning / contributing
│  └─ STORAGE-STANDARD.md                   # 存储规范（位置 + 对账）
├─ scripts/                                 # 跨层构建/发布工具
├─ ARCHITECTURE.md                          # ★ 架构与硬约束（唯一事实来源）
├─ _archive/                                # 历史归档（只读）
├─ gradle*/settings.gradle.kts              # 根构建（:app → container/app）
└─ .github/workflows/                       # CI（唯一合法验证通道，见 §2.1）
```

### 2.1 规范索引（改动前先读）

| 主题 | 文件 |
|---|---|
| 架构与硬约束（唯一事实来源） | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| 存储位置 / 目录契约 / 对账 | [`docs/STORAGE-STANDARD.md`](docs/STORAGE-STANDARD.md)、[`docs/contracts/layout.json`](docs/contracts/layout.json) |
| Git / 提交 / 令牌使用 | [`docs/runbook/git-repo-standard.md`](docs/runbook/git-repo-standard.md) |
| **测试（只准走 CI，本地禁止执行）** | [`docs/runbook/testing-standard.md`](docs/runbook/testing-standard.md) |
| **发布身份 / 密钥 / PAT** | [`docs/runbook/release-identity.md`](docs/runbook/release-identity.md) |
| **版本管理（各层版本 / bump 规则）** | [`docs/runbook/versioning.md`](docs/runbook/versioning.md) |
| **内核 OTA（怎么推 / 怎么下）** | [`docs/runbook/kernel-ota.md`](docs/runbook/kernel-ota.md) |
| 决策记录（含已否决方案） | [`docs/adr/`](docs/adr/) |
| 契约（内核包 / 运行时 / 桥协议） | [`docs/contracts/`](docs/contracts/) |

### 2.1 ⚠️ 为什么 node 必须放在 jniLibs 而不是 assets

这是本项目踩过的最大一个坑，也是**真机 `error=13, Permission denied` 的根因**，改动前务必先读。

Android 10 (API 29) 起 SELinux 强制 **W^X** 策略：

| 路径 | SELinux label | 能否 `execve` |
|---|---|---|
| `/data/data/<pkg>/files/`（`getFilesDir()`） | `app_data_file` | ❌ 禁止 |
| `/data/data/<pkg>/cache/`（`getCacheDir()`） | `app_data_file` | ❌ 禁止 |
| `/data/app/<pkg>/lib/<abi>/`（`nativeLibraryDir`） | `exec_type` | ✅ 允许 |

把 node 解压到 `filesDir` 再 `ProcessBuilder` 启动，会得到：

```
IOException: Cannot run program ".../files/node/24.21.0/node": error=13, Permission denied
```

官方认定这是**设计如此**（Google issuetracker 128554619）：

> Calling exec() on writable application files is a W^X violation... While exec() no longer works on files within the application home directory, it continues to be supported for files within the read-only /data/app directory. In particular, it should be possible to package the binaries into your application's native libs directory and enable android:extractNativeLibs=true, and then call exec() on the /data/app artifacts.

因此方案是：**把 node 命名为 `libnode.so` 放进 `jniLibs/<abi>/`，开启 `extractNativeLibs`，运行时从 `applicationInfo.nativeLibraryDir` 执行。** 三个配套条件缺一不可：

1. 文件名必须是 `lib*.so` 形式，否则 AGP 不会当 native lib 处理；
2. `android:extractNativeLibs="true"`（本项目在 Manifest 与 gradle 两处都写了）—— 否则 AGP 3.6+ 默认把 `.so` 压缩在 APK 内不落盘，文件系统上根本没有可执行路径；
3. 二进制解释器必须是 Android 的 `/system/bin/linker64`（交叉编译产物天然满足）。

> **还有一个必设的环境变量**：`LD_LIBRARY_PATH = nativeLibraryDir`。Android linker 查找依赖库的目录只有 `$LD_LIBRARY_PATH` / DT_RUNPATH / 系统默认路径三者，`nativeLibraryDir` **不在其中**（它只在 Java 层 `dlopen` 时进搜索路径）。而 `libnode.so` 自身既无 DT_RPATH 也无 DT_RUNPATH，若不设这个变量，`libc++_shared.so` 的符号解析会直接失败：
> ```
> CANNOT LINK EXECUTABLE ".../libnode.so": cannot locate symbol "_ZTVNSt6__ndk119basic_ostringstream..."
> ```

> **一个隐蔽的陷阱**：`File.canExecute()` 对上述限制**完全无感** —— 它只查 stat 的 x 权限位，不知道 noexec 挂载、更不知道 SELinux 策略。所以它在不可 exec 的文件上照样返回 `true`，造成"诊断显示可执行、真 exec 却失败"的假阳性。**判断能否执行，唯一可靠的办法是真去执行一次**（本项目在启动前跑一次 `node -v` 来验证，见 `runExecProbe`）。

> **对 OTA 的影响**：`nativeLibraryDir` 是安装时固定、运行期只读的，且每次 APK 更新路径中的随机串都会变。这意味着"在沙箱放多个 Node 版本目录、切指针"的 Node OTA 方案在该路径上**不成立**。当前策略是以内置版本保证首启可用。**本文的 OTA 通道（签名验签/解包/原子指针）服务于内核包（L1）**——内核是 `filesDir` 下的 JS 代码，由 `node` 解释执行，不涉及 `execve`，因此不受 W^X 限制。

---


## 3. 内核启动流程（base-spec §9）

`NodeRuntimeService`（独立 `:node` 进程，`START_STICKY` 前台通知）由 `ContainerSupervisor`
（:main，L-A 监督者）持有 binder 边并负责复活；App 启动 / `BootReceiver` / 互保边
（§ARCHITECTURE 1.2）进入链路后，:node 的 boot 循环依次：

1. **预置体检**（`ProvisioningProbe`，provisioning §4）：device-owner / accessibility / adb-shell / mediaprojection / special-perms 五项落 `diagnostics.txt` + `provisioning.json`，保证内核起不来时也能看清设备能力。
2. 确保 **HostBridgeService**（UDS 监听，内核侧主动 connect）—— 拉起权在 L-A 监督者（每次被戳都 ensure），:node 只戳监督者、不再直接管桥（ADR-0006）。
3. 读 `files/kernel/CURRENT` 指针；启动链 OTA（`autoCheck` 缺省 true）在 spawn **之前**查一次远端 feed，无内核/有更新即下载+校验+安装（ADR-0005：APK 不内置基线，本地 feed 已删除）。
4. 确认内置 node 就位（`nativeLibraryDir/libnode.so`）→ 自检两个 `.so` → **exec-probe 真跑一次 `node -v`**。
5. 取冻结的 Node 运行时（`files/node/CURRENT`）。
6. 写 **runtime.json（schema 2，容器写内核读）** 到 `files/supervisor/runtime.json`。
7. 装配安卓环境（**唯一装配点 `runtime/GuestAdapter`**，§ARCHITECTURE 1.1）：`DSH_ANDROID=1` / `DSH_PLATFORM=android` / `DSH_SUPERVISOR_HOME` / `DSH_UI_DIR` / `DSH_BRIDGE_SOCKET` / `DSH_PERMISSION_MODE` / `PATH` / `HOME` / `TMPDIR`(=cacheDir) / `LD_LIBRARY_PATH` / `NODE_PATH`。
8. `spawn node bin/dsh-supervisor daemon`（内核入口）；无内核包时回落到 `assets/node/server.js` 探针（:3080）。
9. 轮询控制面（有内核看 `36360/status`；探针模式看 `3080`）；失败/进程退出 → **退避重启**（1s→…→30s 上限，存活 ≥15s 才清零）。

> 一次内核升级 = 重启**内核子进程**（:node 宿主进程不重启）：面板发 `ACTION_RESTART`，
> :node destroy 子进程后由自家 boot 循环按退避重拉 —— 用户侧"热"的，无 APK 重编。

---

## 4. HostBridge（能力桥，职责维 L-B）

- **传输**：Unix 域套接字（抽象命名空间 `dsh_hostbridge`）；内核（Node）经 `net.connect('\0dsh_hostbridge')` 主动连接（**前导 NUL 字节**，Node 22 原生支持）。**严禁 TCP 暴露控制面**（base-spec §8）。
- **协议**：JSON-RPC 2.0，换行分隔 JSON 帧；握手协商 `capabilities` / `groups`。
- **8 组方法**：`app_control / ui_automation / shell / device_policy / storage / build / notification / system`。
- **鉴权**：**两层门禁** —— 组级（握手按每组**代表能力**协商 `bridge:*`）+ 方法级（每次调用按 `caps` 精确拦截）。未授权 → `ERR_CAPABILITY_MISSING (-32001)`；未知方法 → `METHOD_NOT_FOUND (-32601)`。内核应优雅降级。
- **审计**：所有特权操作（`methods.js` 里 `audit: true` 的全集，见 bridge-protocol §5）落 `files/bridge-audit.log`（持久，不随内核包切换丢失）。
- **内核侧客户端**：`kernel/src/platform/host-bridge/`（进程级单例，已互通）；`notif.post` / `app.openUrl` 分别承接通知与「打开浏览器」。

**落地进度（2026-09）**：

| 方法组 | 状态 | 说明 |
|---|---|---|
| `app_control` / `notification` / `system` | ✅ | 真实实现 |
| `device_policy` | ✅ | 13 个 `dpm.*` 方法真实调用（需 Device Owner）；**P1 修正 6 处存量 API 误用** |
| `ui_automation` | ✅ | **P2 落地**：手势/节点树/文本注入；**P5 补 `ui.screenshot`**（MediaProjection） |
| `storage` | ✅ | **P5 落地**：`fs.read/write/list/mkdir` 真实实现（全放开 + 危险路径提示不拦截） |
| `shell` | ✅ | **壳自带 ADB 客户端（无线调试）**：`shell.pair/status/exec/forget`，exec 以 shell uid(2000) 执行（能力 `adb_shell`=已配对）。Shizuku 已删除（ADR-0003 勘误 2026-09-24） |
| `build` | ✅ | **P3 已收口（不做内置编译链，已证伪）**：语义 = 从本地 feed 安装已签名内核（`build.kernelInstall/kernelStatus`）；`build.apk` 返回 `-32602` 迁移指引 |

> **`ui.screenshot` 的前置**：MediaProjection 授权**不可预置**（与 Device Owner 本质区别）——
> 需在 App 诊断面板点一次「授权屏幕捕获」，之后缓存于 `files/screen-capture-grant.json` 长期复用。
>
> 协议细节、方法表、错误码见 [`docs/contracts/bridge-protocol.md`](docs/contracts/bridge-protocol.md)；实现与 [`container/engine/src/bridge/*`](container/engine/src/bridge) 对齐。
> 互通由 `container/engine/test/bridge-interop-test.js` 实测（内核真实客户端 ←→ 容器参考桥，真实 UDS；默认打同仓 `kernel/`，`DSH_KERNEL_REPO` 可指向 fork）。
> 权限预置与自检见 [`docs/runbook/provisioning.md`](docs/runbook/provisioning.md)；`Device Owner` 激活：`adb shell dpm set-device-owner io.github.lobbowen.dshmobile/.lifecycle.DeviceAdminReceiver`。

---

## 5. 快速开始

### 5.1 编译 Node 二进制（一次性）

前置（主机侧）：`git python3 ninja cmake make zip` + **Android NDK r27+**。

```bash
ANDROID_NDK=/path/to/ndk ./scripts/build-node-android.sh 24.21.0
# 产物 -> app/src/main/assets/node-bin/arm64-v8a/node
```

### 5.2 生成 OTA 密钥对（开发期）

```bash
./scripts/keygen.sh
# 生成 keys/ota-private.pem（gitignored）+ 把公钥焊进 app/src/main/assets/ota-public.pem
```

> 私钥仅用于**签名内核包**；公钥焊死在 APK。私钥轮换 = 发新版 APK。

### 5.3 出包（APK）

**路径 A（推荐，零本地环境）：GitHub Actions 一键出包** — `.github/workflows/build-apk.yml` 自动解析最新 Node 24.x tag、NDK 交叉编译、`./gradlew assembleDebug` 上传 APK。推到你有写权限的仓库 → Actions → Run workflow。

**路径 B（本地，逃生通道 —— 需 SDK/NDK/JDK；项目政策是构建一律走 CI，本机只开发）：**

```bash
export ANDROID_HOME=/path/to/sdk ANDROID_NDK=/path/to/ndk   # NDK r27+
./scripts/build-apk-local.sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

打开 App → 常驻通知 → 先显示“启动诊断”面板（逐阶段带时间戳），内核就绪后 WebView 加载
**内核同源托管的宿主帧** `http://127.0.0.1:36360/__host`（页内 iframe 嵌内核面板）。

### 5.4 构建并签名内核 OTA 包

```bash
# 先确保私钥就位（见 5.2）
./scripts/build-kernel-bundle.sh <内核源码目录> 1.4.0 node24-arm64-android35 https://cdn.example.com/ota
# 产物（release/，gitignored）：
#   kernel-1.4.0.zip        OTA 下发的内核包（已 ed25519 签名）
#   kernel-manifest.json    版本/url/sha256/签名
```

CI 等价流程见 `.github/workflows/kernel-ota.yml`（用 `OTA_PRIVATE_KEY_PEM` secret 签名，绝不进 APK）。

### 5.5 内核更新桥（dsh:kernel-update）

内核 WebView 加载**内核同源托管的宿主帧** `GET /__host`（`ui/public/host.html`），其内 iframe 嵌面板（`src="/"`）。

- **为什么同源**：内核 `originAllowed` 闸② 要求驱动页面 Origin = `<本机/局域网>:<apiPort>`；
  容器 `assets/` 的 `file://` 宿主页 Origin 为 null → 面板写操作**一律 403**。故宿主帧搬到内核侧同源托管。
- **链路**：面板 iframe `postMessage({v:1,type:'dsh:kernel-update-request',requestId})`
  → 宿主帧 `window.DshNative.onRequest(json)`（`MainActivity` 经 `JavascriptInterface` 收到）
  → 重启 `:node` 重读 `CURRENT` / 承接 OTA
  → 回灌 `{v:1,type:'dsh:kernel-update-result',requestId,ok,stage,version,restartUncertain,error}`
  → 宿主帧 `dshDeliverResult(json)` → 面板 iframe。
- ⚠ 回灌**必须含 `v` 与 `ok`**（内核 `kernelUpdateBridge.ts` 依此过滤，缺则丢弃 → 面板超时）。
  契约由 `container/engine/test/kernel-update-bridge-test.js` 锁定。

---

## 6. container/engine（可测 OTA 引擎）

纯 Node、零外部依赖。测试**只在 CI 跑**（`scripts/require-ci.js` 门禁拦截本地执行——
本地无 Android/设备环境，测出的绿不可信），秒级完成：

```bash
# CI: cd container/engine && npm run test:logic
# 套件：layout-manifest / dead-path / shizuku / bridge-methods-crosslang / native-assets /
# dependency-rule / contract-schema / sign-verify / kernel-bundle / kernel-selfboot /
# ota-engine / runtime-json / bridge-protocol / bridge-e2e / bridge-interop /
# kernel-update-bridge / e2e-mock-kernel / kernel-version-crosslang / boot-env-contract / adb-client
#
# 说明（ADR-0005）：曾经另有 test:baseline（验 APK 内置基线产物），已随
# "内核不随 APK 分发"整体删除 —— 内核只从 OTA 源安装，产物断言不再属于本仓逻辑测试。
```

注：`bridge-interop` 读的是**同仓子目录** `kernel/`（单仓布局的默认路径，
由测试文件位置推导）。用 `DSH_KERNEL_REPO=<路径>` 可指向 fork / 其他内核源码做跨仓试验。

覆盖：ed25519 签名/验签、内核包打包、OTA 验签+解包+原子指针切换+坏包拦截、runtime.json 契约、HostBridge 协议编解码/握手/方法能力/审计、**内核↔容器桥真实 UDS 互通**、**更新桥协议契约**，以及**真实 spawn 内核 + 健康检查**的端到端。

---

## 7. 已核实事实

- **最新 LTS = Node 24 Krypton**（24.21.0；Active LTS 到 2028-04-30）；Node 24 自带 OpenSSL 3.5，默认安全等级 2。
- **16KB 页对齐**：NDK r27+ 编译满足安卓 15+ (API 35) `dlopen` 要求。
- **双信任根**：容器 ed25519 私钥签内核、公钥焊进 APK；npm 标准 integrity 验 Agent。
- **传输私有**：Agent↔HostBridge 走 UDS，不走 TCP（base-spec §8）。
