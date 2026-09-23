# native/rootns — 容器根（用户态路径命名空间）

- 来源：本仓自有代码，BSD-3-Clause。编译为 `libdshrootns.so`。
- 作用：`DSH_ROOT` 设置后，绝对路径统一解析进容器根，令 Agent 拥有一棵从 `/` 开始、
  祖先链完全属于自己的文件系统；`/proc`、`/dev`、`/system`、`/data/app` 与 `DSH_REAL_ROOT` 直通。
- 未设置 `DSH_ROOT` 时全部直通：零行为变化。
- 状态：随包构建，**尚未激活**（不注入 LD_PRELOAD）。是否激活取决于 native/rootprobe 的判定：
  路线 A（内核级真根）不可行时启用本层。见 docs/ADR-001。
- 局限：仅覆盖经 libc 符号的调用；不经 libc 的裸 syscall 不受影响。
