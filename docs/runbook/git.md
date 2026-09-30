# 仓库与 Git 规范（GIT-REPO-STANDARD）

- 状态：v2（2026-09-27 按实际 workflow 校正）
- 目的：把「仓库拓扑 / 分支 / Tag / CI 触发 / 凭据 / 无 .git 工作副本接入」固化为可执行规范。

---

## 1. 仓库拓扑（唯一事实）

| 仓 | 角色 | 默认分支 | 冻结性 |
|---|---|---|---|
| `lobbowen/lobos` | **主仓**。`container/{app,engine,native,rom} + scripts/` = **OS（冻结 APK）**；`programs/console/` = **默认控制面板 Program** | `main` | OS 冻结；Program 热更 |
| `dsh-console-core` | 内核的 PC 起源仓（历史），**不再承载 Android 内核** | `master` | 只读 / 归档 |
| `dsh-console-launcher` | 桌面 Tauri 壳（PC） | `main` | 独立演进 |

> **Program 只有一个正统家**：当前 = `programs/console/`。不允许两处同时可写。
> 旧名 `app/`、`container-engine/`、`native/`、`kernel/` 均已不存在，
> 映射见 [../contracts/layout.json](../contracts/layout.json) 的 `moves`。

## 2. 分支模型

- `main` 受保护：**禁止 force-push、禁止直推**（本规范唯一硬红线）。
- 工作分支：`feat/<slug>` · `fix/<slug>` · `ci/<slug>` · `docs/<slug>` · `chore/<slug>` · `hotfix/<slug>`。
- 生命周期：分支 → PR → Squash/Rebase 合并 → 删除分支。

## 3. 提交规范

- 格式：`<type>(<scope>): <subject>`
- `type`：feat / fix / docs / ci / refactor / test / chore
- `scope`：`app` · `engine` · `native` · `console` · `ci` · `docs`
- **一次提交只做一件事**；"目录搬迁"与"逻辑修改"必须分开提交。

## 4. Tag 规范（2026-09-30 按发布连归一后的实际 workflow 校正）

**一条版本流一个发布 tag，发哪一版写在 ref 名里**（全仓拓扑见
[../adr/0011-one-release-chain-per-stream.md](../adr/0011-one-release-chain-per-stream.md)）。

| Tag | 消费方 | 产物 / 作用 |
|---|---|---|
| `os-release-<versionName>-<versionCode>` | fast-apk | **发布这一版壳**。tag 名那两个数必须与 `version.json` 逐字相等才投递，落到版本化归档 `v<versionName>`（资产 `app-debug-<VN>+<VC>.apk`）并记一笔回执 |
| `runtime-release-<node 版本>-<abi>` | build-apk | **固化这一版运行时**：跑完整交叉编译后发不可变 Release `node-runtime-<版本>-<abi>`（如 `node-runtime-24.21.0-arm64-v8a`） |
| `userland-<canary\|stable>-<revision>` | build-userland | **发 C 层清单/件**到对象存储；`revision` 是正整数、闸门要求严格单调 |
| `program-ota-<channel>-<version>` | program-ota | **发这一版 Program**：`program-<version>` 版本归档 + `program-<channel>` 通道指针 |
| `v<versionName>` | fast-apk 写、ci 读 | 壳的版本化归档 Release 名（不是触发器；`v*` 也在 ci.yml 的 tags 里，跑门禁） |
| `program-<version>` / `program-<channel>` | program-ota | Program 版本化归档 / 通道滚动归档 |
| `native-cap-<指纹>-<abi>` | pin-capabilities | 小件原生能力件的不可变固化（身份是内容指纹，不是序号） |

> 已废止（2026-09-30 发布连归一时整条删除，删除理由与实测账在 ADR-0011 §3；此处保留名字是因为
> 历史取证与债表按这些名字引用它们）：`fast-*`、`admin-*`、`publish-*`、`repack-*`、`pin-node-*`、
> `apk-latest`（滚动别名，设备上没有任何东西读它），以及更早的 `container-v<semver>`、`kernel-v<semver>`
> （曾在本规范出现，workflow 从未消费）。

## 5. CI 触发（按实际 workflow 校正）

```yaml
# ci.yml —— 统一门禁（骨干，不投递任何东西）
on:
  push:  { branches: [main, master], tags: ['v*'],
           paths: ['container/**','programs/**','docs/**','scripts/**','version.json',
                   '.github/gate-policy.json','.github/native-assets.txt','.github/workflows/**', …] }
  pull_request: { paths: [与 push 侧逐字对称] }

# fast-apk.yml —— OS 版本流（唯一壳 APK 投递口）
on:
  push: { branches: [main, master],      # → 只构建校验，不投递
          paths: ['container/app/**','container/native/**','gradle/**','build.gradle.kts',
                  'settings.gradle.kts','gradle.properties','gradlew','gradlew.bat',
                  '.github/native-assets.txt','version.json'],
          tags: ['os-release-*'] }       # → 发布这一版
  workflow_dispatch:                      # → 只构建校验

# build-apk.yml —— Runtime 版本流
on: { workflow_dispatch: {}, push: { tags: ['runtime-release-*'] } }   # 不监听分支

# build-userland.yml —— C 层版本流
on: { push: { branches: [main], paths: [供给声明与发布器], tags: ['userland-*'] },
      workflow_dispatch: {} }

# program-ota.yml —— Program 版本流
on: { workflow_dispatch: { inputs: … }, push: { tags: ['program-ota-*'] } }

# pin-capabilities.yml —— 能力件固化（唯一刻意保留的 dispatch-only 链，理由见 ADR-0011 §5）
on: { workflow_dispatch: {} }
```

**⚠️ 一个 workflow 的 `on.push` 只能出现一次**：写成两个 `push:` 块时，YAML 里后一个会覆盖前一个
（重复 key），触发条件变得不可预期 —— fast-apk 真踩过这条坑。分支条件与 tag 条件必须合进同一个块。
**⚠️ Path filters 对 tag 推送不做判定**（官方语义），所以上面 `paths` 只约束分支推送轮，tag 轮恒跑。

目的：**内核改动不触发 APK 重编；Program 改动不自动发壳。**
注意 fast-apk **不**监听 `container/engine/**` 与 `programs/console/**`。

## 6. 凭据规范

**存放**
- 令牌只存**仓库之外**：`<filesDir>/.secrets/github.token`（目录 700 / 文件 600）。
- 绝不出现在仓库、构建产物、日志里；`.gitignore` 另做纵深拉黑。

**使用（硬规则）**
1. **禁止 `set -x`**，禁止 `echo`/`printenv`/错误信息带出令牌；命令里只出现 `$(cat "$TOK")`。
2. 令牌只经 `Authorization: Bearer` 头传递；**不写进 URL、不写进 git remote**。
3. 一个令牌只对一个仓有效。
4. 一次性动作优先走 API。

**权限（与 [release.md](release.md) §9 对齐）**：fine-grained，仅本仓
`Contents: Read and write` + `Actions: Read and write` + `Workflows: Write`。

**轮换与泄露处置**
- 有效期 ≤ 30 天，到期前更换。
- 令牌一旦出现在**任何日志 / 终端历史 / 对话**中即视为泄露 → 立即吊销重发。
- 轮换只改 `files/.secrets/github.token` 一个文件。

**CI**：优先 `secrets.GITHUB_TOKEN`；确需跨仓时才用 `secrets.GH_PAT` / `secrets.PAT`。

## 7. 核心流程：无 `.git` 工作副本 → 接入远端

> 适用：解压包 / 沙箱 / 交接包拿到的目录树要接回远端。

**红线**：**禁止**在该目录 `git init` 然后 `git push --force` —— 会覆盖远端历史。

**步骤**：另开临时目录 `git clone` 远端 → 把工作副本的文件同步过去 → 在克隆里提交 → 推分支 → 开 PR。

## 8. 不入库清单（路径按现状）

| 类别 | 路径 |
|---|---|
| 构建产物 | `container/app/build/`、`.gradle/`、`container/engine/node_modules/`、`programs/console/ui/dist/`、`programs/console/ui/node_modules/` |
| 原生件（构建现编） | `container/app/src/main/jniLibs/` —— `libnode.so`（`scripts/build-node-android.sh:58`）与 `liblobos{pty,posix,flock,…}.so`（`scripts/build-native-capabilities.sh:74`）都落这里，CI 每次现编 |
| Program 投递产物 | `release/`、`feed/` |
| 秘密 | `keys/`（白名单保留 README）、`*.keystore`、`keystore.properties`、`.secrets/` |
| 日志 | `*.log` |

> `_artifacts/baseline/baseline.zip` 已随 ADR-0005 删除（见 [../adr/0005-program-via-ota-only.md](../adr/0005-program-via-ota-only.md)）。
