/* 动态 bionic 的 libc.so 不再导出这几个符号（静态 libc.a 里还有），而 bash 引用它们。
 * 我们要 bash **动态**（否则 liblobosposix 的 LD_PRELOAD 语义层对它失效，见
 * scripts/build-native-capabilities.sh 的判据），就必须自己补上：
 *   · mblen —— 按 C.UTF-8 语义用 mbrlen 等价实现（bionic 导出 mbrlen）；
 *   · setgrent/getgrent/endgrent —— Android 没有 NSS 组库枚举，给空实现；
 *     载荷只跑非交互 `bash -c`，`compgen -u` 这类用户/组补全路径用不到。
 *
 * 首轮 CI 事实（动态化后立刻暴露）：
 *   ld.lld: error: undefined symbol: mblen / setgrent / getgrent / endgrent
 */
#include <grp.h>
#include <stddef.h>
#include <wchar.h>

int mblen(const char *s, size_t n) {
    if (s == 0) return 0;              /* 无状态编码（C / C.UTF-8）*/
    if (n == 0) return -1;
    size_t r = mbrlen(s, n, 0);
    if (r == (size_t)-1 || r == (size_t)-2) return -1;
    return (int)r;
}
void setgrent(void) {}
struct group *getgrent(void) { return 0; }
void endgrent(void) {}
