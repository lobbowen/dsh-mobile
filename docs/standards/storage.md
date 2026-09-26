# 存储规范（STORAGE-STANDARD）

- 目的：给每一类产物**唯一**的存放位置与命名，配套**机器可读契约 + 对账工具**，使目录重构可验证、可回滚。
- 机器可读契约：[contracts/layout.json](contracts/layout.json)（**本文的判据数据源**）
- 对账工具：`container/engine/test/layout-manifest-test.js`

---

## 1. 分层与目录所有权

| 层 | 目录 | 权属 | 是否冻结 |
|---|---|---|---|
| **L0 容器** | `container/app`（Kotlin）· `container/engine`（纯 Node OTA）· `container/native`（C） | APK 冻结层 | 仅 Node/桥/权限变更才重编 |
| **L1 内核** | `kernel/` | 独立单元，容器 OTA 热更新 | 不冻结 |
| **L2 Agent** | 不入库（运行时 npm 拉取） | 内核管理 | — |
| **Tier S** | `system/`（priv-app / sepolicy / init / kernel frag） | ROM 集成面 | 独立 |
| **文档** | `docs/`（唯一归宿）· 根 `README.md` | — | — |
| **CI** | `.github/`（GitHub 强制根位置）· `scripts/`（跨层构建/发布工具） | — | — |
| **根构建** | `settings.gradle.kts` `build.gradle.kts` `gradle.properties` `gradle/` `gradlew*` | Gradle 强制根位置 | — |

> 规则：**一个产物只属于一个层**。跨层的（脚本）放 `scripts/`，并在 layout.json 的 `scriptsOwnership` 登记。

## 2. 目标目录树

```
dsh-mobile/
├── README.md                     # 仓入口
├── .github/                      # CI（强制在根）
│   └── native-assets.txt         # 由 NativeAssetRegistry 生成
├── container/                    # ══ L0 ══  app/ engine/ native/
├── kernel/                       # ══ L1 ══
├── system/                       # ══ Tier S ══
├── docs/                         # ══ 文档唯一归宿 ══
│   ├── README.md  architecture.md  glossary.md
│   ├── adr/  contracts/  standards/  runbook/  components/  plans/
├── scripts/                      # 跨层构建/发布工具
├── gradle/ · gradlew · gradlew.bat · gradle.properties
├── settings.gradle.kts · build.gradle.kts
├── .gitignore
└── version.json
```

## 3. 命名规范

| 对象 | 规范 | 例 |
|---|---|---|
| 目录 | 全小写，`-` 分隔，**不用** `_` | `container-engine` → `engine` |
| ADR | `docs/adr/NNNN-<slug>.md`，四位编号、不复用 | `0002-container-root-rejected.md` |
| 契约 | `docs/contracts/<name>.{json,md}` | `layout.json`、`bridge-protocol.md` |
| 规范 | `docs/standards/<topic>.md` | `storage.md`、`testing.md` |
| 运维手册 | `docs/runbook/<topic>.md` | `contributing.md`、`release.md` |
| 组件说明 | `docs/components/<topic>.md` | `kernel.md`、`native.md` |
| 脚本 | `scripts/<verb>-<object>.sh` | `build-kernel-bundle.sh` |

## 4. 存储分类（入库 / 生成 / 秘密 / 大文件 / 发布物）

| 类别 | 位置 | 是否入库 |
|---|---|---|
| 源码 | `container/**` `kernel/**` `system/**` `scripts/**` `docs/**` | ✅ |
| 构建产物 | `container/app/build/`、`.gradle/`、`container/engine/node_modules/`、`kernel/ui/{dist,node_modules}/` | ❌ gitignore |
| 运行时资产 | `container/app/src/main/assets/{npm,node-bin}/` | ❌ 可重建 |
| 内核投递产物 | `release/`、`feed/` | ❌ |
| **秘密** | `<filesDir>/.secrets/`（**仓库之外**）、`keys/` | ❌ 绝不入库 |
| **发布物** | GitHub Release：`node-runtime-<ver>-<abi>`、`apk-latest`、`kernel-*` | 不入 git |
| 大文件 | 单文件 > 5MB 一律走 Release 附件 | ❌ |

> `container/_artifacts/` 已删除（ADR-0005 之后它不再承载内核样本）。

### JSON 资产的严格性

- **数据资产必须是合法 strict JSON**（不允许 `//`、`/* */` 注释、不允许尾逗号）：
  `container/app/src/main/assets/*.json`、`docs/contracts/*.json`、`version.json`、`kernel/package.json` 等。
  理由：它们被 `JSON.parse` / Android `org.json` / 第三方工具消费，宽松解析器不应成为依赖。
  需要说明写在合法的字符串字段里（如 kernel-feed.json 的 `notes` 数组），不要用注释。
- **例外**：`tsconfig.json` / `tsconfig.*.json` 按 TypeScript 规范**允许**注释与尾逗号（JSONC），
  其消费方是 tsc。这类文件保留注释是**符合规范**的，不按上面的要求处理。

## 5. 单一事实源：`docs/contracts/layout.json`

所有"东西放哪"的判断只认这个文件：`layers`、`rootAllow`、`moves`（迁移映射 + 期望文件数）、
`legacyForbidden`、`generated`/`secrets`、`scriptsOwnership`。

## 6. 对账机制

```sh
# 报告模式（只列事实、不做断言 —— 属 testing.md §4 白名单）
node container/engine/test/layout-manifest-test.js
# 强制模式（CI 的 test:logic 首项）
LAYOUT_ENFORCE=1 node container/engine/test/layout-manifest-test.js
```

口径：① 路径对账（`moves` 的 `from` 消失、`to` 存在）；② 数量对账（`to` 文件数不得少于 `expectFiles`）；
③ 根对账（只允许 `rootAllow`）；④ 反残留（`legacyForbidden` 任一存在即失败）。

> `expectFiles` 在**有意的文件减少**（如把文档搬出源码目录）时应同步下调，并在条目里说明理由。

## 7. 变更流程

任何新增顶层目录 / 改变归属 / 移动文档，必须**先改 `layout.json` 并说明理由**，再改目录；
CI 的门禁会以契约校验兜底。未在契约登记的根条目视为违规。
