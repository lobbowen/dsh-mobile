# 仓库与 Git 规范（GIT-REPO-STANDARD）

- 状态：v2（2026-09-27 按实际 workflow 校正）
- 目的：把「仓库拓扑 / 分支 / Tag / CI 触发 / 凭据 / 无 .git 工作副本接入」固化为可执行规范。

---

## 1. 仓库拓扑（唯一事实）

| 仓 | 角色 | 默认分支 | 冻结性 |
|---|---|---|---|
| `lobbowen/dsh-mobile` | **主仓**。`container/{app,engine,native} + scripts/` = **L0 容器**；`kernel/` = **L1 内核** | `main` | 容器冻结；内核热更 |
| `dsh-supervisor-core` | 内核的 PC 起源仓（历史），**不再承载 Android 内核** | `master` | 只读 / 归档 |
| `dsh-supervisor-launcher` | 桌面 Tauri 壳（PC） | `main` | 独立演进 |

> **内核只有一个正统家**：当前 = `dsh-mobile/kernel/`。不允许两处同时可写。
> 旧名 `app/`、`container-engine/`、`native/`、`dsh-android-kernel/` 均已不存在，
> 映射见 [../contracts/layout.json](../contracts/layout.json) 的 `moves`。

## 2. 分支模型

- `main` 受保护：**禁止 force-push、禁止直推**（本规范唯一硬红线）。
- 工作分支：`feat/<slug>` · `fix/<slug>` · `ci/<slug>` · `docs/<slug>` · `chore/<slug>` · `hotfix/<slug>`。
- 生命周期：分支 → PR → Squash/Rebase 合并 → 删除分支。

## 3. 提交规范

- 格式：`<type>(<scope>): <subject>`
- `type`：feat / fix / docs / ci / refactor / test / chore
- `scope`：`app` · `engine` · `kernel` · `native` · `ci` · `docs`
- **一次提交只做一件事**；"目录搬迁"与"逻辑修改"必须分开提交。

## 4. Tag 规范（按实际 workflow 校正）

| Tag | 触发方 | 产物 / 作用 |
|---|---|---|
| `v<versionName>` | fast-apk / ci | 壳的**版本化归档**（`app-debug-<VN>+<VC>.apk`）；`v*` 也触发 ci.yml |
| `apk-latest` | fast-apk / build-apk / release-admin | 滚动通道（`app-debug.apk` + `version.json`） |
| `node-runtime-<version>-<abi>` | build-apk 的 pin job | 预编译 Node 运行时（如 `node-runtime-24.21.0-arm64-v8a`） |
| `kernel-<version>` | kernel-ota | 内核版本化归档（`kernel-<v>.zip` + manifest） |
| `kernel-<channel>` | kernel-ota | 内核通道滚动归档（canary / stable） |
| `kernel-ota-*` | 人 | **触发** kernel-ota 构建 |
| `fast-*` | 人 | **触发** fast-apk 构建 |
| `pin-node-*` | 人 | 触发固化最近一次成功的 Node 构建产物 |
| `admin-*` | 人 | 管理命令（status / logs / release / cancel / cancelall） |
| `publish-*` · `repack-*` | 人 | 触发 release-admin 的 publish / repack |

> 已废弃：`container-v<semver>`、`kernel-v<semver>`（曾在本规范出现，workflow 从未消费）。

## 5. CI 触发（按实际 workflow 校正）

```yaml
# ci.yml —— 统一门禁（骨干）
on:
  push:  { branches: [main, master], tags: ['v*'],
           paths: ['container/**','kernel/**','docs/contracts/**','scripts/**',
                   '.github/native-assets.txt','.github/workflows/**'] }
  pull_request: { paths: [同上] }

# fast-apk.yml —— 日常出包
on:
  push: { branches: [main, master],
          paths: ['container/app/**','container/native/**','gradle/**','build.gradle.kts',
                  'settings.gradle.kts','gradle.properties','gradlew','gradlew.bat',
                  '.github/native-assets.txt'],
          tags: ['fast-*'] }

# kernel-ota.yml —— 内核 OTA
on:
  workflow_dispatch: { ... }
  push: { tags: ['kernel-ota-*'] }     # 确实有 push 触发，勿删

# build-apk.yml —— 全量 Node 交叉编译，仅手动
on: { workflow_dispatch: {} }          # push 触发已移除
```

目的：**内核改动不触发 APK 重编；容器改动不自动发内核包。**
注意 fast-apk **不**监听 `container/engine/**` 与 `kernel/**`。

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
| 构建产物 | `container/app/build/`、`.gradle/`、`container/engine/node_modules/`、`kernel/ui/dist/`、`kernel/ui/node_modules/` |
| 运行时资产 | `container/app/src/main/assets/node-bin/`、`container/app/src/main/assets/npm/` |
| 内核投递产物 | `release/`、`feed/` |
| 秘密 | `keys/`（白名单保留 README）、`*.keystore`、`keystore.properties`、`.secrets/` |
| 日志 | `*.log` |

> `_artifacts/baseline/baseline.zip` 已随 ADR-0005 删除（见 [../adr/0005-kernel-via-ota-only.md](../adr/0005-kernel-via-ota-only.md)）。
