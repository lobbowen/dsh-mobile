#!/usr/bin/env bash
#
# apk-latest 版本门禁的**取数外壳**：把「本次的清单」与「线上已有的清单」两样事实凑齐，
# 再交给 scripts/verify-apk-version-gate.sh 判定。判据本身不住在这里（退 0/1/2 的含义见那份）。
#
# 为什么要这一层：四个发布口都要做同样的两次取数，写在 workflow 里就是四份会各自漂移的
# gh 调用；而「线上清单取不到」有两种完全不同的含义 —— 资产确实不存在（首次发布）与
# 只是这次没取到（看不清）—— 旧实现把两者一起降成 warning 然后照发，正是这里要收掉的口子。
#
# 用法: bash scripts/check-apk-release-version.sh <本次 version.json> <release tag> <auto|explicit> [来源 run_id]
#   第 4 个参数给「发别的 run 产物」的两条链路（release-admin 的 publish / repack）：
#   比较基准取**那个 run 的提交**里的清单，而不是本 workflow 自己 checkout 的那份 ——
#   拿后者比前者，发出去的包和读出来的版本对不上，门禁就成了自证。
#   环境变量 VG_SRC_DIR=<目录>：把判据实际读到的那份清单拷成 <目录>/version.json 留给调用方上传。
# 退出: 与门禁一致（0 放行 / 1 判红 / 2 无从校验）。调用方在非 0 时都不得发布。
set -euo pipefail

NEW="${1:-}"
TAG="${2:-}"
CHANNEL="${3:-}"
RUN_ID="${4:-}"
REPO="${GITHUB_REPOSITORY:-}"

die() { echo "::error title=版本门禁::$*" >&2; exit 2; }
[ -n "$NEW" ] && [ -n "$TAG" ] && [ -n "$CHANNEL" ] || {
  echo "[error] 用法: $0 <本次 version.json> <release tag> <auto|explicit> [来源 run_id]" >&2
  exit 2
}
[ -n "$REPO" ] || die "环境里没有 GITHUB_REPOSITORY，gh 不知道去哪个仓取线上清单。"

SRC="$NEW"
if [ -n "$RUN_ID" ]; then
  # 来源 run 的提交 sha 只能从 run 对象本身读；REST 字段 head_sha 比 gh 的 --json 字段名稳定。
  SHA="$(gh api "repos/$REPO/actions/runs/$RUN_ID" --jq .head_sha || true)"
  case "$SHA" in ''|null) die "run $RUN_ID 没给出 head_sha —— 它用的是哪份版本清单无从确定。" ;; esac
  SRC_DIR="$(mktemp -d)"
  if ! gh api -H 'Accept: application/vnd.github.raw+json' \
       "repos/$REPO/contents/version.json?ref=$SHA" > "$SRC_DIR/version.json" 2>"$SRC_DIR/err"; then
    cat "$SRC_DIR/err" >&2 || true
    die "取不到 run $RUN_ID（$SHA）那份 version.json；看不清产物自己的版本就不许发。"
  fi
  SRC="$SRC_DIR/version.json"
  echo "[version] 来源 run $RUN_ID @ ${SHA:0:10} 的清单 → $SRC"
fi

# VG_SRC_DIR：把「判据实际读到的那份清单」原样留一份给调用方。
# 为什么要有这个出口：发出去的包必须自带它被判定用的那份 version.json，否则「校验的清单」
# 和「上传的清单」是两次取数、可以各自漂移 —— 调用方再抄一份 gh 取数就是第二份拷贝（门禁法 §7.1）。
if [ -n "${VG_SRC_DIR:-}" ]; then
  mkdir -p "$VG_SRC_DIR"
  cp "$SRC" "$VG_SRC_DIR/version.json"
  echo "[version] 判定用清单已留到 $VG_SRC_DIR/version.json（上传时用它，别再自己取一次）"
fi

DIR="$(mktemp -d)"
OLD="-"
# 「线上清单不存在（首次发布）」与「取不到（看不清）」是两种完全不同的结局，分类住在
# scripts/read-release-asset.sh（内核 OTA 那条链共用同一处）。这里只按退码分派：
#   0 → 拿它比；10 → 按首次发布走门禁；其它（2）→ 直接退 2，不许发。
# 旧实现把后两者混成一句 ::warning 然后照发 —— 那正是「把不可逆风险发出去」的那条路。
rc=0
bash "$(dirname "$0")/read-release-asset.sh" apk-version-manifest "$TAG" version.json "$DIR" || rc=$?
case "$rc" in
  0) OLD="$DIR/version.json" ;;
  10) echo "[version] $TAG 上没有可读的 version.json —— 按首次发布处理（通道=$CHANNEL）" ;;
  *) echo "::error title=版本门禁::读 $TAG 的已发布清单失败（见上一条），本次不发布。" >&2; exit 2 ;;
esac
bash "$(dirname "$0")/verify-apk-version-gate.sh" "$SRC" "$OLD" "$CHANNEL"
