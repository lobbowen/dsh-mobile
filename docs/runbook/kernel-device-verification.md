# 内核生命周期：真机验证清单

> 这是整条链路上**唯一还没有被证明**的一环。CI 只能证明「编译通过 + 纯逻辑正确」，
> 而下载、安装、提交、回滚这些**在真实 Android 上发生的事**必须走一遍。
>
> 一次做完约 20–30 分钟。每条都给出：怎么触发 → 看哪个字段 → 什么结果对应什么结论。

## 0. 前提

| 项 | 值 |
|---|---|
| 安装包 | `apk-latest` 的 `app-debug.apk` |
| 设备通道 | **canary**（`assets/kernel-feed.json`: `baseUrl=https://hubcdn.zll.ink`, `channel=canary`） |
| 已发布内核 | **别写死在本清单里**，从通道现读：`<base>/kernel-<channel>/kernel-manifest.json?t=<ms>`（`?t=` 不能省，理由见 [kernel-ota.md §2.1](kernel-ota.md)）。下文用 `<目标版本>` 指代它，落到哪条就 substituted 成实际值 |

**两个观察窗口**

```
files/provisioning.json   ← 五项体检 + 内核状态
files/diagnostics.txt     ← 逐事件流水（本清单主要看这里）
files/kernel/             ← CURRENT / FLOOR / PENDING / <version>/
```

取文件（任一方式）：

```bash
adb shell run-as io.github.lobbowen.dshmobile cat files/provisioning.json
adb shell run-as io.github.lobbowen.dshmobile cat files/diagnostics.txt
# 或设备上通过面板导出的诊断包
```

**先确认基线**（还没做任何操作时）：`provisioning.json` 里应有
`appVersion=1.0.0`、`bridgeProtocol=1`、`kernelVersion` 为空、`kernelFloor` 为空、`kernelPending` 为空。

---

## 1. 首装（CURRENT 缺失 → 从 OTA 装）

| | |
|---|---|
| **触发** | 全新安装后首次启动（或清掉 `files/kernel/` 后启动） |
| **看** | `diagnostics.txt` 的 `[kernel-ota]` / `[kernel-commit]` 行；`kernel/` 目录 |
| **期望** | ① 取到 `kernel-canary/kernel-manifest.json`（**带 `?t=` cache-buster**）；② manifest **验签通过**；③ 下载 ~1.2MB 且 **sha256 一致**；④ 安装落盘；⑤ 首次健康检查通过后出现 **`[kernel-commit] 内核 <目标版本> 已提交`** |
| **落地证据** | `kernel/CURRENT` = `<目标版本>`；`kernel/FLOOR` = 同值；`kernel/PENDING` **不存在**（已提交）；`provisioning.json` 的 `kernelVersion`/`kernelFloor` 均为 `<目标版本>` |

**若失败看这里**

| 现象 | 结论 |
|---|---|
| `403 qiniu_center_auth` | 空间又变私有 → 控制台改回公开 |
| 证书 / `SSL` 错误 | `hubcdn.zll.ink` 证书问题 |
| `manifest signature invalid` | 发布侧签发与设备验签不一致（**真 bug，报我**） |
| `sha256 校验未通过` | 传输/拼接问题（**真 bug，报我**）；半包会保留在 `cacheDir/*.part` |
| 一直「尚无内核包」 | 看 `[kernel-ota]` 行有没有报错 |

## 2. 已是最新（不应重复下载）

| | |
|---|---|
| **触发** | 再次启动 |
| **期望** | 不下载；日志为「已是最新（本地 0.1.0-android.11，远端 0.1.0-android.11）」 |
| **为什么重要** | 防止每次开机都重下 1.2MB |

## 3. 升级（版本前进 → 下载 → 提交 → FLOOR 前移）

| | |
|---|---|
| **触发** | ① 改 `kernel/package.json` 的 version（如 `0.1.0-android.12`）；② 跑 `kernel-ota`(channel=canary)；③ 设备启动 |
| **期望** | 下载新包 → 安装 → `PENDING` 写入 → 健康通过 → `[kernel-commit]` → `FLOOR` **前移到 .12** |
| **关键断言** | 提交后 `FLOOR` = `.12`；`PENDING` 消失 |

## 4. 过期即拒（防「永久冻结在旧版本」）

| | |
|---|---|
| **触发** | 把桶里 manifest 的 `expiresEpochMs` 改成**过去**（改一个副本最省事） |
| **期望** | 日志出现 `manifest-expired`，**不安装**；`CURRENT` 不变 |
| **若没拒** | **真 bug**（C3 失效），报我 |

## 5. 重放即拒（防把设备拉回旧版）

| | |
|---|---|
| **触发** | 把 manifest 的 `sequence` 改成**小于设备已见水位**的值（水位存在 `files/kernel-feed-state.json`） |
| **期望** | 日志出现 `manifest-replay`，不安装 |

## 6. 灰度未命中（停发语义）

| | |
|---|---|
| **触发** | 用 `rollout_percent=0` 发一次（或改桶里 manifest 的 `rolloutPercent` 为 0），然后启动设备 |
| **期望** | 日志「灰度未命中（bucket=N >= rolloutPercent=0）」，**不安装**、**不是错误**（下次启动再试） |
| **若仍然装了** | **真 bug**（停发失效），报我 |

> 分桶是**确定性**的（同设备同版本永远同桶），所以「灰度 10%」意味着同一台设备
> 要么一直命中、要么一直不命中，不会随机跳。

## 7. 提交 / 回滚（C2：装得上 ≠ 跑得起来）

| | |
|---|---|
| **触发** | 制造一个**装得上但起不来**的内核（例如入口脚本立刻崩溃的版本） |
| **期望** | ① 安装成功、`PENDING` 写入、`CURRENT` 指向新版；② 健康检查**失败**；③ 日志 `[kernel-rollback] 已回滚到 <旧版>`；④ `CURRENT` 回到旧版；⑤ **`FLOOR` 不降** |
| **最要紧的一条** | **回滚后 FLOOR 不得降低** —— 否则「回滚」就成了降级的后门 |

## 8. 断点续传（弱网可用性）

| | |
|---|---|
| **触发** | 启动后立刻开**飞行模式**（或断网），让下载中途失败；再恢复网络并重启 |
| **期望** | `cacheDir/kernel-ota-<ver>.zip.part` **存在**且 > 0；恢复后从断点继续（不是从 0 开始） |
| **为什么重要** | 这是「弱网也能装上」的核心；旧实现失败即丢弃，永远装不上 |

---

## 9. 原生件能力核验（投放 ≠ 能力）

| 项 | 内容 |
|---|---|
| **触发** | 装完/升级完 DSH 后重启内核（安装那一轮必核验一次），或在面板上等 `/status` 刷新一轮 |
| **看哪里** | ① 面板 DSH 卡片第二排「能力…」；② `files/supervisor/native-manifest.json` 的 `nativeCaps`（内核重启后仍能看到上次结论）；③ `files/supervisor/events/guard.events.log` 里的 `native_capability` |
| **判据** | `ok=true` 才是可用；`false` = 探针跑起来了而判据不过（能力确实坏了）；`null` = 探针没条件跑 / 判据待做 / 免检 —— **未知，不算通过** |
| **与投放结局对照** | 同一格在 `nativeUnits` 里完全可能是 `applied`，那只代表「我们补装动过手」。两排不一致是设计如此，读能力以 `nativeCaps` 为准 |
| **为什么重要** | 真机 2026-09-26：`sharp-image` 报 applied（`@img/sharp-wasm32` 就在依赖树里）而 sharp 取不到绑定，`read_image` 全灭，界面上零痕迹 —— ADR-0001 P4 因此把「已解决」写了出去（现已作废） |

判据本体（每格一段交给**被检那份 node** 跑的 JS）住在 `kernel/src/guard/native/supply-table.json`
的 `units[].verify`，执行器唯一：`capability-probe.js`。改判据就是改表，CI 逐格盯得住
（`native-supply-gate-test.js`）。当前表里 `node-pty` 那格按拍板挂起到终端批次，面板恒读「未知」——
那不是 bug，别替它报通过。

**回传要求**：任何一格是 `false` 或 `null`，把该格 `detail` 原文带回来 —— 它就是探针的完整结论。
面板上 `detail` 挂在 chip 的 `title`（桌面浏览器悬停可见）；手机上直接看 ② 那份文件：

```bash
adb shell run-as io.github.lobbowen.dshmobile cat files/supervisor/native-manifest.json
```

（`supervisor/` 这一段不能省：`NativeManager` 的 `stateDir` = `dirname(config.stateFile)`，
而 stateFile 是 `<DSH_SUPERVISOR_HOME>/supervisor/state.json` —— 见 `platform/config.js:45` 与 `supervisor.js:275`。
设备侧 `DSH_SUPERVISOR_HOME` 就是应用 `filesDir` —— 见 `runtime/GuestAdapter.kt:90`。）

---

## 10. 验证通过后的两件事（别忘）

1. **提升到生产通道**：跑 `kernel-ota`，`channel=stable`、同版本（门禁允许同版本重发）、`rollout_percent` 从小比例开始；
2. **把设备通道改回 stable**：`assets/kernel-feed.json` 的 `"channel": "canary"` → `"stable"`，并重新出 APK。

> 顺序不能反：stable 通道现在**还没有** manifest，先改会 404。

## 11. 请回传给我的

- `provisioning.json` 全文；
- `diagnostics.txt` 里含 `kernel-ota` / `kernel-commit` / `kernel-rollback` / `health` / `process` 的行；
- 任一**与上表不符**的现象（那些都是真 bug，我来修）。
