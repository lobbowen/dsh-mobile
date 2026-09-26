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

**(d) 历史基线**（2026-09-23 手工取，当时 targetSdk=34；那份一次性脚本 `kernel/tools/domain-probe.js`
已于 2026-09-26 退役，判据改住供给表 `exec-domain` 格，读数走 `nativeCaps`）：

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
| P0 | targetSdk=28 重打 APK，读供给表 `exec-domain` 格 | 该格 `ok=true`：app home 里的脚本与自带 ELF 各 exec 一次并读到自身输出（对照组 = `/system/bin/sh`，它起不来则整格红）。`link(2)` 不在本格 —— 它已被 `libdshposix` 的 LD_PRELOAD 接管，同进程量不到系统事实 |
| P1 | `libdshposix` 收敛（flock/publish/pty/image） | 单一 .so + 单一加载器；旧三件退役 |
| P2 | `$PREFIX`（bash/coreutils/rg） | DSH bash 工具**无任何补丁**可用；`glob/grep` 无补丁可用 |
| P3 | Agent 描述符 + DSH adapter | 内核对 DSH 零硬编码；可挂第二个 Agent |
| P4 | 图像/PTY 原生件（自有 codec、node-pty android 构建） | `read_image`/图片附件、终端可用。读数只认 `nativeCaps` 对应格的 `ok=true`（投放结局 applied 不算过，见 P4 证伪记录） |
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
| D1 targetSdk=28 | 已落地（`container/app/build.gradle.kts:41`）。exec 读数不再靠人跑脚本：供给表 `exec-domain` 格每进程核一次，结论进 `status().nativeCaps` 与面板。**真机读数未采** ⇒ 本条只算「判据已就位」，不算「域已自证」 |
| D2 bionic 原生基底 | 已落地：`PrefixProvisioner` 从 nativeLibraryDir 派生 `$PREFIX`（bash/rg 真名可执行） |
| D3 原生原语 | 已落地：`native/posix/libdshposix.so` 以 LD_PRELOAD 替代 link(2)，`native/publish` 已删 |
| D5 依赖供给 | rg 平台包 `@vscode/ripgrep-android-arm64` 由内核补给；flock / require-builtin 两个第三方垫片保留 |
| D6 退役 shim | 已删 3 个改 DSH 字节的垫片（link-publish / capability-env / ptc-env）及其测试与夹具 |

### 已知降级（明确记录）

- PTC 工具模式：`ptc-env-shim` 已删，`DSH_TOOLS_MODE=ptc` 下子进程可能缺 LD_LIBRARY_PATH；默认 native 不受影响。
  - **2026-09-26 更正：这条判断错了。** 默认 native 模式一样受影响 —— `dsh` 的
    `run_code` 从清空的环境起子进程（`dsh-ptc-runtime-node/lib/index.js` 里
    `process.env` 被显式清掉），与工具模式无关。现网表现就是 `dsh run_code` 全灭。
    正解不是把 shim 装回去，而是让依赖路径进二进制（`DT_RUNPATH=$ORIGIN`）：
    见 ARCHITECTURE.md 第 3 节。根因与执行域选择无关，是**两件事叠加**：
    随包的 `libnode.so` 从来不带 RUNPATH，而我们的 exec 探针自己补 `LD_LIBRARY_PATH`，
    于是这道门禁恰好测不到 `run_code` 的真实形态。能力件（`$PREFIX` 下的 bash/rg）
    按同一判据重编属后续工作。
- 终端：node-pty 无 wasm/回退路径，必须 NDK 交叉编译。已在 fast-apk.yml 落地构建步骤（API 24 取 forkpty、去 `-lutil`、node-gyp + node 头），产物 `libdshpty.so` 经 `PrefixProvisioner` 落到 `$PREFIX/lib/pty.node`，再由内核投放到 `node-pty/prebuilds/android-arm64/pty.node`；上游配方失败只降级终端能力。
- 图片：**仍是降级项。** 本节 2026-09-23 写的「已按补真实依赖解决」已于 2026-09-26 被真机证伪，见下「P4 证伪记录」。

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

### P4 证伪记录（2026-09-26 真机，环境报告 §4.2）

上面「图片：补给 `@img/sharp-wasm32` 即解决」这句结论**作废**。真机实测：

- 依赖树里确实有 `@img/colour` 与 `@img/sharp-wasm32`（补装那一步成功了），**没有** `@img/sharp-android-arm64`；
- 而 `sharp@0.35.4` 仍加载失败。失败路径本身还盖掉了真因：`sharp/dist/sharp.cjs:115` 直接对
  `err.code` 调 `.endsWith("MODULE_NOT_FOUND")`，此处 `err.code === undefined` → 表层报
  `reading 'endsWith'`，实际是「找不到本平台二进制」。
- 影响面不止 `read_image`：`dsh-attachment`、`dsh-compaction-image-offload` 等图片链路共用 sharp。

「Android 走不进 sharp 硬编码 switch、只能靠 wasm 回退」这段分析仍然成立；被证伪的是**下一步**：
补装完成后没有任何人对「sharp 能不能加载」做一次观测，于是投放结局（applied）被当成能力结论写进了
本 ADR。缺的不是细心，是一层判据 —— 补装成功与能力可用之间当时零可见证据。

**口径修正（2026-09-26 起）**：原生件有两个正交结论 —— 投放结局 `nativeUnits`
（applied/already/skipped/blocked/failed，只说「动没动过手」）与能力结论 `nativeCaps`
（true/false/null，未知绝不算通过）。判据以数据形式住在 `kernel/src/guard/native/supply-table.json`
每格的 `verify`，唯一执行器是 `capability-probe.js`，探针跑在**被检的那份 node** 的子进程里；
以「文件在不在」作结论已被 `native-supply-gate-test.js` 禁用（那正是本节假绿的形状）。
本 ADR 此后不再写「某能力已解决」，除非引用那格 `ok=true` 的出处（面板 / `native_capability` 事件）。

**待办**：真机跑一次核验，读 sharp-image 那格到底是 `false`（绑定坏了，要另找供给路径）还是
`null`（探针没条件跑，先修环境）。在读到该读数之前，图片项按降级项对待。

**同期更正（2026-09-26）**：`ADR-0002` 的 P2 曾记「未解决：疑因内核 env 缺 `LD_LIBRARY_PATH`，
复核即可关闭」—— 复核已做，结论是**没有这条缺口**：`libsharp.so` 的 `DT_NEEDED` 全为
android-arm64，且它由 node 以 `dlopen(RTLD_LAZY)` 加载（不走 exec 路径）。所以 wasm 回退不通
与执行域选择无关，本条从 ADR-0002 的待办里作废，归口到上面的 sharp-image 探针读数。

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

> **2026-09-23 更新**：路线 A 实测不可得（应用 seccomp 把 `unshare(CLONE_NEWUSER)` 挡成 EINVAL）；
> 路线 B（`libdshrootns`）经真机实测**已否决并删除**（libc 符号覆盖不全 + 祖先 realpath 导致 node 静默 exit 1），
> 详见 [adr/0002-container-root-rejected.md](adr/0002-container-root-rejected.md)。
> 当前采用「长 `$PREFIX`、不伪造 `/`」；真根留待 Tier S（`system/`）。

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
