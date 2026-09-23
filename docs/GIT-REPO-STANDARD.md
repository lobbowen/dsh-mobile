# 仓库与 Git 规范（GIT-REPO-STANDARD）

- 状态：v1 · 2026-09-23
- 适用范围：本组织下全部工程仓
- 目的：把「仓库拓扑 / 分支 / Tag / CI 触发 / 凭据 / 无 .git 工作副本接入」固化为可执行规范，
  杜绝 `git init` + `push --force` 这类毁历史的操作。

---

## 1. 现状事实（必须先对齐）

| 事实 | 值 |
|---|---|
| 主仓 | `lobbowen/dsh-mobile`（public） |
| 远端 main | `b34f889`（2026-09-23 **重建**：单一根提交，363 文件） |
| 形态 | **单仓双子项目（M）**：容器目录 + `dsh-android-kernel/` |
| 本工作副本 | 已建 `.git`；旧历史与全部旧 ref 备份于本机 `work/_backup/` |
| 旧 ref 快照 | `work/_backup/dsh-mobile/BACKUP-REFS.txt`（3 分支 / 26 tag 的真实 SHA） |
| 结论 | 基线已干净；后续改动一律走**分支 + PR**，`main` 不再 force-push |

---

## 2. 仓库拓扑（唯一事实）

| 仓 | 角色 | 默认分支 | 冻结性 |
|---|---|---|---|
| `dsh-mobile` | **主仓**。`app/ + container-engine/ + native/ + scripts/` = **L0 容器**；`dsh-android-kernel/` = **L1 内核** | `main` | 容器冻结；内核热更 |
| `dsh-supervisor-core` | 内核的 **PC 起源仓**（历史）。**不再承载 Android 内核** | `master` | 只读 / 归档 |
| `dsh-supervisor-launcher` | 桌面 Tauri 壳（PC） | `main` | 独立演进 |

> **规则：内核只有一个正统家。** 当前 = `dsh-mobile/dsh-android-kernel/`。
> 将来若迁到独立仓（S 子模块 / T 子树），必须一次性迁移并更新本表，不允许两处同时可写。

---

## 3. 分支模型

- `main` 受保护：**禁止 force-push、禁止直推**（本规范唯一硬红线）。
- 工作分支：`feat/<slug>` · `fix/<slug>` · `ci/<slug>` · `docs/<slug>` · `chore/<slug>` · `hotfix/<slug>`。
- 生命周期：分支 → PR → Squash/Rebase 合并 → 删除分支。

---

## 4. 提交规范

- 格式：`<type>(<scope>): <subject>`
- `type`：feat / fix / docs / ci / refactor / test / chore
- `scope`：`app` · `engine` · `kernel` · `native` · `ci` · `docs`
- **一次提交只做一件事**；"目录搬迁"与"逻辑修改"必须分开提交（结构化重构的前提）。

---

## 5. Tag 规范（"两个仓"的本质）

| 前缀 | 触发方 | 产物 |
|---|---|---|
| `container-v<semver>` | 容器发版 | APK |
| `kernel-v<semver>` | 内核发版 | 签名内核包（OTA） |
| `baseline-<YYYYMMDD>` | 接管 / 大重构前 | 回滚锚点 |

---

## 6. CI 触发（path 过滤 = 两个项目互不干扰）

```yaml
# .github/workflows/kernel-ota.yml
on:
  push:
    tags: ['kernel-v*']
    paths: ['dsh-android-kernel/**']

# .github/workflows/fast-apk.yml
on:
  push:
    paths:
      - 'app/**'
      - 'container-engine/**'
      - 'native/**'
      - '.github/workflows/fast-apk.yml'
```

目的：**内核改动不触发 APK 重编；容器改动不触发内核发版。** 这是单仓实现"两套独立发布"的关键。

---

## 7. 凭据规范（令牌使用规则）

**存放**
- 令牌只存**仓库之外**的固定路径：`<filesDir>/.secrets/github.token`（目录 700 / 文件 600）。
- 绝不出现在仓库、构建产物、日志里；`.gitignore` 另做纵深拉黑。

**使用（硬规则）**
1. **禁止 `set -x`**，禁止 `echo`/`printenv`/错误信息带出令牌；命令里只出现 `$(cat "$TOK")`。
2. 令牌只经 `Authorization: Bearer` 头传递；**不写进 URL、不写进 git remote**。
3. 一个令牌只对一个仓有效（最小权限：Contents: Read and write）。
4. 一次性动作（建树/提交/推 ref）优先走 API，避免交给会被日志捕获的进程。

**轮换与泄露处置**
- 有效期 ≤ 30 天，到期前更换。
- 令牌一旦出现在**任何日志 / 终端历史 / 对话**中即视为泄露 → 立即吊销重发（本次会话令牌属此例）。
- 轮换只改 `files/.secrets/github.token` 一个文件，脚本无需改动。

**CI**
- 优先 `secrets.GITHUB_TOKEN`；确需跨仓时才用 `secrets.GH_PAT`。

---

## 8. 核心流程：无 `.git` 工作副本 → 接入远端 → 发布

> 适用：解压包 / 沙箱 / 交接包拿到的目录树要接回远端。

**红线**：**禁止**在该目录 `git init` 然后 `git push --force` —— 会覆盖远端历史。

**步骤**

1. 另开临时目录克隆远端：
   ```sh
   git clone https://github.com/lobbowen/dsh-mobile.git /tmp/attach
   ```
2. 建工作分支：
   ```sh
   cd /tmp/attach && git checkout -b chore/attach-working-tree
   ```
3. **先 dry-run 看差异**，再覆盖：
   ```sh
   rsync -an --delete --exclude '.git/' ~/work/dsh-mobile/ ./
   rsync -a  --delete --exclude '.git/' ~/work/dsh-mobile/ ./
   ```
   ⚠ `--delete` 会删除"远端有、本地无"的文件；必须用第 4 步复核。
4. 复核：
   ```sh
   git status --short
   git diff --stat
   ```
5. 提交并推**分支**（不是 main）：
   ```sh
   git add -A
   git commit -m "chore(repo): attach working tree (pre-refactor baseline)"
   git push -u origin chore/attach-working-tree
   ```
6. 开 PR → 评审 → 合并 → 打 `baseline-<date>` tag。
7. 验收：`git status` 干净；远端 main 包含本地全部文件；CI 绿。

**无本地 git 的沙箱**：用纯 JS 实现（`isomorphic-git`）或 GitHub Git Data API；
流程与红线完全一致，只是命令替换。参见 `scripts/attach-and-publish.sh`。

---

## 9. 大文件与生成物

- 不入库：`app/src/main/assets/{kernel/baseline.zip,npm/,node-bin/}`、`feed/`、`release/`、`*.log`（现有 `.gitignore` 已覆盖）。
- `_artifacts/baseline/baseline.zip` 已入库（历史遗留）；**新的**大产物一律走 Release 附件。
- 任何单文件 > 5MB 前先停下确认。

---

## 10. 泄露处置（本次会话）

1. **立即吊销**本次会话中贴出的 PAT。
2. 重建**细粒度** PAT：仅 `dsh-mobile`、Contents RW、有效期 ≤ 30 天。
3. 复核近期 push 记录，确认无异常提交。

---

## 11. 回滚

- 打点：每次结构性改动**前**打 `baseline-*` tag。
- 本地回滚：`git reset --hard <baseline>`。
- 远端回滚：一律 `git revert`（**main 永不 force-push**）。
