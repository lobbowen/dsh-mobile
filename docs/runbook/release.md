# 发布与版本（Release & Versioning）

> 两件事合一：**版本怎么定** + **发布身份怎么保**。决策依据见
> [ADR-0004](../adr/0004-dual-version-streams.md)（双版本流）与
> [ADR-0005](../adr/0005-kernel-via-ota-only.md)（内核只经 OTA）。

---

## 1. 两条版本流，各自的单一事实源

| | 壳流（APK / L0） | 内核流（kernel / L1） |
|---|---|---|
| 版本字段 | `versionName` + `versionCode` + `bridgeProtocol` | `version` + `dsh.requiresProtocol` |
| 单一事实源 | **`version.json`**（仓根） | **`kernel/package.json`** |
| 引擎侧 | `container/engine/package.json` | — |
| 面板 | `kernel/ui/package.json` | — |
| Node 运行时 | `container/app/src/main/assets/node-versions.json` | — |

**两条流的版本号从不互相比较。**「壳 1.1.7 / 内核 0.1.0-android.13」是正常状态。

## 2. 改哪层，bump 哪个

| 改动范围 | 必须 bump | 不动的 |
|---|---|---|
| `kernel/**` | `kernel/package.json` 的 `version` | 壳版本 |
| `container/app/**` | `version.json` 的 `shell.versionCode` +1 | 内核版本 |
| 桥协议语义变更 | 壳 `shell.bridgeProtocol` +1，内核 `dsh.requiresProtocol` 跟上 | — |
| 只改 `kernel/ui/**` | `kernel/ui/package.json` 的 `version` | 以上都不动 |
| 换 Node 运行时 | `node-versions.json` 的 `default` | — |

> `versionCode` 是**单调整数**，只增不减。动了 `container/app/**` 却没 bump 的合并，
> `fast-apk` 会在发布步骤判红（自动通道不许同版本重发）。补救是**补 bump 再合**，
> 不是推 `fast-*` tag 把同号字节换掉。同版本重发只留给「投递本身坏了」的显式通道。

## 3. 两把信任根（互相独立，都不是代码能替代的）

| # | 信任根 | 用途 | GitHub secret（**准确名**） | 丢了会怎样 |
|---|---|---|---|---|
| ① | APK 签名密钥（keystore） | 决定"这个包是谁"，Android 只允许同签名覆盖安装 | `ANDROID_KEYSTORE_BASE64` + `ANDROID_KEYSTORE_PASSWORD`（+ `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` 可选，默认 `dsh` / =store 口令） | **永久失去**给已装设备推升级的能力 |
| ② | 内核 OTA 私钥（ed25519 PEM） | 给内核包签名；公钥焊在 APK 里 | `OTA_PRIVATE_KEY_PEM`（公钥可用 `OTA_PUBLIC_KEY` 覆盖写入） | 内核 OTA 通道失效（APK 仍可升级） |

> 为什么两把分开：APK 签名保护"应用身份"，OTA 签名保护"内核包来源"。混用会让
> 「内核包泄露」升级成「可伪造应用更新」。
>
> 注意 `DSH_KEY_ALIAS` / `DSH_KEY_PASSWORD` **不是**仓库 secret 名 ——
> 它们是 `scripts/inject-apk-keystore.sh` 写出到 `$GITHUB_ENV` 的**内部键**（:85-87）。
> 真正要配的是 `ANDROID_*` 那四个。

## 4. 信任根校验门禁

- `scripts/verify-apk-signing.sh`（唯一实现；注入侧 `scripts/inject-apk-keystore.sh`）：
  - 配了 keystore → APK 内证书 SHA-256 指纹与注入锚点**逐指纹比对**，不符即硬红；
  - 发布链路（`build-apk` / `release-admin` 的 repack）带 `--require-stable`：debug 身份、没配 keystore、锚点本身是 debug 三种情况都硬红；
  - **日常链路 `fast-apk` 允许 debug 档**，只打 `::warning::`（已知缺口：该链路仍会写 `apk-latest`，见 §11）。
- `scripts/verify-ota-anchor.sh`：强制锚点算法为 **Ed25519**，并在带 `--private` 时校验
  「私钥派生公钥 == 焊死锚点」，堵住轮换后 CI 全绿而设备全拒收的静默故障。

## 5. 发布物与命名

**壳**（`apk-latest` Release）：

| 资产 | 用途 |
|---|---|
| `app-debug.apk` | 稳定别名（latest 地址永久不变） |
| `app-debug-<versionName>+<versionCode>.apk` | 版本化归档（在 `v<versionName>` tag 下） |
| `version.json` | 壳版本清单（下次单调性检查的输入） |

**内核**（GitHub Release 只作归档；设备实际读对象存储）：

| Release | 资产 | 用途 |
|---|---|---|
| `kernel-<version>` | `kernel-<v>.zip` · `kernel-manifest.json` | 版本化归档 |
| `kernel-<channel>` | `kernel-manifest.json` · 本次 `kernel-<v>.zip` | 通道滚动归档（CI 版本前进门禁读这里） |

> gh 的资产名**取上传文件的 basename**（`file#标签` 里 `#` 后面只是 label，不改名）。
> 「确保 Release 在 → 覆盖上传 → 回读确认」只住 `scripts/gh-release-upload.sh`，四条发布链路都调它。

设备入口（对象存储，按通道滚动）配置来自 `container/app/src/main/assets/kernel-feed.json`：

```
<baseUrl>/kernel-<channel>/kernel-manifest.json?t=<ms>   ← 判断有没有更新
<baseUrl>/kernel-<channel>/kernel-<version>.zip          ← 或 manifest.url
```

## 6. CI 门禁

| 门禁 | 位置 | 拦的是 |
|---|---|---|
| workflow YAML 校验 | `ci.yml` / `fast-apk` / `build-apk` → `scripts/validate-workflow.py` | workflow 写坏（GitHub 表现是"0 个 job"，伪装成"没触发"）；重复 key / `on.push` 互相覆盖 |
| 跨层版本校验 | `ci.yml` → `scripts/gen-version.js --check` | 事实源缺失/非法；协议号漂移；内核要求协议 > 壳实现协议 |
| 壳 versionCode 单调 + 同版本通道分叉 | `scripts/verify-apk-version-gate.sh`（取数 `scripts/check-apk-release-version.sh`）；四个发布口各自调用 | 回退；自动通道同号换字节 |
| 内核版本前进 | `kernel-ota` 发布步骤（取数 `scripts/read-release-asset.sh`） | 版本复用 → 设备判"无更新" → 静默不生效 |

> 「不存在」与「取不到」的三态分类只住 `scripts/read-release-asset.sh`
> （退 0=取到 / 退 10=确实没有 / 退 2=看不清）。退 2 一律**禁止发布**。

## 7. 设备端"我是谁"

`files/provisioning.json` 同时给出两个身份：`appVersion` / `appVersionCode` / `bridgeProtocol`（壳）
与 `kernelVersion`（内核，来自 `files/kernel/CURRENT`）。

## 8. 签名密钥：生成与配置（一次性）

```bash
# ① 生成 keystore
./scripts/keygen-android-keystore.sh          # 产出 keys/release.keystore（keys/ 已 gitignore）
# ② 转 base64
base64 -w0 keys/release.keystore > /tmp/ks.b64
# ③ 写入 GitHub secrets：
#    ANDROID_KEYSTORE_BASE64 / ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS(默认 dsh) / ANDROID_KEY_PASSWORD
```

**备份（强制）**：`keys/release.keystore` 与口令存进离线密码库。它不是"可再生成的"——**丢了就永远回不来**。

## 9. GitHub PAT（维护通道）规则

- **存放**：仓外、权限 600（如 `files/.secrets/github.token`）；绝不入库、绝不进日志。
- **用法**：`Authorization: Bearer $(cat "$TOK")`；禁止 `set -x` / `echo` 令牌。
- **最小权限**：fine-grained，仅本仓 `Contents: RW` + `Actions: RW` + `Workflows: Write`。

## 10. 一次性基线重置（已执行完毕，仅存档）

2026-09-23 产品线起点定为 `1.0.0 (versionCode 1)`（开发期是 `0.2.0`）。因 versionCode 单调门禁会拦回退，
**一次性**清掉了 `apk-latest` 上的 `version.json`，使下一次发布被识别为"首次带版本发布"。

**重置后单调门禁即为权威，不得再重置**；此后一切发布只能递增。

## 11. 已知缺口（待修）

- `fast-apk` 的签名门禁**允许 debug 档**，且该链路仍会把产物写 `apk-latest`（自动通道）。
  未配 keystore 时，main 合并即把一次性 debug 签名包推给存量设备 → `INSTALL_FAILED_UPDATE_INCOMPATIBLE`（不可逆）。
  修法：写 `apk-latest` 的链路一律带 `--require-stable`。

## 12. 发布前自检

- [ ] 签名门禁输出「APK 证书指纹与注入锚点一致」（配了 keystore 时）
- [ ] `OTA_PRIVATE_KEY_PEM` 已配置，且 `verify-ota-anchor.sh --private` 通过
- [ ] `keys/release.keystore` + 口令已离线备份
- [ ] `fast-apk` 日志出现 `[version] 本次发布 x.y.z (versionCode=N)` **和** `[version] 版本前进（M → N）`
- [ ] 只更新内核时：`kernel-ota` 成功，且**壳版本未变**
- [ ] 设备 `provisioning.json` 的 `appVersion` / `kernelVersion` / `bridgeProtocol` 三者自洽
