# Agent OS 执行案（唯一在途方案）

状态：**执行中**。决策依据 = ADR-0008（域模型与 init 权威）+ ADR-0006（常驻边界）。
全仓在途方案文档**只许这一份**（放在 `docs/plans/`）；要开新轨先把它收口或并入。

## 1. 轨道总览

| 轨 | 内容 | 状态 | 量 |
|---|---|---|---|
| **P0** | C1 出生收口：`onCreate` 自出生 + 三态判据 + 空壳上屏 + 门禁出生链 | 已合入 main（`07faed6`，壳 1.1.6(8)），CI 绿；真机判据 **4、5 已过**（01:2x 实跑，见 §7 收口状态），**判据 3 真机判失败 = D9** ⇒ P0 未收口 | 0.5d + 1 壳 + 1 机 + 判据 3 补修 1 壳 |
| **PC-0** | 命名表 / 目标树终稿 / CI paths 对照表 / `capability`⇄`permissions` 裁决阅读 | 待做 | 0.5–1d |
| **PC-1** | D1+D2 搬家：`guard`⇄`supervisor` 双词汇合并 + `container/engine`→`hosttools` | 待做 | 2 壳 |
| **PC-2** | Kotlin 六域包制重排（含组件名迁移 + a11y 注册串自校正） | 待做 | 2–3 壳 + 1 机 |
| **PC-3** | `NodeRuntimeService` 860 行上帝文件拆分（machine / supply 分离） | 待做 | 1d + 1 壳 |
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
| D3 | **Kotlin 顶层散文件 + 特权双包并存（原判「capability⇄permissions 双权威」已被代码证伪）**：`MainActivity`/`NodeContainerApp`/`ProvisioningProbe`/`RuntimeDiagnostics` 裸在包根；`capability/` 与 `permissions/` 并存，但查询裁决**已是单源** —— `PermissionCenter.isGranted()` 唯一入口（`PermissionCenter.kt:40` 按 id 分发、`:72` `batteryExempt()`），`LifecycleChecks.kt:22` 也走它而不是自己判。残留罪 = **字面量外溢**：权限 id 在 `LifecycleChecks.kt:24` 裸写 `"battery-optimization"`（单源常量在 `PermissionCatalog.kt:34`），同一事实的显示名有三份写法（`PermissionCatalog.kt:87` 与 `CapabilityCatalog.kt:148` 各写「电池优化豁免」，`LifecycleChecks.kt:24` 写「电池优化」） | 2026-09-27 逐文件通读 + origin main 行号复核（上一轮「双权威」属印象定罪，本轮自纠并按 D3 现述为准） | PC-2：六域包制收编散文件；把 §6 判据 2 的「跨域读取只经合同常量」从**文件路径**扩到**权限 id / 显示名**（门禁扫 Kotlin 裸字面量，活样本自证） |
| D4 | **`NodeRuntimeService.kt` 860 行上帝文件**：预置体检/写探针/OTA/暂存清扫/装配/spawn/轮询/退避/诊断转发混住 | 本轮通读全文 | PC-3：按 ADR-0008 §2 拆 machine / supply / kernelota |
| D5 | **死残待判**：`kernel/src/platform/os/browser.js` 等桌面域文件仍被 `platform/os/index.js`、`guard/supervisor/settings-view.js` require | grep 引用实拍 | PC-4：**删前逐项引用计数 + 真机域运行证明**；若该代码路径在 Android 运行期会被触达，先解耦再删（不许砍能力迁就缺陷） |
| D6 | **根目录半拉子文档**：仓根平铺方案 md，且被 `layout-manifest-test` 的 rootAllow 判红；`system/README.md` 指向不存在的 `docs/ADR-001`（实际在 `docs/adr/0001-*`） | 本轮 `node test/layout-manifest-test.js` 实跑 FAIL + head 实拍 | 本 PR：方案文档一律进 `docs/plans/`，决策进 `docs/adr/`；stale 引用修复入门禁 |
| D7 | **`system/` 目录本体无罪**：Tier S（特权系统服务形态）集成契约，与 Tier A 垫片路径并存的刻意设计 | `system/README.md` | 保留，只修引用 |
| D8 | **交付通道无单一写者**（2026-09-26 夜间事故，2026-09-27 复核）：`fast-apk` 从**任意 ref** 都能写共享发布通道，未合入 main 的分支字节被原地投成用户手里的下载地址 | 实证：16:12–16:13 分支 commit `090abbd`（领先 main 18 个 commit）经 run #185 同时覆盖 `apk-latest` 与 `v1.1.6`，`ci-ok.txt` 落 `sha : 090abbd`；成因三处逐行复核 —— `fast-apk.yml` 全文无 `github.ref_name` 校验（发布步骤 `:730`、`TAG="apk-latest"` `:736`、版本化归档 `VTAG="v$VN"` `:796`），版本门禁放行同号换字节（`verify-apk-version-gate.sh:77`），两条合起来 = 任何分支都能顶掉线上 | 归 **P2b**（另一工作区正收敛门禁/`fast-apk.yml`/`scripts`，本轮不碰）：发布步骤加「`GITHUB_SHA` 必须是 main head」硬失败 + 门禁活样本；合同条文已进 ADR-0008 §4 C4。本轮治标**已完成并复核**：fast-apk run #188（`main` / `9d530d3`，21 步全绿，含 step 17 签名门与 step 20 发布）后，Releases API 实读 `apk-latest/app-debug.apk` 与 `v1.1.6/app-debug-1.1.6+8.apk` digest 相同 = `sha256:8466cdaa67b6a4b03…`（53406521 字节），`ci-ok.txt` 现记 `sha : 9d530d3` + 同值 `apk_sha`（污染版是 `25c117d…` / 53406529 字节 / `090abbd`）；**同一破口 8 分钟后再次点火**：16:30:59 分支 `ws-p2b-audit`（`a6c9fafb`）dispatch fast-apk run #189，只因它自己红在 step 18「Audit APK contents」（发布步 `:730` 没有 `if:`，前一步红则后续整步不跑）才没顶掉通道 —— 挡住事故的是别人的门禁判红，不是这条链有设计 |
| D9 | **常驻通知（NOTIF_ID 1004）有两个内容写者**（2026-09-27 真机判据 3 定罪）：`promoteToForeground()` 每次 `onStartCommand` 都用 `ResidencyAudit.interruption() ?: "状态采集中…"` 覆盖正文（`ContainerSupervisor.kt:100` 投递 → `:118-124`，覆盖语句在 `:121`），而三态结论只由 `refreshStatusNotice()`/`statusLine()`（`:209-243`，`NOTIFY_MS = 20_000L` 在 `:313`）发布 ⇒ **拉起风暴里后者的节拍永远赢不过前者**。为什么必然成风暴：`ensureRunning` 是普通 `startService`（`:321-327`），而它的调用点包含「`:node` 每次 boot 尝试」（注释 `:316-320` 自证）⇒ :node 越是不出生就越频繁地戳，戳一次盖一次，屏幕上恒定只剩定罪段。罪不在 throttle，在**同一 id 两套正文** | 真机注入 `POWER ∧ ¬BORN ∧ ¬ONLINE` 后 40s 内通知从未印「运行时未出生」，且定罪段时长数字 40s 冻结；logcat 无「监督拍异常」⇒ 非抛异常（判据 3 实跑记录见 §7 收口状态） | 补修（壳 1.1.7(9)）：1004 的正文**单写者** = `statusLine()`，`promoteToForeground()` 只负责转前台不再另写文案；首拍读数未采集时 `statusLine()` 自己如实说「状态采集中…」。判据仍走 §7-3，另加一条 JVM 单测：连续 `onStartCommand` 后正文必须含三态结论 |
| D10 | **内核 stdout/stderr 转发线程未捕获 `InterruptedIOException`**：`forward()` 在裸 `Thread { }` 里 `bufferedReader().use { r -> r.forEachLine { … } }`（`NodeRuntimeService.kt:627-632`），任一异常沿默认 `UncaughtExceptionHandler` 上抛 ⇒ 拆内核管道（`close()`）与读线程抢 FD，抛 `read interrupted by close() on another thread`，**整个 `:node` 进程 FATAL** | 真机 crash buffer 实证：`FATAL EXCEPTION: Thread-2/Thread-3 · Process: …:node · java.io.InterruptedIOException: read interrupted by close() on another thread`，栈尾实名 `kotlin.io.TextStreamsKt.forEachLine(ReadWrite.kt:163)` → `NodeRuntimeService.forward$lambda$11(NodeRuntimeService.kt:632)`；01:07:46 / 01:11:13（两条）/ 01:12:13（两条）共 5 次、三个不同 pid（22169 / 26037 / 27052），stdout 与 stderr 两条转发线程都会炸 ⇒ **不是我这轮手动杀进程才有的罕见竞态，内核每次被拆管都炸一次整进程** | 独立小修（可与 D9 同 PR）：两处都要，缺一仍是撞运气 ——① 拆管顺序：先让读线程退出再 `close()`；② 语义更正：`InterruptedIOException("read interrupted by close()…")` 是 libcore 对「另一线程关掉了 FD」的**正常**信号，按 EOF 处理并静默收尾，不当故障上抛。判据 = 反复拆/起内核后 crash buffer 零新增、`:node` 不 FATAL，只按 `SupervisorPolicy` 退避重启内核 |

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
  本轮第一次实测就因此看到假的「运行时未响应」）；t+4s…t+40s 每 3s 抓一次通知，
  **通知从未出现「运行时未出生」**，且定罪段里的「中断 3 分 28 秒」40s 不动；
  logcat 无「监督拍异常」⇒ tick 没抛异常，是**内容被另一个写者盖掉**。
  机制见 D9。**⇒ P0 不算交付完成**：断服根因已被 `node.birth` 单源治好（判据 4 成立），
  但「空壳必须上屏」这条产品判据未成立，需一笔补修（壳 1.1.7(9)）+ 重发布 + 复点。
