# 发布与版本（Release & Versioning）

> 两件事合一：**版本怎么定** + **发布身份怎么保**。决策依据见
> [ADR-0004](../adr/0004-three-version-streams.md)（双版本流）与
> [ADR-0005](../adr/0005-program-via-ota-only.md)（内核只经 OTA）。

---

## 1. 两条版本流，各自的单一事实源

| | OS 流（APK / L0） | Program 流（console / L2） |
|---|---|---|
| 版本字段 | `versionName` + `versionCode` + `bridgeProtocol` | `version` + `lobos.requiresProtocol` |
| 单一事实源 | **`version.json`**（仓根） | **`programs/console/package.json`** |
| 引擎侧 | `container/engine/package.json` | — |
| 面板 | `programs/console/ui/package.json` | — |
| Node 运行时 | `container/app/src/main/assets/node-versions.json` | — |

**两条流的版本号从不互相比较。**「壳 1.1.7 / 内核 0.1.0-android.13」是正常状态。

## 2. 改哪层，bump 哪个

| 改动范围 | 必须 bump | 不动的 |
|---|---|---|
| `programs/console/**` | `programs/console/package.json` 的 `version` | 壳版本 |
| `container/app/**` | `version.json` 的 `shell.versionCode` +1 | Program 版本 |
| 桥协议语义变更 | 壳 `shell.bridgeProtocol` +1，内核 `lobos.requiresProtocol` 跟上 | — |
| 只改 `programs/console/ui/**` | `programs/console/ui/package.json` 的 `version` | 以上都不动 |
| 换 Node 运行时 | `node-versions.json` 的 `default` | — |

> `versionCode` 是**单调整数**，只增不减。动了 `container/app/**` 却没 bump 的合并，
> `fast-apk` 会在发布步骤判红（自动通道不许同版本重发）。补救是**补 bump 再合**，
> 不是推 `fast-*` tag 把同号字节换掉。同版本重发只留给「投递本身坏了」的显式通道。

## 3. 两把信任根（互相独立，都不是代码能替代的）

| # | 信任根 | 用途 | GitHub secret（**准确名**） | 丢了会怎样 |
|---|---|---|---|---|
| ① | APK 签名密钥（keystore） | 决定"这个包是谁"，Android 只允许同签名覆盖安装 | `ANDROID_KEYSTORE_BASE64` + `ANDROID_KEYSTORE_PASSWORD`（+ `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` 可选，默认 `dsh` / =store 口令） | **永久失去**给已装设备推升级的能力 |
| ② | Program OTA 私钥（ed25519 PEM） | 给Program 包签名；公钥焊在 APK 里 | `OTA_PRIVATE_KEY_PEM`（公钥可用 `OTA_PUBLIC_KEY` 覆盖写入） | Program OTA 通道失效（APK 仍可升级） |

> 为什么两把分开：APK 签名保护"应用身份"，OTA 签名保护"Program 包来源"。混用会让
> 「Program 包泄露」升级成「可伪造应用更新」。
>
> 注意 `LOBOS_KEY_ALIAS` / `LOBOS_KEY_PASSWORD` **不是**仓库 secret 名 ——
> 它们是 `scripts/inject-apk-keystore.sh` 写出到 `$GITHUB_ENV` 的**内部键**（:85-87）。
> 真正要配的是 `ANDROID_*` 那四个。

## 4. 信任根校验门禁

- `scripts/verify-apk-signing.sh`（唯一实现；注入侧 `scripts/inject-apk-keystore.sh`）：
  - 配了 keystore → APK 内证书 SHA-256 指纹与注入锚点**逐指纹比对**，不符即硬红；
  - 发布链路（`build-apk` / `release-admin` 的 publish 与 repack）带 `--require-stable`：debug 身份、没配 keystore、锚点本身是 debug 三种情况都硬红；
  - **日常链路 `fast-apk` 允许 debug 档**，只打 `::warning::` —— 它的产物是 `v<versionName>` 下的取证归档，不写滚动别名。
- `scripts/verify-apk-release-form.sh`（唯一实现）：读 `android:debuggable`，判的是**形态**，与「谁签的」是两个独立事实
  （`container/app/build.gradle.kts:119-132` 让 debug 档也用 release keystore 签名，所以签名绿不代表形态绿，债 AUD-G33）。
  写 `apk-latest` 的三条链路（build-apk / publish / repack）都判非 debuggable；
  `fast-apk` 做**两侧对照**：debug 归档必须被读成 debuggable、控件构建出的 release 变体必须不是 —— 只测一侧的尺子分不清「包真干净」与「解析没生效」。
- release 变体的构建由 `assembleRelease` 里的 AGP 自带门禁 `lintVitalRelease` 一起判（fatal 即构建红）。它唯一被关掉的规则是
  `ExpiredTargetSdkVersion`（Google Play 的 targetSdk 下限），豁免只住在 `container/app/lint.xml` 一处：本包不走 Play，
  而 `targetSdk = 28`（`container/app/build.gradle.kts:41`）是 ADR 钉死的能力取值，不是可抬的版本号。其余 fatal 项照常拦。
- `scripts/verify-ota-anchor.sh`：强制锚点算法为 **Ed25519**，并在带 `--private` 时校验
  「私钥派生公钥 == 焊死锚点」，堵住轮换后 CI 全绿而设备全拒收的静默故障。

## 5. 发布物与命名

**壳**：

| 资产 | Release tag | 用途 |
|---|---|---|
| `app-release.apk` | `apk-latest` | 稳定别名（latest 地址永久不变），**release 形态**；装机/升级用的就是这个地址 |
| `app-debug-<versionName>+<versionCode>.apk` | `v<versionName>` | 版本化归档（debug 形态，`run-as` 取证只在它上面可用） |
| `version.json` | `apk-latest` | 壳版本清单（下次单调性检查的输入） |

**内核**（GitHub Release 只作归档；设备实际读对象存储）：

| Release | 资产 | 用途 |
|---|---|---|
| `program-<version>` | `program-<v>.zip` · `program-manifest.json` | 版本化归档 |
| `program-<channel>` | `program-manifest.json` · 本次 `program-<v>.zip` | 通道滚动归档（CI 版本前进门禁读这里） |

> gh 的资产名**取上传文件的 basename**（`file#标签` 里 `#` 后面只是 label，不改名）。
> 「确保 Release 在 → 覆盖上传 → 回读确认」只住 `scripts/gh-release-upload.sh`，四条发布链路都调它。

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
| 壳 versionCode 单调 + 同版本通道分叉 + 两格取严 | `scripts/verify-apk-version-gate.sh`（判据唯一宿主，0 放行 / 1 判红 / 2 无从校验）；取数外壳 `scripts/check-apk-release-version.sh` **每次取两格**：线上那格按参照物形状取（某条 Release 的 `version.json` 资产，或日常链的 `v<versionName>` 归档族资产名，宿主 `scripts/read-archived-shell-version.sh`），账本那格取 `scripts/read-apk-receipts.sh`（`ci-receipts` 分支上的 `apk-receipts.log`，写入唯一入口 `scripts/append-apk-receipt.sh`，四个发布口各自记账）；**两格取严**（按高的那格比），并把**参照物名**传给判据 | 回退；自动通道同号换字节；参照物选成这条链永不写的通道；**线上那一格被删小**（归档族可以被删，账本给出一条够不到的下界 —— 债 DS-16） |
| Program 版本前进 | `program-ota` 发布步骤（取数 `scripts/read-release-asset.sh`） | 版本复用 → 设备判"无更新" → 静默不生效 |

> 参照物必须是**这条链路自己会写的通道**：日常链 `fast-apk` 比对的是它写的 `v<versionName>` 归档族，
> 不是发布面别名 `apk-latest`（2026-09-30 现读：那条 Release 今天 404，而日常链从不写它 ⇒ 取数每次退「首次发布」、
> 门一个数都没比过；债 DS-14）。参照物空转的门比没有门更危险 —— 全绿读数会让人以为这一格有人守着。
>
> 但「这条链路自己会写的通道」仍然是一份**可以被删的线上状态**：2026-09-30 同日实测归档族从 44 条掉到 34 条，
> 6 个 `v<数字>` Release 消失，而门禁照绿 —— 所以线上那一格不再是完整的下界，回执账本才是
> （账本住在独立分支的只追加日志上，`append-apk-receipt.sh` **永不** `--force`，推送被拒就红着让人重跑）。
>
> 账本这格的两条纪律：「未起账」与「看不清」都不许咽成「线上什么都没有」。未起账时**自动通道判红**，
> 只有显式通道（`fast-*` tag / `workflow_dispatch`）放行并把第一笔记下 ⇒ **起账必须人工用显式通道做一次**；
> 若要**播种**账本（直接写首笔而不是等一次发布），起始 versionCode 必须等于线上现存的最高码，
> 从更低的码起账会让下一次自动发布判「有一次发布没记账」（这是设计，不是 bug）。
> 「不存在」与「取不到」的三态分类按**所读对象**分三处宿主，退码约定同一条（0=取到 / 10=确实没有 / 2=看不清，
> 退 2 一律**禁止发布**）：某个 Release 的**资产**住 `scripts/read-release-asset.sh`（内核 OTA 那条链共用这一处），
> 日常链的**整族归档**住 `scripts/read-archived-shell-version.sh`（它没有「某个资产不存在」这一态，整族为空才是首次发布），
> **回执账本文件**住 `scripts/read-apk-receipts.sh`（404=未起账，其它失败=看不清；把 gh 失败降成「账本还没有」
> 就是拿更弱的参照物放行 —— 那是最危险的一侧被放行）。

## 7. 设备端"我是谁"

`files/provisioning.json` 同时给出两个身份：`appVersion` / `appVersionCode` / `bridgeProtocol`（壳）
与 `programVersion`（内核，来自 `files/programs/console/CURRENT`）。

## 8. 签名密钥：生成与配置（一次性）

```bash
# ① 生成 keystore
./scripts/keygen-android-keystore.sh          # 产出 keys/release.keystore（keys/ 已 gitignore）
# ② 转 base64
base64 -w0 keys/release.keystore > /tmp/ks.b64
# ③ 写入 GitHub secrets：
#    ANDROID_KEYSTORE_BASE64 / ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS(默认 dsh) / ANDROID_KEY_PASSWORD
```

**备份（强制）**：`keys/release.keystore` 与口令存进离线密码库。它不是"可再生成的"——**丢了就永远回不来**。

## 9. GitHub PAT（维护通道）规则

- **存放**：仓外、权限 600（如 `files/.secrets/github.token`）；绝不入库、绝不进日志。
- **用法**：`Authorization: Bearer $(cat "$TOK")`；禁止 `set -x` / `echo` 令牌。
- **最小权限**：fine-grained，仅本仓 `Contents: RW` + `Actions: RW` + `Workflows: Write`。

## 10. 一次性基线重置（已执行完毕，仅存档）

2026-09-23 产品线起点定为 `1.0.0 (versionCode 1)`（开发期是 `0.2.0`）。因 versionCode 单调门禁会拦回退，
**一次性**清掉了 `apk-latest` 上的 `version.json`，使下一次发布被识别为"首次带版本发布"。

**重置后单调门禁即为权威，不得再重置**；此后一切发布只能递增。

## 11. 已知缺口（待修）

- 滚动别名上的**历史资产**：`app-debug.apk` 这个名字在形态收口（AUD-G33）之前一直是 latest 的资产名，
  线上那份 debug 形态的包要等写 latest 的三条链路里任意一条下一次真跑完才被 `--prune '^app-debug\.apk$'` 清掉。
  在那之前，按旧地址取包的人拿到的仍是 debuggable 包 —— 三个写者都已判形态，所以这是**投递滞后**，不是判定缺口。
  线上现读（2026-09-29 05:2x，`GET /releases/tags/apk-latest`）：资产 594507819 `app-debug.apk`（53 254 712 字节，
  digest `sha256:8329235acf2f…`，2026-09-28T04:39:35Z 上传）与 594507888 `version.json` 仍是 latest 的全部内容，
  即 prune 从没执行过。
  **2026-09-30 更正（现读同一端点）**：`GET /releases/tags/apk-latest` 退 **404**，且 `GET /releases?per_page=100`
  的 39 条里没有名为 `apk-latest` 的 tag —— 这条 Release 在 09-29~09-30 之间消失，删除动作没有任何在案记录，未查实是谁。
  于是这条缺口的当前状态是「无载体」（prune 的目标连同 Release 一起没了，下一次写 latest 会重新创建它），
  而它带出的**更大**问题另有归属：发布面三条链路的版本门禁参照物就是这条别名，今天就绪度=0 ⇒ 它们的门也全落在
  「首次发布 + 显式放行」那侧（在册 DS-14 的 ③，收口条件是发布面真跑一次 publish 自己把它写回来，不手动创建 Release）。
- 发布链的包**整套原生能力件缺席**（在册 DS-11，2026-09-29 由本批收口的审计当场抓出）：`build-apk` 从来没有
  调用过 `scripts/build-native-capabilities.sh`（只有 fast-apk 调），所以它 assembleRelease 出来的 APK 里
  `lib/arm64-v8a/` 只有 `libc++_shared.so` + `libnode.so`，缺 `liblobosflock/liblobosposix/liblobosptyprobe/libbash/liblobosrg`
  （PTY 件 `liblobospty.so` 软缺）。run 36513213633（head `ee1bab3a`）05:51:37Z 的审计读数原文：
  `== APK: …/app-release.apk (45530810 字节, ABI=arm64-v8a) ==` 后逐条 `[error] APK 里缺少 …`、
  `==> [error] 审计不通过，缺项: …（5 件）` ⇒ 该 run 判红、**没走到 publish**，
  所以上面那条 prune 的首次真执行仍要等下一次 build-apk 成功跑完（本批已在该链路补上同一份构建步骤）。
  判据侧的教训：审计收到唯一宿主 `scripts/verify-apk-native.sh` 之前，这条链只查 native-assets 清单、
  `lib/` 零条目只 echo 不红 —— 「构建成功」与「发出去的东西有没有能力面」之间原来没有门。
- `fast-apk` 的 release 控件构建**带着稳定签名**（2026-09-29 run 36490042734 读到 `[lobos-signing] 使用稳定签名`），
  但它只用来验形态，不投递；若哪天 fast-apk 撤掉 keystore，同一条会出 `app-release-unsigned.apk`——形态照样读得出，
  只是不是可投递的发布包。可投递的 release 包仍只由 build-apk / release-admin 产，而那两条要人按。
- 取证面：发布包非 debuggable 之后，`run-as` 只在 `v<versionName>` 的 debug 归档上可用；
  控制面起不来（内核没跑）时**没有**远程读法。这条不可约，见 `docs/runbook/system-device-verification.md` §0.1。

## 12. 发布前自检

- [ ] 形态门禁输出「[lobos-form] [ok] 非 debuggable（release 形态）」
- [ ] 审计（`scripts/verify-apk-native.sh`）逐件读到自有小件与 $PREFIX 依赖件
      （`liblobosflock`/`liblobosposix`/`liblobosptyprobe`/`libbash`/`liblobosrg`）——
      只读到 `libnode.so` + `libc++_shared.so` 的包发出去就是「有能力名、没能力面」（DS-11 的成因）
- [ ] 签名门禁输出「APK 证书指纹与注入锚点一致」（配了 keystore 时）
- [ ] `OTA_PRIVATE_KEY_PEM` 已配置，且 `verify-ota-anchor.sh --private` 通过
- [ ] `keys/release.keystore` + 口令已离线备份
- [ ] `fast-apk` 日志出现 `[version] 本次归档 x.y.z (versionCode=N)` **和** `[version] 版本前进（M → N）`
- [ ] 只更新内核时：`program-ota` 成功，且**壳版本未变**
- [ ] 设备 snapshot 的 `programVersion` / `programFloor` / `bridgeProtocol` 三者自洽（取法见 `system-device-verification.md` §0.1）
