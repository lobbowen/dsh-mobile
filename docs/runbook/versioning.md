# 版本管理（Versioning）

> 一句话：**任何发出去的东西都必须能回答"它是哪个版本"。**

## 1. 各层版本与单一事实源

| 层 | 版本 | 单一事实源 | 消费方 |
|---|---|---|---|
| L0 壳 APK | `versionName` + `versionCode` | `version.json`（仓根） | `build.gradle.kts` 派生；Release 资产名；`provisioning.json` |
| L0 引擎 | semver | `container/engine/package.json` | gen-version 汇总 |
| L1 内核 | semver | `kernel/package.json` | OTA 包名/manifest（`build-bundle.js <ver>`）；gen-version 汇总 |
| 面板 | semver | `kernel/ui/package.json` | gen-version 汇总 |
| L2 Node 运行时 | `<ver>-<abi>` | `container/app/src/main/assets/node-versions.json` | fast-apk 下载该 tag；gen-version 汇总 |
| L3 Agents | npm semver | npm registry | npm 自身 |

**禁止在第二个地方复制同一个版本号。** `gen-version.js` 只做**汇总**，不产生新事实
（例如它从 `node-versions.json` 读运行时，而不是再定义一遍）。

## 2. 生成产物与门禁

- `scripts/gen-version.js` → `.github/version-manifest.json`（**进 git、可评审**）。
- `ci.yml` 门禁：`node scripts/gen-version.js && git diff --exit-code -- .github/version-manifest.json`。
  任何版本漂移都会红，评审时一眼看到"这次动了哪个版本"。

## 3. 什么时候 bump 什么

| 改动 | 必须 bump |
|---|---|
| `container/app/**`（Kotlin / 资源 / 清单） | `version.json` 的 `shell.versionCode` **+1**；`shell.versionName` 视语义 |
| `container/engine/**` | `container/engine/package.json` 的 `version` |
| `kernel/**`（ui 除外） | `kernel/package.json` 的 `version`（OTA 包名随之变化） |
| `kernel/ui/**` | `kernel/ui/package.json` 的 `version` |
| 换 Node 运行时 | `node-versions.json` 的 `default`（并确保对应 Release tag 存在） |

语义：`versionCode` = **单调递增整数**（只增不减，Android 升级判定用它）；
`versionName` = 给人看的 semver。

## 4. versionCode 单调门禁（不可逆事故的唯一防线）

`fast-apk` 的发布步骤会：

1. 从 `apk-latest` 下载**已发布**的 `version.json`；
2. 断言本次 `versionCode` **严格大于**已发布值，否则**硬红并拒绝发布**。

为什么：`versionCode` 回退 = 已升级的设备**永远收不到**新版本，且只能卸载重装 —— 不可逆。

## 5. 发布物命名

`apk-latest` Release 每轮携带三个资产：

| 资产 | 用途 |
|---|---|
| `app-debug.apk` | **稳定别名**：latest 下载地址永久不变 |
| `app-debug-<versionName>+<versionCode>.apk` | **版本化**：任何一次发布都可追溯 |
| `version.json` | 版本清单：下次发布的单调性输入 |

## 6. 自检清单

- [ ] `ci.yml` 的 version-manifest 门禁绿
- [ ] `fast-apk` 日志出现 `[version] 本次发布 x.y.z (versionCode=N)`
- [ ] Release 上同时存在三个资产
- [ ] 设备上 `files/provisioning.json` 的 `appVersion` / `appVersionCode` 与本次发布一致
