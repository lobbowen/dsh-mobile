# Agent OS 执行案（唯一在途方案）

状态：**执行中**。决策依据 = ADR-0008（域模型与 init 权威）+ ADR-0006（常驻边界）。
全仓在途方案文档**只许这一份**（放在 `docs/plans/`）；要开新轨先把它收口或并入。

## 1. 轨道总览

| 轨 | 内容 | 状态 | 量 |
|---|---|---|---|
| **P0** | C1 出生收口：`onCreate` 自出生 + 三态判据 + 空壳上屏 + 门禁出生链 | **已收口**（壳 1.1.7(9)，main=`7afa06d5`）：真机判据 **1、2、3、4、5 全过**。1.1.6(8) 上判据 3 真机判失败 = D9（通知 1004 双正文写者），补修（D9 单写者 + D10 转发线程不致命）随 PR #92 合入并上线；02:05 同型注入复点，t+24s 实读「运行时未出生」⇒ 判据 3 成立。逐条读数与口径更正见 §7，ADR-0008 §5 同步 | 0.5d + 1 壳 + 1 机 + 补修 1 壳 1 机 |
| **PC-0** | 命名表 / 目标树终稿 / CI paths 对照表 / `capability`⇄`permissions` 裁决阅读 | **已交表**（2026-09-27，读数对 origin main `3d5cd9e7` 实拍、行号已对 HEAD `1c32d8cf` 逐条复算）：命名表见 §3.1，目标树终稿与逐目录/逐包映射见 §3.2–§3.3，paths 对照表与门禁空转地雷见 §5.1–§5.2，裁决阅读见 §8。交回拍板的事共 **5 件**（§3.4 三件 + §8.4 两件） | 0.5–1d |
| **PC-1** | D1+D2 搬家：`guard`⇄`supervisor` 双词汇合并 + `container/engine`→`hosttools` | 待做 | 2 壳 |
| **PC-2** | Kotlin 六域包制重排（含组件名迁移 + a11y 注册串自校正） | 待做 | 2–3 壳 + 1 机 |
| **PC-2b** | privilege 声明层收口（§8 ①–⑤：4 条门禁 + 删 2 个死字段 + id 常量化），语义改动不得混进搬家轮 | 待做（新增轨，待 §8.4 第 4 项拍板） | 1d + 1 壳（无真机判据） |
| **PC-3** | `NodeRuntimeService` 905 行上帝文件拆分（machine / supply 分离） | 待做 | 1d + 1 壳 |
| **PC-4** | D5 桌面残项逐项引用定罪与删/耦 | 待做 | 1–2d |
| **P1** | init 权威成文：adopt-or-start（先决实验）+ runtime.json schema 3 握手 + C2 状态机 | 待做 | 3d + 2 壳 + 2 机 |
| **P2** | 多运行时（python/go 以「供给单元 + 受管对象类」注册，安卓侧零改动 = 验收判据） | 排后 | 4–6d（调研占 6 成），不承诺工期 |
| **P3** | 工作连续性（I2 欠账：受管任务 checkpoint-resume） | 排后 | 0.5d 设计 + 2–3d + 1 机 |

**P0 与 PC 的顺序（2026-09-26 已拍板）**：P0 先以现状路径上小 PR，让真机当天就脱离
「退后台即永久断服」；搬家 PR 再把它原样搬进 `machine/`。不为搬家让线上继续带病。

## 2. 现仓「波动源」定罪清单（2026-09-26 逐项亲眼取证）

| # | 罪状 | 证据 | 处置 |
|---|---|---|---|
| D1 | **双词汇生命周期权威**：`kernel/src/supervisor.js`（顶层）⇄ `kernel/src/guard/`（目录）⇄ `guard/supervisor/*.js`（mixin 视图）三套名字指同一权威 | `ls kernel/src`、`ls kernel/src/guard` 实拍 | PC-1：合并为单一 `init/`，旧名进死词汇门禁 |
| D2 | **`container/engine` 名不副实**：目录里是发布工具链（`src/sign.js`、`verify.js`、`ota-engine.js`、`kernel-bundle.js`、`zip.js`、`keys.js`、`runtime-json.js`）+ 契约夹具（`test/boot-fixture.js`），与「运行时引擎」无关，L-C/L-D 真身在 Kotlin `runtime/` | `ls container/engine/src` 实拍 | PC-1：改名 `hosttools/`，与 test 夹具分家 |
| D3 | **Kotlin 顶层散文件 + 特权双包并存（原判「capability⇄permissions 双权威」已被代码证伪）**：`MainActivity`/`NodeContainerApp`/`ProvisioningProbe`/`RuntimeDiagnostics` 裸在包根；`capability/` 与 `permissions/` 并存，但查询裁决**已是单源** —— `PermissionCenter.isGranted()` 唯一入口（`PermissionCenter.kt:20` 按 `spec.id` 分发、`:72` `batteryExempt()`），`LifecycleChecks.kt:22` 也走 `PermissionCenter` 而不是自己判。残留罪（PC-0 §8 逐字段读完后的定稿口径）= ①**分层枚举两套**：`PermTier`（`permissions/PermissionCatalog.kt:11`，7 值）与 `PermTierClass`（`capability/CapabilityCatalog.kt:42`，4 值），同一个权限在两侧被分成不同的档（无障碍：`SERVICE_TOGGLE` vs `SECURE_SETTINGS`；通知读取：`SETTINGS` vs `SECURE_SETTINGS`；屏幕捕获：`SETTINGS` vs `IN_APP`）；②**显示名两份**：8 个 id 的 label 在 `CapabilityCatalog.kt:78,141-163` 逐条重写一遍（`MANAGE_EXTERNAL_STORAGE`→「全部文件访问」vs「…:48」→「MANAGE_EXTERNAL_STORAGE」、`NOTIFICATION_ACCESS`→「通知读取」vs「通知访问」…）；③**无登记的 id**：`LifecycleChecks.kt:32` `"phantom-process-killer"`、`:45` `"fgs-keepalive"` 全仓仅此一处，且 `Line.id` 三个取值**零消费点**（只有 `ProvisioningProbe.kt:80-88` 读 `ok/title/detail`）；④**绕过单源的第二条查询路径**：`LifecycleChecks.kt:22` 直调 `batteryExempt()`，而同一事实的正路是 `isGranted(BATTERY_OPTIMIZATION 的 spec)`（`PermissionCenter.kt:40`），`:24` 因此必须重抄一遍裸串 `"battery-optimization"`；⑤`PermissionSpec.note` **零消费点**（声明处自称「会被拼进诊断行」= 空头承诺），`PermissionSpec.tier` 只有 1 个消费者（`CapabilityNavigation.kt:35` 判 `RUNTIME`） | 2026-09-27 对 origin main `3d5cd9e7` 全量抓取（60 个 `.kt`）逐文件通读 + 逐字段引用计数；行号已按 origin 复核（上一轮「双权威」属印象定罪，本轮自纠） | PC-2：六域包制收编散文件 + 按 §8 的裁决把「权限声明」收成一份；把 §6 判据 2 的「跨域读取只经合同常量」从**文件路径**扩到**权限 id / 显示名 / 分层**（门禁扫 Kotlin 裸字面量，活样本自证） |
| D4 | **`NodeRuntimeService.kt` 905 行上帝文件**（2026-09-27 对 origin 实测行数，本表原记 860 行属旧读数）：预置体检/写探针/OTA/暂存清扫/装配/spawn/轮询/退避/诊断转发混住 | origin `3d5cd9e7` 实拍：50,358B / 905 行，全包最大件（第二名 `HostBridgeService.kt` 51,361B） | PC-3：按 ADR-0008 §2 拆 machine / supply / kernelota |
| D5 | **死残待判**：`kernel/src/platform/os/browser.js` 等桌面域文件仍被 `platform/os/index.js`、`guard/supervisor/settings-view.js` require | grep 引用实拍 | PC-4：**删前逐项引用计数 + 真机域运行证明**；若该代码路径在 Android 运行期会被触达，先解耦再删（不许砍能力迁就缺陷） |
| D6 | **根目录半拉子文档**：仓根平铺方案 md，且被 `layout-manifest-test` 的 rootAllow 判红；`system/README.md` 指向不存在的 `docs/ADR-001`（实际在 `docs/adr/0001-*`） | 本轮 `node test/layout-manifest-test.js` 实跑 FAIL + head 实拍 | 本 PR：方案文档一律进 `docs/plans/`，决策进 `docs/adr/`；stale 引用修复入门禁 |
| D7 | **`system/` 目录本体无罪**：Tier S（特权系统服务形态）集成契约，与 Tier A 垫片路径并存的刻意设计 | `system/README.md` | 保留，只修引用 |
| D8 | **交付通道无单一写者**（2026-09-26 夜间事故，2026-09-27 复核）：`fast-apk` 从**任意 ref** 都能写共享发布通道，未合入 main 的分支字节被原地投成用户手里的下载地址 | 实证：16:12–16:13 分支 commit `090abbd`（领先 main 18 个 commit）经 run #185 同时覆盖 `apk-latest` 与 `v1.1.6`，`ci-ok.txt` 落 `sha : 090abbd`；成因三处逐行复核 —— `fast-apk.yml` 全文无 `github.ref_name` 校验（发布步骤 `:730`、`TAG="apk-latest"` `:736`、版本化归档 `VTAG="v$VN"` `:796`），版本门禁放行同号换字节（`verify-apk-version-gate.sh:77`），两条合起来 = 任何分支都能顶掉线上 | 归 **P2b**（另一工作区正收敛门禁/`fast-apk.yml`/`scripts`，本轮不碰）：发布步骤加「`GITHUB_SHA` 必须是 main head」硬失败 + 门禁活样本；合同条文已进 ADR-0008 §4 C4。本轮治标**已完成并复核**：fast-apk run #188（`main` / `9d530d3`，21 步全绿，含 step 17 签名门与 step 20 发布）后，Releases API 实读 `apk-latest/app-debug.apk` 与 `v1.1.6/app-debug-1.1.6+8.apk` digest 相同 = `sha256:8466cdaa67b6a4b03…`（53406521 字节），`ci-ok.txt` 现记 `sha : 9d530d3` + 同值 `apk_sha`（污染版是 `25c117d…` / 53406529 字节 / `090abbd`）；**同一破口 8 分钟后再次点火**：16:30:59 分支 `ws-p2b-audit`（`a6c9fafb`）dispatch fast-apk run #189，只因它自己红在 step 18「Audit APK contents」（发布步 `:730` 没有 `if:`，前一步红则后续整步不跑）才没顶掉通道 —— 挡住事故的是别人的门禁判红，不是这条链有设计 |
| D9 | **常驻通知（NOTIF_ID 1004）有两个内容写者**（2026-09-27 真机判据 3 定罪）：`promoteToForeground()` 每次 `onStartCommand` 都用 `ResidencyAudit.interruption() ?: "状态采集中…"` 覆盖正文（`ContainerSupervisor.kt:100` 投递 → `:118-124`，覆盖语句在 `:121`），而三态结论只由 `refreshStatusNotice()`/`statusLine()`（`:209-243`，`NOTIFY_MS = 20_000L` 在 `:313`）发布 ⇒ **拉起风暴里后者的节拍永远赢不过前者**。为什么必然成风暴：`ensureRunning` 是普通 `startService`（`:321-327`），而它的调用点包含「`:node` 每次 boot 尝试」（注释 `:316-320` 自证）⇒ :node 越是不出生就越频繁地戳，戳一次盖一次，屏幕上恒定只剩定罪段。罪不在 throttle，在**同一 id 两套正文** | 真机注入 `POWER ∧ ¬BORN ∧ ¬ONLINE` 后 13 个采样点（40s / 3s 粒度）通知从未印「运行时未出生」，撤掉注入后同一条通知立刻自愈成「运行时在线」⇒ 链路在跑、内容被盖；logcat 无「监督拍异常」⇒ 非抛异常（实跑记录与口径更正见 §7 收口状态） | 补修已落（壳 1.1.7(9)）：1004 的正文**单写者** = `statusLine()` —— `promoteToForeground()` 改为 `startForeground(NOTIF_ID, buildNotification(statusLine()))`（`:126`），首拍读数未采时由 `statusLine()` 自己如实说「状态采集中…」（新增 `readingsCollected`，声明 `:73-75`、落 `:225`、用 `:235-237`）。**刻意不加**「状态变化即发布」的第二套节拍：判据 3 的窗口是 40s，20s 一档足够，加机制=加风险 |
| D10 | **内核 stdout/stderr 转发线程未捕获 `InterruptedIOException`**：`forward()` 在裸 `Thread { }` 里 `bufferedReader().use { r -> r.forEachLine { … } }`（`NodeRuntimeService.kt:627-632`），任一异常沿默认 `UncaughtExceptionHandler` 上抛 ⇒ 拆内核管道（`close()`）与读线程抢 FD，抛 `read interrupted by close() on another thread`，**整个 `:node` 进程 FATAL** | 真机 crash buffer 实证：`FATAL EXCEPTION: Thread-2/Thread-3 · Process: …:node · java.io.InterruptedIOException: read interrupted by close() on another thread`，栈尾实名 `kotlin.io.TextStreamsKt.forEachLine(ReadWrite.kt:163)` → `NodeRuntimeService.forward$lambda$11(NodeRuntimeService.kt:632)`；01:07:46 / 01:11:13（两条）/ 01:12:13（两条）共 5 次、三个不同 pid（22169 / 26037 / 27052），stdout 与 stderr 两条转发线程都会炸 ⇒ **不是我这轮手动杀进程才有的罕见竞态，内核每次被拆管都炸一次整进程** | 修已落（壳 1.1.7(9)）：`forward()` 的读取整体收进 `try/catch (Throwable)`（`NodeRuntimeService.kt:627-679`），异常按**正常收尾**处理 —— `InterruptedIOException("read interrupted by close()…")` 是 libcore 对「另一线程关掉了 FD」的信号，不是故障；收尾时 `Log.w` + `RuntimeDiagnostics.append(kernel-$tag)` 留痕，绝不上抛。顺带给线程命名 `kernel-$tag-forward`（本缺陷在崩溃栈里只叫 Thread-2/Thread-3，无从归因）。**没做**「先停读线程再 close()」的顺序改造：拆管方在别处且不止一条路径，把「转发线程之死不许带走宿主」这条不变式立住之后，顺序竞态只会少几行日志、不再致命 —— 为一个不致命的窗口引一套线程协调属过度设计。判据 = 反复拆/起内核后 crash buffer 零新增；壳 1.1.7(9) 真机复点：12 次拆内核 + 3 次换 :node，FATAL 恒 14（修前 5 次全在里面）、:node 全程存活，但落盘诊断 `转发线程结束` 计数 0 ⇒ **只到「不复现」，未拿到「catch 真的接住过」的正向证据**，判据不销（读数与探针自匹配的坑见 §7） |

## 3. 目标树（发布维 L0/L1/L2 不动，职责维六域落目录）

```
dsh-mobile/
├─ host/                        # 发布维 L0（原 container/；Gradle 模块名仍 app）
│  ├─ app/src/main/java/io/github/lobbowen/dshmobile/
│  │  ├─ machine/               # 机器域：NodeRuntimeService(拆分后)+NodeWatchdogPolicy+ContainerSupervisor
│  │  ├─ privilege/             # 特权/驱动域：capability+permissions 裁决后的唯一入口 + adb/配对
│  │  ├─ bridge/                # 能力总线（HostBridgeService 系）
│  │  ├─ supply/                # 供给域：native/ + kernelota/ + Prefix 装配
│  │  ├─ observability/         # 观测域：RuntimeDiagnostics + ResidencyAudit + 探针出口
│  │  └─ onboarding/            # 界面（原 ui/ + MainActivity + NodeContainerApp）
│  ├─ hosttools/                # 原 engine/：发布工具链 + 契约夹具
│  └─ native/                   # C 探针件（flock/posix/ptyprobe，原位）
├─ runtime/                     # 发布维 L1（原 kernel/）= init 权威唯一载体
│  ├─ init/                     # D1 合并：supervisor.js + guard/* → init/{lifecycle,supply,proc,monitor}
│  ├─ platform/                 # 安卓专属客户端层（host-bridge client、state-root、env-catalog）
│  ├─ workloads/                # 原 domains/ + adapters/（D5 裁决后保留或删）
│  ├─ api/                      # 控制面路由
│  └─ ui/                       # 面板
├─ system/                      # Tier S 契约（保留，修引用）
└─ docs/{adr,contracts,runbook,plans}/
```

**两条硬规矩（防"搬家搬出第二现场"）**

1. **只搬不改语义**：搬家 PR 的判据 = `git diff --stat` 全为 rename + 引用点路径更新，
   行为性 diff 零行；CI 四关（gates / app-tests / container / kernel）绿是唯一验收标准。
2. **旧名清零**：搬完的同轮，旧目录名/旧包名/双词汇进 `capability-single-source-gate` 死词汇表
   （手法先例：被否决的进程外复活边、监督者补投 startService），并给每条死词汇自带
   "活样本自证"（判据方法学 v3：正样本必须命中、负样本必须判不合格）。

### 3.1 命名表：一个词汇的三层身份（PC-0 交表，读数对 origin `3d5cd9e7`）

**这张表存在的唯一理由：同一个词在「仓内目录」「产物与设备落盘」「代码符号」三层里的可改性完全不同。
搬家 PR 只许动第 ①③ 层；动第 ② 层 = 破坏现役设备上的既有数据，那是数据迁移案，不是搬家。**

| 词汇 | ①仓内路径（PC 可改） | ②产物 / 设备落盘（**不许改**） | ③代码符号 / 日志（随搬家改） |
|---|---|---|---|
| `container/` | 约 144 件：`app` 99 / `engine` 41 / `native` 4（`_artifacts/` 已删） | 无（APK 内不留仓名痕迹；Release 资产名 `app-debug-<ver>+<code>.apk` 与此无关） | `settings.gradle.kts:23` `projectDir`；commit scope `app·engine·native` 与 tag 规范 `container-v<semver>`（`docs/runbook/git.md:48,57`，现役实际用 `fast-*`/`v<ver>`） |
| `kernel/` | 236 件：`src` 84 / `test` 74 / `ui` 74 / `bin`+`adapters`+`docs` 各 1 | **OTA 包内前缀 `kernel/<version>/`**（`container/engine/src/kernel-bundle.js:124`、`ota-engine.js:119`）⇒ 设备 `files/kernel/<ver>/`；APK 断言 `assets/kernel/` 必须为空（`fast-apk.yml:536-538`、`scripts/verify-apk-native.sh:138-146`）；`assets/kernel-feed.json` | `kernelota/` 包、`KernelManager` 等 12 个类名、tag `kernel-<channel>`；`kernel/package.json` 的 version = OTA 版本单一事实源（ADR-0004） |
| `supervisor` | `kernel/src/supervisor.js`（1094 行，D1 的顶层入口）+ `kernel/src/guard/supervisor/`（6 个视图 mixin） | **入口脚本名 `dsh-supervisor`**（`kernel/package.json` 的 `bin` + `kernel/bin/dsh-supervisor`）；**设备状态目录 `files/supervisor/`**（`kernel/src/platform/state-root.js:17,48`；壳侧 `NodeRuntimeService.kt:554,841`；`AdbClientRunner.kt:86` 靠 `--migrate-from files/supervisor/adb` 认领密钥） | Kotlin `ContainerSupervisor`/`SupervisorPolicy`；诊断 stage 名 `"supervisor"`（`NodeRuntimeService.kt:193`）；内核日志行 `[supervisor] daemon started` |
| `guard` | `kernel/src/guard/` 27 件（`lifecycle`/`monitor`/`proc`/`native`/`supervisor`/`guardian`/`health.js`/`intent.js`） | 锁文件落盘名 `supervisor/guard.lock`（`NodeRuntimeService.kt:547,554`）；**stderr 日志前缀 `[guard]`**（壳侧 `RuntimeDiagnostics` 逐行采集，改前缀会让既有定罪日志的读法失效） | require 边 `supervisor.js:14,27-31`、`api/guard.js`、`guardVersion`（`platform/version.js`） |
| `engine` | `container/engine/`：`src` 12（含 `bridge/` 4）/ `test` 24 / `bin` 1 / `package.json` | — | **`container/engine/package.json:2` 的 `name` 至今 = `container-engine`，正是 `docs/contracts/layout.json:152` `legacyForbidden` 在册的旧名**；CI 的 `working-directory: container/engine`（`ci.yml:39`、`build-apk.yml:241`）；24 个测试文件用 `require('../src/…')` 相对边（整目录搬即可，不必逐条改） |
| `dsh-android-kernel` | —（目录旧名 2026-09 已消失） | **`kernel/package.json:2` 的 `name` 仍是这个 legacyForbidden 旧名，而且它被写进设备文件**：`SHIM_MARKER = 'dsh-android-kernel:narb-js-shim:v1'`（`guard/native/require-builtin-shim.js:20`、`flock-shim.js:23`）会嵌进投放到已安装 npm 树里的垫片 JS 源码，作为幂等判据 ⇒ **改名 = 设备上已打垫片的入口被判定为"未打"，再打一遍并覆盖 `.dsh-orig.js` 原生入口备份** | `platform/host-bridge/protocol.js:5` 注释仍写「两仓独立」+ 旧路径 `container-engine/src/bridge/protocol.js`（单仓化后失效叙述） |
| `$PREFIX` / `files/usr` | — | 设备 `files/usr`（bash/rg/pty.node/node，见壳侧诊断行 `prefix: $PREFIX 能力件全就位`） | `PrefixProvisioner`/`supply`；与搬家无关，列此防误伤 |

**两条由这张表直接产生的硬判据（PC-1 合入前必须自证）**

1. **包名/标记串也要清零**：`layout-manifest-test` 只对目录做 `existsSync`（`:38-46`），所以两个
   legacyForbidden 旧名至今住在 `package.json` 的 `name` 里而门禁不响 ⇒ §6 判据 1「旧名全仓 grep 零命中」
   目前的机器形态必须扩到 `*/package.json` 的 `name` 与 `SHIM_MARKER` 这类**写入产物的常量**。
2. **改第 ② 层要另案**：`SHIM_MARKER` 的正确改法是「认两个标记」（新标记 + 旧标记并存判等），
   与目录搬家无关 ⇒ 不进 PC-1/PC-2，单列待拍板（§3.4 第 3 项）。

### 3.2 目标树终稿：逐目录 / 逐包映射（现状件数 → 去向 → 批次）

顶层与内核侧（PC-1）：

| 现状（origin 实拍件数） | 去向 | 批次 | 搬家当轮的打断点（见 §5.1） |
|---|---|---|---|
| `container/`（145） | `host/` | PC-1 | `settings.gradle.kts:23`、4 份 workflow 的 paths/字面量、`dependency-rule-test.js:25,39` |
| `container/engine/`（41） | `host/hosttools/` | PC-1 | `ci.yml:39`、`build-apk.yml:239-241`、`kernel-ota.yml:244`、`scripts/{gen-version.js:34-37,69,build-kernel-bundle.sh:33}` |
| `container/native/`（7） | `host/native/` | PC-1 | `fast-apk.yml:51,333,343,390`、`scripts/build-node-android.sh:58` |
| `container/_artifacts/`（1 个 README） | **删或并进 `docs/runbook/`**（目标树 §3 未列它；它存在的唯一理由曾是 ADR-0005 删掉的签入内核包） | PC-1 裁决 | 无（`.gitignore` 刻意不忽略内核包的叙述在 `git-repo-standard.md:159`） |
| `kernel/`（236） | `runtime/` | PC-1 | 全部 `kernel/**` glob + `gen-version.js:35` + `ci.yml:158` + `kernel-ota.yml:92-98` |
| `kernel/src/supervisor.js` + `kernel/src/guard/**`（1+27） | `runtime/src/init/{index.js,lifecycle,supply,proc,monitor,…}`（D1 双词汇合并；`supervisor.js` 1094 行按 §3.3 的六域拆） | PC-1 | `require('./guard/…')` 边（`supervisor.js:14,27-31`）、`kernel/test/*` 读源路径（`kernel-update-single-writer-test.js:45` 直读 `src/supervisor.js`） |
| `kernel/src/platform/`（28） | `runtime/src/platform/`（不改名，安卓专属客户端层） | — | — |
| `kernel/src/domains/`（17）+`kernel/adapters/dsh/agent.json`（1） | `runtime/src/workloads/`（D5 裁决后保留或删） | PC-1/PC-4 | `platform/os/index.js:79` → `domains/router/router-ops.js:29` 的 browser 边 |
| `kernel/src/api/`（11）、`kernel/ui/`（74）、`kernel/bin/`（1）、`kernel/docs/`（1） | `runtime/{api,ui,bin,docs}` | PC-1 | `bin/dsh-supervisor` 文件名**不许改**（②层） |

Kotlin 侧（PC-2，现状 9 个包 + 包根 4 件 = 60 个 `.kt`）：

| 现状包（件数，代表件） | 六域去向 | 裁决依据 / 注意 |
|---|---|---|
| 包根 4：`MainActivity`(379 行)/`NodeContainerApp`/`ProvisioningProbe`/`RuntimeDiagnostics` | `onboarding/`（前二）+ `observability/`（后二） | `MainActivity` **是活件不许顺手删**：`AndroidManifest.xml:205` 仍声明（注释自证「旧快捷方式直达不被切断」），且 `NodeRuntimeService.kt:14` 有 import |
| `lifecycle/` 7（`ContainerSupervisor`/`NodeWatchdogPolicy`/`ResidencyAudit`/`BootReceiver`/`DshAccessibilityService`/两个 Receiver） | `machine/`（监督与判据）+ `observability/`（`ResidencyAudit`）+ `privilege/`（`DshAccessibilityService`、两个 Receiver） | 组件名迁移代价按 §4 走 a11y 注册串自校正，不要求人工重授 |
| `runtime/` 6（`NodeRuntimeService` 905 行/`NodeProvisioner`/`PrefixProvisioner`/`SupervisorPolicy`/`GuestAdapter`/`NodeVersionManager`） | `machine/`（进程与判据）+ `supply/`（预置/装配/版本） | PC-3 的拆分与 PC-2 的落点在**同一轮**做完，避免"先拆再搬"两次打断门禁 |
| `native/` 3 + `kernelota/` 12 | `supply/` | `NativeAssetRegistry.kt` 是 `.github/native-assets.txt` 的生成源（`gen-native-assets.js:9`），路径改了必须同步生成器 |
| `capability/` 15 + `permissions/` 3 | `privilege/`（按 §8 裁决收成一份声明） | 门禁直读这两个包的文件名：`capability/CapabilityCatalog.kt`、`permissions/PermissionCatalog.kt`（`capability-single-source-gate-test.js` 的 `CATALOG_REL`/`PERM_CATALOG_REL`） |
| `bridge/` 7（`HostBridgeService` 51KB 最大件） | `bridge/`（域不变，仅随 `container→host` 换顶层） | — |
| `ui/` 3（`OnboardingActivity`/`PairingProbeService`/`ProbeJournal`） | `onboarding/` | manifest 里 9 处相对组件名（`.lifecycle.` / `.runtime.` / `.ui.`）同轮改 |

### 3.3 落地载体 = 既有的 `docs/contracts/layout.json`，不新造第二份表

`layout.json`（v1，`updated: 2026-09-23`）已经是目录权威：`rootAllow` / `layers.L0·L1·S·CI·DOCS·ARCHIVE` /
`moves[{from,to,kind,expectFiles}]` / `legacyForbidden` / `generated` / `secrets` / `scriptsOwnership`，
并由 `layout-manifest-test.js` 判据化（`:38-46` 状态机 pending/done/conflict/missing、`:49-51` `expectFiles`
**下限**防丢件、`:56` legacy 存在即 problems、`:58-60` 未声明根条目入 problems，`LAYOUT_ENFORCE=1` 可红）。
⇒ PC-1/PC-2 的交付形态是**给它追加条目**，而 §3 硬规矩 2「旧名清零」的机器判据就是 `legacyForbidden`。

**追加顺序（这是有牙的，搞反了门禁会自己判红）**：`layout-manifest-test.js:44` 对
`f&&!t` 判 pending、`:56` 对 legacyForbidden 命中判红 ⇒

1. 搬家**前**一轮：只加 `moves`（此时 from 在、to 不在 = pending，合法）；`rootAllow` 暂不收旧名。
2. 搬家**当**轮：`git mv` + 引用点更新 + `rootAllow` 加新名**并删旧名** + 旧名进 `legacyForbidden`
   + `layers.*.paths` 与 `scriptsOwnership` 同步 + `expectFiles` 基线按 §3.2 实拍件数填。
3. 同轮才允许改 `dependency-rule-test.js` 的判据字符串（§5.2 第 1 条），并补「扫描面归零即红」自证。

### 3.4 PC-0 交回拍板的三件事

1. **顶层要不要改名 `host/`+`runtime/`**：收益 = 与 ADR-0002 已否决的「容器根」词汇切割、与六域模型对齐；
   成本 = §5.1 列出的 4 份 workflow / 12 个 scripts 调用点 / 5 个门禁文件的同步改，以及 `runtime/` 这个
   词在壳侧已有 `runtime/` 包与 `runtime.json` 契约（PC-2 把壳侧那个包拆进 `machine/`+`supply/` 后冲突自消）。
   **推荐：做，且 PC-1 一次改完三条顶层名**（分两轮 = 打断 CI 两次）。
2. **`container/_artifacts/`（1 个 README）的去留**：推荐删并把其叙述并进 `docs/runbook/release.md`，
   同时从 `layers.L0.paths` 移除 —— 目标树里不留"没人认领的目录"。
3. **`SHIM_MARKER` 的旧名（含设备数据兼容判等）**：不进 PC 系列，另案；在案证据见 §3.1 第 6 行。

## 4. 组件改名的真机代价与解法

安卓按**组件名**记账：无障碍注册串 = `pkg/.lifecycle.DshAccessibilityService`
（2026-09-25 实证 `settings put` 可经 S0 通道静默写入且跨覆盖安装在册）。
⇒ 包制重排导致类 FQN 变化的代价**不是人工重授权**，而是升级首启机器域 reconcile 里加一步
「a11y 注册串指向当前 FQN 校正」（写进 C2 合同，5 行级，判据走既有 Evidence 通道）。
Device Owner 在本机已判死（ColorOS several-users），无该记账迁移问题。
manifest `android:name` 保持相对类名写法：改一处不扩散（「同一事实单源」门禁条文覆盖）。

## 5. CI paths 地雷审计（每次搬家的前置动作）

在册血案：单 bump `version.json` 不触发任何 job；`ci.yml` 的 paths 白名单只含
`container/**`、`kernel/**`、`docs/contracts/**`、`scripts/**`、`.github/native-assets.txt`、
`.github/workflows/**`（`docs/adr/**`、`ARCHITECTURE.md` 不在内）。
目录改名前逐条列 `grep -rn "container/\|kernel/\|engine/" .github/workflows/ scripts/` 的命中点，
产出旧 glob → 新 glob 对照表；搬家 PR 必须同时改 workflow，并**当场验证 job 真的跑了**
（判据：job 数齐备 + 关键 step 非 skipped）。这不是可选项，是合入判据。

### 5.1 CI paths 对照表（PC-0 交表：origin `3d5cd9e7` 全量命中点，逐条标「漏改会不会响」）

**行号已于 2026-09-27 对 origin main HEAD `1c32d8cf`（#94 之后）逐条复算**：HEAD 相对 `3d5cd9e7` 只动了
9 个 blob（4 份 workflow + `container/engine/package.json` + `docs/contracts/layout.json` 的
`scriptsOwnership` + `docs/runbook/release.md` + 新增 `scripts/gh-release-upload.sh` 与其测试），
本表受影响的只有两处行号（`fast-apk.yml` 的 `APK_SHA` 700→669、`build-apk.yml` 的 apk 路径 776→777，已按新值填），
其余全部原位。**这张表本身就是 §5 那句「搬家 PR 必须当场验证 job 真的跑了」的操作性前提**：
上一段（`3d5cd9e7`）到这一段（`1c32d8cf`）之间行号就会漂，所以每次开搬家 PR 前必须重跑
`grep -n` 而不是引用这张表里的数字。

| 引用点（file:line） | 现状值 | 搬家后 | 漏改的后果 |
|---|---|---|---|
| `settings.gradle.kts:23` | `project(":app").projectDir = file("container/app")` | `host/app` | **响**（gradle 配置期直接失败） |
| `ci.yml:12-13,20-21` | paths 白名单 `'container/**'`、`'kernel/**'`（push 与 PR 两份） | `'host/**'`、`'runtime/**'` | **静默**：改壳/内核不再触发 gates ⇒ 唯一编译器停机（同型在册血案见本节开头） |
| `ci.yml:39` | `working-directory: container/engine` | `host/hosttools` | 响（job 第一步就失败） |
| `ci.yml:126,136,158` | `working-directory: kernel/ui`、`path: kernel/ui/dist`、`require('./kernel/package.json')` | `runtime/…` | 响 |
| `ci.yml:210,226` | `RES=container/app/build/test-results/testDebugUnitTest`、artifact `path: container/app/build/reports/tests/` | `host/app/…` | 响（#66 补的「单测地板」从 XML 实名核对，取不到即红） |
| `fast-apk.yml:39,51` | paths `'container/app/**'`、`'container/native/**'` | `host/…` | **静默且致命**：改 Kotlin 不出包，`apk-latest` 停在旧字节；下一次真改动的发布步骤还会被 #82 同号禁发门禁判红 |
| `fast-apk.yml:247-267,331-344,377-390,520-521,581-606,669` | `container/app/src/main/jniLibs/${ABI}`、`container/native/{flock,posix,ptyprobe}/*`、`container/app/build/outputs/apk/debug` | `host/…` | 响（投放/审计/发布各步都会红） |
| `fast-apk.yml:536-538` | 断言 `KD=container/app/src/main/assets/kernel` 必须为空 | 路径前缀随 `container→host` 改，**`assets/kernel/` 这个 APK 内路径不许改**（②层） | 响（改成别的串 = 断言永真 = 静默失效） |
| `build-apk.yml:191,239-241,346,404-434,544,568-574,606,673-726,777` | 同型 `container/**` 字面量 + 阶段名串 `"2.5/9 container/engine-tests"` | `host/…`（阶段名同步） | 前一类响；阶段名**静默**（人读的进度锚点，不参与判据） |
| `kernel-ota.yml:92-98,117,244` | `require('./kernel/package.json')`×3、`ANCHOR=container/app/src/main/assets/ota-public.pem`、`require('./container/engine/src/kernel-version')` | `runtime/…`、`host/hosttools/…` | 响 |
| `scripts/gen-version.js:34-37,52-54,62,69-74` | 四个版本源（`container/engine/package.json`、`kernel/package.json`、`kernel/ui/package.json`、`container/app/src/main/assets/node-versions.json`）+ `container/engine/src/bridge/protocol.js` | 同上新路径 | 响（#83 的三态语义：取不到 = 「看不清」= 禁止发布，不降 warning） |
| `scripts/gen-native-assets.js:9,53` + `.github/native-assets.txt:4` | `NativeAssetRegistry.kt` 全路径（含 Java 包名段） | 随 PC-2 包重排改 | 响（清单会 `git diff --exit-code` 判「生成物≠源」）——**注意 PC-2 的包名改动会连带重写整份清单头注释** |
| `scripts/{build-node-android.sh:58,66,build-kernel-bundle.sh:33,keygen.sh:18,make-release.sh:22,read-node-versions.sh:8,stage-npm-assets.sh:22,verify-apk-native.sh:216,build-apk-local.sh:41}` | `container/app/src/main/{jniLibs,assets/…}`、`container/engine/bin/build-bundle.js`、`container/app/build/outputs/…` | `host/…` | 多数响；`build-node-android.sh:58` 的 `OUT_DIR` 属**半静默**（编好的件投到没人读的目录，要等下游门禁才红） |
| `docs/runbook/git.md:16,27,31,48,57,73-75` | 规范正文钉死 `container/{app,engine,native}`+`kernel/`、commit scope `app·engine·native·ci·docs`、tag `container-v*`/`kernel-v*`、paths 示例 | 同步改 | **静默**（文档即断言；PR #78 的教训：口径不跟着改，下一个人拿它当证据误判） |

### 5.2 五处「不跟着改就静默通过」的门禁（搬家轮必须先修判据）

1. **`container/engine/test/dependency-rule-test.js:25,30,39`（头号地雷）**：R1/R2/R3 各自 `walk()` 一个顶层目录，
   然后 `for (const f of 集合)` 判违规 —— 目录改名后集合长度 0，`problems` 为空 ⇒ **PASS 且零覆盖**。
   更狠的是判据字符串本身：`:33` `m[1].includes('container/')`、`:42` `m[1].includes('kernel/')` ——
   `container/` 一旦改名，内核引用壳源码的相对路径就写成 `../../host/…`，**R2 永不再命中**。
   ⇒ 搬家轮三件事一起做：三条 walk 各加「扫描面 `< N` 文件即 FAIL」自证 + 判据串换新名 + 活样本
   （构造一条真违规 require，证明它确实红）。
2. **正例照抄**：`capability-single-source-gate-test.js` 就自带防惰变 —— `:478-479` 边表文件读不到直接 FAIL、
   `:481-482` 边数 `<4` 与「全仓只扫到 <4 个通知 id 常量」两条扫描面自证，所以它的 `PKG` 常量（`:24`）一旦指错
   会**立刻红而不是静默**。PC-2 改包名时同轮更新 `:231` 的 `relPath: container/app/src/main/AndroidManifest.xml`。
3. **`native-assets-test.js:514`** 把 `fast-apk.yml` 里的一行命令**内嵌成活样本**（`APK="$(find container/app/build/… )"`）
   ⇒ 改 workflow 不改样本 = 对照组失真，门禁的「通过」失去意义（同文件另有 `:42,184,806,848,885,936,970,1077`
   八处直读仓内路径，逐条随搬家改）。
4. **`kernel/test/kernel-update-single-writer-test.js:45`** 直读 `src/supervisor.js` 源码文本 ⇒ D1 把它合并进
   `init/` 的当轮必须改这个路径；`kernel/test/` 里所有「读源码文本」型判据要在同一轮清点（手法先例：出生链的函数体切片）。
5. **`layout-manifest-test.js:56` 的 `legacyForbidden` 只 stat 目录/文件在否** ⇒ 两个旧名正活在
   `container/engine/package.json:2`（`container-engine`）与 `kernel/package.json:2`（`dsh-android-kernel`）
   的 `name` 字段、以及写进设备文件的 `SHIM_MARKER` 串里，**门禁完全看不见**（§3.1 硬判据 1）。

**执行口径**：每次搬家 PR 的前置动作 = 把 §5.1 逐行填成新值并附 `grep` 证据、§5.2 五条逐条给对照组；
两张表没填完不许开搬家的 PR。

## 6. 「彻底」的定义（完成判据，缺一不叫做完）

1. 旧目录/旧包/旧词汇全仓 grep 零命中（门禁死词汇表在册 + 活样本自证）。
2. 每个状态文件单一写者；跨域读取只经合同常量（`NODE_PID_FILE`/`NODE_BIRTH_FILE` 手法推广到全部，
   门禁扫裸路径字面量）。
3. 六域各有 ADR 段落（起点 ADR-0008），`ARCHITECTURE.md` §1.1 旧五层表退役为新树的一节。
4. 在途方案文档全仓至多一份（本文件）。
5. 真机判据：搬家完成的那版 APK，退后台 30min × 3 次，每次恢复 ≤2 拍且 a11y/通道零人工重授。

## 7. P0 验收判据（本 PR 收口用）

1. JVM 单测：三态判据双向对照（空壳必升级、已出生绝不折腾、三条升级路径共吃冷却、阈值自洽）。
2. 门禁：`capability-single-source-gate` 出生链 6 处按函数体/签名段取证在位；反向自证负样本判不合格。
3. 真机：面板/通知在 `:node` 空壳时显示「运行时未出生」而不是「运行时在线」。
4. 真机：退后台被 cached-kill 后，**不点图标**、仅靠监督者 rebind 即恢复控制面（`/proc/net/tcp`
   端口 3080/36360 复听）；恢复耗时 ≤2 个监督拍。
5. 边界不变：强停（`am force-stop`）后保持沉默，只由 `ResidencyAudit` 定罪可见。

**收口状态（2026-09-27 凌晨，真机 PLP120 / 无线 adb `192.168.3.74:43519`）**：

- 判据 1、2 的代码随 `07faed6` 进 main；CI 侧实读 run #214（head `9d530d3`）四个 job：
  `container` / `kernel` / `app-tests` 全 success，`kernel-release` skipped（paths 无关，
  skipped ≠ 红）。门禁输出 `PASS 出生链：6 处按函数体/签名段取证全在位…负样本判为不合格`。**通过**。
- 装机实读：`dumpsys package` = versionName 1.1.6 / versionCode 8；干净态
  `:node=11159` 且 `node.birth` == `node.pid` == 11159，端口 3080/36360 在 LISTEN ⇒ 出生链在真机成立。
- **判据 4 通过**：退后台后用 `run-as <pkg> kill -9 <pid>` 以 app uid 精确杀 :node 22944
  （**`am kill` 杀不掉 bound service，拿它注入等于没注入** —— 本轮第一次实测 55s 零变化即此因）；
  不点图标：t+4s 新 :node 25205 在册、`node.birth` 重写、t+11s 两端口复听。
  贴着「≤2 拍」边界，采样粒度 3s，因此这条读数是**下界不是精确耗时**。
- **判据 5 通过**：`am force-stop` 后 96s 内零进程、零 LISTEN 端口（沉默，无任何进程外复活边）；
  重开应用后定罪段如实显示「上次存活到 01:16:44，中断 3 分 28 秒」。
- **判据 3 失败（→ D9）**：注入 `rm -f node.birth; mkdir node.birth` 并每拍杀 libnode，
  造出 `POWER ∧ ¬BORN ∧ ¬ONLINE`（先 `rm -f` 是必须的：`mkdir` 撞已存在的文件会失败 = 注入根本没生效，
  本轮第一次实测就因此看到假的「运行时未响应」）；t+4s…t+40s 每 3s 抓一次通知（13 个采样点），
  **通知从未出现「运行时未出生」**，正文只有裸的定罪段；清理注入后自愈成
  `:node=16486 birth=16486 pidrec=16486 端口=2 · 运行时在线 · 通道通 · :node 已绑定`，
  ⇒ 通知链路本身是活的，不是没刷新；logcat 无「监督拍异常」⇒ tick 没抛异常。
  **决定性一步（把「只是没刷新」这个解释排除掉）**：`statusLine()` 的 runtime 段是 `when` 全分支，
  任何时刻必然产出「运行时在线 / 运行时未出生 / 运行时未响应」三词之一，且句尾必然带
  ` · 通道… · :node …`（`:243`）；注入期采样里**这两样一个都没有** ⇒ 屏幕上那句根本不是
  `statusLine()` 的形态 ⇒ 另有写者。机制见 D9。
  **同型复现（01:38，脚本 `/tmp/t11.sh`、日志 `/tmp/t11.log`）**：`:node=1816` 全程稳定（POWER）、
  `birth=[]`（¬BORN），t+6/12/18/24s 四个采样点正文均为裸定罪段，清理后立刻回到
  `:node=2911 birth=2911 · 运行时在线 · 通道通 · :node 已绑定` ⇒ 非偶发，是稳定判据失败。
  **⇒ P0 已收口（判据 3 于壳 1.1.7(9) 复点通过）**：断服根因已被 `node.birth` 单源治好（判据 4 成立），
  「空壳必须上屏」这条产品判据在 1.1.6(8) 上未成立；补修（D9 正文单写者 + D10 转发线程不致命）
  已随 PR #92 合入 main=`7afa06d5`，**壳 1.1.7(9) 已上线**：
  `apk-latest/version.json` 带 `?t=` 读回 = 1.1.7 / versionCode 9，
  `apk-latest/app-debug.apk` 与 `v1.1.7/app-debug-1.1.7+9.apk` 同 53,406,864B /
  `sha256:d60a290accb7dd815…`。CI 实证：`container 430 PASS / 0 FAIL`（出生链 6 处、常驻链 8 边、
  通知 id 6 个全仓唯一）、`app-tests BUILD SUCCESSFUL + 单测执行数 143`、`kernel` success、
  `kernel-release` skipped。

- **判据 3 复点通过（02:05，壳 1.1.7(9)，同型注入）**：干净态出口
  「… · 运行时在线 · 通道通 · :node 已绑定」；注入 `rm -f node.birth; mkdir node.birth` + 每拍杀内核后，
  t+24s 通知正文变成 **「常驻被打断：… · 运行时未出生 · 通道通 · :node 已绑定」**，
  撤掉注入立刻回到「运行时在线」⇒ D9 修复真机证实（1.1.6(8) 上 13+4 个采样点一次都没出现过这句话）。
  t+6/12/18s 仍显示「运行时在线」不是漏判：那三拍 `端口=1`（控制面真可达），ONLINE 优先是判据本意。
- **D10 复点：只到「不复现」，没到「已被捕获」**：同一台机连做 12 次拆内核 + 3 次换 :node，
  crash buffer 的 FATAL 计数恒为 14（修前那 5 次全在里面）、`:node` 全程存活；
  但新 catch 写的诊断行 `转发线程结束` 在 `files/diagnostics.txt` 里**计数为 0** ⇒ 本轮没有触发到
  `close()` 抢 FD 那个窗口，无法断言「是 catch 救了进程」。**判据留在册**：下次真复现时看该计数是否 >0。
  **作废一条我差点写进去的假正向证据**：收尾那轮我曾读到 `catch=2`，据此几乎要把结论升级成「已被捕获」。
  复核实读：那两条匹配是 logcat 里 `adbd` 打印的**我自己那条 shell 命令行**（命令行含
  `grep '转发线程结束'`，被 adbd 原样回显成日志行），不是产品日志。同型探针再跑即全中：
  `logcat -d | grep 'id=1004'` 的 3 条命中也全是我的 `dumpsys`/`grep` 命令回显。
  ⇒ 口径改两条：**计数型 grep 一律先 `grep -v adbd`**；**「已捕获」只认 `files/diagnostics.txt`
  这个落盘产物，不认 logcat**。清理注入后重读该文件：`转发线程结束` 仍 0 条（`run-as … grep -c` 实读），
  结论维持「不复现 ≠ 已验证」。
  **测量坑记一笔**：只要每拍杀内核，`:node` 的 boot 重试就会反复重写 `node.pid`，
  `pidRecordAgeMs` 永远回不到 30s 阈值 ⇒ **空壳清账（EscalateStop）在这种注入下不会发生**；
  要验清账路径得让 :node 自己静下来（别再杀内核）而不是杀得更勤。
  **这条坑被正面证实了一次**：02:13 撤注入（`rmdir files/node.birth` → `rmdir-ok`）后，
  `:node` 自家 boot 重试在 02:14:15 同时重写 `node.pid`（`205956392` → `206016548`）与 `node.birth`
  （实读 `birth=23118` == 当时的 `:node` pid），而 pid 全程是同一个 23118、`diagnostics.txt` 里
  没有任何清账记录 ⇒ **自愈走的是「被监督者自己出生」这条边，监督者的清账路径本轮仍未被真机走过**
  （判据上它是安全的：空壳清账只在 ¬BORN ∧ pidAge≥30s 才发，而 :node 每拍重试都会把计时器归零）。
  **注入回收口径（同一类假阳性）**：`mkdir node.birth` 造出来的空壳，撤的时候 `rm -f` 撤不掉
  （`rm: files/node.birth: Is a directory`），残留目录会让**下一轮**注入的第一句 `rm -f` 直接失败、
  整轮空壳态是继承来的而不是新造的（本轮 02:1x 那批就是这样）。⇒ 撤注入一律 `rmdir`，
  开跑前 `ls -l files/node.birth` 确认它是 `-rw-------` 普通文件，否则这一轮读数全部作废。
  **取证通道边界（下次别再当成缺陷）**：本机通知正文只能靠 logcat 的 `NotificationRecord … id=1004`
  那一条，且**必须发布后立刻抓**——这台机 logcat 滚得极快，收尾窗口整块 buffer 里 `id=1004` 命中 0 条；
  `dumpsys notification --noredact` 在 ColorOS 上只印 channel/flags/intent，**不印正文**，
  `uiautomator dump` 也取不到（首页此时无该文本）。⇒ 判据 3 的正向读数只在那次 40s 窗口里成立过，
  现在要复核必须重跑注入。

## 8. `capability` ⇄ `permissions` 裁决阅读（PC-0 第四件）

**取证口径**：对 origin main 快照 `3d5cd9e7` 的 60 个 `.kt` 全量抓取后逐文件通读，每条断言都配
「定义处 + 全仓消费者 grep 计数」；计数为 0 的字段一律按**死字段**定罪，不按「以后会用到」保留。
**HEAD 复核（2026-09-27，`1c32d8cf`）**：#94 只动 workflow / `scripts/gh-release-upload.sh`（新增）/
`layout.json` 的 `scriptsOwnership` / `engine/package.json` 的 test 清单，**本节引用的 8 个 `.kt`
与 `capability-single-source-gate-test.js` 三个 blob 均未变** ⇒ 行号原位（`container-engine` 这个
legacyForbidden 旧名也仍在 `container/engine/package.json:2`）。
本节编号 ①–⑤ 与 §2 D3 的 ①–⑤ 一一对应，D3 是罪名清单，本节是**裁决**（怎么收、搬家轮能做什么、判据）。

**总裁决：不合并两个包，也不新建第三份表 —— 查询裁决已经是单源，债全部在「声明层字段」。**
所以 PC-2 只需把两包按 §3.2 收进 `privilege/`，而把 ①–⑤ 的收口列为 PC-2 之后的独立一轮（下称 **PC-2b**），
理由是硬规矩 1「只搬不改语义」：①②⑤ 三条都要动字段/枚举，混进搬家轮会让 `git diff --stat`
不再是纯 rename，搬家判据当场失效。

### 8.1 已经立住的单源（PC-2 不许回退的现状）

| 事实 | 唯一源（定义处） | 消费者（全仓 grep 实拍） |
|---|---|---|
| 权限 id 常量 | `permissions/PermissionCatalog.kt:29-36`（8 个 id） | `capability/` 侧全部走 `PermissionCatalog.X` 符号；门禁已有 ghost perm 判红（`capability-single-source-gate-test.js:313` 解析 `perm(PermissionCatalog.X`、`:356` 无定义即 FAIL）⇒ ①–⑤ 的门禁提案**不许与这两条重复** |
| Secure 键名 | `PermissionCatalog.kt:42-43` | 读侧 `PermissionCenter.kt:58,65`、写侧 `CapabilityAcquisitionRunner`；门禁 `:54` 那条「键名串只声明一次」在册 |
| 状态查询 | `PermissionCenter.isGranted()`（`permissions/PermissionCenter.kt:20-51`，按 `spec.id` 分发） | `capability/CapabilityEvidenceCollector.kt:29,72` 用 `PermissionCatalog.ALL.filter { center.isGranted(it) }` 产出 `grants`；`capability/Evidence.kt:73` 的 `granted(id)` 只读这个集合 ⇒ **判据链上没有任何一处自己查系统** |
| 原始系统 API | 只在 `PermissionCenter` 内 | `canDrawOverlays` / `isExternalStorageManager` / `isIgnoringBatteryOptimizations` / `canRequestPackageInstalls` / `checkSelfPermission` 在 `permissions/` 之外**零命中**（唯一相邻命中 `CapabilityAcquisitionRunner.kt:130` 仍走 `center.notificationListenerEnabled()`）⇒ 该文件顶部 `:15` 那句「唯一查询入口」在代码里成立，④ 是它唯一的自己开的漏口 |
| 授权页落点 | `PermissionSpec.settingsAction`（`PermissionCatalog.kt:49,54,63,68,75`） | `capability/CapabilityNavigation.kt:27` `byId(acq.target)?.settingsAction` ⇒ UI 不自己拼 Intent |
| 首启冲刺清单 | **没有手写清单**（从两张表推导） | `capability/PermissionSprint.kt:19-21` 由 `requiresInOrder(ADB_CREDENTIALS)` + `byId() != null` 推导、`:34-35` 由 `keepAliveAnchor` 推导、`:38-41` 取余集 ⇒ **这就是 §6 判据 2 要推广到 ①–⑤ 的样板** |

### 8.2 五条残留债逐条裁决

**① 两套分层枚举（`PermTier` 7 值 `PermissionCatalog.kt:11` ⇄ `PermTierClass` 4 值 `CapabilityCatalog.kt:42`）**

- 先自纠一句：这两条轴**本来就不是同一件事**，`CapabilityCatalog.kt:41` 的注释已经把区别写死
  （Manifest 声明档 vs「哪一档由谁给」）。所以罪不在「有两个枚举」，在**它们被一条代码路径串成因果、
  却没有任何地方校验对得上**。
- 串接点实拍：RUNTIME 弹窗这条取法要两侧同时说 RUNTIME 才成立 ——
  `CapabilityCatalog.kt:228` 由 `PermTierClass.RUNTIME` 产出 `Acquisition(RUNTIME_DIALOG, target=id)`，
  `CapabilityNavigation.kt:35` 再要求 `spec.tier == PermTier.RUNTIME` 才返回 Manifest 名。
  任一侧改档而另一侧没改 ⇒ `runtimePermission()` 静默返回 null ⇒ **点「授权」毫无反应，不报错不变红**。
  今天两侧一致（`POST_NOTIFICATIONS`：`CapabilityCatalog.kt:78` RUNTIME / `PermissionCatalog.kt:57` RUNTIME）
  纯靠人肉记住。
- 已存在的分叉（不是假想）：无障碍 `SERVICE_TOGGLE`(:74) vs `SECURE_SETTINGS`(:157)、
  通知读取 `SETTINGS`(:53) vs `SECURE_SETTINGS`(:152)、屏幕捕获 `SETTINGS`(:79) vs `IN_APP`(:163)。
  这三条今天**不致命**（它们都不走 RUNTIME_DIALOG 分支），但正因为不致命，没人会去修 ——
  门禁是唯一能让它显形的办法。
- 裁决（两案，PC-2b 选一案）：
  - **A（并轴，改语义）**：删 `PermTierClass`，把「由谁给」降级成 `perm()` 的两个显式参数
    （`silentVia=`、`tapTarget=`），RUNTIME 档由 `spec.tier == RUNTIME && spec.permission != null` 推。
    终态 = 一个 id 只有一个档位来源。代价：`permAcquirers()`(:226-255) 整段重写。
  - **B（只加校验，语义零改动）**：在门禁里对每条 `perm(PermissionCatalog.X, …, PermTierClass.Y)`
    要求 `byId(X).tier` 与 `Y` 落在一张**显式映射表**内（APPOP↔APPOP、RUNTIME↔RUNTIME、
    SECURE_SETTINGS↔SETTINGS|SERVICE_TOGGLE、IN_APP↔SETTINGS），对不上即 FAIL。
  - **推荐 B 起步**：它符合 §3 硬规矩 1，且把 A 需要的决策拆成「映射表对不对」这一眼能看的事。
    A 留作 PC-2b 的正式一轮，判据用 §8.4 的活样本自证。
- 判据（B）：活样本自证 = 造一个 `PermTierClass.RUNTIME` + `PermTier.APPOP` 的负样本必须 FAIL、
  现役 8 条必须全 PASS；映射表本身住 `docs/contracts/`，不许住在门禁脚本里（否则又是第二把尺子）。

**② 显示名两份，而且权限表那一份根本没人读**

- 决定性事实：`PermissionSpec.label`（`PermissionCatalog.kt:19`）**零消费者** ——
  全仓 `.label` 命中全是 `Acquisition.label` / `ProbeResult.label` / `KernelInstaller.Source.label`，
  没有一处读 spec 的 label；`PermissionSpec` 这个类型本身只被 `PermissionCenter.kt:20` 和目录自己引用。
  屏幕上的名字唯一走 `CapabilityCatalog.titleOf()`（`:309`）← `perm(title=…)`。
- 于是「label 双写」的真实形态是：**一份活的 + 一份死的副本，而死副本已经开始漂移** ——
  `NOTIFICATION_ACCESS` 权限表「通知访问」(:53) vs 现役 UI「通知读取」(`CapabilityCatalog.kt:152`)；
  `MANAGE_EXTERNAL_STORAGE` 权限表直接写裸常量名「MANAGE_EXTERNAL_STORAGE」(:48) vs UI「全部文件访问」(:141)。
  第三份写法在 `LifecycleChecks.kt:24`「电池优化」（那里是**活的**，进 `ProbeResult.hint`）。
- 裁决：**显示名唯一源 = `Capability.title`**，删 `PermissionSpec.label` 字段。
  理由（反向方案「让 `perm()` 的 title 由 `byId(id).label` 派生」我没选）：`PermissionCatalog` 是
  系统事实登记表（id / Manifest 名 / settingsAction / 档位），把 UI 文案塞进去会让「adb 侧看到的名字」
  与「屏幕上看到的名字」再次混住，而这两者本就该分属 `privilege/` 与 `onboarding/` 两域。
- 附带裁决：`LifecycleChecks` 的 `title`（"电池优化"/"Phantom process killer"/"前台服务保活前提"）
  属**风险读数**文案，不与权限同名冲突，可保留；但 `:24` 那个 id 必须换成常量（见 ④）。
- 判据：门禁扫 `PermissionSpec(` 实参中的第二个字符串字面量（label 位）即 FAIL；
  交叉校验「同一 id 在两张表里出现的显示名必须唯一」，并把现役 8 条 id 的显示名清单作为基线打印
  （数数自证：命中数 ≠ 8 说明写法漂移）。

**③ `Line.id` 是看着像主键、其实零消费者的字段**

- 实拍：`permissions/LifecycleChecks.kt:15` 声明 `Line(id, ok, title, detail)`；唯一消费者
  `ProvisioningProbe.kt:79-89` 只读 `ok`（计数）与 `title + detail`（拼 hint），**从不读 `.id`**；
  快照侧 `writeSnapshot`（`:94` 起）写的是 capability id（`:98` 注释自证 schema 2 换过来源）。
- 三个取值里 `phantom-process-killer`(:32) 与 `fgs-keepalive`(:45) **不在** `PermissionCatalog` 里 ——
  这不是漏登记：它们表达的是「系统级风险读数」，本来就不是可申请的权限。真正的罪是
  **同一条 when 里第三个取值 `"battery-optimization"`(:24) 与权限表的 id 撞名而 label 不同**，
  于是同一个 id 在两个命名空间里各指一份文案。
- 裁决：`Line.id` 二选一并写进 ADR-0008 §3 ——
  (a) 删字段（三条线改用顺序稳定的 `title` 作展示键，快照不变）；
  (b) 让它**真的当主键**：`ProvisioningProbe` 的 lifecycle 子结果按 id 写进快照，
  且 `id` 只能引用 `PermissionCatalog` 常量或新建的 `LifecycleRiskIds` 常量表（不许裸串）。
- **推荐 (b) 但排在 ④ 之后**：(a) 会让 shell/内核侧未来读快照时无从归因；(b) 是 §6 判据 2 的正例形态。
- 判据：门禁扫 `permissions/`、`capability/` 内的裸权限串字面量（`"battery-optimization"` 这类
  与 `PermissionCatalog` 常量值重合的串）命中即 FAIL；活样本 = 现有 `LifecycleChecks.kt:24` 必须命中一次
  （改完的当轮把这条活样本换成新增的反例，防门禁空转）。

**④ `batteryExempt()` public = 单源入口自己开的漏口**

- 实拍：`LifecycleChecks.kt:22` 直调 `center.batteryExempt()`；同一事实的正路是
  `isGranted(BATTERY_OPTIMIZATION 的 spec)`，而 `PermissionCenter.kt:40` 显示 `isGranted` 内部**就是**
  转调 `batteryExempt()` ⇒ **答案不会分歧**，这条罪不在结果，在**入口唯一性**：
  只要它 public，将来任何一处想「顺手问一下电池」都不需要过 `isGranted`，第 8.1 表里那句
  「原始系统 API 只在 PermissionCenter 内」会先烂掉。同文件 `:42-43` 是**正例**
  （`byId()` 取 spec → `center.isGranted(notif)`），说明作者本来就走对路，:22 属漏改。
- 裁决：`batteryExempt()` 收为 `private`（`accessibilityEnabledInSettings()`/`accessibilityServicesValue()`/
  `notificationListenersValue()` 保持 public，它们是「取值给写侧合并用」不是判据），
  `LifecycleChecks.kt:22` 改走 `isGranted(byId(BATTERY_OPTIMIZATION)!!)` + 常量 id。
  这两处一共 4 行，属**搬家轮可以顺手带上**的例外吗？—— 不许。判据是 `git diff --stat` 纯 rename，
  所以它进 PC-2b，与 ②③ 同轮。
- 判据：门禁扫 `PermissionCenter` 之外对 `batteryExempt(` 的调用，命中即 FAIL；
  并在 `PermissionCenter` 上立「public 判据方法只许 `isGranted` + 三个 Secure 取值器」的白名单计数。

**⑤ `PermissionSpec.note` 死字段：靠注释被别的包抄写**

- 实拍：`note` 声明 `PermissionCatalog.kt:24`（注释自称「会被拼进诊断行」），赋值 7 处
  （`:50,59,64,69,76,80,89`）；全仓 `.note` 唯一命中是 `native/NativePreparer.kt:106` 的 `exe.note`
  （另一个对象）⇒ **零消费者 = 空头承诺**。屏幕上「未授权（…）」来自 `perm()` 自己的 `note` 参数
  （`CapabilityCatalog.kt:208` → `:219`）。
- 最扎眼的案底：`CapabilityCatalog.kt:85` 的注释把 `PermissionCatalog` 那条 note 的原文
  （「notif.post 会被系统静默丢弃」`:59`）**逐字抄过去当证据** —— 一个没人读的字段
  靠注释在另一个包里续命。这正是 §6 判据 2 要消灭的形态（同一事实两份，且靠人记同步）。
- 裁决：删 `PermissionSpec.note`，7 处内容各归其位 ——
  「DO 能否静默」→ ① 的 `silentVia=`（或 B 案的映射表）；「系统行为后果」→ `perm(note=)`（活的那一份）；
  「物理不可预置」这类平台结论 → ADR-0008 §3 的权限段落（它是决策不是文案）。
  `PermissionSpec.tier` 只有 1 个消费者（`CapabilityNavigation.kt:35`），但那是 ① 的串接点，**不许删**。
- 判据：门禁扫 `PermissionSpec(` 实参里的 `note =`，新增即 FAIL；现存 7 处作为待迁基线列出（迁完归零）。

### 8.3 裁决后的目标形态（`privilege/` 域，PC-2 落点 + PC-2b 收口后）

```
privilege/
├─ PermissionCatalog.kt    # 只登记系统事实：id 常量 / Manifest 名 / settingsAction / PermTier / Secure 键名
├─ PermissionCenter.kt     # 唯一查询入口（public 判据方法 = isGranted + 三个 Secure 取值器）
├─ LifecycleChecks.kt      # 风险读数（不再是权限，id 引用常量表）
└─ acquisition/            # 原 capability/ 的取法链与判据：CapabilityCatalog + Evidence + Runner + Sprint
```

`Capability.title` = 显示名唯一源；`PermTier` = 档位唯一源；`Acquisition` = 取法唯一表达。
一句话版本：**权限表说「这是什么、能不能拿」，capability 表说「怎么拿到、屏幕上叫什么」**，
两侧不许再互抄字符串 —— 这就是 ①–⑤ 收完之后的不变式，也是 PC-2b 的完成判据。

### 8.4 交回拍板（在 §3.4 三件之外新增两件）

4. **PC-2b 要不要独立成轨**：①–⑤ 的字段级收口（A 案并轴 / 删两个死字段 / id 常量化）
   与搬家轮的「纯 rename」判据互斥。建议新增一行 **PC-2b：privilege 声明层收口（4 条门禁 + 3 处删字段，
   1d + 1 壳，无真机判据）**，排在 PC-2 之后、PC-3 之前。
5. **① 选 A 还是 B**：B（加校验、语义零改动）可今天就写进门禁；A（并轴）动 `permAcquirers()` 整段。
   我建议 B 先行、A 作为 PC-2b 的正式一轮。

**未验证项（诚实申报，不作为裁决依据）**：本轮没有跑 JVM 单测（CI 是唯一编译器，本地 `require-ci.js` 退出码 86），
所以 ①–⑤ 全部是**静态消费者计数 + 行号实拍**，没有一条来自运行时读数；
`PermissionSprint.REQUIRED` 在 ①的 A 案下的实际取法链变化未经真机验证。
另：门禁现状只读到 `capability-single-source-gate-test.js` 的源码（682 行，`:298-341` 的 anchor-span 切段手法、
`:344-356` 的自证与 ghost perm 判红），未在本轮执行过它 —— PC-2b 落地时必须先跑出「现役 8 条全 PASS」的基线读数。
