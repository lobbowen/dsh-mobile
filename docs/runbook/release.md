# 发布与版本（Release & Versioning）

> 三件事合一：**版本怎么定** + **发布身份怎么保** + **哪一条链有权投递**。决策依据见
> [ADR-0004](../adr/0004-three-version-streams.md)（三版本流）、
> [ADR-0005](../adr/0005-program-via-ota-only.md)（内核只经 OTA）、
> [ADR-0011](../adr/0011-one-release-chain-per-stream.md)（每条版本流一条链，投递由带版本号的 tag 决定）。

---

## 1. 版本流与各自的单一事实源

| | OS 流（APK / L0） | Runtime 流（Node） | C 层流（用户态件） | Program 流（console / L2） |
|---|---|---|---|---|
| 版本字段 | `versionName` + `versionCode` + `bridgeProtocol` | `default`（node 版本）+ abi | 清单 `revision`（正整数，**来自 tag 名**，仓内没有它的文件源） | `version` + `lobos.requiresProtocol` |
| 单一事实源 | **`version.json`**（仓根） | `container/app/src/main/assets/node-versions.json` | 声明面 `scripts/userland-verify.json`；通道锚 `container/app/src/main/assets/supply/channel.json` | **`programs/console/package.json`** |

| 发布 tag | `os-release-<name>-<code>` | `runtime-release-<ver>-<abi>` | `userland-<channel>-<revision>` | `program-ota-<channel>-<version>` |
| 链外字段 | `container/engine/package.json`（引擎）、`programs/console/ui/package.json`（面板） | — | — | — |

**各流的版本号从不互相比较。**「壳 1.1.12 / 内核 0.1.0-android.48」是正常状态。

## 2. 改哪层，bump 哪个

| 改动范围 | 必须 bump | 不动的 |
|---|---|---|
| `programs/console/**` | `programs/console/package.json` 的 `version` | 壳版本 |
| `container/app/**` | `version.json` 的 `shell.versionCode` +1 | Program 版本 |
| 桥协议语义变更 | 壳 `shell.bridgeProtocol` +1，内核 `lobos.requiresProtocol` 跟上 | — |
| 只改 `programs/console/ui/**` | `programs/console/ui/package.json` 的 `version` | 以上都不动 |
| 换 Node 运行时 | `node-versions.json` 的 `default` | — |
| C 层件/入口声明（`scripts/build-userland-*.sh`、`userland-verify.json`、`supply/channel.json`） | 仓内**不 bump**：本次 `revision` 由发布 tag 名给出，且必须比线上那份大 | 壳 / Program / Runtime 版本 |

> `versionCode` 是**单调整数**，只增不减。动了 `container/app/**` 却没 bump，推 `os-release-*` 时
> 版本门禁会判红（自动通道不许同版本重发）；合并到 `main` 根本不投递，所以「忘了 bump」的后果从
> 「自动出了个同号新字节」变成「发不出去」——可见，且不需要修。
> 补救是**补 bump 再打 tag**，不是想办法让同一个 versionCode 指向另一批字节：投递坏了的正确反应
> 是 bump 一个版本号（ADR-0011 §6）。同号重发那格（`explicit` 通道）刻意留在判据里当对照组，
> **没有任何链路能把壳 APK 投递接到它**（`native-assets-test.js` 反向扫，出现即红）。

## 3. 两把信任根（互相独立，都不是代码能替代的）

| # | 信任根 | 用途 | GitHub secret（**准确名**） | 丢了会怎样 |
|---|---|---|---|---|
| ① | APK 签名密钥（keystore） | 决定"这个包是谁"，Android 只允许同签名覆盖安装 | `ANDROID_KEYSTORE_BASE64` + `ANDROID_KEYSTORE_PASSWORD`（+ `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` 可选，默认 `lobos` / =store 口令） | **永久失去**给已装设备推升级的能力 |
| ② | Program OTA 私钥（ed25519 PEM） | 给Program 包签名；公钥焊在 APK 里 | `OTA_PRIVATE_KEY_PEM`（公钥可用 `OTA_PUBLIC_KEY` 覆盖写入） | Program OTA 通道失效（APK 仍可升级） |

> 为什么两把分开：APK 签名保护"应用身份"，OTA 签名保护"Program 包来源"。混用会让
> 「Program 包泄露」升级成「可伪造应用更新」。
>
> 注意 `LOBOS_KEY_ALIAS` / `LOBOS_KEY_PASSWORD` **不是**仓库 secret 名 ——
> 它们是 `scripts/inject-apk-keystore.sh` 写出到 `$GITHUB_ENV` 的**内部键**（:85-92）。
> 真正要配的是 `ANDROID_*` 那四个。

## 4. 信任根校验门禁

- `scripts/verify-apk-signing.sh`（唯一实现；注入侧 `scripts/inject-apk-keystore.sh`）：
  - 配了 keystore → APK 内证书 SHA-256 指纹与注入锚点**逐指纹比对**，不符即硬红；
  - **发布档由 ref 决定而不是由链路名决定**：壳 APK 唯一投递口 `fast-apk` 只在
    `os-release-*` tag 那一轮追加 `--require-stable`（debug 身份、没配 keystore、锚点本身是
    debug 三种情况都硬红）。归一之前这里是三条链各写一份严格度，现已不存在多个调用方
    （`apk-signing-gate-test.js` ⑥ 反向扫 + 档位判据自证）。
  - **构建校验轮允许 debug 档**，只打 `::warning::` —— 那一轮不投递任何东西。
- `scripts/verify-apk-release-form.sh`（唯一实现）：读 `android:debuggable`，判的是**形态**，与「谁签的」是两个独立事实
  （`container/app/build.gradle.kts:119-132` 让 debug 档也用 release keystore 签名，所以签名绿不代表形态绿，债 AUD-G33）。
  调用方只有 `fast-apk`，且做**两侧对照**：debug 归档必须被读成 debuggable（对照组）、
  同轮 `assembleRelease` 出来的 release 变体必须不是 —— 只测一侧的尺子分不清「包真干净」与「解析没生效」。
  本轮投递的是版本化归档（debug 形态，真机 `run-as` 取证要用它）；换成 release 形态是 AUD-G33/E3.3 的账，
  代价是存量设备必须卸载重装 ⇒ 时机归人定。
- release 变体的构建由 `assembleRelease` 里的 AGP 自带门禁 `lintVitalRelease` 一起判（fatal 即构建红）。它唯一被关掉的规则是
  `ExpiredTargetSdkVersion`（Google Play 的 targetSdk 下限），豁免只住在 `container/app/lint.xml` 一处：本包不走 Play，
  而 `targetSdk = 28`（`container/app/build.gradle.kts:41`）是 ADR 钉死的能力取值，不是可抬的版本号。其余 fatal 项照常拦。
- `scripts/verify-ota-anchor.sh`：强制锚点算法为 **Ed25519**，并在带 `--private` 时校验
  「私钥派生公钥 == 焊死锚点」，堵住轮换后 CI 全绿而设备全拒收的静默故障。

## 5. 发布物与命名

**壳**（只有一个投递口，只有一个目的地 —— 版本化归档；**全仓不再有滚动别名**）：

| 资产 | Release tag | 用途 |
|---|---|---|
| `app-debug-<versionName>+<versionCode>.apk` | `v<versionName>` | 该版的**发布物**，装机/取证都用它（debug 形态，`run-as` 只在它上面可用；换成 release 形态是 AUD-G33/E3.3 的账） |

> 已废止的载体（ADR-0011 §3）：`apk-latest` 上的 `app-release.apk` 与 `version.json`。
> 别名可以被三条链各自覆盖 ⇒ 「线上这一版是什么字节」没有答案；而 2026-09-30 现读它根本不存在，
> 设备上也没有任何东西读它。下一次发布**不会**重建它，`gh-release-upload-test.js` 的反向扫让任何
> 「再写一次 latest」的改动直接判红。

**运行时**：不可变 Release `node-runtime-<node 版本>-<abi>`（`libnode.so` + `libc++_shared.so`），由 `build-apk` 在 `runtime-release-*` 那一轮自己固化；`fast-apk` 按名下载并逐字节校验后放进 `jniLibs/`。
**能力件**：不可变 Release `native-cap-<内容指纹>-<abi>`（`pin-capabilities.yml`，身份是指纹不是序号）。

**内核 / C 层**（GitHub Release 只作归档；设备实际读对象存储）：

| 位置 | 资产 | 用途 |
|---|---|---|
| Release `program-<version>` | `program-<v>.zip` · `program-manifest.json` | 版本化归档 |
| Release `program-<channel>` | `program-manifest.json` · 本次 `program-<v>.zip` | 通道滚动归档（CI 版本前进门禁读这里） |
| 对象存储 `userland/` | 各工具件（按 name/version 命名） | C 层件本体 |
| 对象存储 `userland-<channel>/` | 清单 + 签名（**远端对象键不在本文写死**：由通道锚 `container/app/src/main/assets/supply/channel.json` 的 `manifestName`/`sigName` 声明） | C 层内容清单（`revision` 单调） |

> gh 的资产名**取上传文件的 basename**（`file#标签` 里 `#` 后面只是 label，不改名）。
> 「确保 Release 在 → 覆盖上传 → 回读确认」只住 `scripts/gh-release-upload.sh`，四条 GitHub 投递链
> （fast-apk / build-apk / pin-capabilities / program-ota）都调它；C 层投对象存储走 `scripts/upload-qiniu.js`。

设备入口（对象存储，按通道滚动）配置来自 `container/app/src/main/assets/program-feed.json`：

```
<baseUrl>/program-<channel>/program-manifest.json?t=<ms>   ← 判断有没有更新
<baseUrl>/program-<channel>/program-<version>.zip          ← 或 manifest.url
```

## 6. CI 门禁

| 门禁 | 位置 | 拦的是 |
|---|---|---|
| workflow YAML 校验 | `ci.yml` / `fast-apk` / `build-apk` → `scripts/validate-workflow.py` | workflow 写坏（GitHub 表现是"0 个 job"，伪装成"没触发"）；重复 key / `on.push` 互相覆盖 |
| 跨层版本校验 | `ci.yml` → `scripts/gen-version.js --check` | 事实源缺失/非法；协议号漂移；内核要求协议 > 壳实现协议 |
| 壳 versionCode 单调 + 同版本通道分叉 + 两格取严 | `scripts/verify-apk-version-gate.sh`（判据唯一宿主，0 放行 / 1 判红 / 2 无从校验）；取数外壳 `scripts/check-apk-release-version.sh` **每次取两格**：线上那格读这条链自己写的 `v<versionName>` 归档族资产名（宿主 `scripts/read-archived-shell-version.sh`，参照物名写死 `archive`，别的直接退 2），账本那格取 `scripts/read-apk-receipts.sh`（`ci-receipts` 分支上的 `apk-receipts.log`，写入唯一入口 `scripts/append-apk-receipt.sh`，唯一投递口每次发布成功后记一笔）；**两格取严**（按高的那格比） | 回退；同号换字节；参照物选成这条链永不写的通道；**线上那一格被删小**（归档族可以被删，账本给出一条够不到的下界 —— 债 DS-16） |
| 发布决定与版本事实源一致 | `fast-apk` Publish 步骤：tag 名 `os-release-<VN>-<VC>` 与 `version.json` 现算的两个数**逐字相等**才投递 | 对旧 ref 打新 tag、先打 tag 再 bump ⇒ 发出去的与 tag 说的不是同一版 |
| C 层发布闸门 + 与线上对账 | 发布前 `scripts/check-userland-manifest-drift.js --immutable`（revision 严格单调、同 `name@version` 不许换字节）；发布后 `drift` 作业逐格比仓内声明与线上清单 | 同号换字节；**改了声明却没发**（ENV-26 的直接形状：npx 的 aliases 合进 main、CI 全绿、线上清单仍是旧格） |
| Program 版本前进 | `program-ota` 发布步骤（取数 `scripts/read-release-asset.sh`） | 版本复用 → 设备判"无更新" → 静默不生效 |

> 参照物必须是**这条链路自己会写的通道**：壳的投递口比对的是它写的 `v<versionName>` 归档族，
> 不是发布面别名 `apk-latest`（2026-09-30 现读：那条 Release 今天 404，而日常链从不写它 ⇒ 取数每次退「首次发布」、
> 门一个数都没比过；债 DS-14）。参照物空转的门比没有门更危险 —— 全绿读数会让人以为这一格有人守着。
> 归一之后别名连同它的三个写者一起删除，取数只剩这一条路（`check-apk-release-version.sh` 对非 `archive`
> 参照物直接退 2），"两个通道各读自己的参照物"这个形状本身不存在了。
>
> 但「这条链路自己会写的通道」仍然是一份**可以被删的线上状态**：2026-09-30 同日实测归档族从 44 条掉到 34 条，
> 6 个 `v<数字>` Release 消失，而门禁照绿 —— 所以线上那一格不再是完整的下界，回执账本才是
> （账本住在独立分支的只追加日志上，`append-apk-receipt.sh` **永不** `--force`，推送被拒就红着让人重跑）。
>
> 账本这格的两条纪律：「未起账」与「看不清」都不许咽成「线上什么都没有」。未起账时**自动通道判红**，
> 补第一笔只能走唯一写入口（`scripts/append-apk-receipt.sh`，由**人**推那一个只追加分支）——
> 判据里那格 `explicit` 通道刻意没有任何链路接得到它（`native-assets-test.js` 反向扫，出现即红），
> 它留着是给「两格取严」当对照组、并让补账这件事必须留下一次改 main 的痕迹，而不是点一个按钮；
> 若要**播种**账本（直接写首笔而不是等一次发布），起始 versionCode 必须等于线上现存的最高码，
> 从更低的码起账会让下一次自动发布判「有一次发布没记账」（这是设计，不是 bug）。
> 「不存在」与「取不到」的三态分类按**所读对象**分三处宿主，退码约定同一条（0=取到 / 10=确实没有 / 2=看不清，
> 退 2 一律**禁止发布**）：某个 Release 的**资产**住 `scripts/read-release-asset.sh`（现在只有内核 OTA 与
> 能力件取数这一处读者），
> 日常链的**整族归档**住 `scripts/read-archived-shell-version.sh`（它没有「某个资产不存在」这一态，整族为空才是首次发布），
> **回执账本文件**住 `scripts/read-apk-receipts.sh`（404=未起账，其它失败=看不清；把 gh 失败降成「账本还没有」
> 就是拿更弱的参照物放行 —— 那是最危险的一侧被放行）。

## 7. 设备端"我是谁"

`files/provisioning.json`（唯一写侧 `container/app/src/main/java/lobos/ProvisioningProbe.kt:134-171`）
给出壳与内核两条流的身份：`appVersion` / `appVersionCode` / `bridgeProtocol`（壳）与
`programVersion` / `programFloor` / `programPending`（内核，指针来自 `files/programs/console/CURRENT`）。
Runtime 与 C 层清单的身份**不在快照里** —— 缺的那两格与后果见 ADR-0004 §5（在册债 ENV-28）。
读法：debug 归档可 `run-as` 直接拉文件；release 包非 debuggable 之后只剩桥方法 `os.provisioning.get`
（`container/app/src/main/java/lobos/bridge/CapabilityBroker.kt:711`），控制面起不来时没有远程读法。

## 8. 签名密钥：生成与配置（一次性）

```bash
# ① 生成 keystore
./scripts/keygen-android-keystore.sh          # 产出 keys/release.keystore（keys/ 已 gitignore）
# ② 转 base64
base64 -w0 keys/release.keystore > /tmp/ks.b64
# ③ 写入 GitHub secrets：
#    ANDROID_KEYSTORE_BASE64 / ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS(默认 lobos) / ANDROID_KEY_PASSWORD
```

**备份（强制）**：`keys/release.keystore` 与口令存进离线密码库。它不是"可再生成的"——**丢了就永远回不来**。

## 9. GitHub PAT（维护通道）规则

- **存放**：仓外、权限 600（如 `files/.secrets/github.token`）；绝不入库、绝不进日志。
- **用法**：`Authorization: Bearer $(cat "$TOK")`；禁止 `set -x` / `echo` 令牌。
- **最小权限**：fine-grained，仅本仓 `Contents: RW` + `Actions: RW` + `Workflows: Write`。

## 10. 一次性基线重置（已执行完毕，仅存档）

2026-09-23 产品线起点定为 `1.0.0 (versionCode 1)`（开发期是 `0.2.0`）。因 versionCode 单调门禁会拦回退，
**一次性**清掉了当时发布面上的 `version.json`，使下一次发布被识别为"首次带版本发布"。
（当时的载体是滚动别名 `apk-latest`，该别名与它的三个写者已于 2026-09-30 随发布连归一整体删除 ——
这一段留在这里是历史证据，不是可重复的操作步骤。）

**重置后单调门禁即为权威，不得再重置**；此后一切发布只能递增。要「重来」只剩一条合法路：
人工用唯一写入口把回执账本的第一笔记到线上现存最高码（§6 的播种纪律），而不是删线上状态。

## 11. 已知缺口（待修）

- **投递的是 debug 形态包，形态门禁判的是同轮另一颗**（AUD-G33 / E3.3，`fast-apk.yml:486-511`）：
  唯一投递口投 `app-debug-<VN>+<VC>.apk`（真机 `run-as` 取证要用它），而每次构建都另跑一次
  `assembleRelease` 并判那颗非 debuggable —— 也就是说「release 变体构建得出来、形态干净」每轮都被证明一次，
  但**发出去的不是它**。换成 release 形态的代价=存量设备必须卸载重装 ⇒ 供给与 adb 配对全部重跑，时机归人定。
  形态门禁刻意排在 Publish **之后**：控件构建坏了要让人看见（job 判红），但不该把已经判过的归档投递一起咽掉。
- `fast-apk` 的 release 控件构建**带着稳定签名**（2026-09-29 run 36490042734 读到 `[lobos-signing] 使用稳定签名`），
  但它只用来验形态，不投递；若哪天 fast-apk 撤掉 keystore，同一条会出 `app-release-unsigned.apk` —— 形态照样读得出，
  只是那颗不可投递。归一之后**没有任何一条链路投 release 形态包**（旧的两个 producer build-apk / release-admin
  的投递职责已随发布连删除，build-apk 现在只投运行时）。
- 取证面：发布包非 debuggable 之后，`run-as` 只在 `v<versionName>` 的 debug 归档上可用；
  控制面起不来（内核没跑）时**没有**远程读法。这条不可约，见 `docs/runbook/system-device-verification.md` §0.1。
- 已收口的成因（留在这是为了下一轮别再把它当新事）：DS-11 —— `build-apk` 曾从不调用
  `scripts/build-native-capabilities.sh`，assembleRelease 出来的包只有 `libc++_shared.so` + `libnode.so`，
  run 36513213633 的审计读数逐条 `[error] APK 里缺少 …`（5 件）⇒ 该 run 判红。教训是判据侧的：
  审计收进唯一宿主 `scripts/verify-apk-native.sh` 之前，那条链只查 native-assets 清单、`lib/` 零条目只 echo 不红
  —— 「构建成功」与「发出去的东西有没有能力面」之间原来没有门。现在两条链都调同一份实现（`fast-apk.yml:409`、
  `build-apk.yml:565`），调用方集合由 `native-assets-test.js` 钉住。
- 线上残留的旧投递物要清（归一之后它们不再有任何写者，但也不会自己消失）：`apk-latest` 这条 Release
  今天现读已 404（09-29~09-30 之间被人删除，无在案记录），它名下的历史资产 `app-debug.apk` /
  `version.json` 的 prune 因此**失去载体** —— 这条从「投递滞后」改判为「无载体」，剩下的账是核查
  还有没有别的孤儿 Release/资产（在册：ADR-0011 §3 的删除清单执行后的线上对账）。

## 12. 发布前自检

- [ ] `version.json` 的两个数与要推的 tag 名逐字相等（`os-release-<name>-<code>`）；不等就是发不出去，不是"先发再说"
- [ ] 形态门禁输出「[lobos-form] [ok] 非 debuggable（release 形态）」——**这是对同轮 `assembleRelease`
      控件构建的读数**，不是对投递那颗的读数（§11 第 1 条）；debug 那颗的对照组读数是
      「[lobos-form] [ok] 按预期读成 debug 形态（对照组：证明这把尺子的正例不是空转）」
- [ ] 审计（`scripts/verify-apk-native.sh`）逐件读到自有小件与 $PREFIX 依赖件
      （`liblobosflock`/`liblobosposix`/`liblobosptyprobe`/`libbash`/`liblobosrg`）——
      只读到 `libnode.so` + `libc++_shared.so` 的包发出去就是「有能力名、没能力面」（DS-11 的成因）
- [ ] 签名门禁在发布轮输出「[lobos-signing] [ok] APK 证书指纹与注入锚点一致」（`--require-stable`；
      debug 签名或没配 keystore 这一轮直接判红）
- [ ] `OTA_PRIVATE_KEY_PEM` 已配置，且 `verify-ota-anchor.sh --private` 通过
- [ ] `keys/release.keystore` + 口令已离线备份
- [ ] `fast-apk` 日志出现 `[version] 本次发布 x.y.z (versionCode=N) → app-debug-x.y.z+N.apk`、
      `[version] 参照物=… 已发布 versionCode=M，本次=N，通道=auto` **和** `[version] 版本前进（M → N）`
- [ ] 同一轮的 `append-apk-receipt.sh` 没有判红（账记上了）—— 没记上就是下一轮下界变小的一部分
- [ ] 只更新内核时：`program-ota` 成功，且**壳版本未变**
- [ ] 设备 snapshot 的 `programVersion` / `programFloor` / `bridgeProtocol` 三者自洽（取法见 §7）
