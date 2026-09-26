# 发布身份与密钥（Release Identity）

> 这一页回答一个问题：**"我发出去的包，还能不能升级它自己？"**
> 答案取决于两把「信任根」，它们**互相独立**，都不是代码能替代的。

---

## 1. 两把信任根

| # | 信任根 | 用途 | CI secret | 丢了会怎样 |
|---|---|---|---|---|
| ① | **APK 签名密钥**（keystore） | 决定"这个包是谁"。Android 只允许**同签名**覆盖安装 | `ANDROID_KEYSTORE_BASE64` + `ANDROID_KEYSTORE_PASSWORD`（+ `DSH_KEY_ALIAS` 可选） | **永久失去**给已装设备推升级的能力（只能卸载重装，数据丢失） |
| ② | **内核 OTA 私钥**（ed25519 PEM） | 给内核包签名；公钥焊在 APK 里 | `OTA_PRIVATE_KEY_PEM` | 内核 OTA 通道失效（但 APK 本身仍可升级） |

> 为什么是两把：APK 签名保护"应用身份"，OTA 签名保护"内核包来源"。混用一把会让
> "内核包泄露"升级成"可伪造应用更新"，所以刻意分开（见 `scripts/keygen-android-keystore.sh` 头注释）。

---

## 2. 没有稳定签名会怎样（必须理解）

- 未配置 keystore 时，AGP 用 runner 上**现场生成**的 debug keystore 签名 → **每次构建指纹都不同**。
- 后果：
  - `adb install -r` 新包 → `INSTALL_FAILED_UPDATE_INCOMPATIBLE`；
  - **设备自我升级**（本项目 A'/自有 OTA 的关键前提）彻底不成立；
  - 增量升级、灰度推送等一切依赖"应用身份稳定"的机制都不成立。
- CI 的门禁是 `scripts/verify-apk-signing.sh`（唯一实现，三条链路同调；注入侧配套
  `scripts/inject-apk-keystore.sh`）。三档结果：
  - 配了 keystore → 把 APK 内证书的 SHA-256 指纹与注入锚点**逐指纹比对**，不符即**硬红**
    （只判 "CN=Android Debug" 查不出「签成了另一把 key」，那种包照样装不上去）；
  - 发布链路（`build-apk` / `release-admin` 的 repack）带 `--require-stable`：debug 身份、
    没配 keystore、锚点自身是 debug 三种情况都**硬红**，产物不会进 apk-latest；
  - 日常链路（`fast-apk`）允许 debug 档，但会打 `::warning:: 开发签名（不可发布）`。

---

## 3. 生成并配置（一次性）

```bash
# ① 生成 keystore（也可用 Android Studio 的向导）
./scripts/keygen-android-keystore.sh          # 产出 keys/release.keystore（keys/ 已 gitignored）

# ② 转成 CI 用的 base64
base64 -w0 keys/release.keystore > /tmp/ks.b64

# ③ 写入 GitHub secrets（仓库 → Settings → Secrets and variables → Actions）
#    ANDROID_KEYSTORE_BASE64   = $(cat /tmp/ks.b64)
#    ANDROID_KEYSTORE_PASSWORD = <keystore 口令>
#    ANDROID_KEY_ALIAS         = <别名，默认 dsh>
#    ANDROID_KEY_PASSWORD      = <key 口令，与 store 口令相同时可留空由脚本兜底>
#    后两个可省；缺省时 scripts/inject-apk-keystore.sh 按 dsh / =store 口令兜底。
```

**备份（强制）**：把 `keys/release.keystore` 与口令存进离线密码库。
它不是"可再生成的"——**丢了就永远回不来**。

---

## 4. GitHub PAT（维护通道）使用规则

- **存放**：仓外、权限 600，例如 `files/.secrets/github.token`；**绝不**入库、**绝不**进日志。
- **用法**：`Authorization: Bearer $(cat "$TOK")` 头；禁止 `set -x` / `echo` 令牌。
- **轮换**：GitHub → Settings → Developer settings → Personal access tokens → 该 token → `Regenerate`，
  然后就地覆盖本地令牌文件即可（旧令牌立即失效，正在跑的作业会 401）。
- **最小权限**：fine-grained，仅本仓 `Contents: Read and write` + `Actions: Read and write` + `Workflows: Write`。

---

## 5. 自检清单（发布前）

- [ ] 签名门禁输出 `APK 证书指纹与注入锚点一致`（配了 keystore 时）；
      发布链路必须带 `--require-stable` 跑过，只输出「非 debug 签名」说明本轮**没有锚点可比**
- [ ] `OTA_PRIVATE_KEY_PEM` 已配置且 `Verify kernel baseline bundle` 全绿
- [ ] `keys/release.keystore` + 口令已离线备份
- [ ] 用**同一签名**的旧包做过一次 `adb install -r` 覆盖安装验证
