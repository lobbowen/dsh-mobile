/* libdshptyprobe —— 安卓真机 PTY 能力探针（纯 C，静态，无 NAPI）。
 *
 * 目的（一次 exec 回答 node-pty 移植的路线问题）：
 * untrusted_app 域能否走通 openpt 链 —— open("/dev/ptmx") → grantpt →
 * unlockpt → ptsname → 打开从端 → ioctl 握手。Termux 历史上用 pipe 假 PTY，
 * 依据正是 SELinux 对 /dev/ptmx（device:ptmx_device）的访问因 ROM/版本而异；
 * 本设备（Android 17）到底允许哪一步，只有实测数据能定夺。
 * 每步单独打印 OK/errno，绝不 fail-fast —— 部分许可（如 master 可开、
 * slave 不可开）同样是决策信息。
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

static void step(const char *name, int ok, int code) {
  if (ok)
    printf("%s:OK\n", name);
  else
    printf("%s:FAIL:%s(%d)\n", name, strerror(code), code);
  fflush(stdout);
}

int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);

  int mfd = open("/dev/ptmx", O_RDWR | O_NOCTTY);
  step("PTMX_OPEN", mfd >= 0, errno);
  if (mfd < 0) {
    printf("SUMMARY:master-open-denied\n");
    return 0;
  }

  int rc = grantpt(mfd);
  step("GRANTPT", rc == 0, errno);

  rc = unlockpt(mfd);
  step("UNLOCKPT", rc == 0, errno);

  char *sn = ptsname(mfd);
  step("PTSNAME", sn != NULL, errno);
  if (sn == NULL) {
    close(mfd);
    printf("SUMMARY:ptsname-denied\n");
    return 0;
  }
  printf("PTSNAME:PATH:%s\n", sn);

  int sfd = open(sn, O_RDWR | O_NOCTTY);
  step("SLAVE_OPEN", sfd >= 0, errno);

  if (sfd >= 0) {
    struct termios t;
    step("TCGETA", tcgetattr(sfd, &t) == 0, errno);
    int room = 0;
    step("TIOCINQ", ioctl(sfd, FIONREAD, &room) == 0, errno);
    close(sfd);
  }
  close(mfd);

  printf("SUMMARY:%s\n", (sfd >= 0) ? "full-pty-usable" : "partial-see-steps");
  return 0;
}
