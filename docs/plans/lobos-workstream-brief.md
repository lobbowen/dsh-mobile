# Lob OS 施工 · 子代理工作简报（W1–W4）

> 这是**唯一**子代理共享上下文。开始前先读：`docs/plans/os-v4-execution-plan.md`（总施工图 + 决策台账）、`docs/plans/os-architecture-v4.md`、`docs/standards/branding.md`、`docs/plans/android-residency-survey.md`、`docs/plans/residency-verification-plan.md`。
> 仓库根：`/data/user/0/io.github.lobbowen.dshmobile/files/work/dsh-mobile`

## 0. 不可违反的硬规则
1. **单一生命周期**：Android 侧最终只允许 1 进程 / 1 前台服务 / 1 常驻通知 / 1 控制台承载面。
2. **内核不是一层**：`programs/console` 只是"控制面板 Program"，可停可换；系统职责必须归 OS 原生（Kotlin）。
3. **品牌**：产品 Lob OS；applicationId `lobos.app`；namespace/Kotlin 包 `lobos`；仓库 `lobos`；OS 命名空间 `LOBOS_*` / `liblobos*` / `lobos_hostbridge` / `.lobos/` / `lobos:runtime` / `lobos-os` / `lobos_os` / `init.lobos.rc`。**`dsh`/`DSH`/`dshmobile`/`deepseek`/`@deepseek-ai` 只允许出现在 `programs/dsh/**` 与 `docs/**`、`THIRD-PARTY.md`。**
4. **常驻 = 五层保活**（锚/载体/豁免/唤醒/可见），**不设兜底/续跑**（agent 断即停，续跑是假信息）。
5. **Device Owner 全面退出**：不保留 DO 能力与路径；仅保留"用户手动同意"的安装。
6. 不 git push；不改 `.github/gate-policy.json` 的 `enforce`（现已置 **true**；要改须经主代理）；不删 `brand-scan-report.txt`；不改 `docs/plans/os-v4-debt-registry.json`（由主代理维护）。

## 1. 归属矩阵（只动自己名下的文件）
| 工作流 | 归属（glob） | 任务 |
|---|---|---|
| **W1 Kotlin OS 形态** | `container/app/src/main/java/**`、`container/app/src/test/**`、`container/app/src/main/res/**`、`container/app/src/main/AndroidManifest.xml`、`container/app/build.gradle.kts` | D1b-Kotlin（包路径/applicationId/namespace/DSH_*→LOBOS_*/文案/图标）+ D2（删 `:node`、3 FGS→1、删 binder 监督链/NodeWatchdogPolicy/node.pid/node.birth）+ D3 骨架（OsHost/OsInit/StateMachine/Journal/PortBroker/AppRegistry/AppManager 的**接口与状态机**，先不追求功能完备） |
| **W2 console Program** | `programs/console/**` | D4-console（入口 `panel`、清 dsh 专名、把"系统级职责"显式移除并输出给 W1 的接口清单）+ D5（可停可换：console 停止不影响 OS 运行/被管理） |
| **W3 品牌/文档/CI** | `docs/**`（除 debt-registry）、`.github/**`（除 gate-policy.enforce）、`scripts/**`、`README.md`、`THIRD-PARTY.md` | D1b-非代码（仓库名 28 处、CI 工作流改名/路径、脚本名与 `DSH_*`→`LOBOS_*`）+ D7（ADR：新增 0010、修订 0004/0005/0006/0008；`components/kernel*.md`→`system/console`；`kernel-bundle.schema.json`→`program-manifest.schema.json`；`agent-os-execution.md` 归档；`layout.json` 复核） |
| **W4 原生件与资产** | `container/native/**`、`container/engine/**`、`container/app/src/main/assets/**`、`container/rom/**` | D1b-资产（`liblobos*.so`→`liblobos*.so` 含 `.github/native-assets.txt` 由 W3 改则只报告、`kernel-verify.js`→`system-verify.js`、assets 路径）+ `container/rom`（`init.lobos.rc`/sepolicy 域 `lobos_os`/privapp xml）+ engine 测试剩余路径 |

## 2. 汇报格式（交付）
1. 改了哪些文件（按 glob 汇总 + 关键 diff 摘要）；
2. 跑了什么命令、结果（含 `node scripts/gate-scan.js` 前后数字）；
3. 完成/未完成（逐条对债表 id）；
4. 阻塞与需要主代理裁决的点（尤其 W1↔W2 的接口）。

## 3. 已知事实（避免重复踩坑）
- CI 在本机跑不了（无 Android SDK）：只做静态一致性与 grep/脚本级验证。
- `docs/contracts/layout.json` 已改 v3；`container/engine/test/layout-manifest-test.js` 依赖它，改前先读该测试。
- 设备实测：ColorOS 会成组清理（热档 bgLimit / lowmem），前台服务不豁免；见 `kill-audit.json`。
