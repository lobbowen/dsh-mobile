#!/usr/bin/env bash
#
# 版本门禁的**取数外壳**：把「本次的清单」与「线上已有的读数」两格事实凑齐，再交给
# scripts/verify-apk-version-gate.sh 判定。判据本身不住在这里（退 0/1/2 的含义见那份）。
#
# 为什么要这一层：投壳 APK 的链要把「本次的清单」与「线上已有的读数」两格事实凑齐才能判，
# 写在 workflow 里就是一份会随链路数漂移的 gh 调用；而「取不到」有两种完全不同的含义 ——
# 那一格里确实没有读数（首次发布/未起账）与只是这次没取到（看不清）—— 旧实现把两者一起
# 降成 warning 然后照发，正是这里要收掉的口子。
#
# 用法: bash scripts/check-apk-release-version.sh <本次 version.json> <参照物> <auto|explicit>
#   <参照物> 目前只有一种合法值，且**必须由调用方说出来**（不许在宿主里写死成一句漂亮话）：
#     archive —— 比对这条链自己写的 `v<versionName>` 归档族资产名读数
#                （取数住 scripts/read-archived-shell-version.sh）
#   为什么不再接受「某个 release tag 上的 version.json 资产」：那种参照物是 release-admin 的
#   publish/repack 用来「发别的 run 的产物」的，两条链随发布连归一一起废除（docs/adr/0011），
#   而全仓现在没有任何链路再往 Release 上落 version.json 资产 —— 留着这一格就等于留着一个
#   「拿线上根本不存在的东西当参照物」的入口，那正是债表 DS-14 定罪的空转形状。传错值当场判红。
#   无论选哪种，都会**再取一格回执账本**（scripts/read-apk-receipts.sh）：线上那一格是可以被删小的
#     （2026-09-30 实测 44→34），账本那一格住在独立分支的只追加文件里，删 Release 碰不到它。
#     两格怎么取严、缺一格怎么分派，只住判据宿主。
#   第 3 格通道同理保留给判据的「两格取严」分派；归一后没有任何链路传 explicit（门禁在册）。
# 退出: 与门禁一致（0 放行 / 1 判红 / 2 无从校验）。调用方在非 0 时都不得发布。
set -euo pipefail

NEW="${1:-}"
TAG="${2:-}"
CHANNEL="${3:-}"
REPO="${GITHUB_REPOSITORY:-}"

die() { echo "::error title=版本门禁::$*" >&2; exit 2; }
[ -n "$NEW" ] && [ -n "$TAG" ] && [ -n "$CHANNEL" ] || {
  echo "[error] 用法: $0 <本次 version.json> <参照物: archive> <auto|explicit>" >&2
  exit 2
}
[ -n "$REPO" ] || die "环境里没有 GITHUB_REPOSITORY，gh 不知道去哪个仓取线上清单。"
[ "$TAG" = archive ] || die "参照物只支持 archive（这条链自己写的 v<versionName> 归档族），收到 $TAG。"
SRC="$NEW"

DIR="$(mktemp -d)"
LDIR="$(mktemp -d)"
OLD="-"
LEDGER="-"
# 「线上清单不存在（那一格没有读数）」与「取不到（看不清）」是两种完全不同的结局，分类住在
# 取数宿主里（这一格 = scripts/read-archived-shell-version.sh；Release 资产那一格 =
# scripts/read-release-asset.sh，Program/能力件那条链共用它）。这里只按退码分派：
#   0 → 交判据拿它比；10 → 把 '-' 交判据（是否算「首次发布」由判据按**两格**与通道一起判）；
#   其它（2）→ 直接退 2，不许发。
# 旧实现把后两者混成一句 ::warning 然后照发 —— 那正是「把不可逆风险发出去」的那条路。
#
# 参照物只有一种形状（上面已按名硬拦），但**三态纪律是同一条**（0 有读数 / 10 没有读数 / 2 看不清），
#   判据宿主依旧只有一种输入。
rc=0
bash "$(dirname "$0")/read-archived-shell-version.sh" "$DIR" || rc=$?
case "$rc" in
  0) OLD="$DIR/version.json" ;;
  10) echo "[version] 线上没有 $TAG 形态的归档 —— 那一格没有读数（是否算首次发布，由判据按两格与通道判）" ;;
  *) echo "::error title=版本门禁::读日常链归档失败（见上一条），本次不发布。" >&2; exit 2 ;;
esac

# ── 第二格参照物：回执账本（线上那格被删小时唯一剩下的下界，债表 DS-16）─────────────
# 取数与三态判据唯一宿主 = scripts/read-apk-receipts.sh。这里同样只按退码分派，不自判：
#   0 → 交判据宿主；10 → 「账还没起」（判据按通道分派：自动红、显式放行起账）；2 → 退 2。
# 为什么不能省这一格：以前只比线上归档族，而当天实测它被删小（44 → 34）后门照样绿 ——
#   「参照物变小」必须是**看得见**的事，不是自动变松。
rc=0
bash "$(dirname "$0")/read-apk-receipts.sh" "$LDIR" || rc=$?
case "$rc" in
  0) LEDGER="$LDIR/version.json" ;;
  10) echo "[version] 回执账本还没有记录 —— 未起账（通道=$CHANNEL，是否放行由判据宿主判）" ;;
  *) echo "::error title=版本门禁::读回执账本失败（见上一条），本次不发布。" >&2; exit 2 ;;
esac

# 两格一起交判据：第 4 格说清「线上那格是谁」，第 5 格给账本读数（没有读数也必须显式给 '-'，
# 缺省成 '-' 就等于允许不发账过门 —— 那一格是这一改的全部效力所在）。
bash "$(dirname "$0")/verify-apk-version-gate.sh" "$SRC" "$OLD" "$CHANNEL" "$TAG" "$LEDGER"
