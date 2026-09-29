# 运行环境层（Runtime Environment）设计方案

- 状态：**待审（第 3 轮重定性）**。脊柱换过三次，每次都因为我把「概念」落成了「针对某个指向的机制」而被否决，三次都留档在 §11 D-1：第 1 轮＝按申报装载/运行/分配/授权（原话：「你现在这不还是给他锁死了吗……完全不是一个通用系统的状态」）；第 2 轮＝一条 OS 唯一的 exec 桥通路（原话见 §11）；**本轮＝环境自洽 + 能力平铺**，撤销第 2 轮的 `proc.exec/proc.wait/proc.kill` 与 `bridge:proc`。本文件不含任何实现。
- **同一轮内还有一处被否决并已撤回**（§11 D-2）：我把「第三方 npm 包先进 C 层签名清单才能用」写成了边界，原话：**「我们把 npm 装上之后，我们所有的系统内的应用当调用 npm 能力的时候，它就自动可以使用它去下载东西，而不是你主动去拦截，你注册个鸡巴毛呀。npm 是环境基础啊……我们做的是个系统，是个运行系统。」** 判据 C 同样杀这条：取包是环境基础件的本职，为它设登记步骤＝中间又多了一层。D-2 已按此重写为「环境够不够让 npm/pnpm 干完它的活」的逐格事实账。
- **同日追加复审（你要求的「是不是所有环境基础件都这么处理错了」）**：跑完的账在 **§4.1**，结论是**同一形状在三处复发**（npm 无真名、pnpm 的判据走自造键、flock 件的可用性只写在自造键上）、**两格成文必备却零供给**（coreutils、python）、**四类是物理边界必须显形**（git over ssh、curl over SFTP、需编译依赖、`$EDITOR`/pager）、**两处契约空指**（指向不存在的对账门与已被定罪的逐件包装）。为此新立**判据 D**（§0：可用性只能落在真名或生态本就读的标准键上）与验收 **V-0d**（§9）。净新增概念仍为 **0**——判据 D 不是机制，是一条可机械检查的规矩。
- **S0 已执行（2026-09-29，你下令「开始修这些问题」；纯文档与登记，不出壳）**：§4/§4.1 的账入债表新组 `ENV-layer` 共 24 条（ENV-1…ENV-24，ENV-19/20/22/24 为本步已清并带现读证据；ENV-9/10 归「需人工裁定」）；`base-spec.md:50`（假对账门＋`npm_config_prefix` 注入的谎＋`--ignore-scripts` 的失效理由）与 `:51`（要求已被定罪的逐件 shebang 包装）按 §10 第 8/9 条改成实现真实的形状；`METHOD-GAPS.md` §1 登记 `shell.exec` 名实与 `os.appmgr.*` 的 id/feed 缺口；§10 第 5 条三面自述文案删净（console-ui.md 的文件树/轮询/页数 + AboutCard 产品描述 + PortPanel 路由标签 + nav.ts 域数）。局部判据实读：`debt-gate` total=164 done=132 open=32、`doc-gate --strict --strict-cites` broken=0 且规范面失效引用 0（历史面 88 未变）、`gate-scan --strict` hits=0、`capability-single-source-gate-test.js` 10 passed/0 failed。**面板四处的文案改动要等 console Program 重新发布才到设备（发布逐次请示）**。S1 起进入 Kotlin，需出壳。
- **S1 已执行（2026-09-29，同一道令的下一步；只到「仓内自洽」这一层，未出壳、未推送、未触发 CI）**：环境装配的本体搬进新件 `container/app/src/main/java/lobos/os/RuntimeEnvironment.kt`（`provision`／`ensureNpm`＋`linkNpm`／`ensureEnvShim`／`ensureNpmPrefixRc`／C 层异步供给，诊断 stage 与文案逐字沿用旧块，不新造读数词），触发点挂在「宿主就位」这条边（`OsHostService.kt:93-106`，投递到 `lobos-host` 线程：provision 是实打实的复制，主线程做就是 ANR 风险），`InstanceHost` 里的三块装配代码删净、只留 `:385` 一个调用方；npm 的真名 = `$PREFIX/bin/npm` → `npm-cli.js` 的**符号链接**（`PrefixProvisioner.kt:108-125`，体内零落盘写脚本，逐件包装是 `d1/exec-path.c:8-9` 定罪的形状）；`Snapshot.complete`（缺件或 npm 无真名即不完整、不完整不进进程缓存）钉在 `RuntimeEnvironmentTest.kt`。门禁读数：`debt-gate` total=164 **done=134** open=30（ENV-1/ENV-3 关账，均 `evidenceTier=static`）、`doc-gate --strict --strict-cites` broken=0 且规范面失效引用 0、`gate-scan --strict` exit 0、`CI=true npm run test:logic` 全链 exit=0（`boot-env-contract-test.js` 新增判定 4 共 5 条断言，25 passed/0 failed）。**新门真能红，已做对照实验**：删本体供给调用／删宿主触发／启动链重新分叉／npm 改回包装脚本 —— 四次受控突变各自 1 failed，突变后按 sha256 逐文件还原一致。**搬家把三个文件的行号整体移位**（`InstanceHost`／`OsHostService`／`PrefixProvisioner`），本文件与债表、`base-spec.md` 里指向它们的引用已逐条按现读重钉（80 处命中全部核到真实行，无一越界或落空）。**未做**：Kotlin 未经编译（本地无 Android SDK，CI 是唯一编译器）；V-0b（停掉 console 后 `$PREFIX` 仍在位）与 V-0c（任一树根下 `npm --version` 按名字可得）都是设备读数，未采；ENV-2/4/5 未动，「按名字可达」要等语义铺到每个树根才算兑现。
- **S2 已执行（2026-09-29，同一道令的下一步；同样只到「仓内自洽」这一层，未出壳、未推送、未触发 CI）**：兼容语义整簇（12 个旋钮）搬进 `lobos/os/RuntimeEnvironment.kt`，形状是纯函数——树根数据 `TreeRoot`（`:45-55`）、唯一语义生产点 `treeRootEnv(root, inheritedPath)`（`:65-124`：HOME `:69`／TMPDIR `:70`／LANG `:74`／LD_LIBRARY_PATH `:78`／NODE_BIN `:79`／PATH `:83-91`／LD_PRELOAD `:93`／SSL_CERT_DIR `:101-106`／SSL_CERT_FILE·CURL_CA_BUNDLE·GIT_SSL_CAINFO `:110-119`／SHELL `:120`／NODE_OPTIONS `:123`）、唯一 Context→树根映射 `treeRootFor`（`:141`、`:144-158`）、按路径段去重 `joinPath`（`:128-133`）。`GuestAdapter` 只剩 console 的 `LOBOS_*` 申报与 command/cwd（`:70-105`），自述 `:6-19` 同批改口径——旧那句「本对象是这两层装配的唯一生产点」随搬家删除：它当时是真的，而「真」正是判据 B 要杀的形状。OS 侧四个载荷树根取同一份语义：内核 `InstanceHost.kt:415-425`、随包探针 `:851-854`（刻意剥两片垫片，理由写在 `RuntimeEnvironment.kt:42-43`——探针读数不能冒充运行态）、包校验器 `ProgramVerifier.kt:100-102`、adb 客户端 `AdbClientRunner.kt:221-223`（spawn 侧 `:234`、`:274`）；三份 `baseEnv` 副本删净。**ENV-2/ENV-4/ENV-5 关账（均 `evidenceTier=static`）**：PATH 单点 `:83-91` 的四段含 `NodeProvisioner.globalBin`，NODE_PATH 第二段 = `globalNodeModules(root.home)`，与 `.npmrc` 钉住的 prefix 同由常量 `.npm-global`（`NodeProvisioner.kt:35`）派生——S2 之后「两侧逐字对账」退化成同源代码，这正是 ENV-19 收口时留的位置。**与 §8 原写有一处偏离**：`KillAudit.kt:28` 不收编，改为以断言豁免（它 exec 的是系统件 `sh`+`dumpsys`、不跑载荷，收编会让每分钟巡检 tick 反复触发装配上屏）；PTY 探针 `InstanceHost.kt:537` 与资产自证 `NativePreparer.kt:336-338` 同为刻意裸 exec。门禁读数：`boot-env-contract-test.js` **31 passed/0 failed**、`CI=true npm run test:logic` 全链 exit=0、`debt-gate` total=164 **done=137** open=27、`gate-scan --strict` hit-files=0 hits=0 dead-terms=0、`doc-gate --strict --strict-cites` files=43 broken=0 且规范面失效引用 0（历史面 88 未变）。**新门真能红，九次受控突变逐一实测**（各自 1 failed，删净 PATH 键那次 3 failed）：`GuestAdapter` 复制一份 LANG／PATH 删掉 npm 全局 bin 段／adb 客户端自拼 HOME／TMPDIR 落点改回 home／NODE_PATH 第二段退回 `filesDir/node_modules`／多出第二处 PATH 组装／PATH 键删净／宿主就位不触发装配／`KillAudit` 改取共享树根——命中的断言名逐条记在 ENV-2 的 evidence，突变后 5 个 Kotlin 文件按 sha256 逐文件还原一致，还原后基线仍 31 passed/0 failed。**未做**：Kotlin 未经编译（本地无 Android SDK，CI 是唯一编译器），所以「golden 迁移后逐键等值」`GuestAdapterTest.kt:83-124、:142-151` 只是写好了断言、还没被执行过；V-0/V-0b/V-0c/V-0d 都是设备读数，未采；`boot-env-contract-test.js:103` 那条 command 形状的反向断言属 S3/S7（本轮不动「一比一定制」的 command，它归 ENV-14）；§9 V-7 未在 `gate-scan` 另立词条，判据由契约门承担（同一事实挂两处判据正是本方案要杀的形状）。搬家又移位了 `GuestAdapter/InstanceHost/OsHostService/PrefixProvisioner/NodeProvisioner` 的行号：本文件、债表与 `docs/runbook/system-device-verification.md` 的引用已逐条按现读重钉，历史位置一律写作「旧 …」并标明随 S2 消失。
- **B 批次「npm 归口 C 清单」已执行（2026-09-30；道令原文：「①APK 里不留 留了就是工程债务 ② A和B 一起执行 b 最关键的不是要报错 而是要真正把问题解决」；同样只到「仓内自洽」这一层，未推送、未触发 CI）**：**供给侧**——`scripts/build-userland-npm.sh` 把上游 npm tarball 打成内容寻址件（双钉：tarball 的 sha512 与件内容 sha256），进 `build-userland.yml` 矩阵，与 pnpm/git/jq/curl/sqlite3 **同一条口**；发布器经 `scripts/read-userland-entry.sh` 取件内入口（`entry=bin/npm-cli.js`，不再无条件写 `bin/<name>`）。**APK 侧的 npm 面四处删净**：`NodeProvisioner.ensureNpm`、`PrefixProvisioner.linkNpm`＋`NPM_BIN_NAME`、`GuestAdapter` 的 `LOBOS_NPM_ENTRY`、`InstanceHost.writeRuntimeJson` 的 `npmPath`/`npmEntry`，连同 `assets/npm/` 投放与 `scripts/stage-npm-assets.sh` 整体删除。删的根据不是「大概用不上」而是**真机现读**：装机 Program `files/programs/console/0.1.0-android.48` 里 `npmPath`/`npmEntry` 与 `runtime.json` 全文零命中 ⇒ 读它们的代码从来不存在，「宿主代跑」是两头都不成立的形状（S1 那格引用的 `PrefixProvisioner.kt:108-125` 随本批消失，历史读数原样留在 S1 条目里）。**设备侧对账换成真尺**：`SupplyProvisioner` 收尾由「C 层供给完成：就位 N 件」改成按「清单声明数 vs 可用数」判，不平即红且逐件点名；marker 命中那一支现在每轮重申 `$PREFIX/bin/<name>` 的链接（旧代码只在新落位时建链 ⇒ bin 目录被清过、或建链代码晚于已就位件的设备，会永久表现为「件装着、名字调不到」）；单件网络/解包故障只跳过这件，不再让一次超时带走整轮。**执行位按内容自证**（`runtime/ExecBits.kt`：`\u007fELF`∨`#!` ⇒ x，`repair()` 走整棵树并跳过链接本身），解包 apply 与 marker 命中 repair 两条路径都覆盖（ENV-25）。契约与文档同批改口径：`runtime-json.schema.json` 的 npm 键删除、`base-spec.md` 的 npm／C 层／交接文件三格、`ADR-0009` §2.2 加勘误、`docs/standards/storage.md` 与 `docs/runbook/git.md` 的「运行时资产」行改成真实落点、`docs/runbook/contributing.md` 的「spawn 硬边界」整节重写（它指名的 `npmInvocation`/`npmEnv`/`dshCliInvocation`/`resolveDshCli`/`config.command` 全仓零命中，与 ENV-19/ENV-20 同形状，另立债）。门禁读数：`boot-env-contract-test.js` **36 passed/0 failed**（本批新增 4 条：APK 侧 npm 面四处零命中／供给对账＋其旧形状的反向对照／真名入口两路重申且建链出口唯一／ENV-25 两条路径覆盖）、`runtime-json-test` 13/0（「不含任何 npm 键」＋ Kotlin⇄JS 键集比对）、`contract-schema-test` 14/0、`e2e-mock-program-test` 9/0、`layout-manifest-test` scriptsOwnership 50/50、`native-assets-test` **138/0**（含反向对照「APK 里留着 `assets/npm` → 立刻退 1」）。**未做**：Kotlin 未经编译（本地无 Android SDK，CI 是唯一编译器）；V-0c（裸名 `npm --version`、`npm config get prefix`）与 pnpm 的 `$PREFIX/bin/pnpm --version` 复点都要等出壳上机；`npx` 无真名新立 **ENV-26**；ENV-25 的 done 仍欠设备 `ls -l` 现读。**B4（本轮）＝债表与文档对齐归口事实**：`os-v4-debt-registry.json` 165→**167** 条（新立 ENV-26 一件一入口⇒`npx` 无真名、ENV-27 文档门不核验符号名空指），ENV-1/2/3/5/6/8/19/20/22/25 与 DS-9 的 `where/action/note/evidence` 按现读全部重钉（**每一条都重新 grep 过真实行，历史位置一律标「旧/改前」**：`RuntimeEnvironment.kt:175-213`、`OsHostService.kt:93-106` 在 `lobos/lifecycle/` 不是 runtime/、`PrefixProvisioner` 的 expected 由 :133→:114、`SupplyProvisioner` 的建链由 :198-211→:215-228、清单解析由 :253-256→:264-270、`InstanceHost` 两个消费者 :415-425/:851-854→:413-422/:848-851、`killAudit` 在 `lobos/os/`），ENV-3 里「LOBOS_NPM_ENTRY 仍在写」这句过期陈述已改写成删除事实；债表回写经 `JSON.stringify(j,null,2)` 逐字节稳定（185,903 字节）。**同一轮扫出的两处门禁缺陷（都是「门禁判自己／门禁被掏空」的形状，当场修）**：① `dead-path-gate-test.js` 的 `SKIP_FILES` 只跳了 `brand-scan-report.txt`，没跳同类的 `doc-gate-report.txt`/`debt-gate-report.txt`——三颗都是 gitignore 的生成物、按设计把被否决路径与已删文件名抄回正文（doc-gate 会抄 ADR-0002 的 `ContainerRoot.kt`），于是「先跑 doc-gate 再跑本门」与不跑给出两种答案（本仓自己的注释 :14-15 已写明这条规则，只是没执行完）；补齐两颗后做**双向对照**：三颗报告都在位时基线绿、真塞一颗 `scripts/zz-deadpath-probe.kt` 含 `ContainerRoot` 立即 1 failed、删掉还原仍绿。② R10（`capability-single-source-gate-test.js:253` 的死词汇表）把 `usable` 判成死词，与本批供给对账的计数器**同名撞车**——R10 的判据形状（裸子串匹配常用英文词）不改（它管的是权限账单那一格），改的是我这侧的名字：`usable`→`available`（5 处，诊断文案「可用 N 件」逐字未动，门里没有任何一条钉这个标识符）。收口读数：`CI=true npm run test:logic` **全 27 个测试文件 exit=0**、`boot-env-contract` 37/0、`dead-path-gate` 1/0、`native-assets` 138/0、`capability-single-source` 10/0、`e2e-mock-program` 9/0、`gate-scan --strict` hit-files=0 hits=0 dead-terms=0 kt-missing=0、`doc-gate --strict --strict-cites` files=43 broken=0 规范面失效引用 0（历史面 91→**89**：本批把 4 处「现」字样的失效引用重钉，余下 89 条是 ADR/计划里刻意保留的旧形状与被定罪符号名，报告模式数字可见）、`debt-gate` total=167 **done=137 open=30**（`--strict` 仍 rc=1：30 条未清项是现状不是门禁红，ENV-25/DS-9 欠的就是设备读数）。`version.json` 壳 1.1.11+42 → **1.1.12+43**（`container/app/**` 改动必须换号；`gen-version --check` 六层单一事实源全通过）。**另抓到自己一处违规**：本批把临时脚本写进仓根 `work/`，被 `layout-manifest-test` 的「undeclared root entries: work」当场判红——已移出仓并删除；临时产物今后一律落 `/tmp`。
- 触发：2026-09-29 `.47→.48` 面板对账 → EXEC-G2 根因层 → 同日四轮重定性。
- 范围：只定义「运行环境如何作为 OS 自己的事实存在，使其中任何可执行物被任何住户直接使用」。面板/agent 的业务代码不在本方案内。
- 不做：不为任何单个应用（含控制面板、含智能路由）写专用逻辑；**不再为「每个程序 / 每个子负载」设计新申报格**（第 1 轮已废）；**不做 exec 白名单、不做「起进程要经 OS 批准」的桥方法面**（第 2 轮已废）；**不拦截环境基础件自带的本职动作**（npm/pnpm 取包即其本职；载荷用它们装出来的依赖归载荷，不进环境清单、不设登记步骤——本轮撤回的 D-2 已在此定性）；不引入进程外复活兜底（`docs/adr/0006-background-lifecycle-keepalive.md:55`、`docs/adr/0008-agent-os-init-authority.md:49` 原文）。

---

## 0. 主张

裁定口径是本章的唯一验收标准，原话：**「我说 node 你就只管 node，我们要的是什么？我们要的是运行时环境可以执行所有的东西……所有依赖运行环境里面的东西都可以直接运行，包括工具链。这些工具链比如说 git，当我运行在整个环境里面的某一个应用，它用到 git 的能力的时候，直接就可以调用，并不需要我每次都要去单独地为每一个产品或者每一个应用单独再造一个通道」**；以及 **「你现在就是所有的东西没有把能力直接平铺下去，就我们现在这个完全不是一套系统。你这都是一个点对点的东西」**。

所以「系统」的定义在本方案里只有一句：**一套所有住户共享的环境与语义，住户使用环境里的能力时不需要任何人再为它拉一条线。** 判据单位既不是 Program，也不是「一次执行」，而是**环境本身**。

**内容层今天已经是对的**——这一点必须先写实，否则又会变成「新建一条通路」：

| 事实 | 证据 |
|---|---|
| 工具链已在按「环境的一部分」供给，不是按应用供给 | `.github/workflows/build-userland.yml:48` 矩阵 `[sqlite3, jq, git, curl, pnpm]`；`lobos/runtime/SupplyProvisioner.kt:24-25,37,198-210,301-304` 落位 `$PREFIX/lib/toolchain/<件>/` ＋ `Os.symlink` 进 `$PREFIX/bin` ＋ link-farm ＋ alias |
| `$PREFIX/bin` 已经在 PATH 首位 | `lobos/os/RuntimeEnvironment.kt:83-91`（`joinPath(prefixBin, nodeBinDir, globalBin, inheritedPath)`；S2 前这段住在 `GuestAdapter`，见 §1 ②） |
| 「按名字用一件工具」的解析机制已经存在且不带应用名 | `container/native/d1/exec-path.c:11-13`：shebang 与标准绝对路径按**调用方 PATH** 解析；`:8-9` 原文点名旧补法「给每个工具手写一层 `#!/system/bin/sh` 包装……那才是中间多了一层」 |
| 注册即全套跟上（加一个件不写装配代码）已成文 | `lobos/native/NativeAssetRegistry.kt:25-31`「新增一个二进制资产要做什么：1. 在 `ALL` 里加一行……就这些 —— 运行时启动链、诊断、exec-probe、`sys.nativeAssets` 全部自动跟上」 |

⇒ **「应用直接调 git」在结构上已经成立，一行新机制都不需要**。缺的是下面这件事——但「结构成立」不等于「每颗件都已兑现」，逐颗复审见 §4.1：npm 那一格就没兑现，另有两格在成文清单里却零供给。

**真正的缺口：环境的两条生命周期与它的语义，都只在一颗 Program 的启动路径上发生一次。** 定罪时（S1 搬家前）全仓现读，这两个调用点各只有一处，且都在同一个函数里（`InstanceHost.kt:224` 起的 `bootProgramOnce()`，实测到 `:470` 之前没有别的函数边界）——该函数现已不再装配环境，触发点搬到「宿主就位」这条边（`OsHostService.kt:93-106` → `lobos/os/RuntimeEnvironment.kt`）：

| 环境事实 | 唯一触发点 | 它长在谁的路径上 |
|---|---|---|
| `$PREFIX` 内容装配（node / bash / rg / CA bundle） | 搬家前唯一调用 `InstanceHost.kt:446`（S1 已删净）；现调用点 `RuntimeEnvironment.kt:179`，触发点 `OsHostService.kt:93-106` ＋ `InstanceHost.kt:385` | console 的启动链 → **宿主就位** |
| C 层工具链供给（sqlite3 / jq / git / curl） | 搬家前唯一调用在 `bootProgramOnce` 的线程块（S1 已删净）；现调用点 `RuntimeEnvironment.kt:209-218` | console 的启动链 → **宿主就位** |
| Linux 语义（12 个兼容旋钮整簇） | 搬家前生产点 `GuestAdapter.kt:113-149`，唯一消费者 `InstanceHost.kt:415`；现生产点 `RuntimeEnvironment.kt:65-124`，OS 侧四个载荷树根共享（§1 ④） | console 的启动计划 → **每个进程树根** |

**四条判据，都能机械检查**（A/B/C 立在前几轮，D 由本轮「逐颗复审」新立）：

- **判据 A（名字）**：如果一件系统能力的名字里带着某个应用的名字，它就不是系统能力。实读规模：`CONSOLE_ID`/`CONSOLE_PORT`/`consoleId()`/`"console"` 在 `container/app/src/main` 共 **25 处、分布在 10 个文件**；`ProgramManager(` 的 22 个构造点只有 `ProgramInstaller.kt:137` 显式传 id，其余全吃 `CONSOLE_ID` 默认值。
- **判据 B（装配位置）**：**如果一件系统能力的装配只在某个应用的启动路径上被调用，它就不是系统能力。** 定罪时（S2 前）实读：`LD_PRELOAD` 在整个 `container/app/src/main/java` 里**只出现 1 次**（旧 `GuestAdapter.kt:114`），`PATH` 的组装只在旧 `GuestAdapter.kt:125,169` ⇒ 兼容层的作用域事实上等于「控制面板这颗 Program」。**S2 后这条判据转绿**：`LD_PRELOAD` 仍只出现 1 次，落点已是 `RuntimeEnvironment.kt:93`；PATH 单点在 `RuntimeEnvironment.kt:83-91`，消费者是四个树根（§1 ④）；`GuestAdapter` 里再出现树根键装配即判红（`boot-env-contract-test.js:191`）。
- **判据 C（零中间层，本轮新立，专门抓我自己的第 1、2 轮）**：**如果环境里的一个件要被使用，需要先「谁专门为它做过一件事」——注册它一格、给它加一条桥方法、给它写一个包装、批准一次执行——那就不是一套系统。** 按这条撤销：第 1 轮的 `workloads[]` 申报格；第 2 轮的 `proc.exec/proc.wait/proc.kill` + `bridge:proc`（那条的实质是「每次执行经 OS 批准」，仍是点对点，只是把线从装载期挪到运行期）。
  可执行形状：**新增一件工具或一个新运行时，diff 里应当只出现「注册表/供给清单加一行」，不出现 Kotlin 装配代码、不出现 schema 新格、不出现桥方法新名。**
- **判据 D（本轮复审新立，管「可用性写在哪个载体上」）**：一件环境基础件的可用性只有两种合法载体——① `$PREFIX/bin` 里的**真名**（由 PATH 解析，见 §0 表第 3 行与 `exec-path.c:11-13`）；② 生态**本来就读的标准键**（`PATH`/`HOME`/`TMPDIR`/`LD_PRELOAD`/`SSL_CERT_FILE`/`SSL_CERT_DIR`/`CURL_CA_BUNDLE`/`GIT_SSL_CAINFO`/`SHELL`/`LANG`/`NODE_PATH`/`NODE_OPTIONS`）。**凡是只落在自造键（`LOBOS_*`、`NODE_BIN`、`PREFIX` 类）上的「可用」，都不算数**：它沿树会被剥（`ADR-0009:143`「DSH 起子进程时会剥掉 `DSH_*`，开关到不了干活进程」、`exec-path.c:15-18` 同条定罪），而且只有某一棵树的代码知道去读它——这正是 npm 那一格的病根，也是它可能复发在哪些件上的判据。逐颗复审见 §4.1。

---

## 1. 塌缩的真实位置：环境今天住在应用的启动路径里

### ① 环境是 console 的附属品

见 §0 那张三行表。后果是实读得到的，不是推断：

- console 被 `am force-stop`、或其包未安装/校验失败 ⇒ `$PREFIX` 不装配、工具链不供给。**环境的存在条件依赖一颗应用**。
- 次序不变式「`$PREFIX` 复制是**副作用**：必须先于装配执行（plan 只声明、不生产）」原先写在 `bootProgramOnce` 体内、以注释自证它是前置步骤；S1 搬家后由结构承担——`InstanceHost.kt:381-385`（第 4 步环境装配先于第 6 步 spawn）＋ `RuntimeEnvironment.kt:175-213`（装配内部先 `PrefixProvisioner.provision`、再垫片、再 `.npmrc`、最后 kick C 层供给线程；旧写「先 provision、再链 npm」里的 npm 那一格随 2026-09-30 归口删净，见上面的 B 批次条目）。那句注释随搬家删掉了，这里记的是它护的判据。

### ② 语义装配点自陈是单消费者的，并明令排除别的进程

**定罪原文（S2 前的 `GuestAdapter.kt`，这些句子随搬家已删）**：旧 `:12`「本对象是这两层装配（内核启动计划 + 探针诊断计划，command/cwd/env）的唯一生产点」——这句话当时是真的，而「真」正是判据 B 要杀的形状。
旧 `:17-18` 更把排除写成规矩：「一次性工具进程（ProgramVerifier、AdbClientRunner）不属于启动计划：它们各设自己的最小 env（HOME/TMPDIR/LD_LIBRARY_PATH），**不注入 LOBOS_\* 适配面**」；旧 `:72` 探针「最小装配（L-C，**不含任何 L-D 旋钮**）」。**S2 后的现状态**：语义生产点 `RuntimeEnvironment.kt:65-124`，`GuestAdapter.kt:6-19` 的自述只剩「console 的启动计划 + 申报」；一次性进程与探针改为共享树根（§1 ④）。今天唯一保留的「不含」是探针刻意剥掉两片垫片，理由写在 `RuntimeEnvironment.kt:42-43`，是「读数不能冒充运行态」，不是「别人不配拿语义」。

### ③ 它的命令形状是硬编码的一种程序，而且被 CI 钉住

`GuestAdapter.kt:71` `command = [nodeBin, programEntry, "daemon"]`；门禁 `container/engine/test/boot-env-contract-test.js:103` 断言「GuestAdapter command = nodeBin + entry + daemon」。**当前 CI 在保护「一比一定制」这个形状。**

### ④ 树根实测：8 个 spawn 点 / 7 个文件，只有 1 个带语义

| 进程（一个树根） | 位置 | 它拿到什么 | 它拿不到什么 |
|---|---|---|---|
| console 内核 | `InstanceHost.kt:415-425`（吃 `programPlan`） | 共享语义 ＋ console 的 `LOBOS_*` 申报 | — |
| 随包探针 | `InstanceHost.kt:851-854`（吃 `probePlan`，树根 `.copy(posixShim = null, envShim = null)`） | 共享语义（PATH/HOME/TMPDIR/CA/`LANG` 全在） | 两片垫片的注入——**刻意**：它测的是裸 node 能否 exec+listen（`RuntimeEnvironment.kt:42-43`） |
| 包校验器 | `ProgramVerifier.kt:96-102`（`putAll(treeRootEnv(treeRootFor(context), Os.getenv("PATH")))`） | 共享语义一份 | —（搬家前它自拼 `HOME`/`TMPDIR`/`LD_LIBRARY_PATH`，缺 `PATH`/`LD_PRELOAD`/CA/`LANG`；那段「靠继承这个变量找库」的注释随副本一起删除） |
| adb 客户端常驻 | `AdbClientRunner.kt:217-223`（`envFor`，spawn 侧 `:234`、`:274`） | 共享语义 ＋ 这条链路专属 `LOBOS_ADB_DIR` | —（搬家前它是第三份副本，还和 `ProgramVerifier` 抄过同一段注释——同一事实两份，正是「装配点分散」的形状） |
| 退出史采集 | `KillAudit.kt:28` `ProcessBuilder("sh","-c",…)` | 继承宿主环境 | **豁免**（§5 I2）：exec 的是系统件 `sh`+`dumpsys`，不经环境、不跑载荷；收编它会让每分钟巡检 tick 反复触发装配上屏。豁免以断言表达：`boot-env-contract-test.js:199-202` |
| PTY 探针 | `InstanceHost.kt:537` | 无 env 装配 | **豁免**：随包静态 C 件、直接 exec，刻意不登记进 native-assets（`InstanceHost.kt:528-529`），给它注入垫片等于给被测对象装脚手架 |
| 资产自证探针 | `NativePreparer.kt:336-338` | **刻意 `environment().clear()`** | 全部——这一处**正当**：它测的就是「裸环境下这颗 ELF 靠自带 `$ORIGIN` RUNPATH 能不能跑」（`:329-331` 原文「补了就是给被测对象装脚手架（门禁绿、真机全灭）」） |

三份 `baseEnv` 副本（旧 `GuestAdapter.kt:154-170`、`AdbClientRunner.kt:217`、`ProgramVerifier.kt:99` 内联）已在 S2 删净，语义唯一生产点 `RuntimeEnvironment.kt:65-124`。**本方案的脊柱不是「把这 8 点收敛成一条经桥的通路」，而是：让语义长在环境上，使每一个树根天然带语义，子树靠继承获得。**

### ⑤ 桥里唯一像 exec 的方法根本不是本机 exec（这条定罪保留，修法改名）

`shell.exec`（`CapabilityBroker.kt:988`）实读：把 `cmd` 与 `args` 拼成一条字符串（`:994-995`）交给 `AdbClientRunner.shell()`（`:996`）走无线调试通道，回包写死 `uid 2000`、`privileged true`（`:1006-1008`）。**它是「经 ADB 通道以 shell uid 执行」，不是本机 exec。** 这个名字必须改准（§6），但**不许**把它的位置补成一条「本机 exec 桥方法」——那正是判据 C 抓的形状：环境已经在树里，应用经 `child_process` 起子进程就是「在环境里执行」，不需要桥。

---

## 2. 兼容驱动今天有什么（已经做出来的部分，别重复造）

12 个环境旋钮 + 4 个 C 件 + 1 份 bionic 桩，全部真实存在、全部已编进包：

| 部件 | 兑现的 Linux 语义 | 证据 |
|---|---|---|
| `LD_PRELOAD=liblobosposix.so` | 注入开关本身 | `RuntimeEnvironment.kt:93`（垫片在场才注入，生产映射 `:155-156`）；构建 `scripts/build-native-capabilities.sh:35-45,83-92`；登记 `NativeAssetRegistry.kt:103-108` |
| `container/native/d1/exec-path.c` | shebang 与标准绝对路径按**调用方 PATH** 解析（安卓无 `/usr/bin/env`、无 `/usr/bin/X`、无 `/bin/sh`） | `:1-13`（含「中间多了一层」的自我定罪）、拦截清单 `:24` |
| `d1/link-interpose.c` | `link(2)/linkat` 的 copy-exclusive 替代（SELinux neverallow） | `:1-11,51-59` |
| `d1/open-fallback.c`、`tmp-redirect.h`、`tmp-paths.c` | 祖先目录 EACCES 回落 `$HOME`；`/tmp` → `$TMPDIR`（整条 path syscall 面） | `open-fallback.c:1-55`、`tmp-redirect.h:1-37`、`tmp-paths.c:1-21` |
| `PATH`（`RuntimeEnvironment.kt:83-91`） | 「按名字用环境里的件」的那一半，`$PREFIX/bin` 首位，`npm -g` 的 bin 也在列（ENV-4） | 注释原文「供载荷按名字解析，不改载荷内部路径（ADR-0001）」 |
| `LD_LIBRARY_PATH`（`RuntimeEnvironment.kt:78`） | 给 `$PREFIX` 下尚无 RUNPATH 的工具兜依赖 | `NativeExecutable.kt:48`「不能靠调用方补 `LD_LIBRARY_PATH` —— 运行时实例执行程序时会清空环境」 |
| `TMPDIR` 单源（`RuntimeEnvironment.kt:70`，映射在 `:146`）、`LANG=C.UTF-8`（`:74`）、`SHELL`=bash（`:120`）、`NODE_OPTIONS --require envShim`（`:123`）、`NODE_PATH`（`GuestAdapter.kt:65`＋`:78-84`） | tmp / locale / shell / node 四处安卓缺口 | 同上 |
| CA 信任根四键（`RuntimeEnvironment.kt:101-119`） | `SSL_CERT_DIR`/`SSL_CERT_FILE`/`CURL_CA_BUNDLE`/`GIT_SSL_CAINFO` | 注释带真机实证（API 37 git https unable to get local issuer；`GIT_SSL_CAINFO` 指同一份 bundle 立刻通） |
| `scripts/bionic-compat.c`、termcap 桩 | bionic 缺 `mblen`/group 枚举/`tputs` 族 | `:1-24`；`build-native-capabilities.sh:113-115` |

**这条机制事实是整个第 3 轮脊柱的地基**：**环境变量沿进程树继承**。所以兼容语义的附着单位是**树根**，不是「每一次执行调用」。这正是用户说的「它就像一个兼容驱动一样的存在」的确切含义——驱动挂在总线上，一次装好，其上所有设备都受益；而不是每次 I/O 都先向驱动申请一次许可。由此：

- 只要每一个树根都带语义，**应用内部 `child_process.spawn("git", …)` 自动可用**，因为 PATH 已含 `$PREFIX/bin`、shebang 由已注入的 `liblobosposix.so` 按调用方 PATH 兑现。⇒ 「为 exec 新增桥方法」是**多余的中间层**（判据 C）。
- 反面形状同样清晰：S2 前有 7 个树根不带语义（§1 ④），所以「环境里的件」对它们中的任何一个及其整棵子树都不可用；S2 后 OS 侧四个载荷树根共享同一份语义，剩下的两处（`KillAudit`、PTY/资产自证探针）是**刻意的裸 exec**，豁免以断言表达而不是以注释表达（§5 I2）。

**三条物理边界必须写进任何后续设计，不许留暗账**：

1. **只对动态可执行文件生效**：`build-native-capabilities.sh:99-103`「容器全部 Linux 语义（link(2)、/tmp、祖先目录）都靠 liblobosposix 经 LD_PRELOAD 落地，而 LD_PRELOAD 只对**动态**可执行文件生效。bash/rg 一旦静态，这套语义对最该生效的 shell 工具就是空的 —— 实测 `echo > /tmp/x` 与 rg 的 link/临时路径全线失败」；`build-userland.yml:12-13` 同义，且 `scripts/verify-userland-artifact.sh:2-3,21-22` 已经是**硬 CI 错误**（静态件直接判红）。⇒ 供给纪律：入 `$PREFIX` 必动态。这是 §5 E1 的准入判据。
2. **不拦 `posix_spawn`/`execvpe`**：`d1/exec-path.c:25-27` 原文（按 aarch64-linux-android21 编译，API 21 头里没有这两个声明；抬目标 API 属独立决定）；`fexecve/execveat` 同样放行（`:28`）。⇒ 经 `posix_spawn` 起子的载荷会绕过 shebang/绝对路径解析，**搬家之后仍然绕过**。
3. **不能用自定义变量当判据**：`d1/exec-path.c:16`「PREFIX 类环境变量会被 Program 子进程清理机制剥掉（真机定罪），不能当判据」，`RuntimeEnvironment.kt:96` 同义。⇒ 双重后果：兼容驱动只认 Unix 约定键（这是它「像驱动」的地方）；**并且「经桥传自定义 env」这条路本来承载不了语义**——第 2 轮那张 `proc.exec` 的 `env` 入参即便实现，也会在子进程里被剥掉，得到一条假通路。OS 侧的记账同样不能靠自定义键，只能靠进程拓扑（§5 E3）。**这条边界在仓里曾有过的一处自相矛盾已于 2026-09-29 收口**：`scripts/userland-verify.json:7` 的 pnpm 判据原先读 `process.env.LOBOS_SUPERVISOR_HOME` 去找 `supervisor/runtime.json` 才拼得出 pnpm 的路径，而那个键正是 `GuestAdapter.kt:88` 才注入、并按本条边界会被剥掉的键 ⇒ **那颗判据只有在 console 的监督上下文里跑得起来**，换成别的树根就自己先失效——这是「判据长在消费者上」的最后一个实例。现在它写成与 sqlite3/jq/git/curl 四颗同形状的裸名调用（`cp.spawnSync('pnpm', ['--version'])`，由 PATH 解析，与 `exec-path.c:14-17` 同一形状），自定义键不再承载任何语义。**仍欠的是执行者**：这条判据要由内核按清单跑一次才产生读数（S7／ENV-8），不是再改判据本身。

---

## 3. 实体与不变式

| 层 | 实体 | 唯一职责 |
|---|---|---|
| L-A | APK（`lobos/**` Kotlin）= OS | **拥有运行环境的生命周期**、供给兼容驱动、记账、分配、授权、可见性。只有环境与账，没有业务 |
| L0 | 运行环境 = 内容供给（运行时＋工具链＋`$PREFIX` 布局） ＋ 兼容语义（12 旋钮 + C 件） ＋ 它自己活在哪条生命周期上 | 让 `$PREFIX` 里任何按名字可解析的东西，被环境内任何进程直接使用，语义与 Linux 上一致 |
| L1 | Program（装载单元；`console` 只是其中一个 `role=system` 的 Program） | 自带业务、自带面板页、经桥消费系统能力；**不自持常驻进程权威**；**在自己的树里自由 spawn** |
| ~~L2~~ | ~~Workload（第 1 轮的申报格）／exec 通路（第 2 轮的桥方法）~~ | **均撤销**。前者是逐负载申报，后者是逐执行批准，都不是环境属性。理由见 §11 D-1 |

不变式（每条配一条能红的判据，§9）：

- **I1 环境属 OS 生命周期，不属任何 Program 的启动路径**：`$PREFIX` 装配与工具链供给的触发点独立于「哪颗 Program 装上了 / 起来了」。反面现形：§0 三行表。
- **I2 语义沿树继承，不许存在「无语义的树根」**：OS 侧每一个 spawn 的树根都拿到同一套兼容旋钮，**与它是不是 console、是什么运行时无关**；确有理由不设语义的（`NativePreparer.probe`）必须以**断言**表达豁免，不许只写注释。反面现形（定罪时）：旧 `GuestAdapter.kt:72`、`:17-18` 把「别人不拿语义」写成注释规矩。**S2 后在册的只有两处裸 exec，且都是断言**：`boot-env-contract-test.js:199-202`（`KillAudit` 既不自己拼 env、也不取共享树根）、`GuestAdapterTest.kt:184`（探针 env 里就是没有 `LD_PRELOAD`）。
- **I3 内容即能力**：新增一件工具＝注册表/供给矩阵加一行（`NativeAssetRegistry.kt:25-31`、`build-userland.yml:48` 已成文的形状），**不新增 Kotlin 类、不新增装配点、不新增桥方法**。
- **I4 记账与放行分离**：OS 记「哪棵树、谁出生、期望它在不在、有没有被打断」，**不**记「这颗程序该有什么参数」，也**不**充当执行的许可门。动词照 `docs/adr/0008-agent-os-init-authority.md:32` 原文「进程树以下一切生命周期：出生、退避、开关、adopt、记账；desired-state 唯一持久处」——adopt 与记账，不是批准。
- **I5 多名额**：同一台设备可同时装载 N 个运行时、N 个 Program、任意多棵子进程树；任何一个的增删不得改写其它任何一个的状态。
- **I6 被杀看得见，不复活伪装**：只承诺「打断可见」，不提供 checkpoint/replay/续跑（`console-system-api.md` §2.1 语义边界原文；ADR-0006:55、ADR-0008:49,:93）。

**「申报」在新脊柱里只剩两件事**，都不涉及「这个程序怎么跑」：① **装载**——把签过名的包放进 `files/programs/<id>/<version>/`；② **身份**——握手声明 `program` 以拿到桥能力组（`CapabilityBroker.kt:196-200`＋`ProgramAuthorizer`）。入口、参数、端口、资源按名字与 PATH 语义自然解析。**组令牌管的是「能不能调用某族桥方法」，与「能不能执行」无关。**

---

## 4. 现状对账：契约已申报 vs 实现实况

全部行号为现读。这张表的角色与第 1 轮相同、结论不同：**这些不是九格各自缺一次实现，而是同一根因（环境住在应用路径上）的症状。** 本轮新增的最后一行「环境基础件的本职」同属这根因——npm 的取包能力是真的，但兑现它所需的语义（真名入口、PATH 段、link 替代、CA 信任根）只在 console 那一棵树上成立。

| 格 | 契约 / schema 已申报 | 实现实况 | 证据 |
|---|---|---|---|
| **环境的触发点** | 契约没有这一格（本轮定罪） | S1 前：各只有一个调用点且都在 console 启动链内；现：触发点 = 宿主就位（`OsHostService.kt:93-102`），本体 = `lobos/os/RuntimeEnvironment.kt` | 搬家前 `InstanceHost.kt:224` 内三块（已删净）；现 `RuntimeEnvironment.kt:175-213` ＋ `OsHostService.kt:93-106`（post :97 → ensure :99）；`PrefixProvisioner.kt:50-84,114`；`SupplyProvisioner.kt:23-25,37,209-228,298-321`（旧写 `:198-210,301-304` 随 B 批次增删移位：建链出口现 :215-228、marker 命中支现 :298-321） |
| **兼容语义的作用域** | 契约没有这一格（本轮定罪，`base-spec.md:51` 已把它写成契约） | 定罪时：语义长在 console 的启动装配里，另 7 个树根各自为政。**S2 已收口**：整簇语义只有一个纯函数生产点，OS 侧四个载荷树根共享，两份最小 env 副本删除，两处裸 exec 以断言豁免 | 现读 `RuntimeEnvironment.kt:45-55,65-124,141,144-158`；`GuestAdapter.kt:61-67,70-105`；`ProgramVerifier.kt:96-102`；`AdbClientRunner.kt:217-223,234,274`；`InstanceHost.kt:415-425,851-854`；豁免与反复制判据 `boot-env-contract-test.js:176-202` |
| `shell.exec` 的名实 | 名字给人「本机执行」的直觉 | 实测走 ADB 通道、uid 2000、privileged 恒 true | `CapabilityBroker.kt:984-1009` |
| Program 身份 | `program-source.schema.json` 必填 `id` | `programId` 默认常量 `"console"`（`:86`），22 个构造点只有 `ProgramInstaller.kt:137` 显式传 id | `ProgramManager.kt:33,86`、`ProgramInstaller.kt:111`（默认值 `= ProgramManager.CONSOLE_ID`） |
| 身份键贯通（id → 授权） | 源 schema 同时必填 `id` 与 `name`（`id`=标识、`name`=显示名；实测三颗均不等，console 的 `name` 是「Lob OS 控制面板」） | **包内清单根本没有 `id` 字段**（`program-manifest.schema.json` required = `name/version/abi/engines/entry/requires/signature`）；构建器把源 `id` 塞进包内 `name`（`program-bundle.js:137`），授权表拿包内 `name` 与调用方 `programId` 比对（`ProgramAuthorizer.kt:26-31`）——**身份靠「字段名错位的巧合」贯通**；同一函数返回的**外层 OTA 清单** `name` 更是硬编码 `'console'`（`program-bundle.js:177`，被 `scripts/build-program-bundle.js:57-63` 原样写进 `release/program-manifest.json`）。设备侧今天**没人读这个字段**（`ProgramOtaUpdater.kt:169,202,216` 只取 `version`/`url`/`sha256`），所以它是「产物里的谎」而非运行故障；但 feed 一加 id 维度（§5 E4）就会变成真故障，必须先修再开多名额 | `program-manifest.schema.json`、`program-bundle.js:137,177`、`ProgramAuthorizer.kt:26-31`、三颗 `programs/*/manifest.json` |
| 入口脚本 | 包内 `program-manifest.json` 带 `entry` | **校验**用申报、**启动**用字面量 `bin/panel`，两套并存 | `program-bundle.js:138`、`ProgramManager.kt:112` vs `:159`、`ProgramInstaller.kt:198`、`InstanceHost.kt:317` |
| 启动参数 | 源清单 `args: ["serve"]`（console）/ `["web","--no-open"]`（dsh） | 命令恒为 `[node, entry, "daemon"]`，`args` 零消费者，并被 CI 钉成不变式 | `GuestAdapter.kt:71`、`boot-env-contract-test.js:103`、`programs/console/manifest.json:11`、`programs/dsh/manifest.json` |
| 端口分配 | §2.4 `os.ports.claim` params = `{ segment, owner, preferred? }` | 只读 `owner`+`preferred`，**`segment` 被丢**；一个 owner 恒复用一个口 | `console-system-api.md` §2.4、`CapabilityBroker.kt:616-620`、`PortBroker.kt:48-62` |
| 端口释放 | §2.4 `os.ports.release` params = `{ port, owner? }` | 只按 owner 整体删 | `CapabilityBroker.kt:621` |
| 实例操作 | §2.2 `os.instances.action` = `{ id, action }` | 第一句拒绝任何非 console 的 id | `CapabilityBroker.kt:516` |
| **os.\* 的 Program 授权** | 契约 §0 的组令牌模型（`requires: ["bridge:<组>"]` → 握手协商 + 调用时判组） | **`os.*` 全族不过组授权**：`groupOfMethod()` 把 `os.`/`capability.`/`bridge.` 一律映射为 `null`（`:162-163` 注释原文「os.* / capability.* / bridge.* 不受组约束」），而授权分支写作 `if (group != null && …)`（`:198`）——该行对 `os.*` 恒不成立。今天 console 的「独占」全靠 handler 内 `:516` 那句硬绑顶掉，**去掉硬绑就等于去掉唯一的墙**——这不是我的推断，镜像桥自己的测试就把它当不变式在测 | `CapabilityBroker.kt:165-174,196-200,516`、`bridge-authorization-test.js:40` |
| 实例读口 | §2.2 result 含 `pid?`、`port?`、`name` | `instanceJson` 无 pid、无 port，`kind` 恒 `"program"`、`name` 直接等于 id | `CapabilityBroker.kt:335-341`（`:337` 字面量） |
| 安装管理 | §2.3 `os.appmgr.install` params = `{ id?, spec?, version? }` | 桥方法**不收参数**（`{ _ -> … }`），进去就是「OTA 控制面板自己」 | `CapabilityBroker.kt:566-568,354-372` |
| 卸载 | §2.3 语义是「卸载 Program」 | 删**所有**版本目录 + 清指针 | `CapabilityBroker.kt:375-398` |
| 目录账本 | `AppRegistry` 本身通用（id/version/role/desired/port） | 唯一写者只写 console 一行，`role` 写死 `"system"`。**读侧反倒已经通用**：`AppRegistry.all()` 逐条吐进 `os.programs.list`（`CapabilityBroker.kt:317`），所以多名额缺的不是账本结构，而是「谁往里写第二行、谁来监管那一行」 | `AppRegistry.kt:81`、`OsHostService.kt:76-85`、`CapabilityBroker.kt:317,389` |
| 授权表 | 「按 Program 授权」（契约 §0，`ProgramAuthorizer` 类注释自证） | `manifestOf()` 只读当前 console 包，等于全表只有一行 | `ProgramAuthorizer.kt:20-35` |
| 监管正件 | v4 计划指定 `os/instances` InstanceManager，文档 §2.2/§40/§42/§43/§83 与面板注释都当它已存在 | **全仓零 Kotlin 定义**；实际只有账本（AppRegistry）＋单例启动器 | `os-v4-execution-plan.md:257`、`console-system-api.md:40,42,43,83`、`programs/console/src/api/lifecycle.js:54`、`InstanceHost.kt:67` |
| 进程名额 | — | 单 `nodeProcess` 字段 + 单实例锁 `supervisor/guard.lock` + `reapOrphanKernel()` | `InstanceHost.kt:67,515` |
| 控制面端口 | — | 常量 36360 靠人肉把同一个数抄进应用侧 config；清单声明的 `ports.http.env=PANEL_PORT` 无人注入 | `GuestAdapter.kt:45`、`programs/console/src/platform/config.js:22`、`programs/console/manifest.json:16` |
| 环境清单读数 | 契约只给了「native 资产」视角 | `sys.nativeAssets`（`:743`）与 `os.nativeAssets.status`（`:666`）报的是**注册表里的件**，不含工具链（git/curl/jq/sqlite3/pnpm/npm）与 `PrefixProvisioner.expected`（`:114`，旧写 `:133` 随 B 批次删链移位）。**更关键：逐件「什么算数」的判据早已随签名清单发到设备上**（`publish-userland-manifest.js:90-92`：件没判据**不许发布**，`t.verify={criterion,node}` 进清单），**而全仓没有任何一方执行它**——内核 `SupplyProvisioner.kt:253-256` 只取 `name/url/sha256/entry`，`LOBOS_PROBE_PASS` 在整个仓里只有判据自身一处命中 ⇒ 「环境里有什么能用」是**判据已就位、执行者缺席**的暗账 | `publish-userland-manifest.js:90-92,115`、`SupplyProvisioner.kt:253-256`、`scripts/userland-verify.json`、`NativePreparer.kt:97,264`、`CapabilityBroker.kt:666,743`、`PrefixProvisioner.kt:133` |
| 环境基础件的本职（npm） | `base-spec.md:50` 定「npm 客户端｜**运行时可用**」＋「全局前缀固定 `$HOME/.npm-global`」；`layout.json:398-400` 定工具由环境自己装进 `$PREFIX`、自更新 | （S1 前）npm 只有**宿主代跑**形状的入口（`npm-cli.js` 绝对路径经 `LOBOS_NPM_ENTRY`/`runtime.json` 的 `npmEntry`），而自定义 `LOBOS_*` 会被载荷子进程剥掉 ⇒ 环境内按名字调 `npm` 不成立。**S1 已补真名**：`$PREFIX/bin/npm` → `npm-cli.js` 的符号链接（`PrefixProvisioner.kt:108-125`）；「按名字可得」的设备读数仍待 V-0c；**S2 已把 `$HOME/.npm-global/bin` 放进 PATH**（`RuntimeEnvironment.kt:83-91`，ENV-4），`NODE_PATH` 第二段改指全局前缀的 `lib/node_modules`（`GuestAdapter.kt:78-84`，ENV-5）；`--ignore-scripts` 的成文理由「容器无 sh 可 spawn」在 D1（bash 进 `$PREFIX/bin`、shebang 按调用方 PATH 兑现）之后已失效 | `base-spec.md:50`、`NodeProvisioner.kt:35,38-44,46-59,86-133`、`RuntimeEnvironment.kt:83-91`＋`GuestAdapter.kt:103`、`InstanceHost.kt:393,890-911`、`container/native/d1/exec-path.c:11-17`、`d1/link-interpose.c:1-3` |

### 4.1 逐颗环境基础件的本职对账（你要求的复审：npm 那一格不是孤例）

判据按 §0 判据 D 走：**真名可达（或标准键）＝可用；只活在自造键里＝不算可用**。逐颗现读：

| 件 | 真名可达（载体） | 它本职还需要的东西 | 现读到的破口 | 归类 |
|---|---|---|---|---|
| **node** | ✓ `$PREFIX/bin/node` 是指向 libnode.so 的**链接**（不是复制），`$ORIGIN` 因此仍落在 nativeLibraryDir 拿到 `libc++_shared.so`（`PrefixProvisioner.kt:86-106`），PATH 首位（`RuntimeEnvironment.kt:83-91`） | shebang 解释器按 PATH 解析 ✓（`d1/exec-path.c:11-13`）；`os.cpus()` 空 ⇒ `NODE_OPTIONS --require envShim` ✓（`RuntimeEnvironment.kt:123`） | 定罪：`NODE_PATH` 第二段曾指向 `filesDir/node_modules`（旧 `GuestAdapter.kt:91-96`），而 npm 的全局前缀是 `filesDir/.npm-global`（`NodeProvisioner.kt:35,44`）⇒ 两个键指向不同目录，而旧第一段那个目录全仓没有创建代码 ⇒ `npm i -g` 装出来的库在任何树里都 `require` 不到。**S2 已收口（ENV-5）**：第二段由 `NodeProvisioner.globalNodeModules` 派生（`GuestAdapter.kt:78-84`），与 `.npmrc` 钉的 prefix 同一事实源 | 补齐（E2 键集一格）——已完成（static） |
| **npm** | ✓ **归口 C 清单（2026-09-30）**：与 pnpm/git 同一条口 —— `scripts/build-userland-npm.sh` 打成内容寻址件 → 对象存储 → 清单带 `url`/`sha256`/`entry=bin/npm-cli.js`，设备侧建 `$PREFIX/bin/npm` 的**符号链接**并在每轮对账时重申（`SupplyProvisioner.kt:209-228`），`#!/usr/bin/env node` 由 `d1/exec-path.c:11-13` 按调用方 PATH 兑现。**APK 侧不留 npm 面**：`assets/npm/` 投放与 `scripts/stage-npm-assets.sh` 已删，`NodeProvisioner.ensureNpm`／`PrefixProvisioner.linkNpm`／`GuestAdapter` 的 `LOBOS_NPM_ENTRY`／`runtime.json` 的 `npmPath`·`npmEntry` 四处同批删净，由 `boot-env-contract-test.js`（四处零命中）与 `verify-apk-native.sh` 第 6 格（反向：包内出现 `assets/npm/` 即退 1）钉住。定罪形状（旧行号，原样记着）：`NodeProvisioner.kt:86-133` 只产 `npm-cli.js` 绝对路径并挂自造键（旧 `GuestAdapter.kt:103`），S1 补了链接、S2 铺了 PATH，本批把「代跑」那一半整块摘掉 | `sh` ✓、TMPDIR ✓、CA ✓、`node` 自身 ✓、`.npmrc` 钉 prefix ✓（`NodeProvisioner.kt:50-59`） | ①**执行位**：件内 `bin/npm-cli.js` 是 shebang 脚本，落盘给位已改成按内容判（`runtime/ExecBits.kt`，ENV-25）——**设备复点未做**；②**`npx` 无真名**：清单是一件一入口，发布器也不产出任何 `aliases`（`publish-userland-manifest.js:60-67` 只写 url/sha256/entry，全仓 `aliases` 零命中），npm 件里的 `bin/npx-cli.js` 因此没有任何链接指向它 ⇒ 新立 **ENV-26**；③**成文契约的对账门不存在**——旧 `base-spec.md:50` 声明「两处目录名由 `test-chain-completeness-test.js` 逐字对账」，实读该文件 33 行、`npm` 零命中，它引用的 `runtime-contract.js`／`npm-contract-chain-test.js` 全仓不存在 ⇒「两侧同一事实」只剩 `.npmrc` 一侧（ENV-19 已按「删净」收口，真对账由 §10 第 8 条与 V-0d 载体判据接管） | 补齐 ＋ 文档收口（§10 第 8 条）；剩 ①② 有账可追 |
| **pnpm** | **投放已上线、待设备复点**：这颗改走构建口 —— `scripts/build-userland-pnpm.sh` 取上游 `@pnpm/exe.android-arm64` 里的 ELF（双钉：tarball 的 sha512 = 上游 packument 的 `dist.integrity`，件内 ELF 的 sha256），经 `package-userland.sh` 打成内容寻址 zip 投对象存储，清单于是带上 `url`/`sha256`/`entry=bin/pnpm`（`build-userland.yml:48` 矩阵）⇒ 与其余四颗同一条供给链，落位即按真名可解析。线上现读（2026-09-30，run 36598918309 发布后）：清单 `version=2026.09.29.145` tools=5、这颗 `url=https://hubcdn.zll.ink/userland/userland-pnpm-12.7.0-8830e2a78936-android-arm64.zip`、22,691,176 字节，实取的 sha256 与清单、与文件名里的内容哈希三者全等；件内 `bin/pnpm` 47,033,992 字节、sha256 `ce0b5e06…` 与在仓外独立取到的上游 ELF 逐字节全等。**仍欠设备复点**（`$PREFIX/bin/pnpm --version` 真跑一次）。定罪形状（原样记着）：清单里这颗曾是 `provider: "npm"`、**没有 `url`**，被供给循环 `url.isEmpty()` 一句 `continue` 掉（在册 `DS-9`：「清单声明 5 件、设备只装到 4 件」） | 同 node/npm | ①**投放已完成**——`scripts/delivery-gate.js` 那扇读线上的门 2026-09-29 现读 `FAIL（1 项）… 没有取件 URL：pnpm`，2026-09-30 投放后现读 `声明键全部在线且身份干净`（`tools=5`、无 url 的件 0 颗）；②**判据不吃真名**——旧写法（`userland-verify.json` 读 `LOBOS_SUPERVISOR_HOME`＋`runtime.json` 拼绝对路径去 spawn）已改成裸名 `cp.spawnSync('pnpm', ['--version'])`，与 sqlite3/jq/git/curl 四颗同形状（ENV-6）；判据的**执行者**仍欠（ENV-8/S7） | 待真机复点 |
| **bash / `sh`** | ✓ 复制进 `$PREFIX/bin`（`PrefixProvisioner.kt:17-20`），`/bin/sh`、`#!/bin/sh` 由 `exec-path.c:89-94,182-185` 兜到 bash（argv[0] 仍叫 `sh` 即 POSIX 模式），`SHELL` 注入 ✓（`RuntimeEnvironment.kt:120`） | 跑脚本 ⇒ 脚本按名字要 `cp/mv/sed/awk/grep/find/tar/gunzip/xargs` | **coreutils 在成文必备清单里（`base-spec.md:51`）却零供给路径**：三处内容源都没有它——`build-userland.yml:48` 矩阵 `[sqlite3,jq,git,curl,pnpm]`、`NativeAssetRegistry.kt:123` 的 `ALL`、`PrefixProvisioner.kt:17-20` 的 `BINS`（只有 bash/rg） ⇒ 环境里任何 shell 脚本普遍跑不完本职 | 清单在册、供给缺席（内容动作，不是设计） |
| **rg** | ✓ 复制进 `$PREFIX/bin`，`DT_RUNPATH=$ORIGIN` 的依赖件 libc++ 同目录落位（`PrefixProvisioner.kt:21-26`） | 无 | 无——这颗是判据 D 的**合格样本**：真名＋依赖随附＋不靠任何自造键 | ✓ |
| **git** | ✓ 真名＋件内链接农场（`libexec/git-core/git-* → ../../bin/git` 等，`SupplyProvisioner.kt:154-196`；DS-7 定罪后 marker 命中仍复验农场）；**但**农场之外留下的**真独立二进制**（与 bin/git 不同尺寸者，`build-userland-git.sh:335-345` 的 KEPT 那格）落在 `libexec/` 前缀判据之外 ⇒ 没有执行位（改前 `SupplyProvisioner.kt:145`，在册 `ENV-25`）⇒ `git clone/fetch/push` 按路径 exec `git-remote-http` 一类子命令会红 | `GIT_SSL_CAINFO` ✓（`RuntimeEnvironment.kt:110-119`，真机实证就在同段注释）、TMPDIR ✓、hooks 靠 shebang＋PATH ✓ | **物理边界（须显形，不许拦也不许装成功）**：件里 OpenSSL 静态、`--without-libssh2 --disable-ldap --without-libidn2`（`build-userland-git.sh:120,164`，`:5` 自述「一个件就能 https clone，不必再拖一串 `.so`」）⇒ `git@…`/`ssh://` 传输不可用且环境里也没有 `ssh`；`git commit` 不带 `-m` 要 spawn `$EDITOR`、`git log` 默认 pager（环境无 vi/less） | 真边界 → journal/读数可见 |
| **curl** | ✓ 真名 | 信任根 ✓（`CURL_CA_BUNDLE`/`SSL_CERT_FILE`/`SSL_CERT_DIR` 三键同注，bundle 每次开机重播 `PrefixProvisioner.kt:72-81`） | 同一类物理边界：`--without-libpsl --without-libssh2 --without-libidn2`（`build-userland-curl.sh:86`）⇒ SFTP/SCP 与 IDN 域名不支持 | 真边界 → 可见 |
| **jq / sqlite3** | ✓ 真名 | 自包含（oniguruma 静态编进件里，`build-userland-jq.sh:76-100`） | 无；判据也写成裸名（`userland-verify.json:9-16`）⇒ 合格形状 | ✓ |
| **python** | ✗ | —— | 成文清单在册（`base-spec.md:51`）但零供给 ⇒ **「装了运行环境里面什么都能跑」今天只对 node 一颗运行时成立**。补它＝注册表/清单加一行（正是判据 C 要求的形状），不该出现任何装配代码 | 清单在册、供给缺席 |
| **原生绑定件**（`liblobosflock.so`、`liblobospty.so`） | flock 只活在自造键 `LOBOS_FLOCK_NATIVE`（`GuestAdapter.kt:98-100`，**本仓零运行时消费者**，靠 vendor 内部 dlopen，文件缺席时逐字回退）；pty 落在约定路径 `$PREFIX/lib/pty.node`（`PrefixProvisioner.kt:29`） | —— | flock 那一格与 npm 同病：可用性写在自造键上 ⇒ 按判据 D 不算数（回退语义还在，但「有没有兑现」无人可读） | 补齐读数（S7） |

| **契约文本自身** | —— | —— | `base-spec.md:51` 仍写着 C 层机制「**自写 `#!/system/bin/sh` 可执行入口**（安卓无 `/usr/bin/env`，npm 生成的 bin shim 不可 execve）」——这正是 `d1/exec-path.c:8-9` 定罪过的旧补法（「给每个工具手写一层包装……那才是中间多了一层」），而 `:11-13` 声称补回约定后 npm 的原生 shim 已按原样工作。实读：**全仓没有任何代码写 shebang 入口**（`system/bin/sh` 在主干里只出现在 `RuntimeEnvironment.kt:120` 的 `SHELL` 兜底值），`SupplyProvisioner.kt:198-210` 建的是 `bin/<name>` 符号链接 ⇒ 契约在要求一件实现里不存在、且已被定罪的机制 | 契约与实现两本账（§10 第 9 条） |

**复审结论**：同一形状（将「可用」写在宿主代跑／自造键上，而不是写在真名与标准键上）**在 npm、pnpm 判据、flock 件三处复发**；**另有一格不在这条轴上**：可执行性由**打包路径前缀**决定而不是由件自身内容决定（`ENV-25`，npm 的 `npm-cli.js` 与 git 件 `libexec/` 的真二进制同病）⇒ 「有真名」与「跑得动」是两件事，判据 D 只承认后者。另有 **coreutils、python 两格是成文必备却零供给**；**git over ssh、curl over SFTP、需编译的 native 依赖、`$EDITOR`/pager 四类是物理边界**，只能如实显形；**契约文本自身还在要求那种逐件包装**，得改。**修法一律是「补真名 / 换成生态本就读的键 / 让失败上屏 / 把契约改成实现的样子」，没有任何一格的答案是「给这颗件加登记、加申报、加桥方法」**——所以本轮复审不新增概念，只把判据 D 立成一条可机械检查的规矩（§9 V-0d）。
**净新增概念：0 个。**（第 1 轮说「净新增只有 Workload 一格」，第 2 轮说「净新增只有 `proc.*` 一条通路」，两轮都撤。本方案的动词全部是**搬家与收口**。）

---

## 5. 改法：五个格

### E1 环境的生命周期搬家（本方案主件）

- **落点**：新增 `lobos/os/RuntimeEnvironment.kt`——它不新增机制，只是把今天分散在 `InstanceHost` 启动链里的**环境装配**收成一个有名字的 OS 组件：① `$PREFIX` 内容布局（现 `PrefixProvisioner`）；② C 层工具链供给（现 `SupplyProvisioner`）；③「环境里有什么、是否就位」的单一读数（现 `PrefixProvisioner.expected` `:105` + `NativeAssetRegistry.ALL` `:123` + 供给 link-farm）。
- **触发点搬家**（S1 已落地，static 档）：从 `bootProgramOnce` 内的 provision/npm/供给三块搬到宿主组件的就位路径（`OsHostService.kt:93-106` → `lobos/os/RuntimeEnvironment.kt`）。现读候选宿主已在做 OS 级播种：`lobos/lifecycle/OsHostService.kt:60-90`（`onStartCommand` 里做 `ResidencyAudit`、状态机 `OsInit.transition(:71)`、`AppRegistry.upsert(:77-85)`、`DozeBackstop.schedule`），环境播种与该路径同族、与「console 是否装上」无关。**绝不允许改成「console 起来后才供给」的周期自愈**（I6、`feedback-single-link-over-fallbacks`）。
- **准入判据（供给纪律，不是建议）**：入 `$PREFIX` 的可执行件必须动态链接（§2 边界 1）。抓手已存在：`verify-userland-artifact.sh:2-3,21-22` 对 userland 已经是硬错误。E1 要做的是把「动态」从构建脚本约定升级为**注册表字段**（`NativeExecutable` 增 `linkage`，`NativeAssetRegistry` 单源），使新增运行时在**装配期**红，而不是真机 `echo > /tmp/x` 失败。
- **环境基础件在环境里必须有真名**（本轮新增的缺口，属搬家补齐、不是新机制）：pnpm 走 C 清单，落位后按名字可解析；npm 定罪时只有 `files/npm/<ver>/bin/npm-cli.js` 与 `LOBOS_NPM_ENTRY`/`runtime.json` 的 `npmEntry` 两个**宿主代跑**形状的入口（`NodeProvisioner.kt:86-133`、`GuestAdapter.kt:103`、`InstanceHost.kt:890-911`），而自定义 `LOBOS_*` 键会被载荷的子进程剥掉（`RuntimeEnvironment.kt:96`、`container/native/d1/exec-path.c:14-17`）⇒ 环境里的住户按名字调 `npm` 这条路在定罪时不成立；**S1 已补真名**，设备读数待 V-0c。E1 的装配内容补「npm 在 `$PREFIX/bin` 有真名」，判据与 `PrefixProvisioner.kt:31-33` 同源（那次 `command -v node` 全 MISSING 的报告，病的就是同一个格；`d1/exec-path.c:11-13` 的注释目标形态本就写着「补回之后 **npm/pip 的原生 shim** 全部按原样工作」）。同时 `$HOME/.npm-global/bin` 曾不在 PATH 组装的两段里（旧 `GuestAdapter.kt:125,169`）——**S2 的 PATH 纯函数已把这一段加进去**（`RuntimeEnvironment.kt:83-91`，ENV-4）。
- **局部判据**：console 未安装 / 被 force-stop 时，`$PREFIX` 仍在位、`git`/`bash`/`rg` 仍可由任一进程按名字解析（V-0b）。**这条在搬家前必红，是 S1 的对照。**

### E2 语义装配搬家 ＋ 树根收编（明确不做的事更多）

- **不做 exec 服务、不做名字解析面、不做桥方法**（§0 判据 C、§2 地基、§2 边界 3 三重理由，见 §6 开头）。名字解析这件事**已经有人做了**，就是 `PATH`（`RuntimeEnvironment.kt:83-91`）＋ `d1/exec-path.c:11-13`；把它再包一层 API 就是「中间多了一层」，而 `exec-path.c:8-9` 早就用这句话定过旧补法的罪。
- **落点**（S2 已落地 static）：兼容旋钮整簇（旧 `GuestAdapter.kt:113-149` ＋ 旧 `:154-170` 的 `baseEnv`）搬进 `lobos/os/`，形状是**纯函数** `treeRootEnv(root, inheritedPath)`（`RuntimeEnvironment.kt:65-124`）：输入是 `TreeRoot` 纯数据（`:45-55`）加继承来的 PATH，输出完整键值 map，不吃 `Context`（可测性约束同 §5 E5）——计划里设想的 `semantics()` 名字没有落地，落地的是同一形状的另一名字，此处按实读写。`TreeRoot` 的唯一生产点是 `treeRootFor`（`:141`、`:144-158`），一次性进程与探针都从它取。三份 `baseEnv` 副本（旧 `GuestAdapter.kt:154`、旧 `AdbClientRunner.kt:217`、旧 `ProgramVerifier.kt:99` 内联）删除，两个一次性进程改为直接取共享树根（`ProgramVerifier.kt:96-102`、`AdbClientRunner.kt:217-223`）。
- **谁起一棵新树的三个合法形状**（都不需要新桥方法）：
  1. **Program 在自己的树里 spawn** —— 它本就跑在带语义的环境里，`child_process` 继承即得。这是「装了 node 所有 node 程序都能跑」「用到 git 直接调」的实现形状。应用侧禁令 `console-system-api.md:161`（不许自持常驻/退避/自拉起）**保持不变**，它管的是常驻权威，不是「能不能起子进程」。
  2. **OS 内部工具进程**改用 E2 的语义装配，不再各抄一份最小 env：`ProgramVerifier.kt:96-102`、`AdbClientRunner.kt:217-223` 已收编。**`KillAudit` 不在此列**——它 exec 的是系统件 `sh`+`dumpsys`、不经环境也不跑载荷，收编它会让每分钟巡检 tick 反复触发装配上屏（诊断刷屏）；按 I2 走**断言豁免**（`boot-env-contract-test.js:199-202`）。这是对 §8 S2 行原写「收编 KillAudit」的一处偏离，理由记在 S2 执行记录。
  3. **OS 自己起的常驻 Program**（现 console 内核）：命令不再硬编码 `[node, entry, "daemon"]`，`entry`/`args` 从清单读（§5 E4），环境由 E1 提供、语义由 E2 提供、出生记入 E3。
- **`GuestAdapter` 的归宿**：装配职责清空后只剩 console 这颗 Program 的**申报值**（`CONSOLE_PORT`、`LOBOS_UI_DIR`、`LOBOS_BRIDGE_SOCKET` 等 `LOBOS_*` 一族），退回给清单/调用方传入。判据 B 已转绿：`LD_PRELOAD` 现在 `RuntimeEnvironment.kt:93`，`GuestAdapter` 里再出现任何树根键装配即红（`boot-env-contract-test.js:191`）。
- **搬家必须同批改的两道门（否则要么门空转、要么整条红）**：
  - `boot-env-contract-test.js` 按**文件名**钉语义装配（S2 后实读行号）：`:32-33` 同时取 `GuestAdapter.kt` 与 `RuntimeEnvironment.kt`、`:48`「键集解析非空（≥12 个，防空转）」、`:74` PATH 组装点唯一（判定由 `>=1 && <=2` **收紧**为 `=== 1`）、`:77` `InstanceHost` 不再内联组装环境键、`:82-83`/`:87`/`:90`/`:97` 逐键（TMPDIR 单源与映射、LANG、NODE_OPTIONS、NODE_PATH 双段）、`:103` 钉 command 形状。**改的是判据对象，没降断言强度**；判定 5（`:157-202`）是本轮新增：三个消费者都走 `treeRoot(Env|For)`（`:176-178`）、消费者重复拼 HOME/TMPDIR 即红（`:184`）、`GuestAdapter` 泄漏 12 个树根键任一即红（`:191`）、PATH 段里必须有 `NodeProvisioner.globalBin(`（`:192-193`）、KillAudit 豁免以断言在册（`:199-202`）。`:103` 换成反向断言「exec 通路不假定 `command[0]`」**属 S3/S7，本轮没做**，不许当成已完成。
  - golden 向量原在 `GuestAdapterTest.kt:46,122`（`:122` 直接 `assertEquals(… "liblobosposix.so", env.getValue("LD_PRELOAD"))`）。S2 后它测的是「console 申报 ＋ 共享树根语义」两层，且**同一个键值断言对两种 plan 同时成立**：`:113-123`（HOME/TMPDIR/LD_LIBRARY_PATH/NODE_BIN 走 `programPlan` 与 `probePlan` 各一遍）、`:97-100`（PATH 四段逐序）、`:103-109`（探针 PATH 与内核同源）、`:139`（`LD_PRELOAD` 逐值）、`:184`（探针 env 里就是没有 `LD_PRELOAD`）。"迁到新的纯函数用例"这条没有另立新文件——`treeRootEnv` 本身就是那个纯函数，golden 留在原文件即已脱离 Android。防空转判据「键集 ≥12」仍在 `boot-env-contract-test.js:48`（`feedback-gates-cannot-idle`）。

### E3 树根记账：`InstanceManager`（契约 §2.2 的正主）

- 表 `pid → { ownerProgram, label, desired, phase, attempts, port? }` ＋ 按 owner 的索引；**归属靠进程拓扑推导，不靠声明**：读 `/proc/<pid>/` 的 ppid 与 uid/上下文，沿树递归归到最近一个在册树根（理由：§2 边界 3——自定义 env 键会被剥掉，拿它当归属键会得到随时间漂移的假账）。
- `kind` 不再恒 `"program"`（拆 `CapabilityBroker.kt:337` 那个字面量），并把「树内子孙计数」补进读数，否则面板看到的仍是「一个 Program」而不是「一棵树」。
- `InstanceHost` 降级为「把宿主 intent 转给 E1/E2/E3」；单 `nodeProcess` 字段（`InstanceHost.kt:67`）与 `reapOrphanKernel()`（`:558`）泛化为 **adopt-or-start per 树根**（收养优先于杀重拉；口径出处 `docs/adr/0008-agent-os-init-authority.md:32` 的 adopt，与 `docs/plans/archive/agent-os-execution.md:20` P1 行）。
- 退避与重启计数：复用 `Backoff.exponential()`（`Backoff.kt`，已声明为唯一实现）与 `SupervisorPolicy.nextRestartCount()`（`SupervisorPolicy.kt:62`），按被监管项各存一份。
- 三个出口必须同调（OTA 锚点收口立的规矩）：`programs.json` 的 desired、常驻通知、`os.instances.*` 读数；任一处对不上即判红。
- **开机 reconcile 与进程外复活的区分必须成文**：从账本重放 desired 属正常开机装配；被禁的是「OS 进程之外把 OS 自己点回来」的边（ADR-0006:55、ADR-0008:49,:93 原文）。写进新 ADR（§10 第 6 条），否则下一个人会拿 ADR-0006 否决正常监管。

### E4 装载与身份：`ProgramManager` 去默认 id ＋ 清单驱动入口

- 去掉 `ProgramManager.kt:33` 的 `= CONSOLE_ID` 默认值、`:112` 的 `bin/panel` 字面量；调用点显式传 id。`:21,30,109` 三处注释已经把「entry 是脚本参数、必须由解释器解释」写成不变式，搬家时保留该注释所护的判据（`assertNotDirectlyExecutable`，见 `InstanceHost.kt:328`）。
- **身份键补齐（前置，不落这条第二颗 Program 一装就撞）**：包内 `program-manifest.json` 增 `id` 并必填，目录键与 `ProgramAuthorizer` 比对键都改吃 `id`；今天靠 `program-bundle.js:137` 把源 `id` 写进包内 `name` 才勉强对上，而外层 OTA 清单 `name` 恒 `'console'`（`:177`）——巧合不是设计。
- feed 侧缺口（登记，不许绕）：`ProgramOtaUpdater.kt:52-53` 的 URL 是**滚动单 tag**（`$baseUrl/$releaseTag/program-$version.zip`），一条 feed 只能描述一颗 Program；多 Program 必须先扩 feed；**扩法已在 §11/§12.2 定为「一 id 一 tag」**（feed 增 id→tag 映射），不改设备运行语义。
- 保留：`files/programs/<id>/<version>/` 布局与 `CURRENT`/`FLOOR`/`PENDING` 指针语义（AUD-G28 已按 id 分目录，指针天然 per-id）。

### E5 分配与授权：`PortBroker` 多租化 ＋ `ProgramAuthorizer` 多行化

- **端口**：lease key 从「owner」改为「`<owner>/<segment>/<slot>`」复合键；`segment` 由树根身份（E3）推导，**不让应用自报区间**。契约补齐：实现 `os.ports.claim` 的 `segment`（`CapabilityBroker.kt:616`）与 `os.ports.release` 的 `port`（`:621`），使实现形状等于 `console-system-api.md` §2.4 已写的形状。现 1000 口单窗口（`PortBroker.kt:15-16`）不够时，**扩窗口是 OS 事实、不是应用诉求**：§11 D-3 已定本轮**不动数字**（维持 41000–41999），只做 key 复合；真要动数是装下第二颗需要监听口的 Program 之后的事，那时改的是一个常量。不变式：`ports.json` 只有一个写者（OS）。
- **授权**：`manifestOf(programId)` 按 id 取当前生效包的清单。引擎侧形状已对——`container/engine/src/bridge/server.js:15-28` 的 `loadProgramRequires()` 已是「遍历 `programs/<id>/manifest.json`、按 `m.id` 建多行表」，`:77-92` 握手按 `params.program` 发 `authorizedGroups(program)`；原生侧才是塌缩的那一侧。未声明 id、或声明 id 与清单不符 → 只有 `base`（沿用现规则）。**注意现「与清单不符」比的是包内 `name`，而那个 `name` 装的是源 `id`（§4 身份键贯通行）**——多行化必须与包内清单增 `id` 同批做。
- **本轮不给「执行」设组令牌**：`bridge:proc`（第 2 轮提法）撤销。令牌只用于桥能力组；执行是环境属性，不是可调用的能力。
- **可测性约束（决定 V-5 有没有 CI 这条腿）**：Kotlin 单测面是纯 JUnit 4（`container/app/build.gradle.kts:263` 只有 `testImplementation("junit:junit:4.13.2")`，无 Robolectric；`container/app/src/test/**` 共 20 个用例文件，全部只喂纯参数，如 `ProgramOtaResolutionTest.kt:14`），而 `groupsFor(ctx, programId)`/`manifestOf(ctx)` 都吃 `Context`，照这个形状**写不出 JVM 单测**。落地：把「清单 JSON + 声明 id → 组集合」抽成不吃 `Context` 的纯函数，`ProgramAuthorizer` 只留读文件的薄壳；新单测放 `container/app/src/test/java/lobos/bridge/`，由 `ci.yml:242 app-tests` 跑。E2 的语义装配同受此约束（纯函数才能进 JVM 单测）。

---

## 6. 桥方法面（只修既有方法的形状，不新增执行面）

**先记一条「不做」：桥不新增 exec/spawn/wait/kill 面。** 三条带出处的理由：

1. **语义的附着点是树根，不是调用**：环境变量沿进程树继承（§2 地基）。兼容驱动已经在 `LD_PRELOAD` 这一层把 shebang/绝对路径/`/tmp`/`link` 全都兑给了整棵子树，再在桥上开一个 exec 方法，就是把「驱动」降级成「每次调用的中介」。
2. **「经桥起进程」＝每次执行要经 OS 批准，正是被否决的形状**：用户原话「并不需要我每次都要去单独地为每一个产品或者每一个应用单独再造一个通道」。第 2 轮那张 `proc.exec` 就是把线从装载期挪到了运行期。
3. **它承载不了语义**：自定义 env 键会被 Program 子进程清理机制剥掉（`d1/exec-path.c:16`、`RuntimeEnvironment.kt:96`），所以「经桥传 env 起进程」这条路的入参在子进程里不成立——会得到一条看起来能用、实际每次都不同的假通路（§2 边界 3）。

下面每一条都是**既有**方法按其自身契约补齐形状，不新增族：

| 方法 | 动作 | 理由 |
|---|---|---|
| `os.instances.action` | **去掉 console 硬绑**（`CapabilityBroker.kt:516`），按在册 id 操作，未知 id 才拒 | 契约 §2.2 本来就写 `{id, action}` |
| `os.instances.get` / `list` | result 补 `pid`、`port`、真实 `name`、`kind`，并加**树内子孙计数** | 契约 §2.2 已写，实现少给（`:335-341`）；计数让「一棵树」在读数里成立，否则 E3 的拓扑记账看不见 |
| `os.appmgr.install` / `upgrade` / `uninstall` | 收 `id`（`install` 必填），按 id 落位与清理；uninstall 只删指定 id 及其指针 | 契约 §2.3 已写 `{id?, spec?, version?}`；现状不收参、uninstall 删全部（`:375-398`） |
| `os.ports.claim` / `release` | 分别消费 `segment`、`port` | 契约 §2.4 已写 |
| `sys.nativeAssets` / `os.nativeAssets.status` | 读数扩成**环境清单**：注册表件 ＋ `$PREFIX` 在位件 ＋ 供给 link-farm 件；保留两者既有分工（一个「现在就验一次」、一个「上一轮落盘结论」，`CapabilityBroker.kt:662-665` 原文理由） | 「环境里有什么」现在分三处、没人拼全（§4 末行）；V-1 需要一处可读 |
| `shell.exec` | **语义不动**，名字改准：它不是本机 exec，是「经 ADB 通道以 shell uid 执行」 | 现状（`:984-1009`）与名字给人的直觉相反；禁止再让两个人往 `shell.exec` 上接不同期望。**注意修法是把契约里的名字与描述改对，不是把它替换成一条本机 exec 方法** |
| `os.state.get` | 不变 | 状态出口已单源 |

**去硬绑必须同批配隔离（安全回归，否则 S6 就是拆掉唯一的墙而不砌新的）**：把 `:516` 换成「按在册 id 操作」之后，若 `os.*` 仍无调用方身份判据，就是「任意 Program 可停/起任意其它 Program」。落地形状：`instances.action` 与 `appmgr.*` 的按-id 写操作纳入**已在册**的组令牌 `bridge:app_control`（`GROUP_REQUIRED:1266`），并由握手已握手的 `peerProgram`（`:155-159`）推导默认作用域——**调用方只能操作自己出生或所属的那棵树**；跨 Program 需要显式的另一格授权。`exec` 不在其列，因为环境不批准执行（判据 C）。

**方法论保留（撤销的是令牌，不是这条实读结论）**：`groupOfMethod()`（`:165-174`）只把 `app./ui./shell./fs./build./notif.|notify./sys.` 映射到组，`else -> null`；授权分支是 `:198` 的 `if (group != null && !peerGroups.contains(group))`。**所以今天 `os.*` 全族没有一行 Program 授权代码在跑**，镜像桥自己把这当不变式测（`bridge-authorization-test.js:40`「os.* 不受组授权约束（按方法自身 caps 判）」；现读该文件 `:22-40` 共 8 条 check，测的是 `container/engine/src/bridge/server.js` 而非 Kotlin）。推论：**将来任何新增组令牌**都必须同批动四处同源点（`container/engine/src/bridge/methods.js:11 GROUPS`、`methods.js:177-187 GROUP_REQUIRED`、`CapabilityBroker.kt:165-174`、`CapabilityBroker.kt:1265-1277 GROUP_REQUIRED`），漏掉 `groupOfMethod` 就得到一条「申报了也没人查」的空转门；跨语言形状门 R6（`bridge-methods-crosslang-test.js`）会盯着对齐。`GROUP_REQUIRED` 的代表能力位置可以用 `base`（`:1270` `bridge:shell → adb_shell` 证明该位可只作纯授权门），并记住 `:1276` 那条教训——代表能力写错会让整组永不可用。本次不新增令牌，所以这四处的改动只发生在**描述既有组**的形状上。

---

## 7. 可见性 / journal

环境里每一棵新树与每个 Program 的 phase 迁移一律进同一条 journal 类别（`instance`），不新造类别词，避免又一份词表漂移；面板侧那 4 处显示契约错位（journal 分类词表、`eventDetail` 的 data 形状、生命周期 id 命名、任务 kind/state）**属另一根因**（展示契约没按 v4 生产者重推，见 `project-panel-forensics-47-to-48` 那一轮定罪），不在本方案范围，单独一单收，但验收时一起看——否则「环境补上了、屏幕上还是空的」会被误判成环境没补。

语义边界照 `console-system-api.md` §2.1 原文约束：journal 只做「打断可见」，**不得出现任何「恢复/续跑」接口**（I6）。

---

## 8. 落地步骤（照此执行，每步自带局部判据）

先交代四条决定步骤切分的实测事实，否则「要不要重出壳」就是猜的：

- **CI 能验的范围比想象大**：`container/engine/**` 在设备上**不运行**。实读 `container/engine/src/bridge/server.js` 的消费者只有 4 个测试文件（`bridge-e2e` / `bridge-interop` / `bridge-authorization` / `native-assets-test.js`），它是 CI 侧的镜像桥；`methods.js` 是声明表，与 Kotlin 由跨语言形状门（`bridge-methods-crosslang-test.js`）三向对账。**所以申报透传、schema、契约登记、授权对账全在 CI 闭环，不重出壳。**
- **设备上真正在跑的只有两处**：Kotlin（`container/app/**`，冻结进 APK；**随包 assets 同属壳内**，如 `container/app/src/main/assets/node/server.js` 探针、`assets/program-feed.json`）与 `programs/console`（签名 OTA 热更新）。凡改 `container/app/**` ⇒ 必出壳；只改 `programs/**` ⇒ 走 `program-ota.yml:70 build-program`，不动壳。**注：E1/E2 主件是 Kotlin，所以 S1/S2 必出壳；这是本方案唯一动到常驻链的部分。**
- **随包探针不算数**：`assets/node/server.js` 只是「node 能否 exec + listen」的探针（L-C），已被明文踢出启动链——`lobos/ota/ProgramOtaResolution.kt:56`「随包 assets/node/server.js 只是探针，不在启动链上（只由诊断页显式驱动）」、`GuestAdapter.kt:47-48`「探针永不参与启动判定：控制面只有 `CONSOLE_PORT` 这一个」、`InstanceHost.kt:58-60`（D15 定罪：它点亮 3080 曾被算成启动成功）。**验收判据一律读环境清单 / `os.instances.list` / 桥方法，绝不允许拿探针端口当「跑起来了」的证据。**
- **分层门禁已经站在我这边**：`container/engine/test/layout-manifest-test.js` 规则 10/11（`:161-175`）就是「共用能力不许加进单个 Program」的成文版——原文引用你 2026-09-29 的话「加到内核里就只有内核能适配，我再装一个其它 Program，这些还要再加一遍 —— 它们是共用的」，并规定共享供给机制必须住 APK 侧、且必须是原生实现。所以 S1 新增 `lobos/os/RuntimeEnvironment.kt`、S4 新增 `lobos/os/InstanceManager.kt` **不需要**在 `docs/contracts/layout.json` 登记：实读 `expectFiles` 是**迁移下限**而非上限（`:59-61` 注释「多于 = 正常演进」），该测试只点名要求存在 `lobos/os/AppRegistry.kt`、`lobos/native/NativeAssetRegistry.kt` 两颗件（`:107-109`、`:124-125`）。红线是规则 8：全仓扫描「已迁移旧路径的残留引用」，`docs/plans/**` 与 `layout.json` 本身豁免（`:132,135`）。

落点数量参考：新增一个桥方法是 3 处（`CapabilityBroker.kt` + `methods.js` + `console-system-api.md`，未实现时另加 `lobos/os/METHOD-GAPS.md` 一行）；新增一个组令牌是 4 处同源点（§6 方法论）。**本方案两者都不做**——这是它与第 2 轮最大的差别，也是判据 C 的直接体现。

| 步 | 动哪些文件 | 改成什么 | 局部判据（在哪跑） | 重出壳 | 失败退路 |
|---|---|---|---|---|---|
| **S0 登记** | `docs/plans/os-v4-debt-registry.json`、`lobos/os/METHOD-GAPS.md`、`docs/contracts/base-spec.md`（§10 第 8/9 条两处空指）、`docs/components/console-ui.md` + `programs/console/ui/src/features/console/settings/AboutCard.tsx` + `PortPanel.tsx` + `nav.ts` | §4 对账表逐条入债表（`status=pending`），含新增三行（环境触发点长在启动链、`shell.exec` 名实不符、环境清单读数分三处）；**§4.1 复审结果一并入册**：同形病三处（npm 无真名、pnpm 判据走自造键、flock 件只活在自造键）、NODE_PATH 与 npm 前缀指向不同目录、成文必备却零供给两格（coreutils·python——**动作是清单/构建矩阵加一行，不是设计**）、物理边界四类（git over ssh、curl over SFTP、需编译依赖、`$EDITOR`/pager）；三面谎要么接要么删净 | `node scripts/debt-gate.js`、`node scripts/doc-gate.js` 均 0 命中 | 否 | 纯文档，直接退 |
| **S1 环境生命周期搬家** | （已落地 static）`bootProgramOnce` 内的 provision/npm/供给三块 → 新 `lobos/os/RuntimeEnvironment.kt`；宿主挂点 `lobos/lifecycle/OsHostService.kt:93-102` | 环境装配的触发与「哪颗 Program 装上」解耦；`PrefixProvisioner`/`SupplyProvisioner` 由环境件调用，二者本身不重写；补 npm 在 `$PREFIX/bin` 的**真名入口**（§11 D-2 第 1 格，判据同 `PrefixProvisioner.kt:31-33`） | **V-0b**（console 未装/被杀时 `$PREFIX` 仍在位）＋ **V-0c**（任一树根下 `npm --version` 按名字可得）＋ `app-tests` | **是** | 先只做「触发点搬家」，读数字段后置到 S7；**不许**改成启动失败再补一轮的自愈 |
| **S2 语义搬家 ＋ 树根收编**（已落地 static） | 落地形状：旧 `GuestAdapter.kt:113-149,154-170` → `lobos/os/RuntimeEnvironment.kt:45-55,65-124,141,144-158`；消费者 `InstanceHost.kt:415-425,851-854`、`ProgramVerifier.kt:96-102`、`AdbClientRunner.kt:217-223`；`KillAudit.kt:28` 改为**断言豁免**（偏离本行原写「收编」，理由见 §5 E2 第 2 条）；门 `container/engine/test/boot-env-contract-test.js:32-33,48,74,77,82-83,87,90,97,103,157-202`；golden `container/app/src/test/java/lobos/runtime/GuestAdapterTest.kt:97-109,113-123,139,184` | 语义整簇搬入并被 OS 侧**四个载荷树根**共享；三份 `baseEnv` 副本删除；`GuestAdapter` 只剩 console 的 `LOBOS_*` 申报值（`:69-105`）；裸 exec 的豁免写成断言；PATH 组装（`RuntimeEnvironment.kt:83-91`）增 `$HOME/.npm-global/bin` 段 ⇒ 全局装的 CLI 按名字找得回（ENV-4），`NODE_PATH` 第二段与 npm 全局前缀同源（ENV-5，`GuestAdapter.kt:78-84`） | `boot-env-contract` **31 passed/0 failed**（改判据对象后仍绿、键集 ≥12 保留）＋ 8 个受控突变各自 1 failed（清单见 S2 执行记录）；`app-tests` 的 golden 逐键等值**本地无 JDK/Android SDK，未编译**，唯一编译器是 CI | **是**（与 S1 同壳） | console 行为等值由 golden 兜；分次落地按「先 Verifier/AdbClientRunner，最后动启动链」执行完毕 |
| **S2b 供给纪律成表** | `NativeExecutable.kt`/`NativeAssetRegistry.kt`（增 `linkage` 字段）、`scripts/build-native-capabilities.sh:99-105`、`.github/gate-policy.json` | 「入 `$PREFIX` 必动态」从注释升级为注册表字段＋门禁；同时把 §2 边界 2（`posix_spawn` 未拦）登记为在册残留，不许留暗账 | 现有 ELF 门禁（`verify-runtime-elf.sh`、`verify-userland-artifact.sh:21-22`）＋ `gate-scan.js` | 否（构建期/CI） | 只登记不升级也不影响运行；但必须留债表行 |
| **S3 装载去默认 id** | `ProgramManager.kt:33,86,112`、`ProgramInstaller.kt:111,137`、`InstanceHost.kt:315-317,415-425`、`program-bundle.js:31-47,137,138,177`、`docs/contracts/program-manifest.schema.json`（required 实读无 `id`）、`scripts/build-program-bundle.js:57-63`、两个 engine 测试 | 包内清单增 `id` 必填、外层清单不再硬编码 `'console'`；`entryPath` 从清单读；`command` 不再假定 `[node, entry, "daemon"]`（源清单 `args` 透传）；`CONSOLE_PORT` 从「全局事实」降级为 console 的申报值 | `cd container/engine && npm run test:logic`（真实入口 `ci.yml:132-135` → `scripts/run-engine-tests.sh:18`；`build-apk.yml:243-244` 同一条链）；`program-bundle-test.js` 增断言「源清单 `args`/`ports` 必须出现在包内清单」 | **是**（Kotlin 部分）＋ S1/S2 已攒的壳 | console 申报值与旧字面量逐字等值 ⇒ 行为不变；**S1–S3 建议攒一次壳**（§8.1） |
| **S4 树根记账** | 新增 `lobos/os/InstanceManager.kt`、收编 `InstanceHost.kt:67,515`、复用 `Backoff.kt`、`SupervisorPolicy.kt:62` | 表 `pid → {owner, label, desired, phase, attempts, port}`；owner 由 ppid 树拓扑推导（不靠自定义 env 键）；`reapOrphanKernel` 泛化为 adopt-or-start per 树根 | V-2、V-3、V-6；`os.instances.list` 行数 = 在册数，且子孙计数非空 | **是** | 先只保住「console 仍恰一个树根」，其余名额后置 |
| **S5 端口多租** | `PortBroker.kt:14-16,48-62`、`CapabilityBroker.kt:616-621`、`methods.js`、`console-system-api.md` §2.4 | lease key 复合（`owner/segment/slot`）；把契约已写的 `segment`、`port` 实现出来 | R6 三向对账；真机 V-4 | **是** | 按 §11 D-3：只做 key 复合、窗口沿用现值；窗口是**一个常量位**，改数不改结构 |
| **S6 授权多行 ＋ 作用域** | `ProgramAuthorizer.kt:20-35`（engine 侧 `bridge/server.js:77-92` 已是 `params.program` 形状，不用动）、`CapabilityBroker.kt:516,335-341,375-398` | `manifestOf(programId)` 按 id 取包内清单（与 S3 新增的 `id` 同批，§5 E5）；未声明 id 或身份不符 ⇒ 只有 `base`。**同批**：`os.instances.action` / `os.appmgr.*` 去硬绑后配 `bridge:app_control` + `peerProgram` 作用域，调用方只许动自己所属的那棵树 | `bridge-authorization-test.js`（engine mock，只证契约形状）＋ **本步新增的 Kotlin 纯函数单测**（`ci.yml:242 app-tests`）；真机 V-5 | **是** | 不得先于 S3（否则第二个 id 无清单可读）；去硬绑与隔离门**绝不可拆成两批**（§6） |
| **S7 环境判据落地执行** | `SupplyProvisioner.kt:264-270`（清单与 tools 的解析处，S7 在这里增取每颗的 `verify`；旧写 `:253-256` 随 B 批次移位）、`CapabilityBroker.kt:666,743`、`PrefixProvisioner.kt:114`、`scripts/userland-verify.json`、`console-system-api.md` | 给已随清单发到设备上的逐件判据**补上执行者**：内核按清单跑一次 `tools[].verify`，把「三集相等」拼成一处读数（pnpm 判据读 `LOBOS_SUPERVISOR_HOME` 拼绝对路径的写法已在 2026-09-29 改成裸名，与其余四颗同形状——那半桩已从 S7 摘掉，见 §2 边界 3、§4.1 pnpm 行），并按**判据 D** 逐颗对账成文必备清单（coreutils/python 报缺、flock 件从「只有键、无读者」改成有读数） | **V-1 三集相等**＋**V-0d 载体合法**；R6 三向对账 | **是**（与 S6 同壳） | 判据跑不起来就是环境树根没带语义——回 S1/S2 补齐，**禁止**在这里加应用特例或把判据改宽 |

**任何一步里若出现一行只为某个应用写的 Kotlin，或出现一个新的桥方法名/新的申报格，方案就跑偏，当场停下重审**——判据 C 的可机械检查形状。

### 8.1 发布形态与验收成本（照 `agent-os-execution.md:18-22` 的量级口径写「壳/机」，天数只是待校准的粗估）

| 步 | 发布形态 | 上机次数 | 量级（未校准） | 为什么是这个形态 |
|---|---|---|---|---|
| S0 登记 | 纯文档 | 0 | 0.5d | 债表/gaps/自述文案，CI 的 `debt-gate` + `doc-gate` 就能判 |
| S1 环境搬家 | **壳** | 1 次（V-0b：停掉 console 后环境仍在） | 1–2d + 1 壳 | 动常驻启动链的装配点，风险在编译期与开机次序；靠 V-0b 而非上机次数兜 |
| S2 语义搬家 | **壳** | 1 次（console 行为等值核对） | 1–2d + 1 壳 | golden 迁移 + 三门判据对象搬家 |
| S2b 供给纪律 | CI/构建期 | 0 | 0.5d | 注册表字段＋门禁，不改运行时行为 |
| S3 装载去默认 id | **壳** + CI（engine 链） | 1 次复点 | 1–2d | 含 S1/S2 未攒上的话要多一次壳 |
| S4 树根记账 | **壳** | 2 次（V-2 装第二颗；V-6 `am force-stop` 三出口同调） | 2–3d + 1 壳 + 1 机 | 监管搬家动到常驻链，`agent-os-execution.md:248` 判据 5 必须重跑 |
| S5 端口多租 | **壳** | 1 次（V-4 双 claim） | 1d + 1 壳 | 结构改动是 key 复合；窗口按 §11 D-3 不动数字 |
| S6 授权多行＋作用域 | **壳** | 0 次可先 CI（V-5 双向 fixture），真机核对可与 S4/S5 合并 | 0.5–1d + 1 壳 | engine 侧握手已是 `params.program` 形状，只补 Kotlin 按 id 读清单与按树判作用域 |
| S7 环境判据落地执行 | **壳** | 1 次（V-1 与 V-0 同机复点） | 0.5–1d + 1 壳 | 判据文本早已发布，缺的只是执行者与一处拼合；跑不出绿说明 S1/S2 有暗账 |
| 通用性验收（不是编码步骤） | 无 | 1 次（V-0） | 0.5d | 见 §9 V-0：用本方案没写过一行专用代码的载荷 |

合并省下的次数：**S1–S3 可并成一次出壳 + 一次上机**（V-0/V-0b/console 等值核对同一颗 APK 复点），S4–S7 再并一次；S0/S2b 与出壳完全解耦，可以现在就红/绿而不占用发布窗口。

**成本大头不在编码，在发布链**：每次出壳要走 tag → publish → 上机复点，且推送与触发 CI 每次单独请示（`feedback-ship-to-machine` 口径）。

---

## 9. 验收标准（每条一句可判真假，且带反向对照）

「判据必须真的能红」：每条都配一个故意做错就要红的对照，没有对照的判据视同无效。

| 编号 | 判据 | 怎么操作 | 在哪读 | 反向对照（必须红） |
|---|---|---|---|---|
| **V-0 环境自洽（裁定的直接验收）** | **本方案没为它写过一行代码**的东西在环境里可用：任一树根下 `git`、`rg`、`node` 按名字可解析并执行；`bash -c 'echo x > /tmp/t'` 不失败；`link` 语义可用；node 载荷的 `os.cpus()` 不炸（envShim） | **不必新造测试**：把清单里已发布的五颗判据（`userland-verify.json` 的 git `init→add→commit→log`＋https、sqlite3 `select 1+1`、jq `.a`、curl 取回清单、pnpm `--version`）在**任意**一个进程树里跑一遍——console 的子进程、adb 客户端的子进程都算 | 该进程自己的 stdout（`LOBOS_PROBE_PASS …`）/退出码 ＋ S7 的环境读数 | ①**把 OS 里任何一行代码改动作为让它跑起来的前提 ⇒ 本条判红**——这就是「还需要 1 对 1 吗」的可执行问法；②故意用**静态**编译的载荷 ⇒ `/tmp`/link 必失败，证明 §2 边界 1 是真判据而不是注释 |
| **V-0b 环境不依附应用** | console 未安装 / 被 `am force-stop` 后，`$PREFIX` 内容仍在位、环境读数非空 | 停掉 console，再读环境清单 | S7 的环境清单读数 | **搬家前（S1 之前）跑同一操作必红**——当时 provision 与 C 层供给的两个调用点都只在 `bootProgramOnce` 内（旧 `InstanceHost.kt:446` 与同函数内的线程块，现已删净）；若把它修成「发现没了就再补一轮供给」的自愈 ⇒ 判红，违反 I6 |
| **V-0c 环境基础件能干完自己的本职**（本轮替掉「第三方包先进清单」那条错界） | 在**任一**树根下：`npm --version` 按名字可得；`npm install -g <纯 JS 包>` 成功且装完的 CLI 按名字可解析；`pnpm` 同；带 postinstall 的包能起 sh（前置于 `base-spec.md:50` 那条限制的重新定性） | 一次真实安装，**不改 OS 侧任何一行代码** | 该进程 stdout/退出码 ＋ `$HOME/.npm-global/bin` 落盘 ＋ §7 journal 行 | ① 让它跑通需要动 OS 一行 ⇒ **本条判红**（这是 D-2 的可执行问法）；② 故意装一颗需编译的 native 依赖 ⇒ 必须**如实失败并上屏**，报 OK 或静默成功判红（设备无编译器是环境事实：`base-spec.md:154`）；③ 若解法是「让 OS 预先把包登记进清单」⇒ 判红，那是本轮已撤回的拦截式思路 |
| **V-0d 可用性的载体合法（判据 D 落地，本轮复审新立）** | 每一颗**成文必备件**（`base-spec.md:51`：运行时 node·python；工具 npm·pnpm·git·jq·sqlite3·rg·curl·coreutils）在环境里的可用性，**只能**由「`$PREFIX/bin/<真名>` 存在并可 exec」或「生态本就读的标准键」来兑现；由自造键（`LOBOS_*`/`NODE_BIN`/`PREFIX` 类）单独承载的可用性一律判不成立 | 一次清单对账：成文必备清单 ⊇ `$PREFIX/bin` 实际名集 ⊇ 判据里出现的名字；再在任一树根下按裸名跑一遍 | S7 的环境读数（含缺项）＋ `container/app/src/test` 的一条新用例 | ① 把 npm 的入口只做成 `LOBOS_NPM_ENTRY` ⇒ **红**（今天就是红的形状，这正是 §4.1 定罪它的原因）；② 把任一判据改成读 `LOBOS_SUPERVISOR_HOME` 这类自定义键拼绝对路径（pnpm 判据曾是这个形状，2026-09-29 已按裸名改回）⇒ 红；③ coreutils/python 从读数里**隐身**（清单不提、也不报缺）⇒ 红——缺必须显形为缺 |
| **V-1 三集相等** | 注册表声明的件、`$PREFIX` 实际在位的件、环境清单报的件 **三集相等**（含 git/curl/jq/sqlite3 与 `PrefixProvisioner.expected:105`） | 一次读数对三处 | `sys.nativeAssets` / `os.nativeAssets.status`（`CapabilityBroker.kt:666,743`）vs 落盘目录 | 故意让一颗件供给失败（改 link-farm 指向不存在的源）⇒ 读数必须报缺，**不许**报「全就位」（防空转读数） |
| **V-2 名额** | 装第二颗 Program 后 `os.instances.list` 恰两行，且 console 的 `CURRENT`/读数字节未变 | 打包上机 | 桥方法读数 | 把第二颗的 `entry` 申报成不存在的脚本 ⇒ **只它报错**，console 不受影响 |
| **V-3 记账不靠声明** | 一棵子树的归属在**自定义 env 键被剥掉**之后仍然正确（因为读的是 ppid 拓扑） | 造一个清理自定义键的子进程再读实例树 | `os.instances.*`（含子孙计数） | 若 owner 靠 `LOBOS_*` 之类的自定义键推导 ⇒ 本条必红——这正是 §2 边界 3 预告的假账形状 |
| **V-4 端口分区** | 同 segment 两次 claim 得**不同** port；`release(port)` 只删那一条 | 两个 owner 各 claim | `os.ports.list` | 用旧实现（owner 单键恒复用）跑同一用例 ⇒ 必红 |
| **V-5 授权与作用域（两腿）** | 腿 1：未申报 `bridge:app_control` 的 Program 调 `os.instances.action` ⇒ 拒；申报后 ⇒ 成功。腿 2：Program A 作用于 B 所属的树 ⇒ 拒（只许动自己出生或所属的那棵树） | 两份 fixture 清单 | **分两层读**：CI `bridge-authorization-test.js` 只能在 engine mock 上证契约形状（现读 `:22-40` 共 8 条）；**Kotlin 侧真实判定必须靠把纯函数抽出来进 JVM 单测**（§5 E5 可测性约束），否则只剩真机一条腿 | 只给一侧申报 ⇒ 一边红一边绿，双向都要看到。**并验 `groupOfMethod`/授权分支真的走到**：故意让 `os.*` 仍返回 `null` 组 ⇒ 用例必须红（否则 §6 的空转门又回来了，`:198` 恒不成立） |
| **V-6 打断可见** | `am force-stop` 后重开，通知/首页/导出报告三处同句式，且**不得**出现「已自动恢复」类文案 | 沿用 `docs/contracts/ui-onboarding-spec.md:374` 判据 ⑪ 的操作序列 | 屏幕 + 导出报告 | 同判据 ⑪ 自带对照：`am stop-service` 后重开**不该**出现这一行（证明确实在写 clean 戳，不是恒定喊被打断） |
| **V-7 语义无例外**（S2 后已能判，static 档） | `LD_PRELOAD`/`PATH`/`TMPDIR`/CA 四键的装配点**只有一处，且不在 `GuestAdapter.kt`**；`ProgramVerifier.kt`/`AdbClientRunner.kt`/`InstanceHost.kt` 里不出现独立 env 装配，只出现 `treeRoot(Env|For)` 取用 | 现读：`LD_PRELOAD` 在 `container/app/src/main/java` 出现 **1** 次且落在 `RuntimeEnvironment.kt:93`；PATH 单点 `RuntimeEnvironment.kt:83-91`；判据 `boot-env-contract-test.js:74`（`=== 1`）、`:176-178`、`:184`、`:191`。在册豁免两处，都由断言表达：`:199-202`（KillAudit）、`GuestAdapterTest.kt:184`（探针 env 无 `LD_PRELOAD`） | CI（`boot-env-contract` ＋ `app-tests`）。**原计划里 `gate-scan.js` 那条 term 没加**，改由契约门盯同一事实——如实记为未做，不是已完成 | 把任一批 `baseEnv` 副本改回三份 ⇒ 红（已实测：`ProgramVerifier` 改回自拼 `HOME` ⇒ `:184` 红）；把 PATH 组装删净 ⇒ `:74` 红；把豁免写成注释而非断言 ⇒ `:199-202` 红 |
| **V-8 无应用名泄漏** | `container/app/src/main/java` 内不出现 `console`/`panel`/`router` 裸字面量（新增代码） | `node scripts/gate-scan.js`；它是**策略数据驱动**扫描器（词表 `.github/gate-policy.json`，一条 term 可有 `paths` 作用域与 `allow` 白名单，实读 `gate-scan.js:26,29-31`；`liveSurface` 统计每条规则真正覆盖的文件数，`:49,63,84`），所以这条只需加一条 term。**次序有硬约束**：`.github/gate-policy.json` 现 `enforce=true`（全局即红，34 条在册），而 §0 实测现存 25 处 console 字面量——所以这条 term **只能在 S3/S6 把 25 处删净后加**；加早了整条 CI 红，下一个人的反应是关 enforce，门就白装了 | CI | 造一个含 `console` 字面量的 fixture ⇒ 必红；`liveSurface=0` 会自己把这条报成死规则（`:138`），防止又一道空转门 |
| **V-9 消费者端到端** | 面板智能路由页读到真实供应商/额度/熔断状态；债表、文档、关于文案、门禁四处口径一致 | 真机点一遍 | 屏幕 | 四处任一处仍写「智能路由」而页面无数据 ⇒ 红（这正是 EXEC-G2 的 done 条件原句）。**注意这一条不要求 OS 为 router 新增任何一格**——它验的正是「环境里的 git/npm 依赖被应用自己用掉」 |

**判绿纪律（已立，本方案照用）**：先等 job 齐备再判——**job 名与个数按当次 run 的列表现读，不凭记忆**；本方案会碰到的宿主实读为 `ci.yml` 五个 job（`gate:53`、`container:89`、`console:140`、`console-release:201`、`app-tests:242`）与发布链 `program-ota.yml:70 build-program`、`build-apk.yml:41 build`。skipped ≠ 红也 ≠ 绿；CI 绿 ≠ 交付——必须 tag → publish → 上机复点；推送与触发 CI 每次都单独请示。

---

## 10. 门禁与文档收口（与实现同批，不许留谎）

1. **推翻** `programs/console/test/console-not-init-test.js:38`（全 src 禁 `child_process`）。理由照本轮裁定：应用**在环境里起子进程是正常行为**——「用到 git 直接调」靠的就是它；今天这条门禁把环境的核心用法判成非法，正是「能力必须点对点再造」得以长期存在的制度原因。改法：判据对象从「不许出现某个词」换成「**不得自持常驻权威**」——即不得自持退避重启/开机自拉起/常驻实例账本（`ports.json`/`programs.json`/实例表），并配一个**能红的对照夹具**（例：夹具里写一段 `setInterval` + 自拉起 → 必须红；写一段 `spawn("git", …)` → 必须绿）。`:56`（禁 `ports.allocate|claimSlot|ports.json`）方向保留、判据措辞随 §5 E5 的 lease key 同步。**撤销这条不等于放开：应用侧禁令 `console-system-api.md:161` 的语义（进程权威在 OS）由 E3 的记账与 `bridge:app_control` 的作用域来兑现，而不是由一个词的缺席来兑现。**
2. `api-surface-test.js:50-53` 的死词汇名单只允许收录「**语义已废**」的端点；`/router/` 属「归 Program 自身的业务面」，不得进死词汇（本条已在 2026-09-29 撤除，需把判据措辞一并改掉，否则下一个人照原注释又加回去）。
3. `boot-env-contract-test.js` 与 `GuestAdapterTest.kt` 的**判据对象**已随 S2 搬家（§5 E2）：门同时读 `GuestAdapter.kt` 与 `lobos/os/RuntimeEnvironment.kt`（`:32-33`），键集非空（`:48`，`≥12`）保持原强度，PATH 单点（`:74`）**由「`>=1 && <=2`」收紧为 `=== 1`**，另加两条能红的判据——消费者重复拼 HOME/TMPDIR（`:184`）、`GuestAdapter` 泄漏 12 个树根键任一（`:191`）。**没做的那半**：`:103` 的 command 形状断言换成反向断言「exec 通路不假定 `command[0]`」——它属 S3（去掉 `"daemon"` 字面量）与 S7 的收口，本轮原断言照旧保留，因为 `command` 今天仍是硬编码形状（§1 ③）。
4. `console-system-api.md` §2.2/§2.3/§2.4 保持不动（它就是本次实现的目标），实现按它对齐；`shell.exec` 的名实修订（§6）与 `METHOD-GAPS.md` §1/§2 的 feed id 维度缺口（§5 E4）同批登记。**§0 组令牌表本次不增行**——不新增令牌（§6）；文档里必须写明这条边界：「组令牌约束桥能力调用，不约束环境内的执行」。
5. 三面谎随收口一并处理，**要么接回来、要么删净，不许留着自述文案让人以为功能还在**：`docs/components/console-ui.md:31,43,55,69`、`programs/console/ui/src/features/console/settings/AboutCard.tsx:36`、`PortPanel.tsx:26,41`、`nav.ts`「5 域」注释。
6. 新增 ADR（0011）成文三件事：① §5 E3 的「开机 reconcile ≠ 进程外复活」区分；② §2 边界 2（`posix_spawn`/`execvpe` 未拦，抬 API 属独立决定）与边界 1（静态件＝兼容层失效）；③ **本轮定罪的次序裁决**——「语义沿树继承 ⇒ 附着点是树根，故不新增 exec 桥方法」。回指 ADR-0006/0008。否则下一个人一定会再提「加一条 exec API」，或被 ADR-0006 误否决正常监管。
7. V-8 那条 term 的**加入时机**本身要写进债表条目：`.github/gate-policy.json` 现 `enforce=true`，加早了会把整条 CI 打死。落地次序＝S3/S6 删净 25 处 → 加 term → 同批提交一个「含 `console` 字面量的 fixture 必红」的对照（没有对照的门禁视同无效，§9 口径）。
8. **`base-spec.md:50` 的 npm 对账声明是空指的**（本轮复审现读）：它说「两处目录名由 `container/engine/test/test-chain-completeness-test.js` 逐字对账」，实读该文件 33 行、`npm` 零命中；它另引的 console 侧 `runtime-contract.js` 与 `npm-contract-chain-test.js` **全仓不存在**（S0 已把 `NodeProvisioner.kt:31-34` 的注释改成历史陈述并指向 ENV-19）。⇒ 与 §10 第 5 条同规矩：**要么把对账接回来（写真存在的两侧对账门＋被引用的文件），要么把这三处引用删净**，不许留「有门禁、有孪生文件」的文案——定罪时 npm 前缀这一事实只有 `.npmrc` 一侧在写（`NodeProvisioner.kt:46-59`）。**S2 后这一事实由一个常量派生全部落点**：`.npmrc` 的 prefix、PATH 的 bin 段、NODE_PATH 的 lib/node_modules 段都出自 `NPM_GLOBAL_DIR_NAME`（`:35,38-44`），"两侧对账"退化成了同源代码，不再需要一道门。
9. **`base-spec.md:51` 要求一种实现里不存在、且已被定罪的机制**：原文「（C 机制）……并自写 `#!/system/bin/sh` 可执行入口（安卓无 `/usr/bin/env`，npm 生成的 bin shim 不可 execve）」。实读：全仓无写 shebang 入口的代码，`SupplyProvisioner.kt:198-210` 建的是符号链接；而 `d1/exec-path.c:8-9` 早已把逐件包装定为「中间多了一层」，`:11-13` 声称约定补回后 npm 的原生 shim 按原样工作。⇒ 契约按实现与判据 D 改（删「自写入口」这半句、把「npm bin shim 不可 execve」改成 V-0c 的真机读数口径），**不许**反过来照契约补一层包装。

---

## 11. 待你过一眼的四条结论（我给判断，不给选择题）

格式统一为：**撞什么 → 改哪一处 → 改完设备上/发布流程上的差别 → 我按这个落地，除非你否**。

- **D-1 已终结（三轮撤销记录，不再回来）**：
  - 第 1 轮把通用性落成「每颗 Program／每个子负载一格申报」（`workloads[]`＋`bridge:workload`）。否决语：「你现在这不还是给他锁死了吗……完全不是一个通用系统的状态」。
  - 第 2 轮把「运行时装给＋兼容驱动＋多名额」落成**一条 OS 唯一的 exec 桥通路**（`proc.exec/proc.wait/proc.kill` + `bridge:proc`）。否决语：「我给你说的是一个概念，你给我落地的是把我的概念变成了针对指向的事儿……并不需要我每次都要去单独地为每一个产品或者每一个应用单独再造一个通道」。实质错误：只是把批准点从装载期挪到执行期，仍是点对点。
  - **本轮**：判据 C 成立 ⇒ 净新增概念 **0**，全部动作是「环境的生命周期搬家」＋「语义的附着点搬家」＋「按既有契约把 `os.*` 的形状补齐」。

- **D-2（撤回重写）：npm/pnpm 是环境基础件，取包就是它的本职——OS 不拦截、不要求登记。**
  - **上一版写的「清单里没有的包就是这项能力此刻不存在、绝不在运行期让载荷自己从网上拉」判错了对象，撤回。** 错在哪：它把「环境基础工具自带的动作」重新包装成 OS 侧的注册/审批步骤，和第 1、2 轮同一个病——又多了一条点对点审批边；判据 C 直接杀它（用一件东西之前要先「谁专门为它登记过一件事」）。
  - **仓内早已把运行期取包写成设计，不该由我另立规矩**：`docs/contracts/base-spec.md:50` 的标题格就是「npm 客户端｜**运行时可用**」，并定「全局前缀固定 `$HOME/.npm-global`」；`NodeProvisioner.kt:46-59` 建 `.npmrc` 的注释原文即为「guest 里载荷自己起的 npm 没有宿主那份 `npm_config_prefix`，只有 .npmrc 管得住」（同调见 `InstanceHost.kt:393`）；`docs/contracts/layout.json:398-399` 定「工具由环境自己装进 `$PREFIX`、自更新，加/更新一件工具不需要内核 OTA、不需要 APK 更新」。**环境清单（注册表＋C 层签名清单）管的是环境基础件，不管载荷用这些基础件装出来的依赖**——后者本就不属于环境内容，进清单反而是错的。可见性由 §5 E3 的树根记账与 §7 journal 兑现，**不由拦截兑现**。
  - 于是这一格真正要过的问题换成一句可判真假的话：**环境今天够不够让 npm 干完它的活**。逐格实测（结论是「我按这个落地，除非你否」，不需要你选数字）：
    1. **按名字可达**：pnpm 走 C 清单、落位即可按名字解析；npm 定罪时只有 `npm-cli.js` 绝对路径＋`LOBOS_NPM_ENTRY`/`runtime.json` 的 `npmEntry` 两个宿主代跑入口（`NodeProvisioner.kt:86-133`、`GuestAdapter.kt:103`、`InstanceHost.kt:890-911`），而自定义 `LOBOS_*` 会被载荷子进程剥掉（`RuntimeEnvironment.kt:96`、`container/native/d1/exec-path.c:14-17`）。**环境件自己的注释早已把目标形态写死**：`d1/exec-path.c:11-13`「按**调用方的 PATH** 解析……补回之后：**npm/pip 的原生 shim**、`#!/usr/bin/env X`、`#!/bin/sh` 全部按原样工作」——缺的不是新机制，是 `$PREFIX/bin` 里没有 npm 这个真名。**改哪一处**：§5 E1 的装配内容增「npm 在 `$PREFIX/bin` 有真名」，判据与 `PrefixProvisioner.kt:31-33`（`command -v node` 全 MISSING 那次报告）同源。**差别**：今天应用要 npm 只能靠宿主把路径喂给它或自己拼 `node + npm-cli.js`；补齐后 `spawn("npm", …)` 与 `spawn("git", …)` 同一形状，零格申报、零桥方法。
    2. **装完找得回**：定罪时 `$HOME/.npm-global/bin` 不在 PATH 的两段里（旧 `GuestAdapter.kt:125,169`＝`$PREFIX/bin` ＋ node 目录）。**改哪一处**：E2 的 PATH 纯函数增这一段——**S2 已落地**（`RuntimeEnvironment.kt:83-91`，ENV-4 关账 static）。**差别**：全局装的 CLI 从「装了但按名字找不到」变成环境内任一树根可用；设备读数待 V-0c。
    3. **link/`/tmp`/祖先目录语义**：`link(2)` 在 app 域被 SELinux 无条件封死（`docs/adr/0001-android-execution-domain.md:43`，真机读数 `:57` = `fail:EACCES`），仓内给出的替代是 `d1/link-interpose.c:1-3` 的独占拷贝，成文的依赖者是「DSH 的发布会话/附件」（`docs/components/native.md:18`）。**npm 安装期是否同样踩这两条（rename/link、临时目录），我不当已知事实写**——它正是 V-0c 那次真实 `npm install` 要读出来的数，读不出来就如实报缺（`ADR-0009:135` 说明这簇语义经 `GuestAdapter` 单点 LD_PRELOAD 注入，只作用于 console 拉起的那棵树及其子进程）。
    4. **信任根**：registry 走 https，CA 四键已随 `RuntimeEnvironment.kt:101-119` 注入（git https 的真机实证就在同一段注释），S2 平铺后任一载荷树根皆得。
    5. **`--ignore-scripts` 的定性要改**：`base-spec.md:50` 记的理由是「容器无 sh 可 spawn」，D1 之后不成立——bash 在 `$PREFIX/bin`（`PrefixProvisioner.kt:17-20`）、`SHELL` 已注入（`RuntimeEnvironment.kt:120`）、shebang 按调用方 PATH 兑现（`exec-path.c:11-13`）。这条限制记的是**环境曾经不完整**，不是设计意图。**改哪一处**：`base-spec.md:50` 的边界措辞；去留不由我拍，由 V-0c 的真机读数判。
    6. **全局装完的库 `require` 不到**：定罪时 `NODE_PATH` 第二段是 `filesDir/node_modules`（旧 `GuestAdapter.kt:91-96`），npm 全局前缀是 `filesDir/.npm-global`（`NodeProvisioner.kt:35,44`）——两个键各指各的目录，而前者全仓没有创建代码。**改哪一处**：E2 的装配纯函数把两段对齐（真名进 PATH、全局库进 `NODE_PATH`）——**S2 已落地**（`GuestAdapter.kt:78-84`，ENV-5 关账 static）。**差别**：今天「用 npm 装个库给环境里的应用使」这条链断在最后一环；补完才谈得上「环境基础件干完它的活」。
  - **同形的病不止 npm——你要求的复审已跑完，逐颗账在 §4.1**：结论是这条形状在**三处**复发（npm 无真名、pnpm 的判据走自造键拼绝对路径、flock 件的可用性只写在 `LOBOS_FLOCK_NATIVE` 上）；**两格**成文必备却零供给（coreutils、python——「装了运行时什么都能跑」今天只对 node 一颗成立）；**四类**是物理边界只能显形（git 无 libssh2、curl 无 SFTP/IDN、需编译的 native 依赖、`$EDITOR`/pager）；**两处**契约空指（`base-spec.md:50` 指向不存在的对账门与孪生文件，`:51` 要求一种已被 `exec-path.c:8-9` 定罪的逐件 shebang 包装，实现里根本没有）。全部修法都是「补真名／换标准键／让失败上屏／改契约文本」，**没有一处是加登记、加申报、加桥方法**——所以判据 D（§0）就是这条形状的机械检查，验收是 §9 V-0d。
  - **唯一硬边界（这是环境事实，不是审批）**：需编译的 native 依赖装不上，因为设备上没有编译工具链（`base-spec.md:154`）。**改法**＝不拦截、让它如实失败并把错误透传给 journal 与应用（§7），不许伪装成功，也不许为它加清单格或申报格。

- **D-3：端口窗口不改，只把 lease key 改成复合键。**
  - 撞什么：`PortBroker.kt:15-16` 现 41000–41999、**owner 单键**（`CapabilityBroker.kt:616` 把契约里写的 `segment` 直接丢了）⇒ 同一个 owner 永远复用同一个口，第二颗要监听口的 Program 拿不到自己的口。
  - 改哪一处：key 改 `<owner>/<segment>/<slot>` 复合，owner 来自 E3 的树根身份而不是应用自报；窗口数字**维持现状**。
  - 差别：这是纯结构修正，改完 console 拿到的口与今天逐字相同（行为等值）。等真出现第二颗需要监听口的 Program 再说够不够——那时要改的是**一个常量**，不是结构。我不需要你选数字，需要数字的时机在 V-2 装第二颗之后。

- **D-4：`ui.path` 从 schema 删掉，不实现。**
  - 撞什么：清单声明 `/__panel`，两处消费者都走 `/__host`（`ConsoleActivity.kt:54`、`programs/console/src/api/index.js:190`）——**有声明、零消费者**，就是给下一个改面板的人埋的雷。
  - 改哪一处：`program-source.schema.json` 删字段，三颗 manifest 的声明与相关注释一并删净，挂载点统一按现状 `/__host` 规则。
  - 差别：留字段＝每颗 Program 一格申报自己的 UI 挂载点，正是本轮要平铺掉的东西；删字段＝零格申报，行为与今天完全一致。所以选删。

都不阻塞 S0–S4：**D-2 已不是待拍项，它换成 E1/E2 的两格补齐（npm 真名入口、`.npm-global/bin` 进 PATH）＋ V-0c 的真机读数**；D-3 的结构改动本就属于 S5；D-4 属于 S3 的 `uiDir` 那一格。**本轮按你的要求只出设计、不动代码**——工作区里已存在的改动只有你批准的那两条门禁删除（`api-surface-test.js` 去掉 `/router/`、`console-not-init-test.js` N-2 去掉 `domains/router`，实跑 12 passed/0 failed 与 22 passed/0 failed）。

---

## 12. 我读不出来的外部事实，与一条请求

（原先这一节把四条混在一起写，其中两条是我自己能读的、一条根本不是拍板而是排期请求。逐条更正。）

1. **必备件清单不由我提问题——它早有成文**：`docs/contracts/base-spec.md:51` 定「运行时 node·python；工具 npm·pnpm·git·jq·sqlite3·rg·curl·coreutils」，`docs/contracts/layout.json:398-399` 定「工具由环境自己装进 `$PREFIX`，加/更新一件工具不需要内核 OTA、不需要 APK 更新，只发清单」。**我上一版把「清单由谁定」列为待拍板是错的**，那是我该去读的东西。
   读出来的**事实差**（不占你决策，只登记）：成文清单 ⊃ 实际供给。已供给——node（`NativeAssetRegistry.kt:123` 的 `ALL`＋`PrefixProvisioner.kt:33` 的 `NODE_BIN_NAME`）、bash/rg（`PrefixProvisioner.kt:17-20` BINS）、git/jq/sqlite3/curl（`build-userland.yml:48` 矩阵，本仓交叉编译）、npm（构建期种进 `assets/npm`，`layout.json:399` 的自举种子，仓内不存在该目录——**但「已供给」≠「环境内按名字可用」**，npm 缺真名入口那格见 §11 D-2 第 1 格）；**pnpm 已投放上线**（`build-userland.yml:48` 矩阵 + `scripts/build-userland-pnpm.sh`；2026-09-30 现读清单 `version=2026.09.29.145` 里这颗带 `url`，`delivery-gate` 由前一天的 `FAIL（1 项）… 没有取件 URL：pnpm` 转为「声明键全部在线且身份干净」），**但设备上还没复点**；**清单里的 `coreutils` 全仓没有供给路径**（python 明标未来）。动作＝S0 登记一行债，等第 3 条的读数窗口一起定它走「本仓编译」还是「取上游预编译件」（两者都走同一条打包→对象存储→清单的口）。
2. **feed 一条只能指一颗 Program（这是事实，不是问题）**：设备端只有一份 feed 配置，`manifestUrl = $baseUrl/$releaseTag/$manifestName`、`releaseTag` 由通道推导为 `program-<channel>`（`ProgramOtaUpdater.kt:36-37,52,117`；随包 `container/app/src/main/assets/program-feed.json` 现值 `channel=canary`、`releaseTag=""`、`manifestName=program-manifest.json`），包名固定 `program-$version.zip`（`:53`）。⇒「同时热更新 console 与第二颗」在当前发布面上**不成立**，S3 之前必须先扩。
   扩法我给结论：**一 id 一 tag**（feed 增「id→tag」映射），而不是一个 manifest 装多颗。理由与 §0 判据同形——一颗的发布/回滚不得改写另一颗的状态；共用一份 manifest 时，发坏一颗会把另一颗的读数一起带进同一份产物。这条只改发布器与 feed 形状，不改设备上的运行语义。
3. **请求（不是拍板，是排期）**：一次 adb 窗口，**把清单里已发布的五颗判据在设备上真跑一遍并落盘**（git 提交回读 / sqlite3 算一条 SQL / jq 解析 / curl 走 HTTPS / pnpm 打印版本），**外加 V-0c 的一次真实 `npm install -g <纯 JS 包>`**——「环境够不够让 npm 干完它的活」和「`$PREFIX/bin` 里的件能不能真 exec」是同一扇窗口的两类读数，都只能上机取。这同时就是「`$PREFIX/bin` 里的件在真机上到底能不能 exec、SELinux 是否拒（W^X）」的读数——**不需要我另造测试：判据你已经定好了，只是从没人执行**（§4「环境清单读数」行）。为什么必须上机：`InstanceHost.kt:221` 的 `canExecute()` 只查 stat 权限位，对 SELinux 无感（假阳性），仓里给不出这个答案——`InstanceHost.kt:325,427-430` 两处注释自证「域内自证归供给表 exec-domain 格，真机读数未采」。**读数未采之前，§5 E1/E2 是纸面设计、§9 V-0 也无法判红。** 你只需回「什么时候可以上机」或「先不上」；未获批准我不推任何东西、不触发 CI。
4. **验通用性用哪颗载荷——我定了，不再问你**：V-0 用 `programs/pi`（真实可打包、只用 Node 标准库，其 `_note` 自证用途就是「装第二个 Program 而 Android 观察面不变」），V-0c 与 V-9 端到端用 router（真实业务；它的 npm 依赖**由环境里的 npm 自己取**，不预登记、不拦截——这一条验的正是 §11 D-2 的逐格账）。
