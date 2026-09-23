# native/rootprobe — 容器根可行性探针

- 来源：本仓自有代码，BSD-3-Clause。静态编译为 `libdshrootprobe.so` 随包。
- 目的：测 app 能否 `unshare(CLONE_NEWUSER|CLONE_NEWNS)` + 绑定挂载 + `pivot_root`。
- 结论用途：允许则走内核级真根（A），否则走用户态路径命名空间（B）。见 docs/ADR-001。
- 副作用：仅作用于探针自身进程的 namespace，退出即消失。
