// ═══════════════════════════════════════════════════════════════════════════
// D1：shebang 与标准路径面的兑现（termux-exec 同族）。
//
// 问题（本仓实证）：安卓没有 /usr/bin/env、没有 /usr/bin/<x>、没有 /bin/sh。
//   而生态里大量程序按这些**绝对路径**写 shebang —— npm 生成的 bin shim 是
//   `#!/usr/bin/env node`，pip 的 console script 同理，我们自己的脚本也这么写。
//   后果：execve 一个这样的脚本 → 内核 exec 解释器时 ENOENT → 调用方以为「脚本不存在」。
//   我们此前的补法是**给每个工具手写一层 `#!/system/bin/sh` 包装**（kernel/src/supply/materialize.js）——
//   那才是「中间多了一层」；根因是**约定缺了**，不是需要适配层。
//
// 本件把缺的约定补回来：execve 家族在交给内核之前，先按**调用方的 PATH** 把
//   shebang 解释器与标准绝对路径解析到真实位置（PATH 首位已是 $PREFIX/bin，由容器单点装配）。
//   补回之后：npm/pip 的原生 shim、`#!/usr/bin/env X`、`#!/bin/sh`、`#!/usr/bin/X` 全部按原样工作。
//
// 为什么用 PATH 而不是读 $PREFIX：
//   · PREFIX 类环境变量会被 DSH 起子进程时剥掉（真机定罪），不能当判据；
//   · 而「按 PATH 找命令」正是 Unix 的既有语义，容器已把 $PREFIX/bin 放在 PATH 首位。
//   ⇒ 本件不持有任何路径常量，只兑现语义。
//
// 实现纪律（与 tmp-paths.c 同）：先 dlsym(RTLD_NEXT) 拿真实实现；拿不到即 ENOSYS ——
//   垫片坏了绝不改变语义。**解析不出来就原样放行**，让内核给出它本来会给的错误。
//
// 覆盖范围与已知边界：
//   · 拦截：execve / execv / execvp / execl / execlp / execle（含 PATH 查找与 shebang 重写）。
//   · **不拦 posix_spawn / execvpe**：本库按 aarch64-linux-android21 编译，API 21 的头文件里
//     没有它们的声明（bionic 是后来才加的）。要覆盖它们需抬高目标 API，属独立决定 ——
//     这条限制写在这里，不留暗账。（Node/libuv 与 CPython 的子进程路径走 execvp/execve，已覆盖。）
//   · fexecve/execveat 放行（拿 fd 不好判 shebang，且我们的消费者不用）。
// ═══════════════════════════════════════════════════════════════════════════

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

static int (*real_execve)(const char *, char *const[], char *const[]);
static int (*real_access)(const char *, int);

static void bind_real(void) {
  if (!real_execve) real_execve = (int (*)(const char *, char *const[], char *const[]))dlsym(RTLD_NEXT, "execve");
  if (!real_access) real_access = (int (*)(const char *, int))dlsym(RTLD_NEXT, "access");
}

static int x_ok(const char *p) {
  if (real_access) return real_access(p, X_OK) == 0;
  return access(p, X_OK) == 0;
}

/** 是否是我们必须兑现的标准绝对路径（/usr/bin/x、/bin/x）。 */
static int is_std_abs(const char *p) {
  if (!p) return 0;
  return strncmp(p, "/usr/bin/", 9) == 0 || strncmp(p, "/bin/", 5) == 0;
}

static const char *base_name(const char *p) {
  const char *s = strrchr(p, '/');
  return s ? s + 1 : p;
}

/** 在调用方 PATH 里找一个可执行文件。找到写进 out，返回 1。 */
static int which_in_path(const char *name, char *out, size_t n) {
  const char *path; const char *p;
  if (!name || !*name || strchr(name, '/')) return 0;
  path = getenv("PATH");
  if (!path || !*path) return 0;
  p = path;
  while (*p) {
    const char *e = strchr(p, ':');
    size_t len = e ? (size_t)(e - p) : strlen(p);
    size_t nl = strlen(name);
    if (len > 0 && len + 1 + nl + 1 <= n) {
      memcpy(out, p, len);
      out[len] = '/';
      memcpy(out + len + 1, name, nl + 1);
      if (x_ok(out)) return 1;
    }
    if (!e) break;
    p = e + 1;
  }
  return 0;
}

/** 解析解释器名：优先同名，`sh` 退到 bash（本容器的 sh 由 bash 兼任，argv[0] 仍叫 sh 即 POSIX 模式）。 */
static int resolve_interp(const char *bn, char *out, size_t n) {
  if (which_in_path(bn, out, n)) return 1;
  if (strcmp(bn, "sh") == 0 && which_in_path("bash", out, n)) return 1;
  return 0;
}

/**
 * 读文件头并解析 shebang。
 * @return 1 = 有 shebang 且至少析出解释器；0 = 没有/读不了/格式不认识（一律放行）
 */
static int parse_shebang(const char *file, char *buf, size_t n, char *tok[], int max, int *ntok) {
  int fd; ssize_t got; size_t i = 0; char *nl; char *s; int k = 0;
  fd = open(file, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  got = read(fd, buf, n - 1);
  close(fd);
  if (got < 4) return 0;
  buf[got] = 0;
  if (buf[0] != '#' || buf[1] != '!') return 0;
  nl = strchr(buf, '\n');
  if (!nl) return 0;
  *nl = 0;
  s = buf + 2;
  while (*s && k < max) {
    while (*s == ' ' || *s == '\t') s++;
    if (!*s) break;
    tok[k++] = s;
    while (*s && *s != ' ' && *s != '\t') s++;
    if (*s) { *s = 0; s++; }
  }
  *ntok = k;
  return k >= 1;
}

/** 以（可能被重写过的）解释器 + 新 argv 执行；失败原样返回真实 errno。 */
static int exec_with(const char *path, char *const argv[], char *const envp[], const char *disp0, char *shebangArgs[], int nShebang) {
  size_t extra = (size_t)nShebang, argc = 1 + extra + 1, i, k = 0;
  char **nargv;
  if (argv) for (i = 1; argv[i]; i++) argc++;
  nargv = (char **)malloc((argc + 1) * sizeof(char *));
  if (!nargv) { errno = ENOMEM; return -1; }
  nargv[k++] = (char *)disp0;
  for (i = 0; i < extra; i++) nargv[k++] = shebangArgs[i];
  nargv[k++] = (char *)path;
  if (argv) for (i = 1; argv[i]; i++) nargv[k++] = argv[i];
  nargv[k] = NULL;
  real_execve(path, nargv, envp);
  { int e = errno; free(nargv); errno = e; return -1; }
}

int execve(const char *path, char *const argv[], char *const envp[]) {
  char buf[512]; char *tok[8]; int ntok = 0;
  char resolved[1024];
  bind_real();
  if (!real_execve) { errno = ENOSYS; return -1; }
  if (!path) { errno = ENOENT; return -1; }

  // ① 脚本 + shebang：内核会按 shebang 里的**绝对路径**找解释器；这里先替它解析。
  if (parse_shebang(path, buf, sizeof buf, tok, 8, &ntok)) {
    const char *interp = tok[0];
    const char *disp0 = base_name(interp);
    int cmd = 1;
    int envStyle = strcmp(disp0, "env") == 0;
    if (envStyle) {
      // env 形态：跳过 -S/-i/-u 与 VAR=VAL，第一个剩下的才是命令。
      while (cmd < ntok) {
        const char *t = tok[cmd];
        if (strchr(t, '=') || strcmp(t, "-S") == 0 || strcmp(t, "-i") == 0 || strcmp(t, "-u") == 0) { cmd++; continue; }
        break;
      }
      if (cmd >= ntok) return real_execve(path, argv, envp);
      interp = tok[cmd];
      disp0 = base_name(interp);
      cmd++;
    }
    if (envStyle || is_std_abs(interp)) {
      if (resolve_interp(disp0, resolved, sizeof resolved)) {
        return exec_with(resolved, argv, envp, disp0, &tok[cmd], ntok - cmd);
      }
    }
    // 解析不出来 → 原样交给内核（它会给出它本来会给的错）。
    return real_execve(path, argv, envp);
  }

  // ② 直接以标准绝对路径调程序（/usr/bin/X、/bin/X，含 /bin/sh）。
  if (is_std_abs(path)) {
    const char *bn = base_name(path);
    if (resolve_interp(bn, resolved, sizeof resolved)) return real_execve(resolved, argv, envp);
  }
  return real_execve(path, argv, envp);
}

int execv(const char *path, char *const argv[]) { return execve(path, argv, environ); }

int execvp(const char *file, char *const argv[]) {
  char resolved[1024];
  bind_real();
  if (!real_execve) { errno = ENOSYS; return -1; }
  if (!file) { errno = ENOENT; return -1; }
  if (strchr(file, '/')) return execve(file, argv, environ);
  if (which_in_path(file, resolved, sizeof resolved)) return execve(resolved, argv, environ);
  // PATH 里没有：走真实 execvp，让 errno 与标准一致。
  {
    int (*real_execvp)(const char *, char *const[]) = (int (*)(const char *, char *const[]))dlsym(RTLD_NEXT, "execvp");
    if (real_execvp) return real_execvp(file, argv);
  }
  return execve(file, argv, environ);
}

static int exec_varargs(const char *path, const char *arg0, va_list ap, int usePath) {
  const char *args[256]; int n = 0;
  args[n++] = arg0;
  while (n < 255) { const char *a = va_arg(ap, const char *); if (!a) break; args[n++] = a; }
  args[n] = NULL;
  return usePath ? execvp(path, (char *const *)args) : execve(path, (char *const *)args, environ);
}

int execl(const char *path, const char *arg0, ...) {
  va_list ap; int r;
  va_start(ap, arg0); r = exec_varargs(path, arg0, ap, 0); va_end(ap);
  return r;
}

int execlp(const char *file, const char *arg0, ...) {
  va_list ap; int r;
  va_start(ap, arg0); r = exec_varargs(file, arg0, ap, 1); va_end(ap);
  return r;
}

int execle(const char *path, const char *arg0, ...) {
  va_list ap; const char *args[256]; int n = 0; char *const *envp; int r;
  va_start(ap, arg0);
  args[n++] = arg0;
  while (n < 255) { const char *a = va_arg(ap, const char *); if (!a) break; args[n++] = a; }
  args[n] = NULL;
  envp = va_arg(ap, char *const *);
  r = execve(path, (char *const *)args, envp ? envp : environ);
  va_end(ap);
  return r;
}
