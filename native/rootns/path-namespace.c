// 容器根（用户态路径命名空间）：把绝对路径统一解析进 $DSH_ROOT，
// 使 Agent 看到一棵属于自己的、从 / 开始的完整文件系统 —— 祖先遍历、
// /tmp、/etc 等桌面 POSIX 假设随之成立。真路径（/proc /dev /system
// 与容器自身 real 前缀）直通。见 docs/ADR-001。
//
// 本文件是启动期一次性建立的通用层，不是按调用点打的补丁；
// 由 DSH_ROOT 与 DSH_REAL_ROOT 两个环境变量驱动，未设置时全部为直通（零行为变化）。
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static const char *g_root;
static const char *g_real;
static int g_ready;

static void init_once(void) {
    if (g_ready) return;
    g_ready = 1;
    g_root = getenv("DSH_ROOT");
    g_real = getenv("DSH_REAL_ROOT");
    if (g_root != 0 && g_root[0] != '/') g_root = 0;
    if (g_real != 0 && g_real[0] != '/') g_real = 0;
}

static int under(const char *path, const char *prefix) {
    size_t n = strlen(prefix);
    return strncmp(path, prefix, n) == 0 && (path[n] == 0 || path[n] == '/');
}

// 直通集：系统伪文件系统、运行时库目录、容器自身的真实前缀。
static const char *const REAL_PREFIXES[] = {
    "/proc", "/dev", "/sys", "/system", "/apex", "/vendor", "/product", "/data/app", 0
};

static const char *tr(const char *path, char *buf, size_t n) {
    init_once();
    if (g_root == 0 || path == 0 || path[0] != '/') return path;
    if (under(path, g_root)) return path;
    for (int i = 0; REAL_PREFIXES[i] != 0; i++) if (under(path, REAL_PREFIXES[i])) return path;
    if (g_real != 0 && under(path, g_real)) return path;
    snprintf(buf, n, "%s%s", g_root, path);
    return buf;
}

static int at_path(int dirfd, const char *path, char *buf, size_t n) {
    if (path == 0 || path[0] == '/') return 0;   // 绝对路径无需 dirfd
    if (dirfd == AT_FDCWD) return 0;
    snprintf(buf, n, "/proc/self/fd/%d/%s", dirfd, path);
    return 1;
}

int open(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); mode = (mode_t)va_arg(ap, int); va_end(ap); }
    char b[PATH_MAX];
    return (int)syscall(__NR_openat, AT_FDCWD, tr(path, b, sizeof b), flags, mode);
}

int openat(int dirfd, const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); mode = (mode_t)va_arg(ap, int); va_end(ap); }
    char b[PATH_MAX], d[PATH_MAX];
    const char *p = tr(path, b, sizeof b);
    if (at_path(dirfd, path, d, sizeof d)) p = d;
    return (int)syscall(__NR_openat, path[0] == '/' ? AT_FDCWD : dirfd, p, flags, mode);
}

int stat(const char *path, struct stat *st) { char b[PATH_MAX]; return (int)syscall(__NR_newfstatat, AT_FDCWD, tr(path, b, sizeof b), st, 0); }
int lstat(const char *path, struct stat *st) { char b[PATH_MAX]; return (int)syscall(__NR_newfstatat, AT_FDCWD, tr(path, b, sizeof b), st, AT_SYMLINK_NOFOLLOW); }
int fstatat(int dirfd, const char *path, struct stat *st, int flags) { char b[PATH_MAX]; return (int)syscall(__NR_newfstatat, dirfd, tr(path, b, sizeof b), st, flags); }
int access(const char *path, int mode) { char b[PATH_MAX]; return (int)syscall(__NR_faccessat, AT_FDCWD, tr(path, b, sizeof b), mode, 0); }
int faccessat(int dirfd, const char *path, int mode, int flags) { char b[PATH_MAX]; return (int)syscall(__NR_faccessat, dirfd, tr(path, b, sizeof b), mode, flags); }
int mkdir(const char *path, mode_t mode) { char b[PATH_MAX]; return (int)syscall(__NR_mkdirat, AT_FDCWD, tr(path, b, sizeof b), mode); }
int mkdirat(int dirfd, const char *path, mode_t mode) { char b[PATH_MAX]; return (int)syscall(__NR_mkdirat, dirfd, tr(path, b, sizeof b), mode); }
int unlink(const char *path) { char b[PATH_MAX]; return (int)syscall(__NR_unlinkat, AT_FDCWD, tr(path, b, sizeof b), 0); }
int unlinkat(int dirfd, const char *path, int flags) { char b[PATH_MAX]; return (int)syscall(__NR_unlinkat, dirfd, tr(path, b, sizeof b), flags); }
int rmdir(const char *path) { char b[PATH_MAX]; return (int)syscall(__NR_unlinkat, AT_FDCWD, tr(path, b, sizeof b), AT_REMOVEDIR); }
int rename(const char *oldp, const char *newp) { char a[PATH_MAX], b[PATH_MAX]; return (int)syscall(__NR_renameat, AT_FDCWD, tr(oldp, a, sizeof a), AT_FDCWD, tr(newp, b, sizeof b)); }
int renameat(int od, const char *oldp, int nd, const char *newp) { char a[PATH_MAX], b[PATH_MAX]; return (int)syscall(__NR_renameat, od, tr(oldp, a, sizeof a), nd, tr(newp, b, sizeof b)); }
int link(const char *oldp, const char *newp) { char a[PATH_MAX], b[PATH_MAX]; return (int)syscall(__NR_linkat, AT_FDCWD, tr(oldp, a, sizeof a), AT_FDCWD, tr(newp, b, sizeof b), 0); }
int symlink(const char *t, const char *l) { char b[PATH_MAX]; return (int)syscall(__NR_symlinkat, t, AT_FDCWD, tr(l, b, sizeof b)); }
int symlinkat(const char *t, int dirfd, const char *l) { char b[PATH_MAX]; return (int)syscall(__NR_symlinkat, t, dirfd, tr(l, b, sizeof b)); }
ssize_t readlink(const char *path, char *buf, size_t n) { char b[PATH_MAX]; return syscall(__NR_readlinkat, AT_FDCWD, tr(path, b, sizeof b), buf, n); }
ssize_t readlinkat(int dirfd, const char *path, char *buf, size_t n) { char b[PATH_MAX]; return syscall(__NR_readlinkat, dirfd, tr(path, b, sizeof b), buf, n); }
int chmod(const char *path, mode_t mode) { char b[PATH_MAX]; return (int)syscall(__NR_fchmodat, AT_FDCWD, tr(path, b, sizeof b), mode, 0); }
int fchmodat(int dirfd, const char *path, mode_t mode, int flags) { char b[PATH_MAX]; return (int)syscall(__NR_fchmodat, dirfd, tr(path, b, sizeof b), mode, flags); }
int truncate(const char *path, off_t len) { char b[PATH_MAX]; return (int)syscall(__NR_truncate, tr(path, b, sizeof b), len); }
int chdir(const char *path) { char b[PATH_MAX]; return (int)syscall(__NR_chdir, tr(path, b, sizeof b)); }
int utimensat(int dirfd, const char *path, const struct timespec ts[2], int flags) { char b[PATH_MAX]; return (int)syscall(__NR_utimensat, dirfd, tr(path, b, sizeof b), ts, flags); }
int execve(const char *path, char *const argv[], char *const envp[]) { char b[PATH_MAX]; return (int)syscall(__NR_execveat, AT_FDCWD, tr(path, b, sizeof b), argv, envp, 0); }

int statfs(const char *path, struct statfs *out) { char b[PATH_MAX]; return (int)syscall(__NR_statfs, tr(path, b, sizeof b), out); }

// getcwd 必须把真实路径映射回命名空间路径，否则 Node 的 realpath/cwd 逻辑会露出真实前缀。
char *getcwd(char *buf, size_t size) {
    init_once();
    char tmp[PATH_MAX];
    long rc = syscall(__NR_getcwd, tmp, sizeof tmp);
    if (rc <= 0) return 0;
    const char *out = tmp;
    if (g_root != 0 && under(tmp, g_root)) out = tmp + strlen(g_root);
    if (out[0] == 0) out = "/";
    size_t n = strlen(out);
    if (buf == 0) return strdup(out);
    if (size <= n) { errno = ERANGE; return 0; }
    memcpy(buf, out, n + 1);
    return buf;
}
