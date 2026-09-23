# 构建产物说明（`_artifacts/`）

这些文件**不在 git 里**（被 `.gitignore` 排除，因为它们是构建产物、
每次构建字节都可能不同）。为了让这个包开箱可用，这里额外附带了一份当前样本。

## `feed/` —— 可投递的内核 feed（A'' 自举用）

设备端从这里发现并安装已签名内核。投递方式：

```bash
adb push _artifacts/feed/kernel-0.1.0-android.1.zip \
          _artifacts/feed/kernel-manifest.json \
          /sdcard/dsh/kernel-feed/
```

设备下次启动时 `NodeRuntimeService` 步骤 0b 会自动发现并安装。

| 文件 | 必需性 | 说明 |
|---|---|---|
| `kernel-0.1.0-android.1.zip` | **必需** | 设备端按**文件名倒序**取第一个 |
| `kernel-manifest.json` | 可选但强建议 | `sha256` / `version` 锚点，挡重放 |
| `KERNEL-FEED-README.txt` | 可选 | 人读说明 |

**校验值**（自己复核用）：

```
sha256 = ad2047f29aa2eded3a2cd3efbed2c199e6be30f87b2d5df8b7e112ae5e1c7abf
size   = 1220204 字节
entries= 177
version= 0.1.0-android.1
```

## `baseline/baseline.zip` —— 无网首启基线内核

与 `feed/kernel-0.1.0-android.1.zip` **字节完全相同**（同 sha256）——
这不是巧合：两者都由同一个内核源码 + 同一把私钥产出，
证明「内置基线」与「OTA 投递」走的是同一条可信路径。

运行时它位于 `app/src/main/assets/kernel/baseline.zip`，
供**设备首次启动且无网络**时使用。

## `release/` —— OTA 发布包

`kernel-0.1.0-android.1.zip` + `kernel-manifest.json`，是 `kernel-ota.yml`
发布到 GitHub Release 的形态（`url` 字段填了可下载地址）。

## 三个文件为什么 sha256 相同

```
feed/kernel-0.1.0-android.1.zip      ad2047f2...
release/kernel-0.1.0-android.1.zip   ad2047f2...   ← 同一个包
baseline/baseline.zip                ad2047f2...   ← 同一个包
```

它们**是同一个内核包**，只是摆在不同位置扮演不同角色：
内置资产 / 投递 feed / Release 附件。

---

## ⚠ 本目录**不含**任何私钥

- ✅ 含 `app/src/main/assets/ota-public.pem`（**公钥**，本就焊在 APK 里，可公开）
- ❌ 不含 `keys/ota-private.pem`（内核 ed25519 私钥）
- ❌ 不含 `keys/release.keystore`（APK 签名 keystore）
- ❌ 不含 `keys/keystore.properties`（上述密码）

这是**刻意**的：拿到这个包的人可以**验证**内核包真伪（用公钥），
但**无法签发**新内核包（没有私钥）。这正是分层的意义。

**重新生成产物**（而不是用这份样本）：

```bash
./scripts/build-kernel-baseline.sh ../dsh-android-kernel   # 基线包
./scripts/build-kernel-feed.sh ../dsh-android-kernel 0.1.0-android.1   # feed
```
