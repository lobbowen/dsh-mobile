# ADR-0009：交付分层 —— 底座 / 开发环境 / Linux 语义 / 平台件 / 装配器 / 产品声明

- 状态：已接受（2026-09-27 用户拍板结构，随后按此结构分提交落地）
- 关联：ADR-0001（exec 域）、ADR-0005（内核只经 OTA）、ADR-0008（域模型与 init 权威）、
  ARCHITECTURE.md §1.1（职责维 L-A..L-E）
- 上位定位：**我们做的是 Agent OS —— 一台以安卓为硬件/特权抽象层的类 Linux 系统。**
  容器不是"一个会拉起 Node 的 App"，而是"这台机器"；它下面要有用户态（开发环境），
  上面才是各 agent 与工具产品。

## 1. 问题（环境报告定罪的那一类）

外部环境检测报告列出一串缺口（pnpm / git / python3 / jq / sqlite3 缺失、
locale 空、os.cpus() 返回 0、/tmp 不可写）。逐条修会修成"补丁"：把工具塞进 APK、
在每个产品里复制一份适配、把全局问题做成单产品特例。根因不是缺件，是**分层没定**：

- 运行时是共享的，但"共享"并不等于"能跑"——第三方软件假设了 **Linux**，而宿主是 **Android**；
  这是**平台差**，与"谁来用"无关，所以共享运行时并不能消掉适配。
- 平台的差与产品的差被混成一根轴，于是归属判错（pnpm 一度被当作某个 agent 的私有工具链）。

## 2. 决策：六层（交付维，与发布维 L0/L1/L2、职责维 L-A..L-E 正交）

```
        Android 宿主（AMS · SELinux · 权限 · W^X）
┌──────────────────────────────────────────────────────────────────────┐
│ B. 容器 / OS 底座      【L0 · APK 冻结 · 只播自举种子】
│  进程与生命周期 · exec 域 · HostBridge · runtime.json 契约
│  nativeLibraryDir: libnode.so · libdshposix.so · libdshflock.so …
│  $PREFIX 种子: bash · rg · node · lib/pty.node
├──────────────────────────────────────────────────────────────────────┤
│ C. 共享开发环境        【共享 · 最大化 · 产品无关】
│  运行时 node/python · 包管理器 npm/pnpm · 工具 git/jq/sqlite3/rg/curl
│  根: $PREFIX(files/usr) · $HOME/.npm-global
│  写者: 供给物化器（如 kernel/src/platform/toolchain.js）
├──────────────────────────────────────────────────────────────────────┤
│ D1. Linux 语义兑现     【共享 · 全局注入】
│  LANG=C.UTF-8 · /tmp 语义 · os.cpus() · exec/dlopen 域
│  link(2)/open 祖先: LD_PRELOAD libdshposix.so
├──────────────────────────────────────────────────────────────────────┤
│ D2. Android 平台件库   【共享工件 · 与落位分层】
│  工件本体解析唯一处: kernel/src/guard/native/platform-artifacts.js
│  rg · pty.node · libdshflock.so · sharp-wasm32 · narb 垫片源
├──────────────────────────────────────────────────────────────────────┤
│ E. 装配器              【共享一套 · 注册表驱动】
│  {包身份} → 平台件 + 落位方式；安装/升级后与 spawn 前幂等跑
│  kernel/src/guard/native/{manager.js, supply-table.json, capability-probe.js}
├──────────────────────────────────────────────────────────────────────┤
══════════ 以下按产品分，一个产品一套（互不共享）══════════
│ F. 产品声明            【adapters/<id>/agent.json】
│  依赖树 · 数据目录 · profile/插件 · 启动契约(android.launchFlags)
│  写者: 该产品自己的安装器
└──────────────────────────────────────────────────────────────────────┘
```

## 3. 判据（归属怎么定）

| 问题 | 归 |
|---|---|
| 是不是「Android 与 Linux 的差」？ | **D1**（全局一次） |
| 是不是「上游没有 android 产物/命名」？ | 工件 **D2**，落位 **E** |
| 是不是「与产品无关的运行时/工具/包管理器」？ | **C** |
| 只跟某个产品的包 / 数据 / 语义有关？ | **F** |

一句话：**能不能共享，看它是不是产品造成的；产品造成的才按产品分。**
不等于"每个产品一套垫片机制"——机制一套（E），产品只给**声明**。

## 4. 三条铁律

1. **共享层只读、单一写者**：C/D 由供给物化器写，产品不许改；B 只播种子。
2. **共享层变更的回归面 = 全部产品的能力核验**：换 node/rg/pty/locale，不能只看一个产品。
3. **产品层互相隔离**：产品树里唯一外来写者是 E，且只写"平台件落位"，不改产品语义。

## 5. 落地状态（按能力记，不按提交）

| 层 | 已落 |
|---|---|
| B | 既有（PrefixProvisioner / GuestAdapter / runtime.json） |
| C | pnpm：`kernel/src/platform/toolchain.js` 物化到共享 $PREFIX（首用即装，自写 sh 入口）；git/python3/jq/sqlite3 在 `supply-table.json` 的 `envUnits` 登记为到期即红的豁免 |
| D1 | `LANG=C.UTF-8`；`/tmp`→`$TMPDIR` 前缀重写（`container/native/posix/open-fallback.c` + 开关 `DSH_TMP_REDIRECT`）；`os.cpus()` 预载垫片（`assets/node/android-env-shim.cjs` + `NODE_OPTIONS`） |
| D2 | `kernel/src/guard/native/platform-artifacts.js`（工件唯一解析处，只读无副作用） |
| E | `manager.js` 经 D2 解析工件；供给表 `envUnits`/`units` 双向对账由 `native-supply-gate-test.js` 把守 |
| F | `adapters/dsh/agent.json` 的 `android.launchFlags`（`--expose-internals` 三处消费者同源） |

## 6. 明确不做 / 欠账

- **/tmp 重写已落，边界明确**：只重写 `/tmp` 前缀（`/tmpfoo` 这类不动），且受开关
  `DSH_TMP_REDIRECT` 控制（容器显式置 1；置 0 即逃生阀）。`TMPDIR` 仍是单一事实源。
- **os.cpus() 垫片已落**：只在 `os.cpus()` 为空时用 `availableParallelism()` 合成，
  非空一律不动；整段 try/catch，绝不成为启动失败点。
- **不承诺每个产品一套机制**：产品只给声明（见 §3）。
