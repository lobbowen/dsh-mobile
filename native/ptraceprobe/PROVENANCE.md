# native/ptraceprobe — 用户态 root 可行性探针

- 来源：本仓自有代码，BSD-3-Clause。静态编译为 `libdshptraceprobe.so` 随包。
- 目的：测 app 域能否 ptrace 自己的子进程、能否拦截 syscall 并改写其路径参数。
- 结论用途：可行则以自研 ptrace 路径根取代 libc 层的 libdshrootns（覆盖静态二进制与裸 syscall）。
- 副作用：仅作用于探针自身创建的子进程，退出即消失。
