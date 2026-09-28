# 品牌清理总账（Lob OS）

> 配套规范：`../standards/branding.md`。原则：以 **Lob OS** 为主导，**不残留别人的品牌标识**。

## 0. 实测概况（仓内扫描）

| 指标 | 现状 |
|---|---|
| 含 `dshmobile` 文件 | **105** |
| `dsh*` 标识符 | **~874** |
| `DSH` 大写出现 | **~361** |
| `DSH_*` 环境变量（去重） | **37 个**（全部 OS/CI 级） |
| 含 `deepseek/harness` 文件 | **54**（含 docs） |
| `@deepseek-ai/*` 引用 | `dsh` 23 · `node-addon-system` 10 · `dsh-base` 4 · 其他 4 |
| 文件名含 dsh | **14** |
| 仓库自名 | `lobbowen/dshmobile`（23 处）、`lobbowen/dsh-mobile`（5 处） |

---

## A. 包身份与仓库（🔴 必须一次做完）

| # | 现状 | 新 |
|---|---|---|
| A1 | applicationId / namespace `io.github.lobbowen.dshmobile` | applicationId **`lobos.app`** / namespace **`lobos`** |
| A2 | Kotlin 包 `io.github.lobbowen.dshmobile.*`（105 文件） | `lobos.*`；源目录 `lobos/`（host/capability/console/setup/sys/ota/diag） |
| A3 | `rootProject.name = "AndroidNodeContainer"` | `"LobOS"` |
| A4 | 仓库名 `lobbowen/dshmobile` | `lobbowen/lobos`（同步 28 处引用） |
| A5 | APK label `Android Node Container` | `Lob OS` |
| A6 | 无应用图标（res 里无 mipmap/drawable） | 新建 `mipmap-*/ic_launcher` + adaptive icon + `lobos-logo.svg` |

## B. 运行期契约（🔴 OS 命名空间清零）

| # | 现状 | 新 |
|---|---|---|
| B1 | `DSH_*` × 37（DSH_ANDROID/DSH_BRIDGE_SOCKET/DSH_HOME/DSH_SUPERVISOR_HOME/DSH_UI_DIR/DSH_PERMISSION_MODE/DSH_FLOCK_NATIVE/DSH_NPM_ENTRY/DSH_ADB_DIR/DSH_APK_CERT_FILE/DSH_KEYSTORE_PASSWORD/DSH_KERNEL_REPO…） | `LOBOS_*` |
| B2 | `DNODE`/`dsh:runtime` 唤醒锁 | `lobos:runtime` |
| B3 | `dsh_hostbridge` 抽象套接字 | `lobos_hostbridge` |
| B4 | 家目录 `files/.dsh/` | `files/.lobos/` |
| B5 | `DSH_HOME` 与 dsh 载荷 `DSH_HOME` 撞名 | OS 侧 `LOBOS_HOME`，彻底切断 |
| B6 | `GuestAdapter` 给**所有** Program 注入 `DSH_*` | 改 `LOBOS_*`；dsh 私有变量由 dsh 适配器自己补 |

## C. 原生件与系统集成

| # | 现状 | 新 |
|---|---|---|
| C1 | `liblobosflock.so` `liblobosposix.so` `liblobospty.so` `liblobosptyprobe.so` `liblobosrg.so` | `liblobosflock.so` 等（含 `.github/native-assets.txt`、`NativeAssetRegistry.kt`、构建脚本） |
| C2 | `bin/dsh-console` | `programs/console/bin/panel`（职责另见执行方案） |
| C3 | `system/init/init.dsh.rc`、`system/kernel/dsh_container.configfrag`、`system/sepolicy/dsh_container.te` | `container/rom/` 下 `init.lobos.rc`、`lobos_os.configfrag`、`lobos_os.te`（域 `lobos_os`） |
| C4 | `privapp-permissions-io.github.lobbowen.dshmobile.xml` | `privapp-permissions-lobos.app.xml` |
| C5 | `kernel/src/d2` 等 D2 命名 | 随 L1 重构（见执行方案） |

## D. 载荷品牌泄漏（🟠 只许留在载荷）

| # | 现状 | 处理 |
|---|---|---|
| D1 | `kernel/package.json`：`name=dsh-android-kernel`、`bin.dsh-console`、`"dsh"` 字段、描述里点名 **Codex / Claude Code / DeepSeek Harness** | → `programs/console/package.json`：`name=lobos-console-panel`、`bin.panel`；描述中性化（"Agent 产品"不点名） |
| D2 | `kernel/src/assembler/flock-shim.js`/`manager.js` 硬编码 `@deepseek-ai/node-addon-system` | 从通用装配器移入 **dsh 适配器**；长期 vendor 到自有 scope 或改用自有原生件 |
| D3 | `kernel/src/api/lifecycle.js` 特判 `id === 'dsh'` | 泛化为 Program 能力/角色判断 |
| D4 | `kernel/src/domains/plugin/pluginmarket.js` 过滤 `dsh/deepseek-harness` | 移入 dsh 适配器或泛化为"已装载荷" |
| D5 | `kernel/adapters/dsh/agent.json`、`platform/agent-defaults.json` | → `programs/dsh/manifest.json` + dsh 适配器 |
| D6 | `kernel/ui/public/dsh-logo.svg`、`ui/src/assets/dsh-logo.svg` | → `lobos-logo.svg`（我们自己的 logo，不得使用载荷 logo 作为面板品牌位） |
| D7 | 测试 `dsh-access-route-test.js`、`fixtures/dsh-mock.js` | 改名/移入载荷测试目录 |

## E. 文案与界面（🔴 品牌位）

| # | 现状 | 新 |
|---|---|---|
| E1 | `strings.xml`：`app_name=Android Node Container`；`accessibility_desc`/`screenshot_*` 里写 **"DSH 容器"**；`notification_title=Node.js 运行时` | `Lob OS`；文案中性化（"Lob OS 需要无障碍服务以启用 UI 自动化能力"） |
| E2 | 通知渠道：`"Node Runtime"`、`"DSH 常驻监督"` | `"Lob OS 运行时"`、`"Lob OS 常驻"` |
| E3 | Kotlin 注释/文案里 **ColorOS / OPPO / OnePlus / HANS / osense**（CapabilityCatalog、OnboardingActivity 等） | 代码注释可保留事实但改用中性表述；**UI 文案不得出现厂商品牌**（改"系统后台管理"） |
| E4 | README / docs 顶部品牌 | 以 Lob OS 主导；第三方名仅在事实描述处出现 |

## F. 构建 / CI / 分发

| # | 现状 | 新 |
|---|---|---|
| F1 | 工作流 `program-ota.yml` 等 + `DSH_KERNEL_REPO`/`DSH_BUNDLE_OUT_DIR`/`DSH_KEY_*` | 改名 + `LOBOS_*` |
| F2 | 脚本 `build-kernel-bundle.*`、`sign-kernel-manifest.js`、`verify-ota-anchor.sh`… | `build-program-bundle.*` 等（随 L1 改名） |
| F3 | OTA 域名 `https://hubcdn.zll.ink`（9 处） | **不变**（已定 2026-09-28） |
| F4 | 镜像源 `registry.npmmirror.com`(226) / `mirrors.tencent.com`(132) / `maven.aliyun.com`(5) | 保留但集中登记、可切换；不算品牌位 |
| F5 | 开源依赖 attribution | 集中 `THIRD-PARTY.md` |

---

## G. 验收

1. 白名单外 `dsh`/`DSH`/`dshmobile`/`deepseek`/`DeepSeek`/`@deepseek-ai`/`harness`/`Android Node Container`/`dsh-android-kernel`/`dsh-console`/`dsh-logo` 命中 **= 0**；
2. 仓内任何 `DSH_*` **= 0**；`liblobos*` 文件名 **= 0**；`.dsh/` 路径 **= 0**；
3. UI 文案（res/通知/面板）第三方品牌名 **= 0**；
4. 品牌位统一：label `Lob OS`、图标存在、仓库名 `lobos`、`THIRD-PARTY.md` 齐备；
5. `brand-scan-report.txt` 随发布物产出，内容为"白名单外残留清单（应为空）"。

---

## H. 执行顺序（并入 v4 执行方案 D0/D1）

| 步 | 动作 |
|---|---|
| H1 | 落 `docs/standards/branding.md` + 禁词门（先红后绿） |
| H2 | 包身份与仓库改名（A1–A4）+ `THIRD-PARTY.md` |
| H3 | 运行期契约改名（B1–B6）+ 原生件（C1–C4） |
| H4 | 载荷品牌收口（D1–D7）+ 面板 logo（E2/D6） |
| H5 | 文案与界面（E1–E4）+ 图标（A6） |
| H6 | 构建/CI/分发（F1–F5）+ 域名决策 |
| H7 | 全量 brand-scan 归零，作为 D1 出口门禁 |
