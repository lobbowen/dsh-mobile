# 方法缺口表（`os.*` / 桥方法）

> 纪律：任何"先返回成功、以后再补"都在此登记；销账 = 本表删行 + 接线代码替换 not-implemented 分支。
> 门禁 `capability-single-source-gate-test.js` 的 R6 做三向对账（Kotlin 登记 ∈ 契约 ∪ 本表；
> 每个 `notImplemented("X")` 必须在 §2 有整名行）。

## 1. 部分实现（诚实降级，非完整）

| 方法 | 当前行为 | 缺口 |
|---|---|---|
| （无） | —— | 2026-09-28 复检后，"部分实现"已全部落地（见 §3 变更记录） |

## 2. 显式未实现（返回 -32002）

| 方法 | 原因 / 依赖 |
|---|---|
| `capability.invoke` | 契约 §2.6 的通用能力调用面：Program 身份/授权表已落地（§0.0），但"由 Program 主动请求 OS 代为调用某项设备能力"的用例尚无消费者 —— 保留为显式未实现，不假装可用 |

## 3. v4 不提供（已从 OS 面移出，不再是缺口）

| 方法 | 去向 |
|---|---|
| `os.programs.webAccess` | 面板由 OS 的 `ConsoleActivity` 直接承载，OS 不签发 Web 令牌 |
| `os.appmgr.pluginAction` | 组件/扩展是 **Program 自己**的 npm 依赖，执行体归 Program（console 侧路由已改为显式 501） |
| `os.appmgr.checkPluginUpdates` | 同上 |
| `os.appmgr.jobStatus` | 同上（Program 侧自持作业状态） |
| `os.runtime.provision` | 运行时（node/npm）随 APK 投放（`assets/node`），不存在"OS 现场装运行时"这条路径 |

## 4. 变更记录（2026-09-28 复检清债）

- 落地为真实实现：`os.journal.tasks`、`os.journal.task`（TaskRegistry）、`os.appmgr.install`/`upgrade`/`uninstall`（OTA feed + ProgramInstaller）、`os.appmgr.checkUpdate`（ProgramOtaUpdater）、`os.instances.get`/`action`、`os.session.stop`（宿主 intent → InstanceHost 控制面）、`os.registry.info`/`set`/`refresh`/`probe`（RegistryStore）、`os.programs.settings`（ProgramSettings）。
- 移出 OS 面：见 §3。

## 5. 别名与兼容

- `notify.post`（契约名）→ 桥内规范名 `notif.post`（在 `dispatch` 做别名），两侧保持可用。
- `shell.status`、`app.openUrl` 早已存在，契约复用同名。
