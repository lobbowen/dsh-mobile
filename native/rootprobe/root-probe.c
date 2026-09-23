// 容器根可行性探针：app 能否自建 user+mount namespace 并 pivot_root/chroot。
// 决定「突破环境」走内核级真根（A）还是用户态路径命名空间（B）。见 docs/ADR-001。
// 只读探针：所有动作都在本进程自己的 namespace 内，进程退出即消失。
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static void say(const char *key, int rc) {
    if (rc == 0) printf("%s:ok\n", key);
    else printf("%s:fail errno=%d(%s)\n", key, errno, strerror(errno));
    fflush(stdout);
}

static int write_all(const char *path, const char *value) {
    int fd = open(path, O_WRONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    size_t n = strlen(value);
    ssize_t w = write(fd, value, n);
    close(fd);
    return w == (ssize_t)n ? 0 : -1;
}

int main(void) {
    char buf[64];
    printf("uid=%d gid=%d\n", getuid(), getgid());
    fflush(stdout);

    errno = 0;
    int rc = unshare(CLONE_NEWUSER);
    say("USERNS", rc);
    if (rc != 0) { printf("SUMMARY:userns-blocked\n"); return 0; }

    snprintf(buf, sizeof buf, "0 %d 1\n", getuid());
    say("UID_MAP", write_all("/proc/self/uid_map", buf));
    say("SETGROUPS", write_all("/proc/self/setgroups", "deny\n"));
    snprintf(buf, sizeof buf, "0 %d 1\n", getgid());
    say("GID_MAP", write_all("/proc/self/gid_map", buf));

    errno = 0;
    rc = unshare(CLONE_NEWNS);
    say("MOUNTNS", rc);
    if (rc != 0) { printf("SUMMARY:userns-only\n"); return 0; }

    errno = 0;
    say("MS_PRIVATE", mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL));

    const char *base = getenv("TMPDIR");
    if (base == NULL || base[0] == 0) base = "/data/local/tmp";
    char dir[512], sub[600];
    snprintf(dir, sizeof dir, "%s/.rootprobe", base);
    snprintf(sub, sizeof sub, "%s/old", dir);
    mkdir(dir, 0700);
    mkdir(sub, 0700);

    errno = 0;
    rc = mount(dir, dir, NULL, MS_BIND | MS_REC, NULL);
    say("BIND_SELF", rc);
    if (rc == 0) {
        errno = 0;
        say("PIVOT_ROOT", (int)syscall(__NR_pivot_root, dir, sub));
    }
    errno = 0;
    say("CHROOT", chroot(dir));
    printf("SUMMARY:full\n");
    return 0;
}
