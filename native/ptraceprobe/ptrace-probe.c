// 用户态 root（proot 原理）可行性探针：app 域 whether ptrace 可用、
// 能否拦截被跟踪进程的 syscall 并改写其路径参数。Termux/proot 在无 root 设备上
// 正是靠这一机制让被跟踪进程拥有自己的 /。见 docs/ADR-001。
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef PTRACE_O_TRACESYSGOOD
#define PTRACE_O_TRACESYSGOOD 0x00000001
#endif
#ifndef PTRACE_GETREGSET
#define PTRACE_GETREGSET 0x4204
#endif
#ifndef PTRACE_SETREGSET
#define PTRACE_SETREGSET 0x4205
#endif
#define NT_PRSTATUS 1
#define SYSCALL_STOP (SIGTRAP | 0x80)

// arm64 通用寄存器组：x0..x30, sp, pc, pstate。x8 = syscall nr，x0..x5 = 参数。
struct dsh_pt_regs {
    unsigned long long regs[31];
    unsigned long long sp;
    unsigned long long pc;
    unsigned long long pstate;
};

static int get_regs(int pid, struct dsh_pt_regs *r) {
    struct iovec iov = { r, sizeof(*r) };
    return ptrace(PTRACE_GETREGSET, pid, (void *)NT_PRSTATUS, &iov);
}
static int set_regs(int pid, struct dsh_pt_regs *r) {
    struct iovec iov = { r, sizeof(*r) };
    return ptrace(PTRACE_SETREGSET, pid, (void *)NT_PRSTATUS, &iov);
}

// 逐字读被跟踪进程内存里的 C 字符串。
static long peek_str(int pid, unsigned long long addr, char *out, size_t n) {
    size_t i = 0;
    while (i + 1 < n) {
        errno = 0;
        long w = ptrace(PTRACE_PEEKDATA, pid, (void *)(addr + i), 0);
        if (errno != 0) return -1;
        for (int b = 0; b < (int)sizeof(long); b++) {
            char c = (char)((w >> (8 * b)) & 0xff);
            out[i++] = c;
            if (c == 0) return (long)i;
            if (i + 1 >= n) { out[i] = 0; return (long)i; }
        }
    }
    out[n - 1] = 0;
    return (long)n - 1;
}

// 把新字符串写进被跟踪进程栈下方，并把指定参数寄存器改指向它。
static int write_str(int pid, unsigned long long addr, const char *s) {
    size_t len = strlen(s) + 1;
    for (size_t i = 0; i < len; i += sizeof(long)) {
        long w = 0;
        size_t chunk = len - i < sizeof(long) ? len - i : sizeof(long);
        memcpy(&w, s + i, chunk);
        if (ptrace(PTRACE_POKEDATA, pid, (void *)(addr + i), (void *)w) != 0) return -1;
    }
    return 0;
}

int main(void) {
    const char *marker = "/ptrace-marker-not-exist";
    const char *target = "/system/bin/sh";
    setvbuf(stdout, 0, _IONBF, 0);
    printf("uid=%d\n", getuid());

    pid_t pid = fork();
    if (pid == 0) {
        ptrace(PTRACE_TRACEME, 0, 0, 0);
        raise(SIGSTOP);
        int fd = (int)syscall(__NR_openat, AT_FDCWD, marker, O_RDONLY);
        printf("child: openat=%d errno=%d\n", fd, errno);
        if (fd >= 0) close(fd);
        _exit(0);
    }
    if (pid < 0) { printf("PTRACE:fail fork errno=%d\n", errno); printf("SUMMARY:ptrace-blocked\n"); return 0; }

    int status = 0;
    if (waitpid(pid, &status, 0) < 0) { printf("PTRACE:fail wait errno=%d\n", errno); printf("SUMMARY:ptrace-blocked\n"); return 0; }
    if (ptrace(PTRACE_SETOPTIONS, pid, 0, (void *)PTRACE_O_TRACESYSGOOD) != 0) {
        printf("SETOPTIONS:fail errno=%d(%s)\n", errno, strerror(errno));
        printf("SUMMARY:ptrace-degraded\n");
        return 0;
    }
    printf("SETOPTIONS:ok\n");

    int stops = 0, seen = 0, rewrote = 0, in_syscall = 0;
    unsigned long long scratch = 0;
    struct dsh_pt_regs saved;
    memset(&saved, 0, sizeof(saved));

    while (1) {
        if (ptrace(PTRACE_SYSCALL, pid, 0, 0) != 0) break;
        if (waitpid(pid, &status, 0) < 0) break;
        if (WIFEXITED(status)) break;
        if (!WIFSTOPPED(status)) break;
        int sig = WSTOPSIG(status);
        if (sig != SYSCALL_STOP) { if (sig != SIGSTOP) ptrace(PTRACE_SYSCALL, pid, 0, (void *)(long)sig); continue; }
        stops++;
        in_syscall ^= 1;
        if (!in_syscall) continue;
        struct dsh_pt_regs r;
        if (get_regs(pid, &r) != 0) continue;
        long nr = (long)r.regs[8];
        if (nr != __NR_openat) continue;
        char buf[256];
        if (peek_str(pid, r.regs[1], buf, sizeof buf) < 0) continue;
        if (strcmp(buf, marker) != 0) continue;
        seen++;
        if (scratch == 0) scratch = (r.sp > 4096 ? r.sp - 4096 : r.sp);
        if (write_str(pid, scratch, target) == 0) {
            saved = r;
            r.regs[1] = scratch;
            if (set_regs(pid, &r) == 0) rewrote++;
        }
    }
    printf("SYSCALL_STOPS:%d\n", stops);
    printf("MARKER_SEEN:%d\n", seen);
    printf("REWRITE:%s\n", rewrote > 0 ? "ok" : "fail");
    printf("SUMMARY:%s\n", (stops > 0 && rewrote > 0) ? "usermode-root-feasible" : (stops > 0 ? "ptrace-only" : "ptrace-blocked"));
    return 0;
}
