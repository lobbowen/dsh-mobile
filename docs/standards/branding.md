# 品牌与命名规范（Lob OS 主导）

- 状态：规范（2026-09-28）
- 一句话：**代码、身份、界面、契约里只允许出现我们自己的品牌；别人的品牌只允许作为"事实引用/依赖归属"出现在文档与第三方清单里。**

---

## 1. 我们的品牌标识（唯一合法集合）

| 用途 | 值 |
|---|---|
| 产品名 | **Lob OS** |
| 显示名（APK/通知/面板标题） | **Lob OS** |
| 标识符小写 | `lobos` |
| Application ID | **`lobos.app`**（Android 要求 ≥2 段） |
| gradle namespace / Kotlin 包根 | **`lobos`**（实际子包：`lobos.os` · `lobos.capability` · `lobos.ota` · `lobos.runtime` · `lobos.bridge` · `lobos.permissions` · `lobos.lifecycle` · `lobos.native` · `lobos.ui`（含 `ui.setup` / `ui.console`）） |
| Kotlin 包 | `lobos.*` |
| 环境变量 | `LOBOS_*` |
| 原生件 | `liblobos*.so` |
| 桥套接字 / 家目录 / 唤醒锁 | `lobos_hostbridge` · `files/.lobos/` · `lobos:runtime` |
| 系统清单 / sepolicy / init | `lobos-os` · `lobos_os` · `init.lobos.rc` |
| 仓库名 | `lobos` |
| 图标资源 | `ic_lobos_*` · `lobos-logo.svg` |

---

## 2. 允许出现的"别人的品牌"（白名单 + 边界）

| 类别 | 例子 | 允许位置 | 不允许位置 |
|---|---|---|---|
| 载荷品牌 | `dsh` · `DSH` · `@deepseek-ai/dsh` · DeepSeek Harness | **仅** `programs/dsh/**` 与该载荷适配器 | OS 一切位置 |
| 载荷依赖 | `@deepseek-ai/node-addon-system` 等 | 该载荷适配器；或 vendor 到自有 scope | 通用装配器/平台层 |
| 其他产品名 | Codex · Claude Code · opencode… | `docs/**`、市场条目数据 | 代码标识符、UI 品牌位 |
| 第三方 ROM/厂商名 | ColorOS · OPPO · OnePlus · HANS · osense | `docs/**` 的事实描述 | 代码标识符、**UI 文案** |
| 开源依赖名 | node · ripgrep · curl · SQLite · libc++… | `THIRD-PARTY.md` + 必要的引用 | 品牌位/标题/包名 |
| 第三方服务/镜像 | npmmirror · tencent mirrors · aliyun maven · npmjs | 构建配置（集中登记、可切换） | 运行时/界面 |

**唯一的保留理由 = 许可证与出处归属**，且必须集中登记在 `THIRD-PARTY.md`；"品牌位"（应用名/通知/面板标题/图标/包名/命名空间/环境变量/原生件名）**一律不得出现别人的品牌**。

---

## 3. 硬规则（可机器判定）

1. OS 命名空间 = `LOBOS_*`；**任何 `DSH_*` 残留 = 0**（仓内实测 37 个，全是 OS/CI 级，无一个是 dsh 载荷私有）。
2. `dsh` / `DSH` / `dshmobile` / `deepseek` / `DeepSeek` / `@deepseek-ai` / `harness`(作品牌) / `Android Node Container` / `dsh-android-kernel` / `dsh-console` / `dsh-logo`：**只允许出现在白名单路径**（`programs/dsh/**`、`docs/**`、`THIRD-PARTY.md`）。
3. UI 文案（`res/values/*`、通知渠道名、面板文案）**不得出现任何第三方品牌**（含 ROM/厂商名）。
4. 品牌位的改名必须**一次性做完**：包名、命名空间、环境变量、原生件、套接字、家目录、图标、文案、CI、仓库名、文档。

---

## 4. 品牌位（2026-09-28 已定）

1. **命名空间根 = `lobos`** → applicationId **`lobos.app`**；gradle `namespace = "lobos"`；Kotlin 包 `lobos.*`。
2. **OTA 域名不变**：`https://hubcdn.zll.ink`（9 处，保持）。
3. **仓库名 = `lobos`**（`lobbowen/lobos`，同步 28 处引用）。

## 5. 门禁

- `scripts/gate-scan.js` + `.github/gate-policy.json`：白名单外命中禁词即 CI 红（含 case/词边界处理）；
  另有 `scripts/doc-gate.js`（文档相对链接）与 `scripts/debt-gate.js`（债表未清项），当前为报告模式；
- 禁词清单与白名单路径随本规范维护；新增载荷时只加白名单目录，**不得**放宽 OS 层；
- 每次发布前跑全仓扫描，输出残留清单（`brand-scan-report.txt`）作为发布物之一。
