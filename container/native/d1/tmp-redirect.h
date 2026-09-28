#ifndef LOBOS_TMP_REDIRECT_H
#define LOBOS_TMP_REDIRECT_H

// D1：/tmp 语义兑现的**唯一实现** —— open-fallback.c（open/openat）与
// tmp-paths.c（mkdir/stat/unlink/rename/… 整张路径 syscall 面）共用这一份。
//
// 安卓根文件系统只读、SELinux 也不给 app 在 / 下建目录，Linux 习惯的硬编码 /tmp
// 必然失败。这里把 /tmp 前缀重写到 $TMPDIR —— 只改前缀、只动 /tmp（/tmpfoo 不动），
// 其余路径与语义一律不变。
//
// 生效条件：TMPDIR 为**绝对路径**即生效（默认开）。曾用一个临时开关，
// 但 Program 子进程清理会剥掉临时环境键（真机定罪），开关到不了干活进程，故去掉。
//
// 判据（设备端探针 tmp-redirect）：/tmp 下的 open + mkdir + stat + unlink
// 全部落到 $TMPDIR，缺一片即红。
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <limits.h>
#include <stdlib.h>
#include <string.h>

static inline const char *dsh_tmp_redirect(const char *path, char *buf, size_t bufsz) {
    if (path == 0 || path[0] != '/') return path;
    if (strncmp(path, "/tmp", 4) != 0) return path;
    if (path[4] != '/' && path[4] != '\0') return path; /* 排除 /tmpfoo */
    const char *tmp = getenv("TMPDIR");
    if (tmp == 0 || tmp[0] != '/') return path;
    size_t tl = strlen(tmp);
    while (tl > 1 && tmp[tl - 1] == '/') tl--;
    size_t rest = strlen(path + 4);
    if (tl + rest >= bufsz) return path;
    memcpy(buf, tmp, tl);
    memcpy(buf + tl, path + 4, rest + 1);
    return buf;
}
#endif
