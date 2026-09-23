# Android 平面规划（ANDROID-PLAN）

> 本目录 = **单仓 `lobbowen/dsh-mobile` 内的移动端内核（L1）源码**，由 PC 端监管器 `dsh-supervisor-core` 剥离而来。
> 2026-09-22 起两仓合并为单仓（L0 容器 = 仓根，本目录 = `dsh-android-kernel/`），**不动 PC 仓**。
> 姊妹规范（容器仓持有）：`BASE_SPEC` / `BRIDGE_PROTOCOL` / `PROVISIONING`。
> ⚠ PC 时代的契约文档（`KERNEL-DAEMON-CONTRACT.md`、`ARCHITECTURE-CONTRACT-phase0.md`、
> `ARCHITECTURE-PLAN-session-lifecycle.md`、`PLATFORM-CAPABILITY-MATRIX.md` 等）已随 PC 三域一并删除；
> 内核侧**唯一架构文档即本文件**。

---

## 1. 定位

内核是一个**运行于「冻结 APK 容器」内 Node 运行时**的**控制面板 / 生命周期管理器（Manager）**：

- 不负责构建、不负责原生打包、不负责应用市场分发 —— 这些归**容器层（L0）**。
- 负责：经**公共 npm** 拉取并管理 Codex / Claude Code / DeepSeek Harness 等 **Agent 产品（L2）**，并对外提供控制面（HTTP + UI）。
- npm 的 `integrity` 即校验：Agent 产品的完整性**不需要内核自造签名机制**。

一句话：**内核 = 装、跑、管、观察 Agent；容器 = 提供运行时、能力桥、保活与 OTA。**

---

## 2. 架构分层

```
┌─ L0 容器层（冻结 APK）───────────────────────────────────┐
│  Node 运行时 · HostBridge(JS↔Kotlin) · OTA 引擎            │
│  负责：拉起/保活内核 · 通知 · 存储 · 自启 · 设备策略        │
└──────────────────────────────────────────────────────────┘
                        ▲ HostBridge / UDS（后续）
┌─ L1 内核层（本仓 dsh-android-kernel）─────────────────────┐
│  guard（生命周期/健康/监控）· api（控制面）· ui（面板）      │
│  native（Agent 运行时管理）· dist（npm 分发）· plugin（扩展）│
│  router（模型网关）· platform（平台抽象）                   │
└──────────────────────────────────────────────────────────┘
                        ▲ 公共 npm
┌─ L2 Agent 产品 ──────────────────────────────────────────┐
│  Codex · Claude Code · DeepSeek Harness · …               │
└──────────────────────────────────────────────────────────┘
```

**铁律**：`src/platform/os/*` 是**唯一平台 API 入口**。域层不得直接触碰
`systemctl` / `launchctl` / `schtasks` / `notify-send` / `osascript` / `xdg-open`。

---

## 3. 保留域映射

| 域 | 路径 | 移动端职责 |
|---|---|---|
| **native** | `src/domains/native/` | Agent 运行时（如 DSH）安装 / 升级 / 卸载 / 探活 |
| **dist** | `src/domains/dist/` | npm 分发、镜像源测速与固定 |
| **plugin** | `src/domains/plugin/` | 第三方插件市场 / 安装 / 启用 |
| **router** | `src/domains/router/` | **模型网关**（多供应商 Key 轮换代理，移动端同样需要） |
| **guard** | `src/guard/` | 生命周期管理、健康监督、注册表、端口、任务 |
| **api** | `src/api/` | 控制面板 HTTP 契约面（`surface.js` 单一事实源） |
| **ui** | `ui/` | 面板前端（**待适配**为移动端容器 webview） |
| **platform** | `src/platform/` | 平台抽象（`os/` 三端实现 + `android.js` 判定） |

---

## 4. 已删除域（及其 Android 等价物）

| PC 域 | 删除内容 | Android 等价物（由谁负责） |
|---|---|---|
| **instance**（沙箱实例） | `src/domains/instance/`、`src/api/instances.js` | 无；多实例能力 `multiInstance:false`，由容器/Android Service 承载 |
| **relay**（远程控制 / frpc） | `src/domains/relay/`、`src/api/relay.js` | 无；`frpExpose:false`，远程访问归容器层 |
| **shell**（桌面 Tauri 壳） | `src/domains/shell/`、`src/api/shell.js` | **APK 容器 / Android Service** 即"壳"；保活、自启、通知归容器 |

同时删除的 PC 构建/部署物：`desktop/`（.desktop 模板）、`systemd/`（unit）、
`release/`（SEA 跨平台打包）、`archive/`（历史归档）、`shared/version-vectors.json`
（整仓真删、无处持有；容器直接出 APK，无 SEA 打包 / launcher / 归档；与 CI 的 `release` job 无关）。

**引用清理**：`supervisor.js`、`guard/supervisor/*`（control / registry / converge / supervise /
main-process / settings 六个 view）、`guard/lifecycle/adapters.js`、`api/index.js`、
`api/surface.js`、`platform/config.js` 中对三域的全部引用均已摘除；
`node -e "require('./src/supervisor')"` 与 `require('./src/api/index')` 均加载成功。

---

## 5. PC → Android 适配状态表

### 5.1 本次已落地（真删，不留占位）

> ⚠ 政策：**不做「占位 / 降级 / 兼容保留」**。PC 专属机制一律删除文件与调用点，
> 不留「返回 unsupported」的空壳实现 —— 空壳会让人以为该能力存在、只是暂时不可用。

新增唯一判定 `src/platform/android.js` → `isAndroid()`：

新增唯一判定 `src/platform/android.js` → `isAndroid()`：

```js
process.env.DSH_ANDROID === '1'      // 运行期，容器启动内核时设置（推荐）
process.env.DSH_PLATFORM === 'android'
process.env.ANDROID_ROOT !== undefined
```

> ⚠ 为什么必须显式判定：安卓上 Node 的 `process.platform === 'linux'`、`arch === 'arm64'`，
> **无法仅靠平台分支与桌面 Linux 区分**。

| 位置 | Android 行为 |
|---|---|
| `platform/os/index.js` → `capabilityProfile()` | `multiInstance:false`、`pidAdoption:true`、`processTreeKill:false`、`desktopNotify:false`、`autostart:false`、`frpExpose:false`、`hostService:'none'`，`guardAutostart/guardSelfHeal/shellAutostart/shellSelfHeal` 全 `false` |
| `platform/os/index.js` → `capabilityProfile()` | Android-only 口径：`multiInstance:false`、`pidAdoption:true`、`processTreeKill:false`、`desktopNotify:false`、`autostart:false`、`frpExpose:false`、`hostService:'none'`（PC 的 `guardAutostart/guardSelfHeal/shellAutostart/shellSelfHeal` 四项已删） |
| `platform/os/service.js` | **文件已删除**（systemd / launchd / schtasks 服务管理：Android 无此概念） |
| `platform/os/autostart.js` | **文件已删除**（开机自启 / GUI 自启：归 APK 容器与 Android Service） |
| `platform/os/desktop.js` | **文件已删除**（桌面会话 / xdg-open：面板由容器 WebView 加载） |
| `platform/os/notify.js` | 经 **HostBridge `notif.post`** 派发（容器内）；`notifyCommand()` 恒返回 `null`（无本地命令行通知）。桥不可用 → 静默返回 `false`，**不调用 onError**（「平台不支持」不是故障） |
| `platform/os/browser.js` | 经 **HostBridge `app.openUrl`**（容器 ACTION_VIEW）打开；桥不可用 → `open()` 返回 `false`、`launchIsolated()` 返回 `{ok:false,isolated:false}`（且**不宣称隔离**，isolated 恒 false） |
| `platform/host-bridge/client.js` | **新增**：内核侧 HostBridge 客户端（抽象命名空间 UDS + JSON-RPC 2.0 + 握手能力协商 + 超时/惰性重连）；桥不可用全部降级不抛 |
| `guard/host-service.js` | **文件已删除**（宿主服务托管：PC 三端服务链概念，Android 无对应物） |
| `guard/supervisor/settings-view.js` | 删 `shellWatchdog` 桌面壳看护观测、删 `closeActionStatus()` / `setCloseAction()`（关窗隐藏到托盘） |
| `guard/supervisor/registry-view.js` | `dsh-main.json` 只写 `{ guardian }`；`remoteEnabled/remoteToken/frp*/wanPort` 与 `dsh_remote_changed` / `dsh_frp_changed` 事件已删 |
| `api/index.js` | **壳源特判已删除**（`isEmbeddedShellOrigin` / tauri CORS 白名单）；面板同源托管，**零 CORS** |
| `api/guard.js` | 删 `/autostart`、`/settings/close-action`、`/self-update/*`（含 410 下架桩） |
| `bin/dsh-supervisor` | 删 `UNIT_PATH` / `AUTOSTART_TEMPLATE` / `AUTOSTART_FILE` / `execInherit` / `uninstall` / `gui-autostart` / `self-update` 命令；保留 `daemon\|status\|start\|stop\|restart\|install\|events\|logs\|version\|upgrade` |

**实测**（`DSH_ANDROID=1 node -e "require('./src/platform/os').capabilities()"`）：

```json
{"platform":"linux","arch":"x64","multiInstance":false,"pidAdoption":true,
 "processTreeKill":false,"desktopNotify":false,"autostart":false,
 "frpExpose":false,"hostService":"none"}
```

### 5.2 后续待办（本次不做，见 §8）

UDS 替代 TCP 控制面（**内核↔容器 HostBridge 已落 UDS**）· Android Service 接入 ·
UI 移动端 webview 适配 · 签名包 OTA 与 APK 公钥焊接。

---

## 6. 能力补全清单（Bridge Protocol 草稿）

容器层需经 **HostBridge** 向内核暴露以下能力组（内核侧目前全部占位）：

| 能力组 | 内核当前状态 | 需宿主桥提供 |
|---|---|---|
| 应用控制（拉起/停止 Agent 进程） | `native` 域已有 spawn 能力；`app.launch/stop/openUrl` 经桥 | 进程可见性 / 前台服务绑定 |
| UI 自动化 | **容器侧全组已实现**（`ui.tap/swipe/inputText/getUiTree/waitFor` + `ui.screenshot`）；内核侧**尚无调用方** | 无障碍服务（`DshAccessibilityService` 已落）+ MediaProjection（`ScreenCaptureService` 已落） |
| 构建（安装已签名内核，非编译） | 容器侧 `build.kernelInstall/kernelStatus` ✅ 已实现（A''）；内核侧调用方待补 | 签名内核包投递本地 feed；~~内置编译工具链~~ **已证伪撤销**（无 aarch64 aapt2） |
| 存储（沙箱目录 / 外部存储） | 走 `state-root`；**容器侧 `fs.*` 已实现** | 应用私有目录 + 授权外部存储 |
| 通知 | **已接桥**：`notify.js` → `notif.post` | `NotificationManager` 通道（替代 notify-send） |
| 设备策略（电池/省电/前台保活） | 无 | 电池优化白名单 / 前台 Service 保活 |
| 自启与保活 | `autostart` = `none` | Android Service + 开机广播（BOOT_COMPLETED） |

> **桥客户端状态（2026-09-16）**：内核侧客户端（`src/platform/host-bridge/`）与容器侧服务端
> （`android-node-container`：Kotlin `HostBridgeService` / `container-engine/src/bridge/`）已**真实互通**
> （抽象命名空间 UDS，`\0dsh_hostbridge`；Node 22 原生支持）。`notify` / `browser` 已从占位切到真桥。
> **组级能力语义已两侧收敛**：「组可用」= 该组**代表能力**具备（`GROUP_REQUIRED`），
> 特权方法另由**方法级 caps** 单独门禁（调用时 -32001）。
>
> **容器侧能力落地进度（2026-09）**：
> - ✅ `ui_automation` —— `DshAccessibilityService` 真实实现（`dispatchGesture` 手势、
>   `getWindows`+`rootInActiveWindow` 节点树、`ACTION_SET_TEXT` 文本注入、条件轮询）；
>   Provider 自检探针（`ProvisioningProbe`）让「无障碍是否真连上」可见。
>   **P5 补齐 `ui.screenshot`** —— `ScreenCaptureService`（MediaProjection 前台服务）真实出图，
>   默认返回 PNG 路径、`inline=true` 内联 base64。
>   ⚠ 授权**不可预置**（与 Device Owner 本质区别）：需用户在 App 内点一次系统弹窗，
>   授权缓存于 `files/screen-capture-grant.json`。内核首次调用若得 `-32001` 应引导用户去授权，
>   而非当作"能力缺失"。
> - ✅ `device_policy` —— 13 个 `dpm.*` 方法真实调用（经 CI 真编译修正了 install/uninstall/reboot 的 API 误用，
>   静默装卸改用 `PackageInstaller`）。
> - ✅ `storage` —— **P5 落地**：`fs.read/write/list/mkdir` 真实实现。范围全放开（有
>   `MANAGE_EXTERNAL_STORAGE` 即通行），危险路径（`/dev`、`/proc`、`/sys`）**仅提示不拦截**。
>   `fs.read` 的 `encoding:"auto"` 会做 UTF-8 无损校验，不无损自动退 base64。
> - ⚠️ `shell` —— **P4 兜底**：`shell.exec` 以**应用 uid** 执行（返回体带 `privileged:false`），
>   不冒充 shell uid(2000)。特权 shell 需 Shizuku SDK，容器**未内置**（不引入第三方 AAR）。
>   设备未装 Shizuku 时调用仍返回 `-32001`（方法级 caps 为 `shizuku`）。
> - ✅ `build` —— **P3 已收口（2026-09 决策：不做内置编译链）**。「内置构建链」已实测证伪
>   （Google Maven 无 aarch64 版 aapt2，interp/架构/libc 三关装机后无法补救），
>   原「全内置 / 首启下载 / 最小子集」三选一并撤销；方案论证以容器仓
>   `docs/ARCHITECTURE.md` §2.2–2.3 为唯一权威（原文档引用的《P3 内置构建链方案对比.md》已不在仓内，勿再找）。
>   本组现语义 =「从本地 feed 安装已签名内核」（`build.kernelInstall`，能力 `kernel_update`，任意设备具备），
>   容器侧已真实实现；`build.apk` 已废弃（返回 `-32602` 迁移指引）。
>   若「设备资源级重打包修改 APK」成为真实需求，另立方案（纯 Node 重打包 + 重签名，不引入原生工具链）。
>
> **结论：内核侧现在可以接 `ui.*` / `fs.*` 了**（六组里五组已有真实实现）。

---

## 7. 分发与 OTA

- **内核**：签名包经容器 OTA **热更新**；**公钥焊进 APK**（容器仓职责）。
  **单写入者 = 安卓容器 OTA**：内核不自更新、不自重启 —— 既不提供写端点
  （`/self-update/apply`、`/self-update/restart-guard`），也**不提供只读端点**
  （`/self-update/status` 已删：内核不经 npm 分发，没有"自己的新版本"可查）。
  ⚠ 本仓是全新仓库，**不保留 410 下架桩**（见 `test/kernel-update-single-writer-test.js` 的 KU-* 门禁）。
- **Agent 产品（L2）**：经**公共 npm** 运行时安装 / 升级，npm `integrity` 即完整性校验。
- **UI**：随内核包分发，由容器 webview 加载（后续适配）。

---

## 8. 后续阶段路线图

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P1 | **UDS 控制面**替代 TCP（回环安全边界） | 容器侧 UDS 服务端 |
| ~~P2~~ ✅ | **HostBridge 客户端**（内核侧 `platform/host-bridge/`）+ JS↔Kotlin RPC 协议（与容器逐字段对齐） | BRIDGE_PROTOCOL |
| P3 | **Android Service** 接入（拉起 / 保活 / 生命周期对齐）— 容器侧已落（`NodeRuntimeService`/`BootReceiver`） | 容器侧 Service |
| ~~P4~~ ❌ 已撤销 | ~~构建链内置~~（JDK + build-tools 随 APK 分发）—— 实测证伪，P3 收口不实施；`build` 组语义改为「从本地 feed 安装已签名内核」（A''），容器侧已实现 | 无（论证见容器仓 ARCHITECTURE §2.3） |
| P5 | **能力桥落地**（§6 各组能力按优先级实现）— 组级/方法级门禁已通，`notify`/`browser` 已接；**容器侧 `ui_automation`（含截图）/ `device_policy` / `storage` 已真实实现，`shell` 已兜底**，内核侧调用方待补 | HostBridge |
| P6 | **UI 移动端适配**（桌面 React → 容器 webview）— 容器宿主帧 + `dsh:kernel-update-*` 桥已落 | 控制面稳定 |

---

## 附：本次交付的验证状态

- `require('./src/supervisor')` / `require('./src/api/index')` / `require('./src/api/surface')` **加载成功**。
- `test/api-surface-test.js`：**12 passed, 0 failed**（契约面双向一致）。
- `npm test`：**49 个测试文件入链，约 695 项断言全部通过，0 failed**；
  排除表仅剩真实卸载两项（`native-test.js` / `plugin-change-restart-test.js`），
  由 `test/test-chain-completeness-test.js` 强制「每个测试文件要么在链中、要么写明排除理由」。
- `test/kernel-update-single-writer-test.js`：**24 passed, 0 failed**（内核零自更新面）。
- `test/host-bridge-test.js`：**20 passed, 0 failed**（H-1…H-6：抽象命名空间路径、socket 名解析、
  桥不可用降级不抛、真实 UDS 端到端握手/调用/-32001/-32601、notify/browser 接线、超时不挂死）。
- `package.json`：`name=dsh-android-kernel`、`version=0.1.0-android.1`，
  移除 `npmPublish`、指向已删 `release/` 的构建脚本与指向已删 `api-contract-test.js` 的 `test:api-contract`。
