# 容器底座规范（BASE_SPEC）

> ⚠ **v4 收敛提示（2026-09-28）**：本文件的 §2/§4 仍描述 v4 之前的三层（容器/内核/Agent）与 `program-manifest.json` 包契约。
> v4 实体为 **OS / Runtime / Program**，Program 契约见 [program-manifest.schema.json](program-manifest.schema.json)，
> 形态主轴见 [ADR-0010](../adr/0010-lob-os-container-form.md)、OTA 见 [ADR-0005](../adr/0005-program-via-ota-only.md)；
> 单一生命周期（无 `:node`/无 binder 监督）见 [ADR-0006](../adr/0006-background-lifecycle-keepalive.md)。§3/§8 的运行时与桥契约继续有效。

> 架构与硬约束的**唯一事实来源**是仓根 [`architecture.md`](../architecture.md)；
> 本文件只定义「冻结容器 ↔ 可热更新内核」之间的**契约**。
>
> 状态：v0.3（2026-09 P3 收口：移除内置构建链，`build` 组语义 = 安装已签名内核；前版 v0.2 修正内核模型：内核=控制面板/Manager，Agent 由运行时 npm 从公共源拉取）
> 定位：定义**冻结的容器**与**可热更新的内核**之间的契约。容器是地基，内核是产品。

---

## 1. 核心原则

1. **容器冻结**：APK 仅在 **Node 运行时版本变更** 或 **HostBridge 能力方法变更** 时才重新编译。其余一切经热更新。（原「内置构建工具链」条款随 P3 收口移除，见 §3 与 ARCHITECTURE §2.3。）
2. **约定优于实现**：容器不认识具体 Agent（Codex / Claude Code / DeepSeek Harness），只认**内核包契约**并提供**运行时 npm 环境**。
3. **两条热更新通道**：
   - 容器 → 内核（Manager）：**签名 OTA**（容器签内核）。
   - 内核 → Agent：**运行时 npm（公共源）**（npm 标准完整性校验 Agent）。
   - 两个信任根，互不替代。
4. **特权收口**：所有安卓危险操作必须经 HostBridge（Kotlin）执行。

---

## 2. 分层架构

| 层 | 名称 | 更新方式 | 冻结？ | 职责 |
|---|---|---|---|---|
| **L0** | 容器（APK） | 仅 Node/桥能力变更才重编 | ✅ | Node 运行时 + **npm 客户端** + libc++_shared.so + HostBridge + OTA 引擎 + 生命周期 + 诊断 |
| **L1** | 内核 = 控制面板 / Manager | 容器签名 OTA 热更新 | ❌ | 控制面板代码 + `program-manifest.json`；运行在 Node 运行时内；**运行时经 npm 安装/升级/启停 Agent** |
| **L2** | Agent 产品 | 内核运行时 npm（公共源） | ❌ | Codex / Claude Code / DeepSeek Harness 等标准公共产品，由内核拉取管理 |

> **发布维只有 L0/L1/L2 三档，不存在 L3。** HostBridge 随 APK 冻结，属 L0；
> 它在职责维的位置是 L-B（见 ARCHITECTURE §1.1）。旧文档中的"L3"即指此层，已废止。

> "把手机变成工作台" = **Manager（控制面板，含工作台 UI）+ Agents（工作者）+ HostBridge（控制面）** 三者之和。Agent 是内核在运行时经 npm 拉取的，不随内核打包。

---

## 3. 运行时契约（容器侧，冻结）

| 项 | 值 |
|---|---|
| Node 版本 | `24.21.0`（arm64-v8a） |
| 平台 | android-35 |
| C++ 运行时 | 容器内 `libc++_shared.so`（native 模块必须链接它） |
| **npm 客户端** | **运行时可用**，且与 git/pnpm/jq/curl/sqlite3 **同级同逻辑**：由 C 层签名清单投放（构建口 `scripts/build-userland-npm.sh`，上游 tarball 的 sha512 与件内容 sha256 双钉），设备侧验签→逐件哈希→原子落位 `$PREFIX/lib/toolchain/npm`，再按清单 `entry=bin/npm-cli.js` 建 `$PREFIX/bin/npm` 的**符号链接**（`SupplyProvisioner.kt:249-264`）；`#!/usr/bin/env node` 由原生兼容件按**调用方 PATH** 兑现（`container/native/d1/exec-path.c`），**不逐件写包装**。落盘件的可执行位按内容自证（ELF/shebang ⇒ x，`runtime/ExecBits.kt`）。**APK 侧不留 npm 面**：`assets/npm/` 随包投放连同 `scripts/stage-npm-assets.sh` 已删除，`scripts/verify-apk-native.sh` 反向门禁钉住（APK 内出现 `assets/npm/` 即退 1）——随包那份与清单那份是两本账，留着就是工程债务。先前宿主把 npm-cli.js 绝对路径经 `runtime.json` 的 `npmEntry` ＋自造键 `LOBOS_NPM_ENTRY` 喂给内核「代跑」，两处均已删净（真机 2026-09-30 现读装机 Program `files/programs/console/0.1.0-android.48`：这些键零命中，读它们的代码也零命中）。全局前缀固定 `$HOME/.npm-global`，**唯一写入点是容器侧开机建的 `$HOME/.npmrc`**（`NodeProvisioner.kt:35,50-59`）；不存在宿主侧 `npm_config_prefix` 注入，也不存在「两侧目录名逐字对账」的门（空指收口见 `docs/plans/app-environment-plan.md` §10 第 8 条与债表 ENV-19）。PATH 三段 `$PREFIX/bin` → node 目录 → `$HOME/.npm-global/bin`（`RuntimeEnvironment.kt:83-91`），`NODE_PATH` 第二段与全局前缀同一事实源（`GuestAdapter.kt:78-84`）⇒ 债表 ENV-4/ENV-5。设备侧完整性 = **清单声明数 vs 可用数**的对账，不平即红且逐件点名（`SupplyProvisioner.kt:427-436`，债表 DS-9 的设备那半）。`npx` 那一格已收口（债表 ENV-26，2026-09-30）：别名表由**件自己**声明（根 `package.json` 的 `bin` 映射；本机 npm 11.16.0 现读 `{"npm":"bin/npm-cli.js","npx":"bin/npx-cli.js"}`），发布器从件内现读并写进清单 `tools[].aliases=[{name,entry}]`（`scripts/publish-userland-manifest.js:81-116,161`），设备侧按各自入口逐颗建链、逐颗点名（`SupplyProvisioner.kt:210-247`）—— 共享本件 `entry` 的写法会把 npx 装成 npm（`npx-cli.js` 2921 字节 vs `npm-cli.js` 54 字节，而两者 `--version` 打印逐字相同），故判据里带 `npx --help` 的 exec 语义判别。形状门禁对件内每一颗面各判一遍，判形宿主仍唯一（`scripts/verify-userland-artifact.sh:30-96`）。边界：`git:`/需编译的 native 依赖不支持（本契约「内置构建链」一格已实测证伪设备侧无工具链）。先前另记一条「安装一律 `--ignore-scripts`（容器无 sh 可 spawn）」：理由在原生兼容件把 shebang 按调用方 PATH 兑现之后已不成立，且设备侧没有任何代码实施它，去留待 V-0c 真机读数判。**「任一树根下 `npm --version` 按名字可得」是设备读数 V-0c，尚未采。** |
| **兼容语义的附着点** | **树根级**，不是单次调用级：`LANG/TMPDIR/PATH/LD_PRELOAD/SSL_CERT_*/CURL_CA_BUNDLE/GIT_SSL_CAINFO/SHELL/NODE_OPTIONS/NODE_BIN/LD_LIBRARY_PATH` 整簇由 `RuntimeEnvironment.treeRootEnv()` 一处生产（`RuntimeEnvironment.kt:65-124`），OS 侧四个起载荷的树根同取一份 —— 内核（`InstanceHost.kt:413-422`）、随包探针（`InstanceHost.kt:848-851`，刻意剥掉两片垫片、且不追加 NODE_PATH 段）、OTA 校验器（`ProgramVerifier.kt:100-102`）、adb 客户端（`AdbClientRunner.kt:221-223`）。**为什么是树根**：env 沿进程树继承，而载荷子进程会剥掉自定义 `LOBOS_*` ⇒ 语义写在申报键上到不了干活的孩子（债表 ENV-2 的成因）。豁免以断言表达：`NativePreparer.probe`（裸测）不取共享树根，见 `boot-env-contract-test.js` 判 5。（旧写法里还列着第二处豁免 `KillAudit` —— 它 exec 系统件 `sh`+`dumpsys`；2026-09-30 债 E11 收口后那个子进程**整体没有了**（app uid 下 dumpsys 根本读不到，退出史改走 `ActivityManager.getHistoricalProcessExitReasons`），豁免随数据源一起撤销，同一条判据转而钉「不许再起子进程」。 |
| **共享开发环境（C 层）** | 与产品无关的运行时/工具出一处、共享（分层见 [ADR-0009](../adr/0009-delivery-layers.md)）。**C 的工具全部由 C 自己的签名清单投放**，npm 与 pnpm·git·jq·curl·sqlite3 走同一口；APK 内**不留 npm 面**（随包 `assets/npm/` 那颗「底座种子」连同投放脚本已删，`scripts/verify-apk-native.sh` 反向门禁拦住复归）。OS 原生 `lobos/runtime/SupplyProvisioner`（机制）在启动时取回清单、对原始字节验签、按件取回并验哈希、原子落位到共享 `$PREFIX/lib/toolchain`，并建 `bin/<name>` → 件内入口的**符号链接**（`SupplyProvisioner.kt:249-264`，一件多真名时别名各按自己的件内入口建链 `:210-247`；marker 命中也重申一次），收尾按「**清单声明数 vs 可用数**」对账、不平即红且逐件点名（`SupplyProvisioner.kt:427-436`，债表 DS-9 设备那半）。shebang 与 `/usr/bin/env X`、`/bin/X`、`/usr/bin/X` 由原生兼容件按**调用方 PATH** 兑现（`container/native/d1/exec-path.c`），**不逐件写包装**——先前这里记的「自写 `#!/system/bin/sh` 可执行入口（安卓无 `/usr/bin/env`，npm 生成的 bin shim 不可 execve）」既没有对应实现、又是 `exec-path.c:8-9` 已定罪的「中间多了一层」补法，属契约与实现两本账（债表 ENV-20）。**加件/升级只发清单，内核不动**；件命名**内容寻址**（文件名带 sha12），对象存储长缓存才安全。C 的内容分两类：**运行时**（node·python，带版本地板 —— 缺 = 一整类负载跑不起来）与**工具**（npm·pnpm·git·jq·sqlite3·rg·curl·coreutils，只判在不在）。 |
| 运行时交接文件 | `<LOBOS_SUPERVISOR_HOME>/supervisor/runtime.json`（**容器写、内核读**，schema 2）：`schema`、`nodePath`（libnode.so 绝对路径）、`nodeBinDir`、`prefix`（`$PREFIX` 根 = `files/usr`，**可选键**：能力件真名的家，`bin/{bash,rg}`、`bin/node`（→ libnode.so 的符号链接）、`bin/{npm,pnpm,git,jq,curl,sqlite3}`（→ 各 C 层件入口的符号链接）、`lib/pty.node`；内核原生件投放单元的唯一取件路径，缺失即判 `blocked` 并上屏，不再静默跳过）、`minNode`、`writtenBy`。**这里没有任何 npm 键**：`npmPath` 先前写的就是 `nodePath` 的字面值（libnode.so），`npmEntry` 则是宿主把 npm-cli.js 绝对路径喂给内核「代跑」的形状 —— 两者都不是 npm 的取用通路（npm 按真名在 PATH 上兑现，见上面两格）。键集三处同调，写方唯一 `InstanceHost.kt:887-910`、引擎读方唯一 `container/engine/src/runtime-json.js`、契约 `docs/contracts/runtime-json.schema.json`，由 `container/engine/test/runtime-json-test.js` 的跨语言键集比对钉住（多一键、少一键都红）。 |
| 内置构建链 | **无**（已实测证伪：Google Maven 无 aarch64 版 aapt2，见 architecture.md §2.3）。`build` 组语义为「经 OTA 安装已签名内核」（A''，见本契约 §3.6） |
| 进程模型 | `InstanceHost`（前台 `START_STICKY`）spawn 独立 `:node` 进程加载内核入口 |

容器在 `program-manifest.json` 中声明上述契约，内核可据此声明兼容性。

---

## 4. 内核包契约（Kernel Bundle Contract）

整个内核是一个目录，**只含控制面板（Manager）+ 清单**：

```
program/<version>/
  program-manifest.json          # 内核包清单（见下）
  bin/panel   # 内核入口（被 node 解释的脚本）
  ui/dist/             # 控制面板静态资源（运行期必需）
```

> **不含 `agents/`**：Agent 产品由内核运行时从公共 npm 拉取，不打包进内核。

`program-manifest.json` schema：

```json
{
  "name": "lobos-console-panel",
  "version": "1.4.0",
  "abi": "node24-arm64-android35",
  "engines": { "node": ">=24 <25" },
  "entry": "bin/panel",
  "requires": [
    "bridge:app_control",
    "bridge:ui_automation",
    "bridge:device_policy",
    "bridge:build",
    "bridge:shell"
  ],
  "managedAgents": [
    { "id": "codex",    "pkg": "@openai/codex",              "version": "1.x", "requires": ["bridge:ui_automation","bridge:shell"] },
    { "id": "claude",   "pkg": "@anthropic-ai/claude-code",  "version": "1.x", "requires": ["bridge:ui_automation"] },
    { "id": "deepseek", "pkg": "<deepseek-harness-pkg>",     "version": "1.x", "requires": ["bridge:ui_automation"] }
  ],
  "signature": "<ed25519 over the manifest hash>"
}
```

- `managedAgents` 只声明"管理哪些、锁哪个版本、需要哪些能力"，**不打包产物**。
- `requires` 是控制面板本身所需能力；各 Agent 的能力在运行时由内核按 `managedAgents[].requires` 校验。

容器启动校验：1) 验签（内置公钥）→ 2) `engines.node` 比对固定运行时 → 3) `requires` 比对设备已预置能力 → 任一不符则**拒绝加载并回滚到上一个良好版本**。

---

## 5. 两条更新通道

### 通道一：容器 → 内核（签名 OTA）
**构建期（CI）**：
1. `npm ci` 解析 Manager 依赖；
2. 对含原生模块者，按固定 ABI（Node 24 / N-API / libc++_shared.so / 16KB 对齐）交叉预编译 `.node`；
3. 打包 `program/<version>/` 目录 → 用私钥签名 → 产出 `program-manifest.json`（版本/URL/sha256/签名）；
4. 发布到 CDN / Release。**npm 在此仅作构建期工具，用于产出内核包。**

**设备端 OTA 流程**：
```
轮询 program-manifest → 下载内核包 → 验签 + sha256
  → 原子解包到 files/programs/console/<new-version>/ → 切换 CURRENT 指针（临时文件 rename）
  → 杀旧 :node 进程、spawn 新进程（Manager 引导）
```
- 原子性：先写新目录再切指针，失败不影响旧版本。
- 回滚：保留上一版本；新包启动健康检查失败 → 指针回退 + 重启。
- **坏包永不生效**：验签不过直接丢弃，绝不切换指针。

### 通道二：内核 → Agent（运行时 npm，公共源）
Manager 在运行时按 `managedAgents` 的 `pkg` + `version`，从**公共 npm registry** 执行 `npm install` 安装/升级 Agent；安装到内核可写目录，按 `bin`/`entry` 拉起。（**未落地**：`managedAgents` 目前无消费者，设备端不执行此编排。）
- **不设私有源**；Agent 为标准规范公共产品，无特殊处理。
- 完整性依赖 **npm 内置 sha512 integrity**（安装即自动校验）。
- 版本由内核升级逻辑**锁定已知良好版本**，不盲目追 latest。
- 这是 "Agent 运行时"：内核读包、按升级逻辑更新、启停、编排。

---

## 6. Agent 信任模型（合理置信逻辑）

- **来源**：公共 npm registry。
- **身份**：确切包名 + 官方发布者（Codex / Claude Code / DeepSeek Harness 均为官方标准产品）。
- **完整性**：npm 内置 integrity（sha512），安装即验——即"完全可验证"，无需自建签名/镜像/白名单。
- **版本**：内核锁版本，升级逻辑决定何时升。
- **特殊处理**：无。

> 信任链：**容器签名内核（Manager）** → **内核按公共 npm 标准完整性拉 Agent**。不需要第三套签名体系。

---

## 7. 原生模块 ABI 契约

内核包内 `.node` 及 Agent 若带原生模块，必须满足（加载期校验）：
- ELF arch == `arm64`；
- 使用 **N-API**（保证 ABI 稳定）；
- `DT_NEEDED` 闭环，解析到容器提供的 `libnode.so` / `libc++_shared.so` / `libc.so` / `libdl.so`；
- **16KB 页对齐**（用 `readelf -W` 校验）；
- 签名校验（与内核包同签名体系；Agent 侧则由 npm integrity 保证）。

> 注：Codex / Claude Code / DeepSeek harness 基本为纯 JS CLI，原生编译通常非问题；个别 Agent 若带 `.node`，须按固定 ABI 预编译（设备侧无编译工具链，见 §3）。

---

## 8. 安全模型

- **双信任根**：容器公钥签内核；npm 标准完整性验 Agent。
- **传输私有**：Agent↔HostBridge 走 **Unix 域套接字（UDS）** 的**抽象命名空间**（名 `lobos_hostbridge`，无文件系统路径、无文件权限保障），**不走 TCP**。控制面是 `127.0.0.1:36360`，也是「运行时在线」的**唯一**判据；`3080` 只是**显式探针**端口（诊断页点一下才跑，不在启动链上、不代表有运行时在服务）。
- **能力作用域**：Agent 仅能使用其 `requires` 声明且在设备已预置的能力；缺失能力 → 桥拒绝/降级。
- **审计**：所有经桥执行的特权操作（装卸应用、锁屏、shell、读屏）须落审计日志。

---

## 9. 生命周期（运行时）

```
App 启动 → InstanceHost(START_STICKY) → 读 CURRENT 指针
  → 加载 program/<version>/bin/panel（由 node 解释）
  → Manager 读 program-manifest.json → 按 requires 连接 HostBridge(UDS)
  → Manager 按 managedAgents 在运行时经 npm 安装/拉起各 Agent
  → 健康检查（端口/探针/桥握手）
  → 进程退出或健康检查失败 → 退避重启（沿用 watchExit/pollPort）
```

`START_STICKY` 保活；内核包更新 = 重启 `:node` 进程（对用户是"热"的，无 APK 重编）。

---

## 10. 可观测性

复用 `RuntimeDiagnostics`，扩展：
- 内核包加载阶段（验签/解包/指针切换）逐阶段诊断；
- Agent 安装/升级日志（npm 输出）、Agent 运行日志桥接进诊断面板；
- 崩溃上报（exitCode + 桥审计摘要）。

---

## 11. 何时重编 APK（冻结边界）

仅以下情况重编并发布新 APK：
- Node 运行时版本升级（如 24.21.0 → 25.x）；
- HostBridge 新增/修改能力方法（桥是冻结层）；
- npm 客户端自身需升级。

其余所有产品演进（控制面板逻辑、Agent 增改、能力参数调整）→ 走两条热更新通道。
