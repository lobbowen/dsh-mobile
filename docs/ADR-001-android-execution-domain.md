# ADR-001：Android 执行域与原生 Agent 运行时基底

- 状态：**已决定**（2026-09-23）
- 边界（不可偏离）：免 root；**不使用 Termux 作为中间层**；完全自研的原生 Agent 容器；**DSH 不可修改**（会自动升级），我们只造它能跑的环境。

---

## 1. 要解决的问题

DSH 在本机反复出现同类故障，且每修一处就多一层补丁：

| 现象 | 曾经的处置 |
|---|---|
| bash 工具全灭（缺 `libbash.so`） | 给 `dsh-bash-local` 的 argv 打字节锚点补丁 |
| `write` 新建文件 EACCES（`link(2)`） | 给 install 树 4 个 bundle 打字节锚点补丁 |
| `read_image`/图片附件不可用 | （拟）再打一层补丁 |
| ripgrep / node-pty / flock / require-builtin | 各打一层垫片 |

这些补丁都在**运行期改写 DSH 的安装字节**（`.dsh-orig` 备份即证据）。DSH 一升级锚点即失效 —— 补丁式适配无法收敛。

## 2. 决定性事实（一手证据）

**(a) `targetSdk` 直接决定 SELinux 域**（AOSP `system/sepolicy/private/seapp_contexts`）：

```
user=_app minTargetSdkVersion=34 domain=untrusted_app
user=_app minTargetSdkVersion=32 domain=untrusted_app_32
user=_app minTargetSdkVersion=30 domain=untrusted_app_30
user=_app minTargetSdkVersion=29 domain=untrusted_app_29
user=_app minTargetSdkVersion=28 domain=untrusted_app_27
```

**(b) app home 的 `execve` 只对 targetApi ≤ 28 放行**（`private/app_neverallows.te`）：

```
# Block calling execve() on files in an apps home directory. ... For compatibility,
# allow for targetApi <= 28.   b/112357170
neverallow { all_untrusted_apps -untrusted_app_25 -untrusted_app_27 -runas_app }
  { app_data_file privapp_data_file }:file execute_no_trans;
```
`private/untrusted_app_27.te`：`allow untrusted_app_27 app_data_file:file execute_no_trans;`

**(c) `link(2)` 对所有 app 域无条件封死**（同文件）：
```
neverallow all_untrusted_apps file_type:file link;
```
→ 与 `targetSdk` 无关，降版本救不了。

**(d) 本机实测基线**（`dsh-android-kernel/tools/domain-probe.js`，targetSdk=34）：

```
SELinux 域         : u:r:untrusted_app_34:s0
exec 系统 sh       : ok
exec app 脚本      : fail:EACCES
exec app 原生二进制 : fail:EACCES
link(2)            : fail:EACCES
rename(2)          : ok
renameat2 NOREPLACE: available
```

**(e) 存在证明**：Termux 是 `minSdk=21, targetSdk=28, compileSdk=36` —— **刻意把 targetSdk 钉在 28**，正是为了拿回 (b) 的豁免，从而运行自带 `$PREFIX` 里的原生二进制。

## 3. 决定

**D1｜`targetSdk = 28`（`compileSdk` 保持 35）。**
这是整个工程的地基开关：没有它，容器永远不能 execve 自己放置的任何二进制（bash/工具链/Agent 生成的程序），只能把一切改名 `lib*.so` 塞 jniLibs —— 这是永久天花板。
代价（显式记录）：放弃 Android 10+ 对 app home 的 W^X 加固；**无法上架 Google Play**（本产品是侧载/企业分发的冻结 APK）。

**D2｜基底走 bionic 原生自研 `$PREFIX`，不引入 proot/glibc userland 作为地基。**
与「原生 Agent 容器」定位一致：无 ptrace 开销、无发行版中间层、体积可控。个别确实无法移植的依赖，再单独评估（见 D3）。

**D3｜自研原生层。** 统一为 `libdshposix`（原语：`renameat2(NOREPLACE)`、flock、PTY、图像编解码），以及**我们自己的 `$PREFIX` 产物**（bash/coreutils/rg/git/node-pty/图像 codec），全部 Agent 无关。

**D4｜控制面板与 Agent 解耦。** 引入 **Agent 描述符 + adapter**（来源/入口/env 契约/健康/端口/能力需求）；DSH 只是第一个 adapter，内核对 DSH 零专属逻辑。

**D5｜适配手段白名单**（除此之外一律不许）：
1. 环境（`targetSdk`/域、`PATH`、`$PREFIX`、原生资产、文件系统）；
2. DSH 自身配置（`$DSH_HOME`、profile `cordis.patch.yml`、settings、凭据）；
3. 依赖供给/覆盖（DSH 按名字解析的东西：`@vscode/ripgrep-android-arm64`、`sharp`、`node-pty`、`node-addon-system`）；
4. DSH 官方 provider 插件（`ctx.shell`/`ctx.fs`/`ctx.attachments` 等 seam）；
5. 向上游提需求。
**禁止**：改 `@deepseek-ai/dsh` 的任何字节。

**D6｜分阶段退役 `guard/native/*-shim.js` 字节补丁层**（其职责迁往 D3/D5）。

## 4. 后果

- 正面：消除「不能 exec 自建二进制」的天花板；bash/工具链以「装包」而非「打补丁」解决；同一套基底可服务未来所有 Node Agent。
- 风险：若未来 Android 收紧 (b) 的豁免，则退回「jniLibs + provider 插件」；`link(2)` 无论如何都需自有原语（已具备）。
- 兼容性：targetSdk 28 会启用若干 legacy 行为（存储/通知/后台），对容器多为有利，但需在真机回归。

## 5. 路线与验收信号

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | targetSdk=28 重打 APK，跑 `domain-probe` | `exec app 脚本/二进制 = ok`；`link = fail:EACCES` 不变 |
| P1 | `libdshposix` 收敛（flock/publish/pty/image） | 单一 .so + 单一加载器；旧三件退役 |
| P2 | `$PREFIX`（bash/coreutils/rg） | DSH bash 工具**无任何补丁**可用；`glob/grep` 无补丁可用 |
| P3 | Agent 描述符 + DSH adapter | 内核对 DSH 零硬编码；可挂第二个 Agent |
| P4 | 图像/PTY 原生件（自有 codec、node-pty android 构建） | `read_image`/图片附件、终端可用 |
| P5 | 退役 shim 层 | `guard/native/*-shim.js` 与 `.dsh-orig` 归零 |

## 6. 被否决的方案

| 方案 | 否决理由 |
|---|---|
| root / Shizuku 提权 | 产品边界：免 root |
| Termux 作为中间层 | 产品边界 |
| proot/glibc userland 作为**地基** | 与「原生」定位冲突；ptrace 开销；引入发行版中间层与 GPL 维护面 |
| 修改 DSH 源码/安装字节 | 边界：DSH 会自升级，改它即工程报废 |

---

## 执行状态（2026-09-23）

| 项 | 状态 |
|---|---|
| D1 targetSdk=28 | 已落地；待 CI 出包后用 `tools/domain-probe.js` 验证 exec |
| D2 bionic 原生基底 | 已落地：`PrefixProvisioner` 从 nativeLibraryDir 派生 `$PREFIX`（bash/rg 真名可执行） |
| D3 原生原语 | 已落地：`native/posix/libdshposix.so` 以 LD_PRELOAD 替代 link(2)，`native/publish` 已删 |
| D5 依赖供给 | rg 平台包 `@vscode/ripgrep-android-arm64` 由内核补给；flock / require-builtin 两个第三方垫片保留 |
| D6 退役 shim | 已删 3 个改 DSH 字节的垫片（link-publish / capability-env / ptc-env）及其测试与夹具 |

### 已知降级（明确记录）

- PTC 工具模式：`ptc-env-shim` 已删，`DSH_TOOLS_MODE=ptc` 下子进程可能缺 LD_LIBRARY_PATH；默认 native 不受影响。
- 终端：node-pty 无 wasm/回退路径，必须 NDK 交叉编译。已在 fast-apk.yml 落地构建步骤（API 24 取 forkpty、去 `-lutil`、node-gyp + node 头），产物 `libdshpty.so` 经 `PrefixProvisioner` 落到 `$PREFIX/lib/pty.node`，再由内核投放到 `node-pty/prebuilds/android-arm64/pty.node`；上游配方失败只降级终端能力。
- 图片：已按「补真实依赖」解决（见下），不再是降级项。

### P4 结论（2026-09-23 复核）

**图片**：Android 不在 `sharp/dist/sharp.cjs` 的**硬编码原生 switch** 内（全包无 `android` 字样），
因此**即使 NDK 编出 android 原生绑定也不会被加载**。但 sharp 为未知平台预留了正式回退：
`require('@img/sharp-wasm32/sharp.node')`（真 libvips 编到 wasm，官方路径，需显式补装）。
故正解是**补给该依赖**：`guard/native/sharp-wasm.js` 在隔离目录装好后拷回 DSH 树。
不 fork sharp、不替换实现、不用 NDK；代价是 wasm 比原生慢（附件归一化场景可接受）。

**PTY**：node-pty 无任何 wasm/回退路径，只能构建原生 `.node`（NDK + node 头）。

### 被否决的做法

- 用自研 `sharp` 兼容包替换依赖（属替换实现，破坏依赖契约）→ 否决。
- 把图像处理搬到 HostBridge/Bitmap 再做替换包 → 同上，且引入跨进程旁路 → 否决。

### P4 补充：read_image 的 EACCES（2026-09-23 定位并修复）

根因：`dsh-attachment-local` 的 `ensureDurableHome` 以 `parse(home).root` 为边界，
会把 `<DSH_HOME>` 的**每一个祖先 fsync 到文件系统根**；Android 上 `/data/user/0`、`/data`、`/`
对 app 均不可读，`open` 目录即 EACCES，附件保存整条失败（`read` 不走此路径，故正常）。

修法（环境层，不改 DSH）：`native/posix/open-fallback.c` —— 在 `open/openat` 因 EACCES 失败、
且目标确为 `$HOME` 的祖先目录时，返回 `$HOME` 的只读目录句柄，让调用方的 fsync 完成。
上游正确修法应是把 durable 边界设到 `$DSH_HOME` 或容忍 EACCES，已记录。
## 追加决策：容器根（2026-09-23）

### 结构性结论

真机实测：`/data/user/0`、`/data`、`/` 对 app 均 EACCES；`/storage/emulated/0/...` 链上也有断点。
即 **Android 上不存在祖先链整条可打开的路径**。
DSH（`dsh-attachment-local.ensureDurableHome`）把边界写成 `parse(home).root`，逐级 fsync 到 `/`，
因此必然失败。这类故障（bash/exec/link/祖先 fsync）同源：
**Agent 运行在系统命名空间里，却假设自己拥有从 `/` 开始的整棵文件系统。**

### 决策：给 Agent 自己的根，而不是继续按 syscall 打补丁

- 路线 A（内核级）：`unshare(CLONE_NEWUSER|CLONE_NEWNS)` + 绑定挂载 + `pivot_root`，
  得到真实容器根；零翻译开销、覆盖静态二进制与直接 syscall。可行性由 `native/rootprobe` 在真机判定。
- 路线 B（用户态）：`libdshposix` 内实现路径命名空间（绝对路径解析进 `$DSH_ROOT`，
  `/proc`、`/dev`、`/system`、nativeLibraryDir 直通）。无特权，覆盖 Node 及其原生插件。
- 选定顺序：A 可行则 A；否则 B。二者都会让症状级补丁（如 `open-fallback`）变为多余并删除。

## 追加决策：底座是系统服务（Tier S），不是普通应用（2026-09-23）

### 事实基础（实测）

目标机 OPPO PLP120 / SM8850：`ro.build.type=user`、`ro.secure=1`、`ro.boot.flash.locked=1`、
`verifiedbootstate=green`、`ro.oem_unlock_supported` 空、adb 关闭、无 su/Magisk。
在该设备上，已安装 APK 不存在通往系统级的软件路径。

### 结论：四条封死来自「普通应用」身份，不是缺 API

`untrusted_app` 域下：自家目录禁 execve、link(2) neverallow、祖先目录不可读、
unshare(CLONE_NEWUSER) 被应用 seccomp 挡成 EINVAL（内核其实编了 CONFIG_USER_NS）。
因此 targetSdk=28、libdshposix、libdshrootns、PrefixProvisioner 这一整套都是**兼容垫片**，
不是架构终点。

### 决策

- Tier S（正解）：容器以 priv-app + 自有域 `dsh_container` + init 服务 + Binder 接口随 ROM 出厂；
  四条封死同时消失，路线 A（真命名空间容器）重新可用，垫片全部删除。集成面见 `system/`。
- Tier A（兼容）：普通应用形态保留给碰不到的设备，作为降级层，不再作为设计基准。
- 交付通道：厂商预装 / 工程机 userdebug / 自有可解锁设备；产线锁定用户机只能走厂商预装。
