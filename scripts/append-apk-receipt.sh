#!/usr/bin/env bash
#
# 往「APK 发布回执账本」追加一条已发布读数 —— 版本门禁第二只眼睛的**唯一写入口**。
#
# 为什么要单独一条链（2026-09-30 定罪，债表 DS-16）：参照物以前只有线上归档族，而当天实测它被删小
#   （44 → 34，6 个 `v<数字>` 归档 Release 与 v1.1.12 的两颗资产消失），门禁拿着变小的参照物继续绿。
#   账本 = 每次 APK 发布成功之后按真名记一行（versionName+versionCode / apk_sha / run / url），
#   住在**独立分支的只追加文件**里：它不是 Release 资产，所以「删 Release」那类动作碰不到它；
#   它与线上归档谁的码高，判据宿主就按高的那个比（取严住 scripts/verify-apk-version-gate.sh）。
#
# 为什么不用 ci-ok 分支（DS-16 最初的设想，实测判死）：ci-ok 的五处写者一律
#   `git push origin HEAD:ci-ok --force`，每次把上一份读数原地换掉（现读 ci-ok.txt 只有最新一次），
#   那里读不出序列。本分支**永不 force**：force 一次就等于把已记的账抹掉，那正是这条链要防的事。
#   并发推送被撞开会直接判红（不重试、不 --force）—— 账没记上必须让人看见，否则下一轮门禁就是
#   拿一份不完整的下界在比（同 scripts/verify-ota-anchor.sh 那条「回执推不上就该看见红」的处置）。
#
# 用法: bash scripts/append-apk-receipt.sh <链路名> <auto|explicit> <version.json> <APK 文件> <发布网址> [run_id]
#   <链路名> 只用于读数点名（fast-apk / build-apk / release-admin-publish / release-admin-repack）
#   version.json 必须是**这个包自己**那份（判据宿主用 VG_SRC_DIR 留出来的那份，别再取一次）
# 退出: 0 已记账 / 2 参数或环境不成立（没记上，调用方不得当成功）/ 1 线上账本没接受这次追加
set -euo pipefail

CHAIN="${1:-}"
CHANNEL="${2:-}"
VJSON="${3:-}"
APK="${4:-}"
URL="${5:-}"
RUN_ID="${6:-}"
REPO="${GITHUB_REPOSITORY:-}"
REF="ci-receipts"
LOG="apk-receipts.log"

usage() {
  echo "[error] 用法: $0 <链路名> <auto|explicit> <version.json> <APK 文件> <发布网址> [run_id]" >&2
  exit 2
}
[ -n "$CHAIN" ] && [ -n "$CHANNEL" ] && [ -n "$VJSON" ] && [ -n "$APK" ] && [ -n "$URL" ] || usage
case "$CHANNEL" in auto|explicit) ;; *) echo "[error] 通道只能是 auto|explicit，收到：$CHANNEL" >&2; exit 2 ;; esac
[ -n "$REPO" ] || { echo "::error title=回执记账::环境里没有 GITHUB_REPOSITORY，不知道该往哪个仓记账。" >&2; exit 2; }
[ -n "${GH_TOKEN:-}" ] || { echo "::error title=回执记账::没有 GH_TOKEN，账记不上（不要静默跳过这一步）。" >&2; exit 2; }
[ -f "$VJSON" ] || { echo "::error title=回执记账::读不到 $VJSON —— 记账要用的版本清单都不在。" >&2; exit 2; }
[ -f "$APK" ] || { echo "::error title=回执记账::读不到 APK：$APK —— 记不出指纹的账等于没记。" >&2; exit 2; }

# 取号只用一种写法（node -p + path.resolve），与判据宿主读同一份清单，避免两侧解析漂移。
VN="$(node -p "require(require('node:path').resolve(process.argv[1])).shell.versionName" "$VJSON" 2>/dev/null || true)"
VC_RAW="$(node -p "Number(require(require('node:path').resolve(process.argv[1])).shell.versionCode)" "$VJSON" 2>/dev/null || true)"
case "$VC_RAW" in ''|*[!0-9]*)
  echo "::error title=回执记账::$VJSON 的 shell.versionCode 不是整数（读到: ${VC_RAW:-空}）—— 这种账记进去下一轮门禁读不出数。" >&2
  exit 2 ;;
esac
[ -n "$VN" ] || { echo "::error title=回执记账::$VJSON 读不出 shell.versionName。" >&2; exit 2; }
APK_SHA="$(sha256sum "$APK" | cut -d' ' -f1)"
[ -n "$APK_SHA" ] || { echo "::error title=回执记账::$APK 算不出 sha256。" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
git init -q .
git remote add origin "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"

# 分支在不在，用 ls-remote 判（不 clone 整个仓：这条链每次只追加一行）。
# ls-remote 自己失败（网络/鉴权）不能当成「分支不存在」—— 那会把「记不上账」伪装成「还没开始记」。
rc=0
git ls-remote --exit-code --heads origin "$REF" >/dev/null 2>&1 || rc=$?
case "$rc" in
  0)
    git fetch -q origin "$REF" || { echo "::error title=回执记账::账本分支在，却 fetch 不下来 —— 看不清线上账本就不硬写。" >&2; exit 2; }
    git checkout -q -b "$REF" FETCH_HEAD || { echo "::error title=回执记账::checkout $REF 失败。" >&2; exit 2; }
    EXISTED=1
    ;;
  2) echo "[receipt] $REF 还没有分支 —— 本次建分支并落下第一条账" ; EXISTED=0 ;;
  *) echo "::error title=回执记账::ls-remote $REF 失败（rc=$rc），原因不是「分支不存在」。看不清就不写。" >&2; exit 2 ;;
esac

if [ "$EXISTED" = 1 ] && [ ! -f "$LOG" ]; then
  # 分支已存在却没有账本文件 = 文件被删过（不是首次建账）：照样写出来，但必须把这句话说清，
  # 否则下一轮取数会读到「一条记录都没有」，而这正是需要看见的破损形状。
  echo "[receipt] 分支 $REF 在而 $LOG 不在 —— 账本文件被删过，重建后从本次起记（历史那部分已不可恢复）" >&2
fi
if [ ! -f "$LOG" ]; then
  {
    echo '# APK 发布回执账本 —— 只追加，不重写、不 force push。'
    echo '# 每条记录一个 RECEIPT 标记行 + 若干「键 : 值」行；取数与判定分别住'
    echo '# scripts/read-apk-receipts.sh 与 scripts/verify-apk-version-gate.sh。'
  } > "$LOG"
fi

{
  echo "RECEIPT"
  echo "time    : $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  echo "chain   : $CHAIN"
  echo "channel : $CHANNEL"
  echo "shell   : $VN+$VC_RAW"
  echo "sha     : ${GITHUB_SHA:-local}"
  echo "apk     : $(basename "$APK")"
  echo "apk_sha : $APK_SHA"
  echo "run     : ${RUN_ID:-${GITHUB_RUN_ID:-}}"
  echo "url     : $URL"
} >> "$LOG"

git add -f "$LOG"
git -c user.email="ci@workbuddy.local" -c user.name="CI Receipt Bot" \
  commit -q -m "receipt: $CHAIN $VN+$VC_RAW (${RUN_ID:-${GITHUB_RUN_ID:-n/a}})" || {
  echo "::error title=回执记账::本地提交没做成（账本内容没变？那这条发布就没被记进下界）。" >&2
  exit 1
}
# 不 --force：被拒 = 有人先推过（并发发布或账本被动过）。此时必须红着让人重跑，
# 而不是把别人的记录冲掉。
if ! git push -q origin "HEAD:$REF"; then
  echo "::error title=回执记账::追加没被 $REF 接受（并发推送或分支被保护规则挡下）。本次发布 $VN+$VC_RAW **没有**记进账本 —— 不重试、不 --force，重跑这条链或人工补记。" >&2
  exit 1
fi
echo "[receipt] 已记账 $CHAIN $VN+$VC_RAW apk_sha=${APK_SHA:0:12}… → $REF/$LOG"
