# 版本管理（Versioning）

> 一句话：**任何发出去的东西都必须能回答"它是哪个版本"**，而**壳与内核是两条独立版本流**。
> 定义与理由（含两条流的对照表、兼容契约、防静默失效门禁）见 **[ADR-0004](../adr/0004-dual-version-streams.md)**。
> 本页只讲**怎么用**。

---

## 1. 两条流，各自的单一事实源

| | 壳流（APK / L0） | 内核流（kernel / L1） |
|---|---|---|
| 版本字段 | `versionName` + `versionCode` + `bridgeProtocol` | `version` + `dsh.requiresProtocol` |
| 单一事实源 | **`version.json`**（仓根） | **`kernel/package.json`** |
| 引擎侧版本 | `container/engine/package.json` | — |
| 面板版本 | `kernel/ui/package.json` | — |
| Node 运行时 | `container/app/src/main/assets/node-versions.json` | — |

**两条流的版本号从不互相比较。** "壳 0.2.0 / 内核 0.1.0-android.11" 是正常状态。

## 2. 改哪层，bump 哪个

| 改动范围 | 必须 bump | 不动的 |
|---|---|---|
| `kernel/**`（内核逻辑/面板） | `kernel/package.json` 的 `version` | **壳版本不动**（这就是"只更新内核"） |
| `container/app/**` | `version.json` 的 `shell.versionCode` +1（`versionName` 视语义） | 内核版本不动 |
| 桥协议语义变更 | 两边都动：壳 `shell.bridgeProtocol` +1、内核 `dsh.requiresProtocol` 跟上 | — |
| 只改 `kernel/ui/**` | `kernel/ui/package.json` 的 `version` | 以上都不动 |
| 换 Node 运行时 | `node-versions.json` 的 `default` | — |

## 3. CI 门禁（都在 CI 侧，本地不执行任何东西）

| 门禁 | 位置 | 拦的是 |
|---|---|---|
| 跨层版本校验 | `ci.yml` → `scripts/gen-version.js --check` | 事实源缺失/非法；`protocol.js` 与 `version.json` 的协议号**漂移**；内核要求协议 > 壳实现协议 |
| 壳 versionCode 单调 | `fast-apk` 发布步骤 | `versionCode` 回退 → 已升级设备永远收不到新版本 |
| 内核版本唯一 | `kernel-ota` 发布步骤 | 版本复用 → 设备端判为"无更新" → **静默不生效** |

## 4. 发布物

**壳**（`apk-latest` Release，每轮三个资产）：

| 资产 | 用途 |
|---|---|
| `app-debug.apk` | 稳定别名（latest 地址永久不变） |
| `app-debug-<versionName>+<versionCode>.apk` | 版本化（可追溯） |
| `version.json` | 壳版本清单（下次单调性检查的输入） |

**内核**（`kernel-<version>` Release）：

| 资产 | 用途 |
|---|---|
| `kernel-<version>.zip` | 签名 OTA 包（设备端验签 + sha256 + 原子切换） |
| `kernel-manifest.json` | 清单（version / sha256 / engines / requires / requiresProtocol） |
| `kernel-feed-<version>.zip` | 投递包（解开设备直推） |

## 5. 设备端"我是谁"

`files/provisioning.json` 同时给出两个身份：

- `appVersion` / `appVersionCode` / `bridgeProtocol`（壳）
- `kernelVersion`（内核，来自 `files/kernel/CURRENT`）

## 6. 自检清单

- [ ] `ci.yml` 的跨层版本校验绿（日志里有 `[version] ... protocol shell vN / kernel requires vN`）
- [ ] `fast-apk` 日志出现 `[version] 本次发布 x.y.z (versionCode=N)`，且 Release 三资产齐全
- [ ] 只更新内核时：`kernel-ota` 成功，且**壳版本未变**
- [ ] 设备 `provisioning.json` 的 `appVersion` / `kernelVersion` / `bridgeProtocol` 三者自洽
