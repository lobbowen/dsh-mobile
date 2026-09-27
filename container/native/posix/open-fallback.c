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

// D1：/tmp 语义兑现。安卓根文件系统只读、SELinux 也不给 app 在 / 下建目录，
// 硬编码 /tmp 的脚本（Linux 习惯）必然失败。这里在 open/openat 上把 /tmp 前缀
// 重写到 $TMPDIR —— 只改前缀、只动 /tmp，其余路径与语义一律不变。
// 开关：DSH_TMP_REDIRECT=1 时生效（缺省不生效）；TMPDIR 缺失/非绝对路径时不生效。
// 判据（设备端探针 tmp-redirect）：写 "/tmp/<name>" 后能在 $TMPDIR/<name> 读回。
static const char *tmp_redirect(const char *path, char *buf, size_t bufsz) {
    if (path == 0 || path[0] != '/') return path;
    /* 默认生效：开关曾用 DSH_TMP_REDIRECT，但 DSH 起子进程时会剥掉 DSH_*（真机定罪），
       靠开关 = 靠不住。这里只在 TMPDIR 缺失/非绝对时放行原路径。 */
    if (strncmp(path, "/tmp", 4) != 0) return path;
    if (path[4] != '/' && path[4] != '\0') return path; /* 排除 /tmpfoo */
    const char *tmp = getenv("TMPDIR");
    if (tmp == 0 || tmp[0] != '/') return path;
    size_t tl = strlen(tmp);
    while (tl > 1 && tmp[tl - 1] == '/') tl--;
    size_t rest = strlen(path + 4); /* "/..." 或 "" */
    if (tl + rest >= bufsz) return path;
    memcpy(buf, tmp, tl);
    memcpy(buf + tl, path + 4, rest + 1);
    return buf;
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
    char rb[PATH_MAX];
    const char *p = tmp_redirect(path, rb, sizeof rb);
    int fd = raw_openat(AT_FDCWD, p, flags, mode);
    if (fd >= 0 || errno != EACCES) return fd;
    return substitute_dir_fd(p);
}

int openat(int dirfd, const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    char rb[PATH_MAX];
    const char *p = tmp_redirect(path, rb, sizeof rb);
    int fd = raw_openat(dirfd, p, flags, mode);
    if (fd >= 0 || errno != EACCES) return fd;
    if (dirfd == AT_FDCWD) return substitute_dir_fd(p);
    return fd;
}
