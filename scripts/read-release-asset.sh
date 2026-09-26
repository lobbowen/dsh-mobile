#!/usr/bin/env bash
#
# 读「某个 Release 上已有的某个资产」——三种结局必须分得开，且都由这一处判。
#
# 为什么单独成宿主：发布前都要拿"线上现在是什么"跟自己比（APK 侧比 version.json，
# 内核侧比 kernel-manifest.json）。旧写法是各 workflow 自己 `gh release download`，
# 失败就 `::warning` 一句然后**照发** —— 那是把「看不清线上是什么」当成了
# 「线上什么都没有」，恰好是最危险的那一侧被放行（2026-09-26 定罪，见
# docs/runbook/release.md §3）。所以「不存在」与「取不到」必须由同一段代码分开判。
#
# 用法: bash scripts/read-release-asset.sh <标签> <release tag> <资产名> <输出目录>
#   输出目录里会落下 <资产名> 这个真名文件（gh 的资产名取 basename，所以要真名落盘）
# 退出:
#   0  = 取到了，文件在 <输出目录>/<资产名>
#   10 = 该 Release 不存在，或存在但确实没有这个资产 —— 「首次发布」，是合法状态
#   2  = 看不清（网络、鉴权、gh 自身的其它错误）—— 调用方**不得**据此继续发布
set -euo pipefail

LABEL="${1:-}"
TAG="${2:-}"
ASSET="${3:-}"
OUTDIR="${4:-}"
REPO="${GITHUB_REPOSITORY:-}"

unknown() {
  echo "::error title=读线上资产($LABEL)::$*" >&2
  exit 2
}
[ -n "$LABEL" ] && [ -n "$TAG" ] && [ -n "$ASSET" ] && [ -n "$OUTDIR" ] || {
  echo "[error] 用法: $0 <标签> <release tag> <资产名> <输出目录>" >&2
  exit 2
}
[ -n "$REPO" ] || unknown "环境里没有 GITHUB_REPOSITORY，gh 不知道去哪个仓取。"

mkdir -p "$OUTDIR"
ERR="$OUTDIR/.read-err"

# 「确实不存在」的措辞：gh 在不同子命令下会给 404、"not found"、"doesn't contain any
# asset matching pattern" 这几种，都只意味着**没有那个东西**，不意味着读失败。
absent() { grep -qiE 'HTTP 404|Not Found|no assets|matching pattern|not found|does not exist' "$1"; }

# ① Release 在不在。这一步不能省：直接 download 时「Release 不存在」和「Release 在但
# 资产不在」会混成同一句报错，而调用方要区分「通道还没开过」与「通道开过但清单丢了」
# ——后者不是首次发布，是状态丢了（APK 侧由版本门禁判红）。
if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>"$ERR"; then
  if absent "$ERR"; then
    echo "[read:$LABEL] Release $TAG 不存在 —— 按首次发布处理"
    exit 10
  fi
  cat "$ERR" >&2 || true
  unknown "读 Release $TAG 失败，且原因不是「它不存在」—— 看不清线上状态就不许继续发布。"
fi

# ② 资产在不在。gh 的 `-O` 是**文件路径**（不是目录），目标已存在会直接报错，
# 所以指向本目录下那个尚未落地的真名。
if gh release download "$TAG" -p "$ASSET" -O "$OUTDIR/$ASSET" --repo "$REPO" 2>"$ERR"; then
  echo "[read:$LABEL] 取到 $TAG/$ASSET ($(wc -c <"$OUTDIR/$ASSET") 字节)"
  exit 0
fi
if absent "$ERR"; then
  echo "[read:$LABEL] Release $TAG 在，但没有资产 $ASSET —— 按首次发布处理"
  exit 10
fi
cat "$ERR" >&2 || true
unknown "Release $TAG 存在、取资产 $ASSET 却失败，且原因不是「资产不存在」—— 看不清线上状态就不许继续发布。"
