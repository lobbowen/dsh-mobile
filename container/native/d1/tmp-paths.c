// D1：/tmp 语义兑现的**路径 syscall 面**（open/openat 由 open-fallback.c 负责）。
//
// 为什么需要：liblobosposix 经 LD_PRELOAD 落地 Linux 语义，而 shell 工具用的是
// mkdir/stat/unlink/rename… 这一整片路径 syscall，不只 open。缺一片，/tmp 就只通一半
// （真机定罪 2026-09-27：动态 bash 下 `> /tmp/x` 通了，而 `mkdir /tmp/d`、
// `[ -e /tmp/x ]`、`rm /tmp/x` 全失败）。
//
// 实现纪律：每个拦截器先按 tmp-redirect.h 重写 /tmp 前缀，再委派 dlsym(RTLD_NEXT)
// 拿到的真实实现；dlsym 失败即报 ENOSYS（垫片坏了绝不改变语义）。
#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include "tmp-redirect.h"

#define DSHR(path, buf) dsh_tmp_redirect((path), (buf), sizeof(buf))

int mkdir(const char *path, mode_t mode) {
    static int (*real)(const char *, mode_t);
    if (!real) real = (int (*)(const char *, mode_t))dlsym(RTLD_NEXT, "mkdir");
    char rb[PATH_MAX];
    if (!real) { errno = ENOSYS; return -1; }
    return real(DSHR(path, rb), mode);
}
int mkdirat(int dirfd, const char *path, mode_t mode) {
    static int (*real)(int, const char *, mode_t);
    if (!real) real = (int (*)(int, const char *, mode_t))dlsym(RTLD_NEXT, "mkdirat");
    char rb[PATH_MAX];
    if (!real) { errno = ENOSYS; return -1; }
    return real(dirfd, DSHR(path, rb), mode);
}
int rmdir(const char *path) {
    static int (*real)(const char *);
    if (!real) real = (int (*)(const char *))dlsym(RTLD_NEXT, "rmdir");
    char rb[PATH_MAX];
    if (!real) { errno = ENOSYS; return -1; }
    return real(DSHR(path, rb));
}
int unlink(const char *path) {
    static int (*real)(const char *);
    if (!real) real = (int (*)(const char *))dlsym(RTLD_NEXT, "unlink");
    char rb[PATH_MAX];
    if (!real) { errno = ENOSYS; return -1; }
    return real(DSHR(path, rb));
}
int unlinkat(int dirfd, const char *path, int flags) {
    static int (*real)(int, const char *, int);
    if (!real) real = (int (*)(int, const char *, int))dlsym(RTLD_NEXT, "unlinkat");
    char rb[PATH_MAX];
    if (!real) { errno = ENOSYS; return -1; }
    return real(dirfd, DSHR(path, rb), flags);
}
int rename(const char *oldp, const char *newp) {
    static int (*real)(const char *, const char *);
    if (!real) real = (int (*)(const char *, const char *))dlsym(RTLD_NEXT, "rename");
    char rb1[PATH_MAX], rb2[PATH_MAX];
    if (!real) { errno = ENOSYS; return -1; }
    return real(DSHR(oldp, rb1), DSHR(newp, rb2));
}
int renameat(int oldfd, const char *oldp, int newfd, const char *newp) {
    static int (*real)(int, const char *, int, const char *);
    if (!real) real = (int (*)(int, const char *, int, const char *))dlsym(RTLD_NEXT, "renameat");
    char rb1[PATH_MAX], rb2[PATH_MAX];
    if (!real) { errno = ENOSYS; return -1; }
    return real(oldfd, DSHR(oldp, rb1), newfd, DSHR(newp, rb2));
}
int stat(const char *path, struct stat *st) {
    static int (*real)(const char *, struct stat *);
    if (!real) real = (int (*)(const char *, struct stat *))dlsym(RTLD_NEXT, "stat");
    char rb[PATH_MAX];
    if (!real) { errno = ENOSYS; return -1; }
    return real(DSHR(path, rb), st);
}
int lstat(const char *path, struct stat *st) {
    static int (*real)(const char *, struct stat *);
    if (!real) real = (int (*)(const char *, struct stat *))dlsym(RTLD_NEXT, "lstat");
    char rb[PATH_MAX];
    if (!real) { errno = ENOSYS; return -1; }
    return real(DSHR(path, rb), st);
}
int fstatat(int dirfd, const char *path, struct stat *st, int flags) {
    static int (*real)(int, const char *, struct stat *, int);
    if (!real) real = (int (*)(int, const char *, struct stat *, int))dlsym(RTLD_NEXT, "fstatat");
    char rb[PATH_MAX];
    if (!real) { errno = ENOSYS; return -1; }
    return real(dirfd, DSHR(path, rb), st, flags);
}
int access(const char *path, int mode) {
    static int (*real)(const char *, int);
    if (!real) real = (int (*)(const char *, int))dlsym(RTLD_NEXT, "access");
    char rb[PATH_MAX];
    if (!real) { errno = ENOSYS; return -1; }
    return real(DSHR(path, rb), mode);
}
int faccessat(int dirfd, const char *path, int mode, int flags) {
    static int (*real)(int, const char *, int, int);
    if (!real) real = (int (*)(int, const char *, int, int))dlsym(RTLD_NEXT, "faccessat");
    char rb[PATH_MAX];
    if (!real) { errno = ENOSYS; return -1; }
    return real(dirfd, DSHR(path, rb), mode, flags);
}
int chmod(const char *path, mode_t mode) {
    static int (*real)(const char *, mode_t);
    if (!real) real = (int (*)(const char *, mode_t))dlsym(RTLD_NEXT, "chmod");
    char rb[PATH_MAX];
    if (!real) { errno = ENOSYS; return -1; }
    return real(DSHR(path, rb), mode);
}
int fchmodat(int dirfd, const char *path, mode_t mode, int flags) {
    static int (*real)(int, const char *, mode_t, int);
    if (!real) real = (int (*)(int, const char *, mode_t, int))dlsym(RTLD_NEXT, "fchmodat");
    char rb[PATH_MAX];
    if (!real) { errno = ENOSYS; return -1; }
    return real(dirfd, DSHR(path, rb), mode, flags);
}
ssize_t readlink(const char *path, char *buf, size_t n) {
    static ssize_t (*real)(const char *, char *, size_t);
    if (!real) real = (ssize_t (*)(const char *, char *, size_t))dlsym(RTLD_NEXT, "readlink");
    char rb[PATH_MAX];
    if (!real) { errno = ENOSYS; return -1; }
    return real(DSHR(path, rb), buf, n);
}
ssize_t readlinkat(int dirfd, const char *path, char *buf, size_t n) {
    static ssize_t (*real)(int, const char *, char *, size_t);
    if (!real) real = (ssize_t (*)(int, const char *, char *, size_t))dlsym(RTLD_NEXT, "readlinkat");
    char rb[PATH_MAX];
    if (!real) { errno = ENOSYS; return -1; }
    return real(dirfd, DSHR(path, rb), buf, n);
}
int utimensat(int dirfd, const char *path, const struct timespec times[2], int flags) {
    static int (*real)(int, const char *, const struct timespec *, int);
    if (!real) real = (int (*)(int, const char *, const struct timespec *, int))dlsym(RTLD_NEXT, "utimensat");
    char rb[PATH_MAX];
    if (!real) { errno = ENOSYS; return -1; }
    return real(dirfd, DSHR(path, rb), times, flags);
}
int truncate(const char *path, off_t len) {
    static int (*real)(const char *, off_t);
    if (!real) real = (int (*)(const char *, off_t))dlsym(RTLD_NEXT, "truncate");
    char rb[PATH_MAX];
    if (!real) { errno = ENOSYS; return -1; }
    return real(DSHR(path, rb), len);
}
DIR *opendir(const char *path) {
    static DIR *(*real)(const char *);
    if (!real) real = (DIR *(*)(const char *))dlsym(RTLD_NEXT, "opendir");
    char rb[PATH_MAX];
    if (!real) { errno = ENOSYS; return 0; }
    return real(DSHR(path, rb));
}
