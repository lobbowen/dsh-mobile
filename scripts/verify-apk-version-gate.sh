#!/usr/bin/env bash
#
# 壳 APK 版本门禁 —— 判据的唯一实现（四个发布调用点共用，见 VERSION-GATE 调用点）。
#
# 为什么判据不许写在 workflow 里：写滚动通道的有四条链路（fast-apk / build-apk /
# release-admin 的 publish 与 repack）。2026-09-26 盘点时只有 fast-apk 那份比较过版本号，
# 其余三个都是「拿到 APK 就覆盖 latest」—— 从旧 run 发一次就能把已升级设备永久锁死
# （versionCode 回退不可逆，只能卸载重装）。写四份必然漂移，收进这一份。
#
# 参照物的**名字**是必填参数（第 4 格），不是写死在这里的一句漂亮话：2026-09-30 定罪（债表 DS-14）查出日常链
#   把参照物写成 apk-latest，而那条通道它自己从不写（滚动别名只由发布面维护）⇒ 这道门从没比过
#   任何数。那时「apk-latest 上没有清单」这句红点读起来像通道坏了，实际是参照物选错了 ——
#   红点必须说清真要比的是谁，否则下次换参照物还是会红在无关的地方。
#
# 为什么同版本重发要分通道：同号换字节 = 用户手里的下载地址指向的东西变了，而版本号没说谎
# 的能力没有了 —— 实证过一次：改 Kotlin 注释合并后 main push 自动重出，1.1.5(7) 的字节
# 在原地被换掉。显式通道（fast-* tag / dispatch / 从旧 run 发布）保留同版本重发，因为
# 「投递本身坏了要重传」是这个通道正当的用途；自动通道必须 bump，否则等于把
# 「改了 app 没 bump 版本」这件事静默咽掉。
#
# 用法: bash scripts/verify-apk-version-gate.sh <本次 version.json> <已发布 version.json 或 '-'> <auto|explicit> <参照物名>
#   '-'        = 调用方已确认该参照物上确实没有版本读数（首次发布），不是「取失败了」
#   <参照物名> = 调用方实际拿谁当线上读数（apk-latest / 某个 release tag / archive）
# 退出: 0 放行 / 1 判红（不许发布）/ 2 无从校验（同样不许发布，宁可发不出去）
set -euo pipefail

NEW="${1:-}"
OLD="${2:-}"
CHANNEL="${3:-}"
REF="${4:-}"

die() { echo "::error title=版本门禁::$*" >&2; exit 1; }
usage() { echo "[error] 用法: $0 <本次 version.json> <已发布 version.json|-> <auto|explicit> <参照物名>" >&2; exit 2; }

[ -n "$NEW" ] || usage
[ -n "$REF" ] || usage
case "$CHANNEL" in auto|explicit) ;; *) usage ;; esac
if [ "$NEW" != "-" ] && [ ! -f "$NEW" ]; then
  echo "[error] 读不到本次 version.json：$NEW —— 产物自己的版本号都确定不了，不得发布。" >&2
  exit 2
fi

# 版本号取数只用一种写法（node -p）：与发布步骤取 VN/VC 的那句同源，避免两侧解析不一致。
# 必须 path.resolve：require() 拿到不带 ./ 的字符串会当**模块名**去 node_modules 里找
# （实证：node -p "require(process.argv[1])" version.json → MODULE_NOT_FOUND），
# 而调用方传的正是仓库根的相对名。
read_vc() {
  node -p "Number(require(require('node:path').resolve(process.argv[1])).shell.versionCode)" "$1" 2>/dev/null || true
}

VC_RAW="$(read_vc "$NEW")"
case "$VC_RAW" in
  ''|*[!0-9]*) echo "[error] 本次 version.json 的 shell.versionCode 不是整数（读到: ${VC_RAW:-空}）。" >&2; exit 2 ;;
esac
VC="$VC_RAW"

if [ "$OLD" = "-" ]; then
  if [ "$CHANNEL" = auto ]; then
    # 参照物上没有版本读数 = 线上状态丢了。自动发布此时照发，就把「不知道线上是什么版本」
    # 伪装成了「线上就是这一版」。红在这里是对的：先把读数补回去（显式通道发一次），再走自动链。
    die "参照物 $REF 上没有版本读数，自动通道不得在线上版本未知的情况下发布。确认首次发布请走 fast-* tag。"
  fi
  echo "[version] 参照物 $REF 无版本读数（首次发布或读数丢失），显式通道放行：本次 versionCode=$VC"
  exit 0
fi

if [ ! -f "$OLD" ]; then
  echo "[error] 传入了已发布清单路径却读不到：$OLD" >&2
  exit 2
fi
PVC_RAW="$(read_vc "$OLD")"
case "$PVC_RAW" in
  ''|*[!0-9]*) echo "[error] 已发布 version.json 的 shell.versionCode 不是整数（读到: ${PVC_RAW:-空}）。线上清单坏了，先修清单再发。" >&2; exit 2 ;;
esac
PVC="$PVC_RAW"

echo "[version] 参照物=$REF 已发布 versionCode=$PVC，本次=$VC，通道=$CHANNEL"
if [ "$VC" -lt "$PVC" ]; then
  die "versionCode 回退（$PVC → $VC）：已升级的设备将永远收不到新版本，且不可逆。本次拒绝发布（两种通道都拦）。"
fi
if [ "$VC" -eq "$PVC" ]; then
  if [ "$CHANNEL" = auto ]; then
    die "同版本重发（versionCode=$VC）在自动通道被拒：这次改动动了 APK 内容却没 bump version.json 的 shell.versionCode。请 bump（见 docs/runbook/release.md §2），确认要原地重传则推 fast-* tag。"
  fi
  echo "[version] 同版本重发（versionCode=$VC，显式通道允许：用于修复投递/重传）"
  exit 0
fi
echo "[version] 版本前进（$PVC → $VC）"
