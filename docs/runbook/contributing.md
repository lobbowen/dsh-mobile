# 贡献规范

本文件规定**唯一的做事方式**。目的：不再重复踩已经踩过的坑。

---

## 1. 改什么，走哪条路

**直接查表，不要凭感觉推。**

| 你改了什么 | 走哪条 | 耗时 | 说明 |
|---|---|---|---|
| `container/app/**`（Kotlin / assets / res / gradle） | `fast-apk.yml` | 分钟级 | 推 `main` 或 `fast-*` tag 触发 |
| `container/native/**` | `fast-apk.yml` | 分钟级 | 原生桥源码 |
| `container/engine/**` | `ci.yml` 的 container job | 分钟级 | **不触发** fast-apk（不出 APK） |
| `kernel/**`（内核 + 面板） | `ci.yml` 的 kernel job | 分钟级 | **不重编 APK**；内核经 OTA 分发 |
| `scripts/build-node-android.sh` | `build-apk.yml`（**手动**，push 不触发） | **2~3 小时** | 只有真要重编 Node 才走 |
| 升级 Node 版本 | `build-apk.yml`（手动）+ release-admin 的 pin job | **2~3 小时** | 编完必须固化，见 §3 |
| `docs/**`、`*.md` | 不触发构建 | — | 纯文档 |
| `.github/workflows/**`、`scripts/**`、`docs/contracts/**` | `ci.yml` | 分钟级 | 走统一门禁 |

> **判断准则**：这个改动会不会改变 `libnode.so` 这一个字节？
> 不会 → 走 fast-apk（或 ci.yml）。会 → 手动跑 build-apk 重编，编完 pin-node 固化。

### 设备内 spawn 的硬边界（改内核必读）

W^X 下 `filesDir` 里的一切**不可 execve**：`npm`/`dsh` 的 bin shim 是脚本，直接 spawn 必失败。
内核里**一切** npm / dsh 子进程只许经统一解析入口拿调用形态：

- npm：`runtimeContract.npmInvocation()` → 恒 `{bin, args}`；环境一律 `npmEnv()`。
- dsh 子命令：`NativeManager.dshCliInvocation()`（插件域经 `resolveDshCli` 注入）。
- 装机成功后 `config.command` 会被写回并落盘 —— 新增消费方读它，不要再猜路径。

行为门禁：`kernel/test/npm-contract-chain-test.js`。

---

## 2. 开发循环：**批次提交**

```
① 连续编辑多个文件（不推）
② 只读自查：是否引用已删文件 / 路径是否写错 / 契约是否同步
③ 一个逻辑单元改完 → 一次提交
④ 推分支 → 开 PR（**不要直推 main**，见 git.md §2）
⑤ CI 跑完，读一次结果
⑥ 红 → 先在本地定位（读源码/日志），再改，再推
```

**核心：推送是"交付"，不是"验证"。** 一个批次 = 一次推送，不是一个文件 = 一次推送。

**本地不执行仓内代码**（`node test`、`gradlew`、`scripts/*`）—— 红线与机制见
[../standards/testing.md](../standards/testing.md)。本地允许的只有：编辑、只读检索、统计。

---

## 3. 升级 Node 版本（低频，需主动操作）

```bash
# ① 改默认版本
vim container/app/src/main/assets/node-versions.json   # 改 default 字段

# ② 手动触发重编（2~3 小时；push 不会自动触发）
#    Actions → "Build Android Node Container APK" → Run workflow

# ③ 编完【必须固化】，否则 fast-apk 找不到对应运行时
#    方式一：推 tag  pin-node-latest（或 pin-node-<run_id>）
#    方式二：Actions → "Admin (cancel / status)" → mode=pin
#    （没有名为 "Pin Node runtime" 的独立 workflow）
```

固化产物落在 Release：`node-runtime-<version>-<abi>`，如 **`node-runtime-24.21.0-arm64-v8a`**。
`fast-apk` 按这个名字去找；不固化会报"找不到 Release"并给出指引。

---

## 4. 触发 CI 的方式（tag 通道）

```bash
# ---- 出包 ----
git push origin refs/tags/fast-verify-1        # 手动跑一次 fast-apk

# ---- 固化运行时 ----
git push origin refs/tags/pin-node-latest      # 固化最近一次成功的 build-apk 产物
git push origin refs/tags/pin-node-<run_id>    # 固化指定 run 的产物

# ---- 管理（release-admin.yml 的 admin job）----
git push origin refs/tags/admin-status-<run_id>   # 查 run 状态 + artifact
git push origin refs/tags/admin-logs-<run_id>     # 拉失败日志
git push origin refs/tags/admin-release           # 查 Release 附件指纹
git push origin refs/tags/admin-cancel-<run_id>   # 取消 run
git push origin refs/tags/admin-cancelall         # 取消所有在跑的
```

结果写到这几个分支，用 `git fetch` + `git show` 读：

| 分支 | 内容 |
|---|---|
| `ci-admin` | admin 命令的结果 |
| `ci-hb` | 构建期心跳（stage / 内存 / OOM 计数） |
| `ci-last` | 构建终态报告（含失败步骤与日志尾部） |
| `ci-ok` | 成功发布信息（含 sha256） |

> **`admin-logs` 是排查 CI 失败的唯一手段。** 不要猜，猜一轮就是几十分钟到几小时。

---

## 5. 提交前自查（CI 会替你跑，本地不必跑）

以下检查由 **CI 的第一步**执行，本地**不要**运行（见 testing.md §2）：

- `scripts/validate-workflow.py`（严格 YAML 校验）；
- `scripts/gen-version.js --check`（跨层版本）；
- `git diff --exit-code -- .github/native-assets.txt`（原生资产清单对账）。

`validate-workflow.py` 能抓到的问题，都是**曾经真实浪费过一整轮 CI 的**：

| 检查 | 为什么重要 |
|---|---|
| 重复 key | GitHub 拒绝加载，页面只显示"红色 ✗ + 0 秒"，没有任何日志 |
| `on.push` 出现两次 | 后者静默覆盖前者，触发条件变得不可预期 |
| `paths` 与 `paths-ignore` 同时写 | 语义冲突 |
| 缺少 `name` | run 列表里显示文件路径，找人极不方便 |

---

## 6. 改 workflow 时的硬规矩

**一条 `on:` 块里只能有一个 `push:`。**

```yaml
# ❌ 错：两个 push，后者覆盖前者
on:
  push: { branches: [main], paths: ['container/app/**'] }
  push: { tags: ['fast-*'] }

# ✅ 对：合并成一个
on:
  push:
    branches: [main]
    paths: ['container/app/**']
    tags: ['fast-*']
```

**触发条件的选择**：

- **高频路径**（日常出包）用 `paths` **白名单**：语义是"不匹配就不跑"。
- **低频路径**（Node 编译）用 `paths-ignore` **黑名单**：万一漏配最多白跑一次。

---

## 7. 代码与注释规范

### 注释只写"改这里必须知道什么"

历史排查过程、外部依据、失败现象 —— **全部归 `docs/architecture.md`**，代码里只在必要处给一行指引。

```kotlin
// ❌ 不要在代码里写长篇叙事
// ✅ 只写约束和指引（完整原因见 docs/architecture.md 第 3 节）
put("LD_LIBRARY_PATH", libSearchPath)
```

**为什么**：同一件事写在三处，改一处忘两处就是事故。

### 删除死代码，不留"以后可能用得上"

判据：**一个 API 如果在仓库里零调用，就删掉。** 需要用的时候从 git 历史里翻。

---

## 8. 出问题时的排查顺序

1. **看真机诊断面板**（App 打开即是），对照 `docs/architecture.md` 第 9 节。
2. **CI 失败** → `admin-logs-<run_id>` 拉日志。不要猜。
3. **真机报错看不懂** → 查 `docs/architecture.md` 的"错误码速查"。
4. **改了没生效** → 先确认跑对了 workflow；再确认 APK 是从 `apk-latest` 拿的。

---

## 9. 一句话总结

> **改 App 代码走 fast-apk（分钟级）；改内核走 ci.yml 的 kernel job；只有动 Node 编译脚本才走 build-apk（小时级）。
> 拿不准就问自己：这会改变 libnode.so 吗？**
