# ADR-0002：容器根（用户态路径命名空间）被否决并移除

- 状态：**已决定 / 已执行**（2026-09-23）
- 关联：ADR-001「追加决策：容器根」、`native/rootns`、`ContainerRoot.kt`

## 背景

ADR-001 在「真命名空间容器不可得」（`unshare(CLONE_NEWUSER)` 被应用 seccomp 挡成 EINVAL）之后，
选定路线 B：用 `libdshrootns.so` 在 libc 层把绝对路径统一翻译进 `$DSH_ROOT`，
让 Agent 拥有一棵从 `/` 开始的文件系统。

## 实测结论（否决依据）

1. **libc 符号覆盖不完整，命名空间不一致**。只拦到了 `stat` 一族，Node 实际用的
   `open/open64/scandir` 等未被拦：
   - `fs.statSync("/testfile")` ✅（被翻译）
   - `fs.readFileSync("/testfile")` ❌ ENOENT（未被翻译）
   - `fs.readdirSync("/home")` ❌ ENOENT
   即：`/home/.dsh/...` 这类命名空间路径**读不到**，特性按当前实现不可用。
2. **祖先路径未直通直接杀死进程**。`DSH_REAL_ROOT` 的祖先（`/data`、`/data/user/0`…）
   被翻译进根目录内不存在的路径，Node 模块解析对候选路径逐级 `realpath/lstat` 失败，
   **以 code 1 静默退出**（A/B 实验：无 rootns exit 0；有 rootns exit 1；
   加 `--preserve-symlinks-main` 又 exit 0）。
3. **与产品方向冲突**：权限/生命周期参考 Termux 的工程方案 —— Termux **不伪造 `/`**，
   而是把长 `$PREFIX` 编进每个二进制。伪造 `/` 属于 proot 式路线，ADR-001 §6 本已否决 proot 作为地基。

## 决定

- **删除路线 B 及其全部产物**：
  `native/rootns/`、`native/rootprobe/`、`native/ptraceprobe/`、
  `app/.../native/ContainerRoot.kt`，以及 `NodeRuntimeService` 中
  `container-root` 诊断、`DSH_ROOT/DSH_REAL_ROOT/LD_PRELOAD` 注入与两个探针方法。
- **保留并强化**真实路径方案：
  - `$PREFIX`（`PrefixProvisioner`）—— 长路径，不假装 `/`；
  - `native/posix/open-fallback.c` —— 祖先目录 fsync 的 EACCES 兜底（与 rootns 无关，真需求）；
  - `targetSdk = 28` —— app home `execve`；
  - `system/`（Tier S）—— 真命名空间容器在 ROM 侧的落地面。

## 后果

- `rootns` 相关的 5 个文件/2 个探针方法与 3 处 CI 构建步骤全部移除；`fast-apk` 少编 3 个 .so。
- Agent 的 `HOME` 回到真实 `filesDir`；需要「自己的根」时走 Tier S，而不是用户态垫片。
- 已加反向门禁：这些路径若复活，测试即失败。
