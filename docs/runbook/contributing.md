# 贡献规范

本文件规定**唯一的做事方式**。目的：不再重复踩已经踩过的坑。

---

## 1. 改什么，走哪条路

**直接查表，不要凭感觉推。**

| 你改了什么 | 走哪条 | 耗时 | 说明 |
|---|---|---|---|
| `container/app/**`（Kotlin / assets / res / gradle） | `fast-apk.yml` | 分钟级 | 推 `main` 只做构建校验；**发布靠推 `os-release-*` tag**，见 §4 |
| `container/native/**` | `fast-apk.yml` | 分钟级 | 原生桥源码 |
| `container/engine/**` | `ci.yml` 的 container job | 分钟级 | **不触发** fast-apk（不出 APK） |
| `programs/**`（console Program + 面板 UI） | `ci.yml` 的 console job | 分钟级 | **不重编 APK**；发 Program 推 `program-ota-<channel>-<version>` tag |
| `scripts/build-node-android.sh` | `build-apk.yml`（**手动**，push 不触发） | **2~3 小时** | 只有真要重编 Node 才走 |
| 升级 Node 版本 | `build-apk.yml`（推 `runtime-release-*` tag） | **2~3 小时** | 同一条链自己固化，见 §3 |
| `docs/**`、`*.md` | `ci.yml`（`docs/**` 在 paths 里） | 分钟级 | 只跑门禁（doc-gate / debt-gate），不出产物 |
| `.github/workflows/**`、`scripts/**`、`docs/contracts/**` | `ci.yml` | 分钟级 | 走统一门禁 |

> **判断准则**：这个改动会不会改变 `libnode.so` 这一个字节？
> 不会 → 走 fast-apk（或 ci.yml）。会 → 推 `runtime-release-*` 重编，同一条链编完即固化。

### 设备内 spawn 的边界（改内核必读）

**能 exec 的是真名，不是宿主喂进来的路径。** 本产品刻意钉 `targetSdk=28` 换 app home 可 execve
（[ADR-0001](../adr/0001-android-execution-domain.md)）：`$PREFIX/bin` 下每一个真名 —— APK 播的
`{bash,rg,node}` 与 C 层签名清单播的 `{npm,pnpm,git,jq,curl,sqlite3}` —— 都按裸名可解析，脚本入口的
shebang 由原生兼容件按**调用方 PATH** 兑现（`container/native/d1/exec-path.c:11-13`），PATH 组装唯一
见 `container/app/src/main/java/lobos/os/RuntimeEnvironment.kt:83-91`。本节先前写的「W^X 下 `filesDir`
里的一切**不可 execve**」是 targetSdk≥29 的规矩，与钉 28 的理由直接矛盾（同口径见
`InstanceHost.kt:423-427`），已按事实改正。

**不要为「拿调用形态」再建一层代跑。** 旧本节指名的 `runtimeContract.npmInvocation()`、`npmEnv()`、
`NativeManager.dshCliInvocation()`、`resolveDshCli`、`config.command` 在仓内**零命中**（`runtimeContract`
只是 `container/engine/test/contract-schema-test.js:7` 里的局部变量名），属契约空指，与债表
ENV-19/ENV-20 同一形状；而它想换来的那个形状正是 `container/native/d1/exec-path.c:8-9` 已定罪的
「中间多了一层」。

**这道门今天不在仓内**：钉「面板全 src 禁 `child_process`」的那道门禁属 .48 世代代码，
2026-10-01 面板回到 .47 世代时随那一代一并移除；它的替换判据（判据对象换成「不得自持常驻权威」，
配能红的双向夹具）尚未落地 —— 所以「应用直接调环境里的 git/npm」现在是**门没了、判据也没补上**的状态，
定罪与动作仍册在债表 ENV-21。
环境形状的行为门禁宿主是 `container/engine/test/boot-env-contract-test.js`（真名=符号链接、APK 侧不留
npm 面、C 层供给对账），不是 `container/engine/test/test-chain-completeness-test.js` —— 后者只管
engine 测试脚本必须入 `test:logic` 链，共 33 行、npm 零命中（ENV-19 定过这条空指）。

---

## 2. 开发循环：**批次提交**

```
① 连续编辑多个文件（不推）
② 只读自查：是否引用已删文件 / 路径是否写错 / 契约是否同步
③ 一个逻辑单元改完 → 一次提交
④ 推分支 → 开 PR（**不要直推 main**，见 git.md §2）
⑤ CI 跑完，读一次结果
⑥ 红 → 先在本地定位（读源码/日志），再改，再推
```

**核心：推送是"交付"，不是"验证"。** 一个批次 = 一次推送，不是一个文件 = 一次推送。

**本地不执行仓内代码**（`node test`、`gradlew`、`scripts/*`）—— 红线与机制见
[../standards/testing.md](../standards/testing.md)。本地允许的只有：编辑、只读检索、统计。

---

## 3. 升级 Node 版本（低频，需主动操作）

```bash
# ① 改默认版本
vim container/app/src/main/assets/node-versions.json   # 改 default 字段

# ② 推固化 tag —— 同一条链跑完整交叉编译（2~3 小时），编完即投递
git push origin refs/tags/runtime-release-<node 版本>-<abi>
#    例：runtime-release-24.21.0-arm64-v8a
```

固化产物落在**不可变** Release：`node-runtime-<version>-<abi>`，如 **`node-runtime-24.21.0-arm64-v8a`**。
`fast-apk` 按这个名字去找；不固化会报"找不到 Release"并给出指引。

**tag 名里的版本号与 `node-versions.json` 现算出来的那一个逐字相符才动手**（判据在 build-apk 的
Resolve 步骤）—— 旧的「先编、再从别的 run 里按 run-id 回取产物固化」（`pin-node-*` /
release-admin 的 pin 模式）已整条删除：跨 run 回取真实断过一次（artifact 改名 ⇒ 取不到件，债 AUD-G33
有取证记录），而「找到的那份是哪一份」由那次 run 的运气决定，不是由判据决定。

---

## 4. 发布与出包：tag 通道（全仓只有这四条投递口）

```bash
# ---- 发这一版壳（OS 版本流；tag 里两个数必须与 version.json 逐字相等）----
git push origin refs/tags/os-release-<versionName>-<versionCode>

# ---- 固化这一版运行时（Runtime 版本流，见 §3）----
git push origin refs/tags/runtime-release-24.21.0-arm64-v8a

# ---- 发 C 层工具件 + 清单（revision 是正整数、严格单调）----
git push origin refs/tags/userland-canary-<revision>

# ---- 发这一版 Program（channel 与 version 都写在 tag 名里）----
git push origin refs/tags/program-ota-canary-0.1.0-android.49

# ---- 小件原生能力件：只有这一条是 workflow_dispatch（身份是内容指纹，人无法预先打 tag）----
#      见 ../adr/0011-one-release-chain-per-stream.md §5；它不写 main
```

**除了这四条 tag（加能力件那一个 dispatch），仓里没有任何一条链会投递。**
推 `main`、点 `workflow_dispatch`、打任意别的 tag —— 一律只构建校验。
旧形状（`fast-*` / `admin-*` / `publish-*` / `repack-*` / `pin-node-*`、合并即出包、
滚动别名 `apk-latest`）已随发布连归一废止，理由与实测账在
[../adr/0011-one-release-chain-per-stream.md](../adr/0011-one-release-chain-per-stream.md)。

**读 CI 结果不再走「push 一个 tag 让 CI 把读数写到某个分支」**：那五个分支
（`ci-hb` / `ci-ping` / `ci-ok` / `ci-last` / `ci-diag`）的写者每轮把上一份读数原地换掉，
从读数里看不出序列 —— 同一形状在债表 DS-16 被判死。现在直接用 PAT 读 API：

```
GET /repos/<owner>/<repo>/actions/runs?per_page=…        # 哪一轮在跑、跑到哪
GET /repos/<owner>/<repo>/actions/runs/<run_id>/jobs     # 每个 job 的结论
GET /repos/<owner>/<repo>/actions/jobs/<job_id>/logs     # 失败正文（判据读数在这里）
GET /repos/<owner>/<repo>/releases/tags/<tag>            # 线上这一版真有什么资产
```

凭据位置与用法见 [git.md](git.md) §6 与 [release.md](release.md) §9。

---

## 5. 提交前自查（CI 会替你跑，本地不必跑）

以下检查由 **CI 的第一步**执行，本地**不要**运行（见 testing.md §2）：

- `scripts/validate-workflow.py`（严格 YAML 校验）；
- `scripts/gen-version.js --check`（跨层版本）；
- `git diff --exit-code -- .github/native-assets.txt`（原生资产清单对账）。

`validate-workflow.py` 能抓到的问题，都是**曾经真实浪费过一整轮 CI 的**：

| 检查 | 为什么重要 |
|---|---|
| 重复 key | GitHub 拒绝加载，页面只显示"红色 ✗ + 0 秒"，没有任何日志 |
| `on.push` 出现两次 | 后者静默覆盖前者，触发条件变得不可预期 |
| `paths` 与 `paths-ignore` 同时写 | 语义冲突 |
| 缺少 `name` | run 列表里显示文件路径，找人极不方便 |

---

## 6. 改 workflow 时的硬规矩

**一条 `on:` 块里只能有一个 `push:`。**

```yaml
# ❌ 错：两个 push，后者覆盖前者
on:
  push: { branches: [main], paths: ['container/app/**'] }
  push: { tags: ['os-release-*'] }

# ✅ 对：合并成一个
on:
  push:
    branches: [main]
    paths: ['container/app/**']
    tags: ['os-release-*']
```

**触发条件的选择**：

- **高频路径**（日常构建校验）用 `paths` **白名单**：语义是"不匹配就不跑"。
- **低频路径**（Node 编译）用 `paths-ignore` **黑名单**：万一漏配最多白跑一次。
- **`paths` 不管 tag 推送**（官方语义：Path filters are not evaluated for pushes of tags），
  所以「同一个块里既有分支白名单又有 tags」是自洽的：分支轮按 paths 过滤，tag 轮恒跑。

---

## 7. 代码与注释规范

### 注释只写"改这里必须知道什么"

历史排查过程、外部依据、失败现象 —— **全部归 `docs/architecture.md`**，代码里只在必要处给一行指引。

```kotlin
// ❌ 不要在代码里写长篇叙事
// ✅ 只写约束和指引（完整原因见 docs/architecture.md 第 3 节）
put("LD_LIBRARY_PATH", libSearchPath)
```

**为什么**：同一件事写在三处，改一处忘两处就是事故。

### 删除死代码，不留"以后可能用得上"

判据：**一个 API 如果在仓库里零调用，就删掉。** 需要用的时候从 git 历史里翻。

---

## 8. 出问题时的排查顺序

1. **看真机诊断面板**（App 打开即是），对照 `docs/architecture.md` 第 9 节。
2. **CI 失败** → 直接读那一轮的 job 日志正文（§4 末尾那四条 API）。不要猜，猜一轮就是几十分钟到几小时。
3. **真机报错看不懂** → 查 `docs/architecture.md` 的"错误码速查"。
4. **改了没生效** → 先确认这条改动归哪个版本流、有没有推对应的发布 tag（只有 tag 轮投递）；
   再确认设备上装的确实是那一版：壳看 `files/provisioning.json` 的 `appVersion`/`appVersionCode`
   （ADR-0004 §5），Program 看 `files/programs/<id>/CURRENT`，C 层看清单的 `revision`。

---

## 9. 一句话总结

> **改 App 代码走 fast-apk（分钟级）；改 console Program 走 ci.yml 的 console job；只有动 Node 编译脚本才走 build-apk（小时级）。
> 拿不准就问自己：这会改变 libnode.so 吗？**
