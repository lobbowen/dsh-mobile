# 内核生命周期：真机验证清单

> 这是整条链路上**唯一还没有被证明**的一环。CI 只能证明「编译通过 + 纯逻辑正确」，
> 而下载、安装、提交、回滚这些**在真实 Android 上发生的事**必须走一遍。
>
> 一次做完约 20–30 分钟。每条都给出：怎么触发 → 看哪个字段 → 什么结果对应什么结论。

## 0. 前提

| 项 | 值 |
|---|---|
| 安装包 | `apk-latest` 的 `app-release.apk`（发布面产物，**非 debuggable**） |
| 开发/取证包 | 日常链的版本化归档 `v<versionName>` 上的 `app-debug-<versionName>+<versionCode>.apk`（debuggable，`run-as` 可用）—— 只在「内核没起来、控制面无从可读」时用它复现 |
| 设备通道 | **canary**（`assets/program-feed.json`: `baseUrl=https://hubcdn.zll.ink`, `channel=canary`） |
| 已发布内核 | **别写死在本清单里**，从通道现读：`<base>/program-<channel>/program-manifest.json?t=<ms>`（`?t=` 不能省，理由见 [program-ota.md §2.1](program-ota.md)）。下文用 `<目标版本>` 指代它，落到哪条就 substituted 成实际值 |

### 0.1 读数怎么取：控制面回环 HTTP

发布包 `android:debuggable=false` ⇒ `adb shell run-as lobos.app` 会被系统拒绝，设备私有目录
**不再有 shell 侧的读法**。常规通道是控制面（面板 HTTP，只绑回环：`platform/config.js:21`），
经 `adb forward` 打进设备：

```bash
adb -s <serial> forward tcp:36360 tcp:36360
BASE=http://127.0.0.1:36360

curl -s "$BASE/status"                       # 相位 + 首行状态 + 已装 Program（三处同源那一份）
curl -s "$BASE/diagnostics/provisioning"     # 开机体检快照：五项体检 + 三条版本流身份
curl -s "$BASE/native/capabilities"          # 上一轮原生件/能力件核验的落盘结论（不重跑探针）
curl -s "$BASE/diagnostics/events?limit=400" # 启动链逐事件（含探针 data 原文）
```

端口 `36360` 是控制面唯一地址（`runtime/GuestAdapter.kt:63`）；探针端口 3080 **永不参与启动判定**，
它没起来不代表内核没起来。回环请求**不需要 access key**（`api/index.js:147` 的门卫只在非回环上要求），
所以以上四条不需要任何凭据。

**每条读数对应的落盘原文**（`snapshot` 里就是 `files/provisioning.json` 的内容，`events` 里就是
`files/os/diag.jsonl` 的行 —— 本清单下面凡是提到某个字段名，都按这张表换算成路由去读）：

| 本清单提到的 | 现在这样读 |
|---|---|
| `provisioning.json` 的 `appVersion` / `programVersion` / `programFloor` / `programPending` | `GET /diagnostics/provisioning` → `snapshot.<字段>` |
| `diagnostics.txt` 的 `[program-ota]` / `[program-commit]` / `[program-rollback]` / `[health]` / `[process]` 行 | `GET /diagnostics/events?stage=program` 等，逐事件的 `stage` + `message` + `detail` |
| `files/os/diag.jsonl` 的原生件结论 | `GET /native/capabilities`（首选，只读落盘）；要全量事件流走 `GET /diagnostics/events?stage=native` |
| `files/programs/console/` 的 `CURRENT` / `FLOOR` / `PENDING` 三个标记 | `GET /diagnostics/provisioning` → `snapshot.programVersion/programFloor/programPending`（空串 = 该标记不存在） |

**控制面本身起不来时**（首装失败、内核没跑起来 ⇒ 面板就是那个内核，36360 自然没人监听）：
这一刻**没有**远程读法，这就是保留 debug 归档的意义 —— 装同 `versionCode` 的
`app-debug-<versionName>+<versionCode>.apk` 复现，`run-as` 那条路在 debug 包上仍然可用：

```bash
adb -s <serial> shell run-as lobos.app cat files/provisioning.json
adb -s <serial> shell run-as lobos.app cat files/os/diag.jsonl
```

**先确认基线**（还没做任何操作时）：`GET /diagnostics/provisioning` 的 `present` 应为 `true`，
`snapshot.appVersion` / `appVersionCode` 与所装包 `version.json` 的 `shell.versionName` / `shell.versionCode`
一致（**别把版本号抄进本清单**，一致这件事才是判据），`bridgeProtocol` = 1，
`programVersion` 为空、`programFloor` 为空、`programPending` 为空。
`present=false` 表示**开机体检还没跑过** —— 这是一件事，不是一句「一切正常」。


---

## 1. 首装（CURRENT 缺失 → 从 OTA 装）

| | |
|---|---|
| **触发** | 全新安装后首次启动（或 `adb shell pm clear lobos.app` 清掉数据后再启动 —— 发布包不能 `run-as` 进去删 `files/programs/console/`，见 §0.1） |
| **看** | `GET /diagnostics/events?stage=program` 的 `program-ota` / `program-commit` 事件；`GET /diagnostics/provisioning` 的三条版本流 |
| **期望** | ① 取到 `program-canary/program-manifest.json`（**带 `?t=` cache-buster**）；② manifest **验签通过**；③ 下载 ~1.2MB 且 **sha256 一致**；④ 安装落盘；⑤ 首次健康检查通过后出现 **`program-commit` 事件「内核 <目标版本> 已提交」** |
| **落地证据** | `snapshot.programVersion` = `<目标版本>`；`snapshot.programFloor` = 同值；`snapshot.programPending` 为空串（= `files/programs/console/PENDING` 不存在，已提交）—— 这三格就是那三个标记文件的机读形态，住址见 §0.1 |

**若失败看这里**

| 现象 | 结论 |
|---|---|
| `403 qiniu_center_auth` | 空间又变私有 → 控制台改回公开 |
| 证书 / `SSL` 错误 | `hubcdn.zll.ink` 证书问题 |
| `manifest signature invalid` | 发布侧签发与设备验签不一致（**真 bug，报我**） |
| `sha256 校验未通过` | 传输/拼接问题（**真 bug，报我**）；半包会保留在 `cacheDir/*.part` |
| 一直「尚无Program 包」 | 看 `[program-ota]` 行有没有报错 |

## 2. 已是最新（不应重复下载）

| | |
|---|---|
| **触发** | 再次启动 |
| **期望** | 不下载；`stage=program` 的事件为「已是最新（本地 0.1.0-android.11，远端 0.1.0-android.11）」 |
| **为什么重要** | 防止每次开机都重下 1.2MB |

## 3. 升级（版本前进 → 下载 → 提交 → FLOOR 前移）

| | |
|---|---|
| **触发** | ① 改 `programs/console/package.json` 的 version（如 `0.1.0-android.12`）；② 跑 `program-ota`(channel=canary)；③ 设备启动 |
| **期望** | 下载新包 → 安装 → `programPending` 写入 → 健康通过 → `program-commit` 事件 → `programFloor` **前移到 .12** |
| **关键断言** | 提交后 `programFloor` = `.12`；`programPending` 回空串 |

## 4. 过期即拒（防「永久冻结在旧版本」）

| | |
|---|---|
| **触发** | 把桶里 manifest 的 `expiresEpochMs` 改成**过去**（改一个副本最省事） |
| **期望** | 日志出现 `manifest-expired`，**不安装**；`CURRENT` 不变 |
| **若没拒** | **真 bug**（C3 失效），报我 |

## 5. 重放即拒（防把设备拉回旧版）

| | |
|---|---|
| **触发** | 把 manifest 的 `sequence` 改成**小于设备已见水位**的值（水位存在 `files/program-feed-state.json`） |
| **期望** | 日志出现 `manifest-replay`，不安装 |

## 6. 灰度未命中（停发语义）

| | |
|---|---|
| **触发** | 用 `rollout_percent=0` 发一次（或改桶里 manifest 的 `rolloutPercent` 为 0），然后启动设备 |
| **期望** | 日志「灰度未命中（bucket=N >= rolloutPercent=0）」，**不安装**、**不是错误**（下次启动再试） |
| **若仍然装了** | **真 bug**（停发失效），报我 |

> 分桶是**确定性**的（同设备同版本永远同桶），所以「灰度 10%」意味着同一台设备
> 要么一直命中、要么一直不命中，不会随机跳。

## 7. 提交 / 回滚（C2：装得上 ≠ 跑得起来）

| | |
|---|---|
| **触发** | 制造一个**装得上但起不来**的内核（例如入口脚本立刻崩溃的版本） |
| **期望** | ① 安装成功、`snapshot.programPending` = 新版、`snapshot.programVersion` 也指新版；② 健康检查**失败**（`stage=health` 的事件为 FAIL）；③ 事件流出现 `program-rollback`「已回滚到 <旧版>」；④ `snapshot.programVersion` 回到旧版；⑤ **`snapshot.programFloor` 不降** |
| **最要紧的一条** | **回滚后 FLOOR 不得降低** —— 否则「回滚」就成了降级的后门 |

## 8. 断点续传（弱网可用性）

| | |
|---|---|
| **触发** | 启动后立刻开**飞行模式**（或断网），让下载中途失败；再恢复网络并重启 |
| **期望** | 半包 `cacheDir/program-ota-<ver>.zip.part` **存在**且 > 0；恢复后从断点继续（不是从 0 开始） |
| **这条只能拿 debug 归档验** | `cacheDir` 没有对外的机读格（控制面只回 `programVersion/Floor/Pending` 与事件流，见 §0.1），而「半包保留不删」是文件层事实。所以这一条用同 `versionCode` 的 debug 归档包复现，读 `adb shell run-as lobos.app ls -l cacheDir/`。**逻辑本身**不靠这条兜底：Range 续传 / 416 / 提前断 / sha256 不符各有 JVM 单测钉着（`.github/convicted-cases.txt` 的「有内容的半包只陈列不判红」等）—— 这里验的是真机上那个文件确实留着 |
| **为什么重要** | 这是「弱网也能装上」的核心；旧实现失败即丢弃，永远装不上 |

---

## 9. 原生件能力核验（投放 ≠ 能力）

| 项 | 内容 |
|---|---|
| **触发** | **自动 + 按需两条，各答一个问题**：① 自动 —— 容器启动链每跑一轮就验一轮（`lobos/runtime/InstanceHost.kt:371` 在 `bootProgramOnce()` 里调 `NativePreparer.prepare()`，循环由 `lobos/runtime/InstanceHost.kt:181` 驱动），所以**首装、升级、每次重拉都会验**，结论当场落盘。核验排在「无内核包就收口」之前：`files/programs` 缺失时也照样验、照样落盘 —— 原生链路坏在哪一格是设备事实，不该被「这次没东西可跑」挡住；② 按需 —— 桥方法 `sys.nativeAssets` 现场再验一次（会真 spawn 探针）。「落盘的那一轮」与「现在再验一次」不许混成一句：把没验过的读成验过、或让界面每刷新一次就重跑 exec-probe，都是这条链的坏形态（债表 D12） |
| **看哪里** | ① 落盘的**结构化结论**（首选）：读 `os.nativeAssets.status`（面板侧 `GET /native/capabilities`），它取 `files/os/diag.jsonl` 里最新一轮的 `data` 字段，**不重跑探针**；没有记录就回 `collected:false` —— 「没验过」与「验过且坏」是两档，不许拿前者当后者；② 现场重验一次：`sys.nativeAssets` 的返回逐格 `status` + `detail`/`missingDep`/`hint`（实现 `lobos/bridge/CapabilityBroker.kt:743`，契约 `container/engine/src/bridge/methods.js:150`；默认每次真跑一次 exec-probe；传 `{"walkProbes": false}` 只做存在性+依赖检查，避免频繁 spawn）；③ 逐事件的三行结论：`GET /diagnostics/events?stage=native` 与 `?stage=capability`、`?stage=prefix` —— `stage=native-assets`（大件 libcxx / node）、`stage=capability-assets`（能力件 bash / rg / flock / posix / PTY 探针）、`stage=prefix`（`$PREFIX` 缺件，`lobos/runtime/InstanceHost.kt:449`）；④ 开机快照：`GET /diagnostics/provisioning`（`ProvisioningProbe` 落盘那份：`checks` 逐格结论 + 三条版本流身份 + `checkedAt`）；逐格的体检事件本身走 `GET /diagnostics/events?stage=probe`。① ③ ④ 都只读已落盘的；落盘原文的住址见 §0.1，控制面起不来时按 §0.1 的 debug 归档复现 |
| **判据** | `status` 是闭集：`ready` 才算可用；`missing_from_lib` / `missing_dependency` / `not_executable` / `probe_failed` 都是**坏或未知**，一律不许报通过。`File.canExecute()` 对 `filesDir` 也返回 `true`，对 SELinux 的 W^X **完全无感（假阳性）** —— 所以判据必须真 exec 一次，不能只查权限位 |
| **与投放结局对照** | 「补装动过手」与「能力可用」是两个正交结论：前者看 ④（`snapshot.checkedAt` 证明体检确实跑过、`snapshot.checks` 给逐格结论），后者只看 ① ② ③ 的读数。两排不一致是设计如此，读能力以核验报告的 `status` 为准 —— 落盘那份（①）与现场重跑那份（②）是同一实现，只是时点不同 |
| **为什么重要** | 真机 2026-09-26：`sharp-image` 那格报「已投放」（`@img/sharp-wasm32` 就在依赖树里）而 sharp 取不到绑定，`read_image` 全灭，界面上零痕迹 —— ADR-0001 P4 因此把「已解决」写了出去（现已作废） |

判据本体（每个能力件该验什么、验不过算哪一档）住在 `container/app/src/main/java/lobos/native/NativeAssetRegistry.kt`，
由 `scripts/gen-native-assets.js` 投影成 `.github/native-capabilities.txt` 供 shell 与测试读取 —— 手改那份投影必红
（`container/engine/test/native-assets-test.js`）。构建期与打包期的校验分别是 `scripts/verify-apk-native.sh`
与链接期的 `scripts/verify-runtime-elf.sh`。**没有第二张表**：改判据就是改 `NativeAssetRegistry`，
不在散文里复述结论，也不在面板侧另拼一把尺子。

落盘的结构化结论就是探针自己算出来的那一份（`NativePreparer.prepare()` 把 `PrepareReport.toJson()` 作为
`data` 字段随诊断事件写入，见 `container/app/src/main/java/lobos/native/NativePreparer.kt:247`）：
`os.nativeAssets.status` 原样读出它，不重新解释、不补默认值。**读不到 ≠ 都就位** ——
这一格丢了要在界面上看得见，不许用一次现场重跑来假装它一直在。

表里 `CAPABILITY` 那几格（bash / ripgrep / flock / posix / PTY 探针）都是 `required = false`：
它们缺件不会让装配失败，而是各自把功能打成降级（每格的 `note` 写着缺件后果，例如 ripgrep 缺件时
glob/grep 报 `SEARCH_FAILED`）。**「能装上」不等于「能力在」** —— 读数以 `sys.nativeAssets` 的 `status` 为准，
别替不是 `ready` 的格报通过。

**回传要求**：任何一格不是 `ready`，把该格 `status` 与 `detail` 原文带回来 —— 它就是探针的完整结论。
带不上原文时（`collected:false`）也要照原样回，那是「没验过」，不是「验过且好」。取法：

```bash
curl -s "http://127.0.0.1:36360/native/capabilities"                       # 落盘的最后一轮
curl -s "http://127.0.0.1:36360/diagnostics/events?stage=native&limit=50"  # 同一份的逐事件原文
```

（落盘原文 `files/os/diag.jsonl` 的住址唯一：`RuntimeDiagnostics.structFile()`；设备侧
`LOBOS_SUPERVISOR_HOME` 就是应用 `filesDir` —— 见 `runtime/GuestAdapter.kt:100`。
发布包上 `run-as` 这条路已经断了，直接读那两份文件只在 debug 归档包里成立，见 §0.1。）

> 已废止的旧形态（随「D4 职责下沉」整段删除，本节不再指向它们）：旧供给表 `programs/console/src/assembler/supply-table.json` 的 `units[].verify`、执行器 `capability-probe.js`、CI 门 `native-supply-gate-test.js`、落盘 `files/console/native-manifest.json` 与 `nativeUnits`/`nativeCaps` 两排。

---

## 10. 验证通过后的两件事（别忘）

1. **提升到生产通道**：跑 `program-ota`，`channel=stable`、同版本（门禁允许同版本重发）、`rollout_percent` 从小比例开始；
2. **把设备通道改回 stable**：`assets/program-feed.json` 的 `"channel": "canary"` → `"stable"`，并重新出 APK。

> 顺序不能反：stable 通道现在**还没有** manifest，先改会 404。

## 11. 请回传给我的

按 §0.1 的四条 curl 原文回（`forward` 之后的终端输出直接粘过来即可，不要只回「正常」）：

- `GET /diagnostics/provisioning` 全文（`present:false` 也要，它说明体检没跑过）；
- `GET /diagnostics/events?stage=program&limit=400` —— 覆盖 `program-ota` / `program-commit` /
  `program-rollback` / `health` / `process` 这些 stage；
- `GET /native/capabilities` 全文；
- `GET /status` 全文（相位与首行）；
- 任一**与上表不符**的现象（那些都是真 bug，我来修）。

控制面起不来、四条 curl 全部拒绝连接时：先回「36360 没人监听」这个事实本身（这就是 §0.1 说的
内核没跑起来），再装同 `versionCode` 的 debug 归档包复现一次，把 `run-as` 读到的
`files/provisioning.json` 与 `files/os/diag.jsonl` 带回来。
