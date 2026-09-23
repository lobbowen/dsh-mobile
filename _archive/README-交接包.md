# DSH Mobile —— 整仓交接包

> ⚠ **历史快照**：本文描述 2026-09-16 的**双仓**交付包布局。2026-09-22 起两仓已并入
> 单仓 `lobbowen/dsh-mobile`（容器 = 仓根，内核 = `dsh-android-kernel/` 子目录），下文目录结构仅作归档参考。

> 打包时间：2026-09-16 19:43 GMT+8
> 主仓 HEAD：`a41b30f`
> 内核仓 HEAD：`50031d3`

## 包里有什么

```
dsh-android-container/          L0 容器仓（主仓）
├── docs/HANDOVER.md            ★ 先读这个（完整交接文档）
├── docs/ARCHITECTURE.md          硬约束原理（653 行，最值得读）
├── README.md                     快速上手
├── app/                          Android App（Kotlin）
├── container-engine/             纯 Node OTA 引擎 + 12 套测试（228 条断言）
├── scripts/                      构建/密钥/校验脚本
├── .github/                      7 个 CI workflow
└── _artifacts/                   ★ 附带的构建产物样本（详见其内 README）

dsh-android-kernel/             L1 内核仓（**本包内含，因为该仓没有配 remote**）
├── bin/dsh-supervisor            内核入口
├── src/                          内核源码
├── test/                         内核测试
└── ui/dist/                      ⚠ 内核控制面板静态资源（运行期必需）
```

## 为什么内核仓也打进来了

`dsh-android-kernel` **没有配置 git remote**，代码只存在于本地。不打包的话
这部分工作就丢了。

打包时做了两处特殊处理：

1. **排除 `ui/node_modules/`**（191M 的平台专用二进制，`npm install` 可重建）
   → 内核仓从 201M 压到 3.3M。
2. **补入 `ui/dist/`** —— 它被内核仓的 `.gitignore` 排除（`**/dist/`），
   但**恰恰是运行期需要的**（内核控制面板的静态资源，`host.html` /
   `supervisor.html` 等）。纯 `git archive` 会打出一个**能启动但打不开控制面板**
   的内核 —— 这是本项目文档里反复强调的那类"构建成功但真机不可用"陷阱。

## ⚠ 本包不含任何私钥（刻意如此）

| 文件 | 在包里？ | 说明 |
|---|---|---|
| `app/src/main/assets/ota-public.pem` | ✅ 含 | **公钥**，本就焊在 APK 里，可公开 |
| `keys/ota-private.pem` | ❌ 不含 | 内核 ed25519 私钥 |
| `keys/release.keystore` | ❌ 不含 | APK 签名 keystore |
| `keys/keystore.properties` | ❌ 不含 | 上述密码 |

含义：拿到本包的人**能验证**内核包真伪（用公钥），但**无法签发**新内核包
（没有私钥）。这正是分层的意义。

**若你需要重新签发内核包或发布 APK**，必须先自行生成密钥：

```bash
cd dsh-android-container
./scripts/keygen.sh                      # 内核 ed25519 密钥对
./scripts/keygen-android-keystore.sh     # APK 签名 keystore
```

## 快速验证这个包

```bash
cd dsh-android-container/container-engine
npm run test:logic      # 期望：228 passed, 0 failed（12 套件）

# 跨仓测试（bridge-interop）需要内核仓，用环境变量指过去：
DSH_KERNEL_REPO=../../dsh-android-kernel npm run test:logic
# 期望：228 passed（bridge-interop 由 SKIP 变为真实执行）
```

基线包测试：

```bash
cd dsh-android-container
mkdir -p app/src/main/assets/kernel
cp _artifacts/baseline/baseline.zip app/src/main/assets/kernel/
cd container-engine && npm run test:baseline   # 期望：8 passed, 0 failed
```

## 产物校验值（可自行复核）

```
sha256 = ad2047f29aa2eded3a2cd3efbed2c199e6be30f87b2d5df8b7e112ae5e1c7abf
size   = 1220204 字节
```

`_artifacts/feed/`、`_artifacts/release/`、`_artifacts/baseline/` 下三份内核包
**sha256 完全相同** —— 它们是同一个包摆在不同位置扮演不同角色（投递 feed /
Release 附件 / 内置基线）。

## 环境要求

| 用途 | 要求 |
|---|---|
| 跑容器引擎测试 | Node ≥ 18（本项目在 v22 验证） |
| 编译 APK | JDK 17 + Android SDK（platform 35 / build-tools 35.0.0）+ NDK r27+ |
| 交叉编译 Node | 同上，且**耗时 2~3 小时** |
| 内核仓测试 | Node ≥ 18 |

---

## 新手第一步

1. 读 `dsh-android-container/docs/HANDOVER.md`（12 节，含遗留债清单）
2. 跑 `npm run test:logic` 确认基线
3. 看 `docs/HANDOVER.md` §3.2 确认有哪些**需要人工处理**的事项
   （主要是密钥备份与 CI secret 配置）
