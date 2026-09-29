# 常驻能力验证执行方案（Lob OS）

> 验证对象：**五层**保活组合（**锚 / 载体 / 豁免 / 唤醒 / 可见**）；**不设兜底/续跑**——唯一路径是不被杀。
> 验证原则：**每一项都要有可复现的命令、可归档的证据、可判定的阈值；观测项与判据项分开。**
> 关联：`os-architecture-v4.md` §2.3 · `android-residency-survey.md`。

---

## 0. 目标能力与总判据

| 代号 | 能力 | 总判据 |
|---|---|---|
| C1 | 锁屏持续运行（CPU 推进） | 锁屏 30 min 内目标进程 `utime+stime` 增量 > 0 |
| C2 | 锁屏可联网 | 锁屏期外部网络请求成功率 ≥ 95%；本地控制面 36360 可服务（无内核包时该项**不适用**，不许拿探针端口顶 —— 探针只在诊断页被点一下才跑）|
| C3 | 不被后台治理清掉（**唯一路径，无兜底**） | **存活率 / 存活时长**为判据；被杀次数与口径为观测项；**不设"恢复/续跑"项** |
| C4 | 用户可见可控 | 常驻通知在锁屏可见且可操作；QS Tile 存在 |
| C5 | 零预置 | 全新安装（不置备、无特殊账号要求）后全部项目可复现 |

**硬门槛（与执行方案一致）**：`dumpsys activity processes` 本 UID = **1 条 ProcessRecord**；`isForeground=true` **=1**；常驻通知 **=1**。

---

## 1. 环境与工具

| 工具 | 用途 | 说明 |
|---|---|---|
| HostBridge `shell.exec`（uid 2000） | 全部 dump/采集 | 已配对的无线调试；跨进程只读采集 |
| `logcat` 常驻轮转 | 事件取证 | `logcat -b all -v threadtime -f <path> -r 4096 -n 4`（建议开机即起） |
| `dumpsys` 系列 | 状态读取 | 见 §2 各层命令 |
| `/proc/<pid>/stat`、`/proc/meminfo` | CPU/内存 | 计算锁屏期增量 |
| 计时器 | 场景时长 | 10 min / 30 min / 8 h |

**产物目录约定**：每次运行 `verify/<YYYYMMDD-HHMM>-<场景>/`，内含 `raw/*.txt`（原始 dump）、`summary.md`（结论）、`commands.txt`（实际执行命令）。

---

## 2. 逐层验证项（命令 → 判据 → 证据）

### V-A 锚（AccessibilityService）
| 项 | 命令 | 判据 |
|---|---|---|
| V-A1 服务在册且已绑定 | `settings get secure enabled_accessibility_services`；`dumpsys accessibility | grep -i -A3 lobos` | 我们的服务在册且 `Bound services` 非空 |
| V-A2 判决档位（本机 ROM） | `logcat -d | grep -i 'importance=accessibility'` | 观察窗内出现 ≥1 次 |
| V-A3 锚掉线**可见**（不承诺重绑） | 解绑（**先记录原值**，可回滚）后：`settings get secure enabled_accessibility_services`、`dumpsys accessibility`、通知/首页状态行、`run-as lobos.app cat files/os/journal/events.jsonl`（`category=accessibility`） | 判据是翻转必须看得见：掉线后状态行不再显示在位，journal 里多出「判决降级告警：锚掉线」。**不设「≤60s 回到 bound」**——`OsHostService` 的锚层监护「只观测，不动手」（2026-09-28 拍板），挂锚只发生在进程出生的第一毫秒 |

### V-B 载体（前台服务）
| 项 | 命令 | 判据 |
|---|---|---|
| V-B1 单进程/单 FGS/单通知 | `dumpsys activity processes`、`dumpsys activity services <pkg>`、`dumpsys notification` | 1 / 1 / 1 |
| V-B2 FGS 类型与申报一致 | `... | grep 'types='` | 与 Manifest 申报一致 |
| V-B3 打断可见（**不承诺回位**） | `am kill <pkg>` 后不主动重开；`dumpsys activity processes`（本 UID 计数）、`run-as <pkg> cat files/os/journal/events.jsonl`（`category=kill-audit`）、通知首行 | 判据只有「看得见」：这一次中断在 journal 里有对应记录，通知/首页/导出报告三处的中断与死因按 V-F3 的取证口径给出。**服务是否回位、隔多久回位只记录，不作通过条件**（进程外复活边 2026-09-26 已整体删除；同口径见 `docs/plans/os-v4-execution-plan.md:306`「不设"被杀后恢复"项」） |

### V-C 豁免
| 项 | 命令 | 判据 |
|---|---|---|
| V-C1 电池优化/Doze/bucket | `dumpsys deviceidle whitelist`、`am get-standby-bucket` | 在册；bucket 为最优档 |
| V-C2 OEM 开关前后对比 | `dumpsys activity exit-info`（分段统计） | 开启后：被杀频次下降 **或** 口径上移（观测项） |

### V-D 唤醒与网络
| 项 | 命令 | 判据 |
|---|---|---|
| V-D1 无永久裸锁 | `dumpsys power | grep -i wake_lock` | 空闲时应无本应用常驻锁 |
| V-D2 干活持锁、空闲释放 | 触发一次任务后重复 V-D1 | 有→无 可观测 |
| V-D3 锁屏 CPU 推进 | `cat /proc/<pid>/stat` 前后 | Δ(utime+stime) > 0 |
| V-D4 锁屏网络 | 外部 HTTP 请求 + 本地 `curl 127.0.0.1:<port>/status` | 成功率 ≥ 95% |
| V-D5 闹钟注册 | `dumpsys alarm | grep -i <pkg>` | 仅注册必要的周期项；无高频滥用 |

### V-E 可见性
| 项 | 命令/动作 | 判据 |
|---|---|---|
| V-E1 通知锁屏可见可控 | 锁屏观察 + 操作 | 可见；点击进入控制台 |
| V-E2 QS Tile | 下拉快控 | 存在且可切换 |

### V-F 打断可见（**不做恢复**）
| 项 | 命令/动作 | 判据 |
|---|---|---|
| V-F1 中断可见 | 杀进程后重启：读 `state.json`/通知 | 能说明"上次中断到何时"，不伪装成未中断 |
| V-F2 口径上移 | `dumpsys activity exit-info` | 被杀 description 不再是 `(service){fg-service}`（观测项） |
| V-F3 死因来自取证 | `run-as <pkg> cat files/os/journal/events.jsonl`（`category=kill-audit`）＋ 通知首行 | ① 新壳的 `kill-audit` 条目数 **> 0**（2026-09-30 定罪时的旧壳对照读数：journal 251 行里 kill-audit **0 条** —— 采集走 dumpsys 在 app uid 下永远被拒）；② 首行死因段要么逐字对应 journal 里那条记录，要么明写「未取证」并说清为什么取不到。两句都不许出现：机制猜测（「锚掉=判决降级=即将被杀」）、「没被杀」（把采集失败伪装成清白） |
| V-F4 首行不跨世（债 E12） | 往 `files/residency.txt` 写一个**假的上一世**时间戳 → `am force-stop` → 重开 → 立刻读通知首行与 `files/os/state.json`（不等第一拍之后的任何刷新） | 出生后的**第一句话只能是本世的**：状态行不得出现上一世留在 `state.json` 里的判决与读数（改前实读：首行立刻带「被打断」，60s 后才被本世实测抹平）。允许出现的只有两种——本世翻旧账得到的判决（`ResidencyAudit.interruption()`），或「状态采集中…／锚未知」这类本世还没量的如实空值。反向对照：`state.json` 里留着上世 `interrupted` 与 `readingsCollected=true` 时，重开首行仍不得照抄那份读数 |
| V-F5 常驻记录只有两行（债 E14） | `run-as <pkg> cat files/residency.txt` | 恰好两行 `lastAliveMs / bootBasisMs`；不存在第三行状态位，也不存在「静默无判决」那一档（本机没有任何一路能正常收尾宿主，`am stopservice` 现读 `Error stopping service`）。整机重启后首启必须写「结束于设备重启」而不是「被打断」 |

> **明确不做**：任务 checkpoint / 续跑 / 复活兜底 —— agent 一旦被切断即停止，"续跑"是假信息（ADR-0006 同判）。

---

## 3. 端到端场景（时长型）

| 场景 | 步骤 | 通过判据 |
|---|---|---|
| **S1 锁屏 10 min** | 起采集 → 锁屏 10 min → 解锁取数 | C1/C2 达标；存活；1/1/1 不变 |
| **S2 锁屏 30 min** | 同上 30 min | 同上；记录唤醒次数与耗电 |
| **S3 过夜 8 h** | 睡前锁屏，早取数 | 存活率达标；被杀次数为观测项；中断如实可见 |
| **S4 多程序** | 装 2–3 个 Program，仅 1 个运行 | 其余冻结；常驻内存不随安装数线性增长 |
| **S5 杀-打断可见** | ①`am kill` ②整 UID 杀 ③重启设备 | **中断如实可见 + 死因来自取证**（V-B3 / V-F3 口径），三种杀法的口径要能区分开；服务/通知是否回位、隔多久回位**只记录，不作通过条件**（不要求任务续跑） |
| **S6 压力复现（可选/高风险）** | 制造低内存或热档 | 只观测，不作为通过条件；用于验证"被杀不丢事" |

---

## 4. 指标定义与计算

| 指标 | 定义 |
|---|---|
| 存活时长 | 进程启动 → 下次死亡/观测结束 |
| MTBK | 平均被杀间隔（按 exit-info 时间戳） |
| 中断跨度 | 死亡时间戳（kill-audit/journal 读数）→ 本次进程出生时间；量的是"断了多久才被看见"，不是"多久活过来" |
| 锁屏 CPU 增量 | Δ(utime+stime) / Δt（jiffies/秒） |
| 网络成功率 | 锁屏期成功请求数 / 总请求数 |
| 常驻内存 | UID RSS 合计（`/proc/<pid>/statm`） |
| 口径分布 | exit-info description 分类计数 |

---

## 5. 执行顺序（与 D0–D8 对齐）

| 阶段 | 验证 |
|---|---|
| D2 完成（合生命周期） | V-B1/B2/B3；S5① |
| D3 完成（立原生 OS + 可见性） | V-A1/A2/A3、V-D1/D2、V-E1/E2、S1 |
| D4 完成（职责下沉 + 可装第二 Program） | S4 |
| D6 完成（豁免 + 唤醒 + 打断可见） | V-C1/C2、V-D3/D4/D5、V-F1/F2/F3/F4/F5、S2/S3 |
| D8 验收 | 全量：S1–S5 + 硬门槛 + 报告归档 |

---

## 6. 观测项 vs 判据项（避免自欺）

- **判据项（必须达标）**：1 进程 / 1 FGS / 1 通知；C1 CPU 增量；C2 网络成功率；C4 锁屏可控；C5 零预置复现；**存活率/存活时长**；V-A3 锚翻转可见；V-B3 打断可见；V-F1 中断可见；V-F3 死因来自取证；V-F4 首行不跨世；V-F5 常驻记录两行。
- **观测项（只记录、不作通过条件）**：被杀次数、被杀口径、OEM 开关前后差异、耗电、压力场景表现、**服务/通知是否回位与回位时延**。
  理由：本机已证整 UID 会被热档/低内存成组清掉；既然不设兜底，就要把**存活本身**与**打断是否看得见**当判据，把"杀了会怎样、多久活过来"只当观测。

---

## 7. 风险与回滚

| 操作 | 风险 | 回滚 |
|---|---|---|
| 解绑/重绑无障碍（V-A3） | 短期失去锚 | 记录原 `settings` 值并恢复 |
| 修改电池/Doze 白名单 | 无 | 记录原值 |
| 压力复现（S6） | 可能触发真实清理/发热 | 仅观察，可随时停止；不在验收判据内 |

---

## 8. 交付物模板

```
verify/<run>/
  commands.txt        实际执行的命令
  raw/                dumpsys/logcat/stat 原始输出
  summary.md          指标表 + 判据表 + 结论（通过/失败/观察）
  evidence/           截图/通知/锁屏照片（C4）
```

`summary.md` 必含：硬门槛三项、C1–C5 逐项结论、观测项数值、与上一轮的对比、遗留问题清单。
