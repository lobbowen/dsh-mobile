# 存储规范（STORAGE-STANDARD）

- 状态：v1 · 2026-09-23
- 目的：给每一类产物**唯一**的存放位置与命名，配套**机器可读契约 + 对账工具**，
  使目录重构可验证、可回滚、可长期维护。
- 机器可读契约：[`docs/contracts/layout.json`](contracts/layout.json)
- 对账工具：`container/engine/test/layout-manifest-test.js`

---

## 1. 分层与目录所有权（唯一）

| 层 | 目录 | 权属 | 是否冻结 |
|---|---|---|---|
| **L0 容器** | `container/app`（Kotlin）· `container/engine`（纯 Node OTA）· `container/native`（C）· `container/_artifacts`（产物样本） | APK 冻结层 | 仅 Node/桥/权限变更才重编 |
| **L1 内核** | `kernel/`（原 `dsh-android-kernel/`） | 独立单元，容器 OTA 热更新 | 不冻结 |
| **L2 Agent** | 不入库（运行时 npm 拉取） | 内核管理 | — |
| **L3 能力桥** | `container/app/src/main/java/<pkg>/bridge` | 随 APK | 冻结 |
| **Tier S** | `system/`（priv-app/sepolicy/init/kernel frag） | ROM 集成面 | 独立 |
| **文档** | `docs/{adr,contracts,runbook,archive}` · 根 `README.md` `ARCHITECTURE.md` | — | — |
| **CI** | `.github/`（GitHub 强制根位置）· `scripts/`（跨层构建/发布工具） | — | — |
| **根构建** | `settings.gradle.kts` `build.gradle.kts` `gradle.properties` `gradle/` `gradlew*` | Gradle 强制根位置 | — |
| **归档** | `_archive/`（历史快照，只读） | — | 不再演进 |

> 规则：**一个产物只属于一个层**。跨层的（脚本）放 `scripts/`，但必须在 §5 登记它的服务对象。

---

## 2. 目标目录树

```
dsh-mobile/
├── README.md                     # 入口
├── ARCHITECTURE.md               # 单一事实源（P5 由 docs/ARCHITECTURE + BASE_SPEC 合并）
├── .github/                      # GitHub 强制在根
│   ├── workflows/
│   └── native-assets.txt         # 由 NativeAssetRegistry 生成（P4）
├── container/                    # ══ L0 ══
│   ├── app/                      # 原 app/
│   ├── engine/                   # 原 container-engine/
│   ├── native/                   # 原 native/
│   └── _artifacts/               # 原 _artifacts/
├── kernel/                       # ══ L1 ══ 原 dsh-android-kernel/
├── system/                       # ══ Tier S ══
├── docs/
│   ├── adr/                      # 0001-… 决策记录（含"已否决"）
│   ├── contracts/                # layout.json · bridge · kernel-bundle · runtime-json · feed
│   ├── runbook/                  # 排障/运维/CI/密钥/交接
│   └── archive/                  # 历史文档（只读）
├── scripts/                      # 跨层构建/发布工具（服务对象见 §5）
├── gradle/ · gradlew · gradlew.bat · gradle.properties
├── settings.gradle.kts · build.gradle.kts
├── .gitignore
└── _archive/                     # 历史快照（README-交接包、CHANGES.diff 等）
```

---

## 3. 命名规范

| 对象 | 规范 | 例 |
|---|---|---|
| 目录 | 全小写，`-` 分隔，**不用** `_` | `container-engine` → `engine`；`_artifacts`→`_artifacts`（下划线仅限归档/样本前缀） |
| ADR | `docs/adr/NNNN-<slug>.md`，四位编号、不复用 | `0002-container-root-rejected.md` |
| 契约 | `docs/contracts/<name>.{json,md}` | `layout.json`、`bridge-methods.md` |
| 运维手册 | `docs/runbook/<topic>.md` | `git-repo-standard.md` |
| Kotlin 包 | `<pkg>.<layer>`（runtime/lifecycle/bridge/ota/assets/permissions/ui） | 应用身份落定后统一替换 `com.example.*` |
| Native | `container/native/<purpose>/` + `PROVENANCE.md` | `native/posix/` |
| 脚本 | `scripts/<verb>-<object>.sh` | `build-kernel-bundle.sh` |
| 生成物 | 一律落在 §5 指定位置，**不进 git** | `app/src/main/assets/{npm,kernel/baseline.zip,node-bin}` |

---

## 4. 存储分类（入库 / 生成 / 秘密 / 大文件 / 发布物）

| 类别 | 位置 | 是否入库 |
|---|---|---|
| 源码 | `container/**` `kernel/**` `system/**` `scripts/**` `docs/**` | ✅ |
| 构建产物 | `container/app/build/`、`.gradle/`、`container/engine/node_modules/` | ❌ gitignore |
| 运行时资产 | `container/app/src/main/assets/{npm,node-bin,kernel/baseline.zip}` | ❌ 可重建 |
| 内核包/feed | `release/`、`feed/` | ❌ 投递产物 |
| 产物样本 | `container/_artifacts/` | ✅（小体积、可重建，仅作参考） |
| **秘密** | `<filesDir>/.secrets/`（**仓库之外**） | ❌ 绝不入库（见 GIT-REPO-STANDARD §7） |
| **发布物** | GitHub Release：`node-runtime-<ver>-<abi>`、`apk-latest`、`kernel-*` | 不入 git |
| 大文件 | 单文件 > 5MB 一律走 Release 附件 | ❌ |

---

## 5. 单一时事源：`docs/contracts/layout.json`

所有"东西放哪"的判断只认这个文件，不再散落在文档/脚本里。它包含：
`layers`（层→目录）、`rootAllow`（允许的根条目）、`moves`（迁移映射 + 期望文件数）、
`legacyForbidden`（迁移后禁止再出现的旧路径）、`generated`/`secrets`（不入库项）、
`scriptsOwnership`（脚本服务对象）。

`scripts/` 服务对象登记：

| 脚本 | 服务对象 |
|---|---|
| `build-node-android.sh`、`build-apk-local.sh`、`keygen-android-keystore.sh`、`inject-libcxx-into-apk.py`、`stage-npm-assets.sh` | L0 容器 |
| `build-kernel-bundle.sh`、`build-kernel-baseline.sh`、`build-kernel-feed.sh`、`keygen.sh` | L1 内核 |
| `make-release.sh`、`gh-access.sh`、`validate-workflow.py`、`attach-and-publish.sh` | 跨层/CI |

---

## 6. P1 迁移映射表（old → new）

| # | 旧路径 | 新路径 | 类型 | 期望文件数 | 需同步的引用 |
|---|---|---|---|---|---|
| 1 | `app/` | `container/app/` | dir | 34 | `settings.gradle.kts`(`projectDir`)、所有 workflow、`app/build.gradle.kts` 内的相对路径 |
| 2 | `container-engine/` | `container/engine/` | dir | 30 | workflow、`docs/*`、`kernel` 跨仓测试的 `DSH_KERNEL_REPO` |
| 3 | `native/` | `container/native/` | dir | 7 | `fast-apk.yml` 编译步骤、`.github/native-assets.txt` 注释 |
| 4 | `_artifacts/` | `container/_artifacts/` | dir | 2 | docs 引用 |
| 5 | `dsh-android-kernel/` | `kernel/` | dir | 236 | `kernel-ota.yml`、`fast-apk.yml`、`scripts/build-kernel-*.sh`、`container/engine/test/bridge-interop*`、`build-kernel-baseline.sh` |
| 6 | `docs/ADR-001-*.md` | `docs/adr/0001-android-execution-domain.md` | file | 1 | 引用路径 |
| 7 | `docs/GIT-REPO-STANDARD.md` | `docs/runbook/git-repo-standard.md` | file | 1 | 引用路径 |
| 8 | `docs/BRIDGE_PROTOCOL.md` | `docs/contracts/bridge-protocol.md` | file | 1 | `kernel` 侧引用 |
| 9 | `docs/HANDOVER.md` `PROVISIONING.md` `CONTRIBUTING.md` | `docs/runbook/` | file×3 | 3 | 引用路径 |
| 10 | `README-交接包.md` | `_archive/README-交接包.md` | file | 1 | — |
| 11 | `docs/adr/0002-*.md` | 保持 `docs/adr/` | — | 1 | — |
| 12 | `CONTAINER-STATUS.md` | `docs/runbook/container-status.md` | file | 1 | — |

> 说明：**内容合并**（`BASE_SPEC`→`ARCHITECTURE`、`CONTAINER-STATUS`→`runbook/status`）属 **P5**，
> P1 只做**位置迁移**，不改正文；Kotlin 包名重排亦在 P1 之后单独做。

---

## 7. 对账机制

### 7.1 工具
```sh
# 报告模式（随时可跑，不阻断）——打印每个映射 pending/done/conflict
node container/engine/test/layout-manifest-test.js

# 强制模式（P1 完成后接入 test:logic）——旧路径残留 / 未声明根目录即失败
LAYOUT_ENFORCE=1 node container/engine/test/layout-manifest-test.js
```

### 7.2 对账口径
1. **路径对账**：`moves` 逐条 `from` 必须消失、`to` 必须存在；
2. **数量对账**：`to` 的**文件数必须等于 `expectFiles`**（P1 迁移前后逐目录守恒，少一个即失败）；
3. **根对账**：仓库根只允许 `rootAllow` 列出的条目；
4. **反残留**：`legacyForbidden` 任一存在即失败；
5. **入库对账**：`generated`/`secrets` 不得出现在 git 索引中（配合 `.gitignore` + gate 测试）。

### 7.3 迁移前后基线（当前存量 = 迁移前）

| 目录 | 文件数 | 目录 | 文件数 |
|---|---|---|---|
| app | 34 | docs | 11 |
| container-engine | 30 | scripts | 14 |
| native | 7 | system | 7 |
| dsh-android-kernel | 236 | .github | 9 |
| _artifacts | 2 | gradle | 2 |
| 根文件 | 9 | **合计** | **361** |

---

## 8. P1 验收清单

- [ ] `node container/engine/test/layout-manifest-test.js` 报告全部 `done`、0 `conflict`
- [ ] `LAYOUT_ENFORCE=1` 通过
- [ ] 各目录文件数与 §7.3 基线**逐一相等**（总计 361；`docs` 因新增契约/规范文件为 11）
- [ ] `settings.gradle.kts` 指向 `container/app`；CI 触发路径已更新
- [ ] `fast-apk` 在分支上构建通过（Kotlin 编译 + APK 产出）
- [ ] 内核测试 `npm test`（在 `kernel/`）通过
- [ ] 提交信息：`refactor(layout): P1 directory layering`

---

## 9. 变更流程

任何新增顶层目录/改变归属，必须**先改 `layout.json` 并说明理由**，再改目录；CI 的门禁会以契约校验兜底。
未在契约登记的根条目视为违规。
