# ADR-0011：每条版本流只有一条发布链，发布由「带版本号的 tag」决定

- 状态：**已决定**（2026-09-30）
- 关联：ADR-0004（三版本流）· ADR-0005（Program 只走 OTA）· ADR-0009（交付六层）· ADR-0010（容器形态）
- 取代：任何「合并即出包 / 点一下按钮就重投 / 从别的 run 回取产物再覆盖」的形态

---

## 1. 决定

**每一条版本流只有一条发布链，且那条链只在「人打的那个 tag 名里写着本次版本号」时投递。**

| 流 | 唯一入口（tag） | 投递到的身份 | 单调判据 |
|---|---|---|---|
| OS 壳 APK | `os-release-<versionName>-<versionCode>` | Release `v<versionName>`，资产 `app-debug-<name>+<code>.apk` | `versionCode`（两格取严：归档族 + 回执账本） |
| Runtime（Node） | `runtime-release-<node 版本>-<abi>` | 不可变 Release `node-runtime-<版本>-<abi>` | 版本号即身份，`--skip-existing` |
| C 层（用户态件+清单） | `userland-<channel>-<revision>` | 对象存储 `userland/` 件 + `userland-<channel>/` 清单 | `revision` 严格单调（`--immutable` 闸门） |
| Program | `program-ota-<channel>-<version>` | `program-<version>` 归档 + `program-<channel>` 通道 feed | Program `version` 不可复用 |
| 原生能力件 | `workflow_dispatch`（**唯一的例外**，见 §5） | 不可变 Release `native-cap-<指纹>-<abi>` | 内容指纹 |

除以上五条之外，**仓里不再存在任何一条会把产物投递到设备可读位置**的链路。push 到分支、`workflow_dispatch`、任意别的 tag 形态一律只构建校验、不投递。

## 2. 为什么必须归一（这不是审美，是实测出来的账）

改动前仓里有 **7 条 workflow、10 个投递口**。逐条实测下来的后果：

1. **发布不是一个决定，而是一个副作用。** `fast-apk` 监听 push 到 main，任何一次合并都自动出包并覆盖 `apk-latest`；同一条链又监听 tag，于是「发不发」取决于合并时机而不是人的意图。
2. **版本门禁只在一条链上真的比过数。** 写滚动通道的有四处（fast-apk / build-apk / release-admin 的 publish 与 repack），2026-09-26 盘点时**只有 fast-apk 那份比较过 versionCode**，其余三个是「拿到 APK 就覆盖 latest」。`versionCode` 回退不可逆 —— 从旧 run 发一次就把已升级的设备永久锁死。
3. **参照物空转（债表 DS-14，2026-09-30 复算）。** 日常链把参照物写成 `apk-latest`，而那条别名**这条链自己从不写**（滚动别名只由发布面维护），线上现读 39 个 Release 里一个 `apk-latest` 都没有，`v<versionName>` 归档里带 `version.json` 资产的 **0 个** ⇒ 每次取数都退 10、每次被「首次发布」放行。**这道门从立起到今天一个数都没比过**，而全绿读数会让人以为这一格有人守着。
4. **参照物可以被删小（债表 DS-16，同日实测）。** 23:19Z 读到 44、23:52Z 只剩 34 —— 6 个 `v<数字>` 归档被抹掉，门禁拿着变小了的参照物继续绿。删参照物 = 自动放松门禁，且从读数上看不出松过。
5. **同版本换字节。** 改一行 Kotlin 注释合并后自动重出，`1.1.5(7)` 的下载地址在原地指向了另一批字节。版本号失去「不说谎」的能力。
6. **多份实现各自漂移。** ELF 形态、APK 原生件、签名身份、版本比较四件事，收口前各有 2~3 份拷贝、两种严格度（见 `docs/standards/quality.md` 的门禁法）。审计口径在三个 workflow 里各写一份，实际代价不是重复而是**分歧**。
7. **固化靠回取。** `release-admin` 的 pin/repack 模式从**别的 run** 里按 run-id 取 artifact 再固化 —— 产物名一改就断，而「找到的那份是哪一份」由那次 run 的运气决定。判据要能被兑现，就不能靠回取。

## 3. 删除清单（能力没有被砍，只是搬家或已无必要）

- **`.github/workflows/release-admin.yml`** —— 四个 job：`admin`（网页终端式运维，存在理由是「维护环境没有可用 PAT」，2026-09-28 起该前提已被本机 DoH+PAT 通道证伪）、`publish`、`repack`（同版本重投/换字节覆盖，正是 §2 第 5 条的形状）、`pin`（跨 run 回取固化，改为 `build-apk` 同轮固化）。
- **`scripts/inject-libcxx-into-apk.py`** —— 唯一调用方是 repack。留着一个「事后改 APK 字节」的工具，就等于留着第二条能产出与门禁读数不同字节的路。
- **滚动别名 `apk-latest`** —— 设备侧没有任何东西读它（注册表 DS-11 实读）。别名一旦可被覆盖，「线上这一版是什么字节」就没有答案了。
- **`fast-*` / `admin-*` / `publish-*` / `repack-*` / `pin-node-*` tag 形态** —— 前者的语义被 `os-release-*` 完全吸收，后四者随 release-admin 一起没有接收方。
- **push 到分支即投递** —— `fast-apk` 与 `build-userland` 的分支轮只做构建校验 + 与线上对账。
- **`ci-hb` / `ci-ping` / `ci-ok` / `ci-last` / `ci-diag` / `ci-admin` 六条自报分支的写者** —— 一律
  `git push --force`，每次把上一份读数原地换掉，那里读不出序列（DS-16 据此判死，回执改住只追加的
  `ci-receipts`）。失败留痕改投 Actions 构件。分支本体是线上残留，归债表的清理项，不在本 ADR 里当已完成。

## 4. 保留的两格「暂无调用方」，以及为什么不算 shim

- `verify-apk-version-gate.sh` 的 `CHANNEL` 仍接受 `explicit`，而**没有任何 workflow 传它**（门禁 `test/native-assets-test.js` 反向扫全仓，出现即红）。留这一格有两个用处：它是「两格取严」的分派对照组（没有显式侧，就无法证明自动侧的严是判出来的而不是唯一出路）；以及当线上读数整体丢失时，补账这条路要求**改 main**，因而可审计 —— 而不是点一个按钮。
- `verify-apk-native.sh --report` 只出事实不判红，调用方（diag 模式）已删。留着是因为审计宿主必须能被单独点着复算一个既有包（4 条测试在册）。

## 5. 能力件那条为什么允许 dispatch

能力件的身份是它的**内容指纹**，而指纹只有构建完才知道 —— 人无法预先打一个写着版本的 tag。所以入口是 `workflow_dispatch`，投递目标 `native-cap-<FP>-<abi>` 由指纹决定，不可变性由 `--skip-existing` + 上传前逐字节核对兑现（`pin-capabilities.yml`）。这条链**不写 main**：固化记录只落在自己的工作树并作为构件留痕，推不推由人定。
这是「tag 决定投递」的唯一例外，且例外的不是**要不要发**（那仍是人点的），而是**版本号从哪来**。

## 6. 后果

- **投递坏了要重传 ⇒ bump 一个版本号。** 同号原地重传这条路已经没有了。
- **首次播种 / 读数整体丢失 ⇒ 由人通过唯一写入口补账**（`scripts/append-apk-receipt.sh`，只追加分支 + 分支保护），补不上就让它红着，不许重试式兜底装成正常。
- **改了声明却没发 ⇒ 立刻红。** `build-userland` 的 `drift` 作业拿线上清单逐格对账，发布器与入口声明都在 `paths` 白名单里（ENV-26 的直接教训）。
- **tag 名与版本事实源必须逐字相等**：`os-release-<name>-<code>` 要和 `version.json` 比对方才投递 —— 对旧 ref 打新 tag、或先打 tag 再 bump，都发不出去（版本变了而内容没变，是 ADR-0004 那件事的镜像形状）。
- **一个 workflow 的 `on.push` 只能出现一次**（`branches`/`paths`/`tags` 必须合进同一个块）；tag 推送**不受 `paths` 过滤**（官方语义），这条是 C 层 TTL 重签能点得动的前提。

## 7. 兑现方式（谁钉住的）

| 不变量 | 钉它的地方 |
|---|---|
| 投壳 APK 的链只有一条 | `gh-release-upload-test.js` ⑦ 调用方集合相等；`apk-release-form-test.js` ③ 形态门禁调用点；`native-assets-test.js` 版本门禁调用点反向扫 |
| **投递只由带版本号的 tag 决定**（已登记的链丢掉 tag 条件即红） | `release-trigger-test.js`：投递宿主名单与存在性、有投递调用的 workflow 集合相等、无 tag 条件的链只允许「`on:` 里没有 push:」那一条、取不到条件一律判红；含「投递步丢掉 `if:`」「注释提及」「paths 白名单登记宿主名」「清单发布器的 `--project` 模式」四组对照。§1 那句决定的效力在这一条，不在调用方名单 —— 名单只防新增，防不住旧链把条件删掉 |
| 参照物是这条链自己会写的那一族 | `native-assets-test.js` 的 `DAILY_CALL` / `TAG="archive"` 两条，含旧写法对照组 |
| 没有链路能把壳版本门禁接到 explicit | `native-assets-test.js` 的 `explicitDoors` 反向扫 + 双向对照组 |
| 不再有滚动别名写者 | `gh-release-upload-test.js` 的 `ALIAS` 判据 + 自证/不误伤两条 |
| C 层 revision 单调、同版本不换字节 | `userland-manifest-drift-test.js` ⑧（含首次投放、旧形状、版本提升三个不误伤对照） |
| ELF / 原生件 / 签名判据各只有一份实现 | `verify-runtime-elf-test.js` ⑩、`native-assets-test.js` ⑨b、`apk-signing-gate-test.js` ⑥ |
| 「不存在 vs 看不清」的词表只住 `scripts/gh-absence.sh` | `native-assets-test.js` 的分类复写清零：扫 workflows + scripts 全量（收口前只扫 workflows 加一个外壳，而三处副本恰好在没扫的那一侧），含旧 grep 形与旧 case 形两条对照、三处 source 接线、「只有注释提及 → 判红」 |
