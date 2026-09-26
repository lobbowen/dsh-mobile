# 能力契约：HostBridge 协议（BRIDGE_PROTOCOL）

> 状态：草案 v0.1 — 方法表为**第一版建议**，待产品确认增删。
> 这是真正的"能力补全清单"：Agent 经此协议控制安卓系统。

---

## 1. 传输

- **Unix 域套接字（UDS）**：**Linux 抽象命名空间**，名为 `dsh_hostbridge`（无文件系统路径，故无 `chmod` 可言）。内核侧 `net.connect('\0dsh_hostbridge')`（前导 NUL）。
  > ⚠ 抽象命名空间 socket 不做 UID 鉴权：当前实现**没有对端认证**，隔离完全依赖 SELinux 域。这是已知缺口，见 README §4。
- 协议：**JSON-RPC 2.0**（请求/响应/通知）。
- 连接由 `:node` 进程（内核）主动发起；HostBridge（Kotlin Service）监听。
- 严禁经 TCP（`127.0.0.1:*`）暴露控制面。

## 2. 版本协商

- 连接建立后，内核发送 `handshake`，携 `protocol` 版本与 `requires` 能力清单。
- HostBridge 回 `capabilities`：设备实际已预置的能力集合（取决于 Device Owner / 无障碍 / ADB 配对 / 特殊权限的开启状态）。
- 内核 `requires` 超出 `capabilities` → 桥拒绝对应方法调用，其余正常。

## 3. 能力分组与方法表（第一版）

> 每个方法标注其依赖的**设备预置能力**（见 PROVISIONING.md）。缺失则调用返回 `ERR_CAPABILITY_MISSING`。
> 「落地」列标出实现状态：✅ 真实实现 / ⚠️ 兜底实现 / ⏳ 未实现（返回 `-32001`）。

### 3.1 app_control（应用控制）
| 方法 | 参数 | 依赖 | 落地 |
|---|---|---|---|
| `app.launch` | `pkg`, `activity?` | 基础 | ✅ |
| `app.stop` | `pkg` | 基础 | ✅（`audit=false`，按 §5） |
| `app.listInstalled` | — | 基础 | ✅ |
| `app.openUrl` | `url` | 基础 | ✅ |
| `app.install` | `apkPath`（包内/下载） | **Device Owner**（静默安装） | ✅ `PackageInstaller` |
| `app.uninstall` | `pkg` | **Device Owner**（静默卸载） | ✅ `PackageInstaller.uninstall` |
| `app.grantPermission` | `pkg`, `perm` | **Device Owner** | ✅ |

> ⚠ 装箱注意：`DevicePolicyManager` **没有** `installPackage` / `uninstallPackage` 方法 ——
> 静默装卸只能走 `PackageInstaller`（`createSession` → `openWrite` → `commit`），
> 异步结果经 `PendingIntent` 回 `PackageInstallReceiver`。

### 3.2 ui_automation（UI 自动化 / 无人值守操作）
| 方法 | 参数 | 依赖 | 落地 |
|---|---|---|---|
| `ui.tap` | `x`, `y`, `durationMs?` | **Accessibility** | ✅ `dispatchGesture` |
| `ui.swipe` | `x1,y1,x2,y2,durationMs?` | 同上 | ✅ 同上 |
| `ui.inputText` | `text`, `selector?` | 同上 | ✅ 三级降级（SET_TEXT → FOCUS+PASTE） |
| `ui.getUiTree` | `maxNodes?`, `maxDepth?` | **Accessibility**（节点树） | ✅ `getWindows` + `rootInActiveWindow` 合并 |
| `ui.screenshot` | `width?`, `height?`, `inline?` | **MediaProjection** | ✅ 默认落盘 PNG；`inline=true` 内联 base64 |
| `ui.waitFor` | `selector`, `timeoutMs?`, `intervalMs?` | Accessibility | ✅ 条件轮询 |

> **`ui.screenshot` 的授权语义与 Device Owner 本质不同**：MediaProjection 授权是**每次会话**的，
> 必须由用户在系统弹窗点一次「开始录制」，**无法预置**。授权结果缓存于
> `files/screen-capture-grant.json`（Intent 的 Parcel 字节流 + base64），进程重启后自动复用。
> 未授权时返回 `-32001` 并附「需先在 App 内授权」的指引。
>
> **`ui.getUiTree` 取的是全窗口**（`getWindows()` 优先），因此 IME / 悬浮窗的节点也能拿到 ——
> 仅靠 `getRootInActiveWindow()` 会漏掉这两类。

### 3.3 shell（内置 ADB 客户端 / 无线调试）
| 方法 | 参数 | 依赖 | 落地 |
|---|---|---|---|
| `shell.status` | — | `base` | ✅ 密钥/配对状态（`files/adb/`） |
| `shell.pair` | `host`, `pairPort`, `code`, `connectPort?`, `timeoutMs?` | `base` | ✅ SPAKE2 配对（BoringSSL 兼容，TLS 1.3） |
| `shell.forget` | — | `base` | ✅ 删除 ADB 身份密钥与配对状态 |
| `shell.exec` | `cmd`, `args?`, `timeoutMs?` | **adb_shell**（已配对） | ✅ TLS 连接执行（shell uid 2000） |

> **归属（ADR-0003 勘误 2026-09-24）**：ADB 客户端是**权限通道**，属壳（L0）——
> 实现在 `container/app/src/main/assets/node/adb-client/`，由 `AdbClientRunner` 以
> 一次性 Node 进程调用（minSdk 24 的 Kotlin 没有 TLS exporter / SPAKE2 原语）。
> 凭据落 `files/adb/`（密钥 0600 / 目录 0700），与内核目录物理隔离 ——
> OTA 下来的 L1 代码不得读写 ADB 身份。Shizuku 路线已整体删除
> （第三方特权通道与自带 ADB 客户端语义冲突；复活即红：engine 测试链有反向门禁）。
>
> **`shell.exec` 返回体不含 `exitCode`**：ADB shell（v1 服务）通道不回传命令退出码，
> 调用方以 `ok` 判成败、`stdout` 取输出（截断 256 KB）、`uid:2000` + `privileged:true`。
>
> **pair/status/forget 只要求 `base`**：否则未配对设备永远无法发起配对（能力先于配对
> 会形成死锁）；`exec` 要求 `adb_shell`（= 已配对，判据 `files/adb/state.json` 存在，
> 与 ProvisioningProbe / KernelSelfCheck 同一把尺子）。连接失败属运行时错误按
> `-32603` 原样带回，不冒充 `-32001`。

### 3.4 device_policy（系统策略，Device Owner）
| 方法 | 参数 | 依赖 | 落地 |
|---|---|---|---|
| `policy.setPassword` | `pwd`, `type` | **Device Owner** | ⚠️ API 30 起废弃，多数设备不生效 |
| `policy.lockNow` | — | **Device Owner** | ✅ |
| `policy.wipe` | `flags?`, `reason?` | **Device Owner** | ✅ API 29+ 走 `wipeData(flags, reason)` |
| `policy.setKiosk` | `pkg` / `packages[]`, `enable` | **Device Owner** | ✅ API 34+ 补 `setLockTaskFeatures` |
| `policy.addUserRestriction` | `key` | **Device Owner** | ✅ |
| `sys.setTime` | `epochMs` | **Device Owner** | ✅ 需 `AUTO_TIME=0`（API 28+） |
| `sys.setTimeZone` | `timeZone`（Olson ID） | **Device Owner** | ✅ 需 `AUTO_TIME_ZONE=0`（API 28+） |
| `sys.reboot` | — | **Device Owner** | ✅ 单参 `reboot(ComponentName)` |

> ⚠ 装箱注意：`dpm.reboot` 在 android.jar 里**只有单参版本**（两参版是桌面 Java 的）。
> `setTime` / `setTimeZone` 是 **API 28+**，且必须先关自动时间/时区，否则静默无效。

### 3.5 storage（存储）
| 方法 | 参数 | 依赖 | 落地 |
|---|---|---|---|
| `fs.read` | `path`, `encoding?`(auto/base64), `maxBytes?` | `MANAGE_EXTERNAL_STORAGE` | ✅ |
| `fs.write` | `path`, `content`, `encoding?`(utf8/base64), `append?` | 同上 | ✅ |
| `fs.list` | `path?`, `recursive?`, `maxEntries?` | 同上 | ✅ |
| `fs.mkdir` | `path` | 同上 | ✅ |

> **访问范围：全放开**（有 `MANAGE_EXTERNAL_STORAGE` 即通行），不做白名单限制 —— 这是显式选择。
> 但保留**审计留痕**与**危险路径提示**（`/dev/*`、`/proc|/sys/*`、`/system|/vendor|/boot`、`/`）：
> 提示经返回体的 `hint` 字段回传，**不拦截**。
>
> `fs.read` 的 `encoding: "auto"` 会做 **UTF-8 无损性校验**（`text.toByteArray(UTF_8).contentEquals(bytes)`），
> 不无损则自动退 base64 并加 `note` —— 避免二进制文件被静默损坏。
> `maxBytes` 默认 8 MB，硬顶 64 MB（与 JSON-RPC 帧模型匹配）。

### 3.6 build（内核安装 —— **不是**编译）
| 方法 | 参数 | 依赖 | 落地 |
|---|---|---|---|
| `build.kernelInstall` | `checkOnly?` | `kernel_update` | ✅ **唯一入口**：从 OTA 源安装/升级 |
| `build.kernelStatus` | — | `kernel_update` | ✅ |
| `build.apk` | — | — | ⚠️ 废弃，返回带迁移指引的 `-32602` |
| `build.status` | — | `kernel_update` | ✅（旧名，保留兼容） |

> **语义已修正**：本组不再是「内置编译工具链」。那个方案**已实测证伪**——
> Google Maven 上没有 aarch64 版 aapt2（`linux-aarch64`/`linux-arm64` 均 404），
> 解包实为 x86-64 + glibc，exec 四道关的后三关装机后无法补救。
> 完整论证见 [architecture.md §2.2–2.3](../architecture.md)。
>
> 现在的语义是「**从 OTA 源安装/升级已签名内核**」（ADR-0005）：设备不生产内核，只安装。
> **来源只有一个**（远端 feed）—— 本地 feed 与 APK 内置基线已收敛删除：
> 来源一多就会出现多份"安装语义"，且其中任何一条都能**绕过版本下限**。
> 验签由 Node 侧完成（Android 要 API 33+ 才有 Ed25519，而 minSdk=24）。

**`build.kernelInstall` 请求 / 响应：**

```jsonc
// 只检查（不下载、不安装）—— "检查更新"用
{ "method": "build.kernelInstall", "params": { "checkOnly": true } }

// 安装或升级到 feed 上的最新版
{ "method": "build.kernelInstall", "params": {} }
```

```jsonc
// 检查：发现新版本但**未安装**（available 与 updated 必须分开报）
{ "result": { "ok": true, "checked": true, "available": true, "updated": false,
              "current": "0.1.0-android.11", "version": "0.2.0",
              "source": "远端 OTA", "restartRequired": false,
              "detail": "发现新版本 0.2.0（checkOnly：未安装）" } }

// 安装成功
{ "result": { "ok": true, "checked": true, "available": true, "updated": true,
              "current": "0.1.0-android.11", "version": "0.2.0",
              "source": "远端 OTA", "restartRequired": true,
              "detail": "内核 0.2.0 已安装" } }

// 失败（**不抛错，返回结构化结果** —— 便于调用方区分"可重试"与"包有问题"）
{ "result": { "ok": false, "checked": true, "available": true, "updated": false,
              "current": "0.1.0-android.11", "version": "0.2.0",
              "source": "远端 OTA", "restartRequired": false,
              "detail": "下载失败（https://...）：HTTP 404" } }
```

> **失败绝不破坏现状**：校验在解包**之前**发生，失败时不碰任何已有文件。
> 最坏情况是"没升级成功"，而不是"把能跑的版本弄坏了"。
>
> **`restartRequired` 刻意由调用方处理**：本方法**不**自己重启进程 ——
> 重启会让调用方（内核自己）在半途消失，无法收到回执。

**channel（通道）约定**：设备读 `<baseUrl>/<rolling>/kernel-manifest.json`，
其中 `rolling = kernel-<channel>`，通道由 `container/app/src/main/assets/kernel-feed.json` 的
`channel` 决定（`canary` 灰度 / `stable` 生产）。完整链路见 [kernel-ota.md](../runbook/kernel-ota.md)。

本地 feed 与 APK 内置基线已于 **ADR-0005** 收敛删除；`build.kernelInstall` 是唯一安装入口。

### 3.7 notification（通知）
| 方法 | 参数 | 依赖 | 落地 |
|---|---|---|---|
| `notif.read` | `limit?` | **Notification Access** | ✅ NotificationListenerService |
| `notif.post` | `title`, `text` | 基础 | ✅ |

### 3.8 system（系统信息）
| 方法 | 参数 | 依赖 | 落地 |
|---|---|---|---|
| `sys.info` | — | 基础（设备/API level） | ✅ |
| `sys.nativeAssets` | `walkProbes?`（默认 `true`） | 基础（只读探测） | ✅ |
| `sys.setTime` / `sys.setTimeZone` / `sys.reboot` | 见 §3.4 | **Device Owner** | ✅ |

#### `sys.nativeAssets` —— 原生资产自检

W^X/exec 这条链的失败几乎全部发生在真机，而容器侧的诊断要么用户手动去翻
`diagnostics.txt`，要么只能看一句「启动失败」。本方法把
`NativePreparer.prepare()` 的**结构化结论**经桥暴露出来。

同一份实现被容器启动链复用，所以桥上的结论和诊断文件里的**永远不会漂移**。

**请求**
```json
{ "method": "sys.nativeAssets", "params": { "walkProbes": true } }
```
- `walkProbes: true`（默认）—— 真跑一次 exec-probe（会 spawn 进程）
- `walkProbes: false` —— 只做存在性 + 依赖检查，不 spawn

**响应**
```json
{
  "allRequiredReady": true,
  "nativeLibraryDir": "/data/app/~~x/pkg-y/lib/arm64-v8a",
  "libSearchPath": "/data/app/~~x/pkg-y/lib/arm64-v8a",
  "assets": [
    {
      "id": "node", "libName": "libnode.so", "humanName": "Node 运行时",
      "required": true, "requiredDeps": ["libc++_shared.so"],
      "note": "实为可执行文件，改名 lib*.so 借 jniLibs 通道落到 exec_type 目录",
      "status": "ready",
      "path": "/data/app/~~x/pkg-y/lib/arm64-v8a/libnode.so",
      "probeOutput": "v24.21.0"
    }
  ]
}
```

`status` 取值与对应的 `hint`（失败时携带）：

| `status` | 附加字段 | 含义 |
|---|---|---|
| `ready` | `path`, `probeOutput` | 就位且探针通过 |
| `missing_from_lib` | `inApk`, `libListing`, `hint` | 不在 `nativeLibraryDir`；`inApk` 区分「安装期未解压」vs「打包期就丢了」 |
| `missing_dependency` | `missingDep`, `libListing`, `hint` | 依赖 `.so` 不在同目录（**历史实现完全缺失这一层**） |
| `not_executable` | `errno`, `raw`, `hint` | 存在+依赖齐但 exec 被拒 → 可确定归因 SELinux W^X |
| `probe_failed` | `exit`, `output` | 进程起来了但退出码/输出不对 |

> 客户端应优先读 `allRequiredReady` 做快速判定，再按 `status` 决定给用户
> 什么引导 —— 这五种状态的修复动作完全不同，不应该被压成同一句「失败」。

---

## 4. 权限与降级

- Agent 的 `requires` 声明所需能力分组；桥按设备实际 `capabilities` 放行。
- 调用未授权方法 → 返回 `ERR_CAPABILITY_MISSING`，内核应优雅降级而非崩溃。
- 每个能力分组只有**一个**预置来源（如 `ui.*` = Accessibility、`shell.*` = 内置 ADB 客户端）；
  历史上"同一能力多机制并存"（Accessibility 与第三方特权通道同时提供 shell）已随
  ADR-0003 勘误收敛为单源 —— 多源会让"能力有没有"变得不可判定。

## 5. 错误处理与审计

- 标准错误码：`ERR_CAPABILITY_MISSING` / `ERR_INVALID_PARAM` / `ERR_RUNTIME` / `ERR_TIMEOUT`。
- **所有特权操作必须写审计日志**：调用方 Agent、方法、参数摘要、结果、时间戳。
  清单以 `container/engine/src/bridge/methods.js` 的 `audit: true` 为准（由
  `bridge-methods-crosslang-test.js` 与 Kotlin `MethodDef` 双向钉住）：
  `app.install/uninstall/grantPermission`、`ui.tap/swipe/inputText/screenshot`、
  `shell.pair/exec/forget`、`policy.*`（setPassword/lockNow/wipe/setKiosk/addUserRestriction）、
  `fs.write/mkdir`、`build.kernelInstall/apk`、`notif.read`、**`notif.post`**（外发内容可被用作伪装通道，故留痕）。
- 审计日志对内核包更新保持持久（不随内核包切换而丢）。
