# 方法缺口表（`os.*` / 桥方法）

> 纪律：任何"先返回成功、以后再补"都在此登记；销账 = 本表删行 + 接线代码替换 not-implemented 分支。
> 门禁 `capability-single-source-gate-test.js` 的 R6 做三向对账（Kotlin 登记 ∈ 契约 ∪ 本表；
> 每个 `notImplemented("X")` 必须在 §2 有整名行）。

## 1. 部分实现（诚实降级，非完整）

| 方法 | 当前行为 | 缺口 |
|---|---|---|
| `shell.exec` | 走 **ADB 通道**执行：uid 2000、`privileged` 恒 true（`CapabilityBroker.kt:984-1009`） | 名字给人「本机执行」的直觉，而它不是 app 域的那棵树。本轮裁定：**不新增 exec 桥方法**——环境内的执行由语义沿进程树继承兑现（债表 ENV-2），不在桥上再造一条通路。名实修订归债表 ENV-12 |
| `os.appmgr.install` / `upgrade` / `uninstall` | 桥方法不收参数，进去就是「OTA 控制面板自己」；卸载删**所有**版本目录＋清指针（`CapabilityBroker.kt:566-568,354-372,375-398`） | 契约 §2.3 的形状是 `{ id?, spec?, version? }` 且语义为「卸载某颗 Program」。缺的两件都在册：包内清单无 `id`（ENV-13，装载去默认 id 的前置）、feed 是**滚动单 tag** ⇒ 一条 feed 只能描述一颗 Program，多名额须先扩成「一 id 一 tag」（`ProgramOtaUpdater.kt:52-53`，§11/§12.2 已定扩法、不改设备运行语义） |

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
