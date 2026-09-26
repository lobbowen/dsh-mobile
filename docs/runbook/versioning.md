# 版本管理（Versioning）

> 一句话：**任何发出去的东西都必须能回答"它是哪个版本"**，而**壳与内核是两条独立版本流**。
> 定义与理由（两条流对照表、兼容契约、防静默失效门禁）见 **[ADR-0004](../adr/0004-dual-version-streams.md)**。
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

**两条流的版本号从不互相比较。** "壳 1.0.0 / 内核 0.1.0-android.11" 是正常状态。

## 2. 改哪层，bump 哪个

| 改动范围 | 必须 bump | 不动的 |
|---|---|---|
| `kernel/**`（内核逻辑/面板） | `kernel/package.json` 的 `version` | **壳版本不动**（这就是"只更新内核"） |
| `container/app/**` | `version.json` 的 `shell.versionCode` +1（`versionName` 视语义） | 内核版本不动 |
| 桥协议语义变更 | 两边都动：壳 `shell.bridgeProtocol` +1、内核 `dsh.requiresProtocol` 跟上 | — |
| 只改 `kernel/ui/**` | `kernel/ui/package.json` 的 `version` | 以上都不动 |
| 换 Node 运行时 | `node-versions.json` 的 `default` | — |

> `versionCode` 是**单调整数**，只增不减（Android 升级判定用它）；`versionName` 是给人看的 semver。

> 这条 bump 规矩从 2026-09-26 起有牙了：动了 `container/app/**` 却没 bump 的合并，`fast-apk`
> 会在发布步骤判红（自动通道不许同版本重发）。所以「连注释都算改了 APK 内容」这一类的补救是
> **补 bump 再合**，不是推 `fast-*` tag 把同号的字节换掉 —— 后者会让已装机的设备以为"没有更新"。
> 同版本重发只留给一种正当用途：投递本身坏了（资产孤立/签名错/传错包），走显式通道。

## 3. CI 门禁（都在 CI 侧，本地不执行任何东西）

| 门禁 | 位置 | 拦的是 |
|---|---|---|
| workflow YAML 校验 | `ci.yml` + `fast-apk` + `build-apk` → `scripts/validate-workflow.py`（严格版唯一实现；宽松 safe_load 那份已删） | workflow 写坏（GitHub 表现是"0 个 job"，伪装成"没触发"）；重复 key / on.push 互相覆盖 / 非法事件名 |
| 跨层版本校验 | `ci.yml` → `scripts/gen-version.js --check` | 事实源缺失/非法；`protocol.js` 与 `version.json` 协议号**漂移**；内核要求协议 > 壳实现协议 |
| 壳 versionCode 单调 + 同版本通道分叉 | 判据 `scripts/verify-apk-version-gate.sh`，取数 `scripts/check-apk-release-version.sh`；四个发布口（`fast-apk` / `build-apk` / `release-admin` 的 publish 与 repack）各自调用 | 回退 → 已升级设备永远收不到新版本；**自动通道同号换字节** → 下载地址指向的东西变了而版本号没说谎的能力没了 |
| 内核版本唯一 | 判据 `kernel-ota` 发布步骤，取数 `scripts/read-release-asset.sh` | 版本复用 → 设备端判为"无更新" → **静默不生效** |

> 最后两道门禁都要先读「线上现在是什么」。**「不存在」与「取不到」的三态分类只住
> `scripts/read-release-asset.sh`**（退 0=取到 / 退 10=该 Release 或该资产确实没有，即首次发布 /
> 退 2=看不清）。退 2 一律**禁止发布** —— 旧写法把它降成 `::warning` 然后照发，等于
> 「看不清就当没有」，两条链（APK 读 `version.json`、内核读 `kernel-manifest.json`）共用这一处判。

## 4. 发布物

**壳**（`apk-latest` Release）：

| 资产 | 用途 |
|---|---|
| `app-debug.apk` | 稳定别名（latest 地址永久不变） |
| `app-debug-<versionName>+<versionCode>.apk` | 版本化（可追溯） |
| `version.json` | 壳版本清单（下次单调性检查的输入） |

**内核**：

| Release | 资产 | 用途 |
|---|---|---|
| `kernel-<version>` | `kernel-<v>.zip` · `kernel-manifest.json` · `kernel-feed-<v>.zip` | 版本化（可追溯） |
| `kernel-<channel>` | `kernel-manifest.json` · 本次 `kernel-<v>.zip` | 通道滚动**归档**（CI 版本前进门禁读这里；GitHub 在设备网络不可达，不是设备入口） |

> 上面这些资产名就是设备/门禁真正去读的字符串，而 gh 的资产名**取上传文件的
> basename**（`file#标签` 里 `#` 后面只是 label，不改名）。所以"换一个包投出去"必须
> 先把副本改成目标名字再交，写进 `#` 后面不算数 —— 2026-09-26 repack 就是这么把
> `apk-latest/app-debug.apk` 投成 `app-signed.apk`、latest 地址当场 404。
> 「确保 Release 在 → 覆盖上传（含孤立资产回退）→ 回读逐字节确认」只住
> `scripts/gh-release-upload.sh`，四条发布链路都调它，判据不在 workflow 里抄第二份。

设备入口在对象存储上，同样是按通道滚动；配置来自 `container/app/src/main/assets/kernel-feed.json`：
```
<baseUrl>/kernel-<channel>/kernel-manifest.json?t=<ms>   ← 判断有没有更新（?t= 由代码无条件拼上，见 kernel-ota.md §2.1）
<baseUrl>/kernel-<channel>/kernel-<version>.zip          ← 或 manifest.url
```

## 5. 设备端"我是谁"

`files/provisioning.json` 同时给出两个身份：

- `appVersion` / `appVersionCode` / `bridgeProtocol`（壳）
- `kernelVersion`（内核，来自 `files/kernel/CURRENT`）

## 6. 自检清单

- [ ] `ci.yml` 的跨层版本校验绿（日志里有 `[version] ... protocol shell vN / kernel requires vN`）
- [ ] `fast-apk` 日志出现 `[version] 本次发布 x.y.z (versionCode=N)` **和** `[version] 版本前进（M → N）`
      （只有前者、没有后者 = 门禁被绕过；同版本在自动通道应当**判红**而不是静默发出去）
- [ ] `apk-latest` 三资产齐全：`app-debug.apk`、`version.json`，版本化归档在 `v<versionName>` 那个 tag 上
- [ ] 只更新内核时：`kernel-ota` 成功，且**壳版本未变**
- [ ] `kernel-<channel>` 归档与 CDN 通道目录（`<base>/kernel-<channel>/kernel-manifest.json?t=<ms>`）指向同一最新内核
- [ ] 设备 `provisioning.json` 的 `appVersion` / `kernelVersion` / `bridgeProtocol` 三者自洽

## 7. 一次性基线重置（只做一次，2026-09-23）

产品线起点定为 **`1.0.0 (versionCode 1)`**（开发期是 `0.2.0 (versionCode 2)`）。
因为 versionCode 单调门禁会拦"回退"，所以**一次性**清掉了 `apk-latest` 上已发布的
`version.json`，使下一次发布被识别为"首次带版本发布"。

**前提（不满足就不能重置）**：没有任何设备安装过旧版本。若有设备装过 `versionCode=2`，
重置会让那些设备**永远收不到**后续更新（不可逆）。

**重置后 versionCode 单调门禁即为权威，不得再重置**；此后一切发布只能递增。
