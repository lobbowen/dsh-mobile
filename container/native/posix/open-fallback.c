// Android 上 /data/user/0、/data、/ 等祖先目录对 app 均不可读（root 所有），
// 而 DSH 的 durable-home 会把祖先逐级 fsync 到文件系统根：open 目录即 EACCES，
// 附件保存（含 read_image）整条失败。这里在 open/openat 因权限失败、且目标确为
// $HOME 的祖先目录时，返回 $HOME 的只读目录句柄，让调用方的 fsync 正常完成——
// 不可读祖先的持久性本就不由 app 负责。见 docs/ADR-001。
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static int raw_openat(int dirfd, const char *path, int flags, mode_t mode) {
    return (int)syscall(__NR_openat, dirfd, path, flags, mode);
}

// 仅在 path 是 $HOME 的祖先（含 "/"）且本身确为目录时替换，避免影响其它 EACCES。
static int substitute_dir_fd(const char *path) {
    if (path == 0 || path[0] != '/') return -1;
    const char *home = getenv("HOME");
    if (home == 0 || home[0] != '/') return -1;
    size_t n = strlen(path);
    if (strcmp(path, "/") != 0) {
        if (strncmp(home, path, n) != 0 || home[n] != '/') return -1;
    }
    struct stat st;
    if (syscall(__NR_newfstatat, AT_FDCWD, path, &st, 0) != 0) return -1;
    if (!S_ISDIR(st.st_mode)) return -1;
    int saved = errno;
    int fd = raw_openat(AT_FDCWD, home, O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0);
    if (fd < 0) { errno = saved; return -1; }
    return fd;
}

int open(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    int fd = raw_openat(AT_FDCWD, path, flags, mode);
    if (fd >= 0 || errno != EACCES) return fd;
    return substitute_dir_fd(path);
}

int openat(int dirfd, const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    int fd = raw_openat(dirfd, path, flags, mode);
    if (fd >= 0 || errno != EACCES) return fd;
    if (dirfd == AT_FDCWD) return substitute_dir_fd(path);
    return fd;
}
